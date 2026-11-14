#!/usr/bin/env bash
# Smoke test for the ci-runner image. Run it inside the image:
#   docker run --rm -e EXPECT_ARCH=aarch64 -v "$PWD/image/smoke.sh:/smoke.sh:ro" --entrypoint bash IMAGE /smoke.sh
# Prints every added tool's version and fails if any check fails.
# EXPECT_ARCH (x86_64 or aarch64, as `uname -m` prints it) is the architecture
# the image was built for; without it the machine's own is expected.
set -uo pipefail

fail=0
check() {
  local name=$1; shift
  local out
  if out=$("$@" 2>&1); then
    printf 'ok   %-16s %s\n' "$name" "$(head -n1 <<<"$out")"
  else
    printf 'FAIL %-16s %s\n' "$name" "$(head -n1 <<<"$out")"
    fail=1
  fi
}
expect() {
  local name=$1 want=$2 got=$3
  if [[ $got == "$want" ]]; then
    printf 'ok   %-16s %s\n' "$name" "$got"
  else
    printf 'FAIL %-16s want %q, got %q\n' "$name" "$want" "$got"
    fail=1
  fi
}

echo "== tools"
check runner         bash -c "/home/runner/config.sh --version | grep -Ex '[0-9]+\.[0-9]+\.[0-9]+'"
check docker         docker --version
check buildx         docker buildx version
check compose        docker compose version
check gh             gh --version
check jq             jq --version
check make           make --version
check cc             cc --version
check c++            c++ --version
check pkg-config     pkg-config --version
check git            git --version
check curl           curl --version
check zstd           zstd --version
check python3        python3 --version
check node           node --version
check npm            npm --version
check aws            aws --version
expect python3.12    3.12 "$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>&1)"

echo "== architecture"
# Each binary the image adds must be built for the image's architecture, so a
# wrong download (the arm64 AWS CLI or compose plugin) fails here, not in a job.
arch=${EXPECT_ARCH:-$(uname -m)}
elf_arch() {
  # e_machine, bytes 18-19 of the ELF header: 62 is x86_64, 183 is aarch64.
  case $(od -An -tu2 -j18 -N2 "$1" 2>/dev/null | tr -d ' ') in
    62) echo x86_64 ;; 183) echo aarch64 ;; *) echo "not ELF: $1" ;;
  esac
}
expect uname          "$arch" "$(uname -m)"
expect docker-bin     "$arch" "$(elf_arch "$(command -v docker)")"
expect buildx-bin     "$arch" "$(elf_arch /usr/local/lib/docker/cli-plugins/docker-buildx)"
expect compose-bin    "$arch" "$(elf_arch /usr/local/lib/docker/cli-plugins/docker-compose)"
expect gh-bin         "$arch" "$(elf_arch "$(command -v gh)")"
expect node-bin       "$arch" "$(elf_arch "$(command -v node)")"
expect aws-bin        "$arch" "$(elf_arch "$(readlink -f "$(command -v aws)")")"
expect aws-exe        "exe/$arch" "$(aws --version 2>&1 | grep -o 'exe/[a-z0-9_]*')"

echo "== runner user"
id runner
expect whoami        runner "$(whoami)"
expect docker-gid    123 "$(getent group docker | cut -d: -f3)"
expect runner-in-123 yes "$(id -G runner | tr ' ' '\n' | grep -qx 123 && echo yes || echo no)"

echo "== toolcache"
expect AGENT_TOOLSDIRECTORY /opt/hostedtoolcache "${AGENT_TOOLSDIRECTORY:-}"
expect RUNNER_TOOL_CACHE    /opt/hostedtoolcache "${RUNNER_TOOL_CACHE:-}"
expect toolcache-owner      runner "$(stat -c %U /opt/hostedtoolcache 2>&1)"
expect toolcache-writable   yes "$(touch /opt/hostedtoolcache/.w 2>/dev/null && rm /opt/hostedtoolcache/.w && echo yes || echo no)"

echo "== idle exit"
# The Fargate capacities' entrypoint (EC2's host script does its own idle
# exit). Fake runners stand in for ./run.sh, with a 2 s timeout.
idle=/usr/local/bin/ci-runner-idle-exit
expect idle-exit-installed yes "$([[ -x $idle ]] && echo yes || echo no)"
t0=$SECONDS
out=$(IDLE_SECONDS=2 timeout 60 "$idle" bash -c 'echo "Listening for Jobs"; sleep 50' 2>&1)
rc=$?
expect idle-exit-stops   "stopped in time" "$( ((SECONDS - t0 < 30)) && [[ $rc != 124 ]] && echo "stopped in time" || echo "rc $rc after $((SECONDS - t0))s")"
expect idle-exit-says    yes "$(grep -q 'no job within 2s' <<<"$out" && echo yes || echo no)"
# Like the real runner: run-helper.sh and the listener sit in their own
# process group, and a TERM doesn't end them. After the grace, a KILL must.
t0=$SECONDS
out=$(IDLE_SECONDS=2 IDLE_GRACE_SECONDS=2 timeout 60 "$idle" bash -c 'trap "" TERM; set -m; echo "Listening for Jobs"; sleep 50 & wait' 2>&1)
rc=$?
expect idle-exit-kills   "stopped in time" "$( ((SECONDS - t0 < 30)) && [[ $rc != 124 ]] && echo "stopped in time" || echo "rc $rc after $((SECONDS - t0))s")"
out=$(IDLE_SECONDS=2 timeout 60 "$idle" bash -c 'echo "Running job: build"; sleep 4; echo finished; exit 3' 2>&1)
rc=$?
expect idle-exit-keeps   "3 finished" "$rc $(grep -x finished <<<"$out")"
out=$(IDLE_SECONDS=0 timeout 10 "$idle" true 2>&1)
expect idle-exit-refuses "2" "$?"

echo "== cargo jobs"
# With CI_RUNNER_VCPUS the entrypoint caps cargo's jobs in a config file, not
# in a CARGO_* variable rust-cache would hash. cargo isn't in the image, so
# the file is checked, not a build.
cfg=/home/runner/.cargo/config.toml
rm -f "$cfg"
IDLE_SECONDS=2 timeout 10 "$idle" true >/dev/null 2>&1
expect cargo-none        no "$([[ -e $cfg ]] && echo yes || echo no)"
out=$(CI_RUNNER_VCPUS=4 IDLE_SECONDS=2 timeout 10 "$idle" true 2>&1)
expect cargo-config      '[build] jobs = 4' "$(paste -sd' ' "$cfg" 2>&1)"
expect cargo-owner       runner "$(stat -c %U "$cfg" 2>&1)"
expect cargo-says        yes "$(grep -q 'cargo jobs = 4' <<<"$out" && echo yes || echo no)"
printf '[net]\ngit-fetch-with-cli = true\n' > "$cfg"
out=$(CI_RUNNER_VCPUS=8 IDLE_SECONDS=2 timeout 10 "$idle" true 2>&1)
expect cargo-keeps       '[net] git-fetch-with-cli = true' "$(paste -sd' ' "$cfg" 2>&1)"
expect cargo-keeps-says  yes "$(grep -q 'exists, leaving it' <<<"$out" && echo yes || echo no)"
rm -f "$cfg"
out=$(CI_RUNNER_VCPUS=four IDLE_SECONDS=2 timeout 10 "$idle" true 2>&1)
expect cargo-bad-value   "0 no" "$? $([[ -e $cfg ]] && echo yes || echo no)"

if (( fail )); then echo "SMOKE FAILED"; exit 1; fi
echo "SMOKE PASSED"
