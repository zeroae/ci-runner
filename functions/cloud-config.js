'use strict';
// cloud-config: renders the #cloud-config user-data of one CI runner instance.
// Shared by scripts/hand-launch.sh (through scripts/render-cloud-config.js) and
// the launcher. Self-contained: no require(), so it can be inlined.
//
// What the instance does (spec, "What an instance does"):
//   bootcmd     the docker group with gid 123, before the package creates it
//               (the runner image's `runner` user is in gid 123);
//   packages    docker;
//   write_files the JIT config (root-only, 0600) and the start script;
//   runcmd      start docker, then the start script: run the runner image with
//               the host socket, and /tmp (on the root disk) and the runner's
//               home at the same paths on host and container (seeded first), stop
//               it if no job started within the idle limit, and power off
//               (= terminate) when the container exits.

const DEFAULTS = {
  image: 'ghcr.io/zeroae/ci-runner:latest',
  idleSeconds: 900,
};
// The runner image's home: the runner itself, $HOME and the work dir (_work).
const HOME_DIR = '/home/runner';
const JIT_PATH = '/etc/ci-runner/jitconfig';
const SCRIPT_PATH = '/usr/local/sbin/ci-runner';
// uid of `runner` in ghcr.io/actions/actions-runner, gid of its `docker` group.
const RUNNER_UID = 1001;
const DOCKER_GID = 123;

function startScript({ image, idleSeconds }) {
  return `#!/bin/bash
# Runs one GitHub Actions job in ${image}, then powers off.
# InstanceInitiatedShutdownBehavior=terminate turns the power-off into a termination.
set -u
trap 'shutdown -h now' EXIT

for i in 1 2 3 4 5; do docker pull ${image} && break; sleep 10; done

# A job's \`docker run -v\` source is a path on this host, so /tmp and the home
# are shared at the same paths. The runner lives in the home: copy it out first.
install -d -o ${RUNNER_UID} -g ${DOCKER_GID} ${HOME_DIR}
docker run --rm --user 0 --entrypoint cp -v ${HOME_DIR}:/seed ${image} -a ${HOME_DIR}/. /seed/ || exit 1
# AL2023's /tmp is tmpfs (half the RAM); put a root-disk dir over it, as on GitHub-hosted.
install -d -m 1777 /var/tmp/ci-runner
mount --bind /var/tmp/ci-runner /tmp || exit 1

docker run -d --init --name ci-runner \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v /tmp:/tmp \\
  -v ${HOME_DIR}:${HOME_DIR} \\
  ${image} ./run.sh --jitconfig "$(cat ${JIT_PATH})" || exit 1

# Idle exit: the runner logs "Running job:" when it is given its job.
( sleep ${idleSeconds}
  docker logs ci-runner 2>&1 | grep -q 'Running job' || {
    echo "ci-runner: no job within ${idleSeconds}s, stopping"
    docker stop -t 30 ci-runner
  } ) &

docker wait ci-runner
docker logs --tail 20 ci-runner 2>&1
`;
}

function indent(text, n) {
  const pad = ' '.repeat(n);
  return text.replace(/\n$/, '').split('\n').map((l) => (l ? pad + l : l)).join('\n');
}

function renderCloudConfig(options) {
  const o = { ...DEFAULTS, ...options };
  // A JIT config is base64; refusing anything else keeps the YAML well-formed.
  if (typeof o.jitConfig !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(o.jitConfig)) {
    throw new Error('jitConfig must be a base64 string');
  }
  if (!Number.isInteger(o.idleSeconds) || o.idleSeconds <= 0) {
    throw new Error('idleSeconds must be a positive integer');
  }
  if (!/^[\w./:@-]+$/.test(o.image)) throw new Error('bad image');

  return `#cloud-config
bootcmd:
  - [sh, -c, "getent group docker || groupadd -g ${DOCKER_GID} docker"]
packages:
  - docker
write_files:
  - path: ${JIT_PATH}
    owner: root:root
    permissions: '0600'
    content: ${o.jitConfig}
  - path: ${SCRIPT_PATH}
    owner: root:root
    permissions: '0700'
    content: |
${indent(startScript(o), 6)}
runcmd:
  - [systemctl, enable, --now, docker]
  - [${SCRIPT_PATH}]
`;
}

module.exports = { renderCloudConfig };
