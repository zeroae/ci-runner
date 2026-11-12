#!/usr/bin/env bash
# Smoke test for the ci-runner image. Run it inside the image:
#   docker run --rm -v "$PWD/image/smoke.sh:/smoke.sh:ro" --entrypoint bash IMAGE /smoke.sh
# Prints every added tool's version and fails if any check fails.
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
check runner         /home/runner/config.sh --version
check docker         docker --version
check buildx         docker buildx version
check compose        docker compose version
check gh             gh --version
check jq             jq --version
check make           make --version
check git            git --version
check curl           curl --version
check zstd           zstd --version
check python3        python3 --version
check node           node --version
check npm            npm --version
check aws            aws --version
expect python3.12    3.12 "$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>&1)"

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

if (( fail )); then echo "SMOKE FAILED"; exit 1; fi
echo "SMOKE PASSED"
