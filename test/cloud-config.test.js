'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderCloudConfig } = require('../functions/cloud-config.js');

const JIT = 'eyJhIjoiYiJ9QUJDREVGR0hJSktMTU5PUA==';

test('it is a #cloud-config document', () => {
  assert.match(renderCloudConfig({ jitConfig: JIT }), /^#cloud-config\n/);
});

test('the docker group gets gid 123 before the docker package is installed', () => {
  const out = renderCloudConfig({ jitConfig: JIT });
  const gid = out.indexOf('groupadd -g 123 docker');
  assert.ok(gid > 0, 'no groupadd -g 123 docker');
  // bootcmd runs in cloud-init's init stage; packages in the config stage.
  assert.ok(out.indexOf('bootcmd:') < gid);
  assert.ok(gid < out.indexOf('packages:'));
  assert.match(out, /^packages:\n {2}- docker\n/m);
});

test('a job sees /tmp and its home at the same paths as the host docker daemon', () => {
  // The job drives the host's daemon, so a `docker run -v` source is a host
  // path: mktemp files and $HOME config must exist there too.
  const out = renderCloudConfig({ jitConfig: JIT });
  const run = out.slice(out.indexOf('docker run -d'), out.indexOf('./run.sh'));
  assert.match(run, / -v \/tmp:\/tmp /);
  assert.match(run, / -v \/home\/runner:\/home\/runner /);
  assert.match(run, / -v \/var\/run\/docker\.sock:\/var\/run\/docker\.sock /);
  assert.match(out, /ghcr\.io\/zeroae\/ci-runner:latest \.\/run\.sh --jitconfig /);
});

test('the host home is seeded from the image before it is mounted over the runner', () => {
  // The image keeps the runner itself in /home/runner; an empty host dir
  // mounted there would hide run.sh.
  const out = renderCloudConfig({ jitConfig: JIT });
  const seed = out.indexOf(' -a /home/runner/. /seed/ || exit 1');
  assert.ok(seed > 0, 'no seed copy');
  assert.match(out, /docker run --rm --user 0 --entrypoint cp -v \/home\/runner:\/seed ghcr\.io\/zeroae\/ci-runner:latest -a \/home\/runner\/\. \/seed\/ /);
  assert.ok(out.indexOf('docker pull') < seed);
  assert.ok(seed < out.indexOf('docker run -d'));
});

test('the JIT config is written root-only, 0600, and handed to run.sh', () => {
  const out = renderCloudConfig({ jitConfig: JIT });
  assert.match(out,
    /- path: \/etc\/ci-runner\/jitconfig\n {4}owner: root:root\n {4}permissions: '0600'\n {4}content: eyJhIjoiYiJ9QUJDREVGR0hJSktMTU5PUA==\n/);
  assert.match(out, /--jitconfig "\$\(cat \/etc\/ci-runner\/jitconfig\)"/);
});

test('a runner given no job is stopped after 15 minutes by default', () => {
  const out = renderCloudConfig({ jitConfig: JIT });
  assert.match(out, /sleep 900\n/);
  assert.match(out, /grep -q 'Running job' \|\| \{/);
  assert.match(out, /docker stop -t 30 ci-runner/);
  assert.match(renderCloudConfig({ jitConfig: JIT, idleSeconds: 120 }), /sleep 120\n/);
});

test('the instance powers off when the container exits, whatever happened before', () => {
  const out = renderCloudConfig({ jitConfig: JIT });
  assert.match(out, /trap 'shutdown -h now' EXIT\n/);
  assert.ok(out.indexOf('trap ') < out.indexOf('docker pull'));
  assert.match(out, /\n {6}docker wait ci-runner\n/);
  assert.match(out, /runcmd:\n {2}- \[systemctl, enable, --now, docker\]\n {2}- \[\/usr\/local\/sbin\/ci-runner\]\n$/);
});

test('it refuses input that would break the YAML', () => {
  assert.throws(() => renderCloudConfig({ jitConfig: 'abc\nruncmd: [x]' }), /base64/);
  assert.throws(() => renderCloudConfig({}), /base64/);
  assert.throws(() => renderCloudConfig({ jitConfig: JIT, idleSeconds: '900; rm' }), /idleSeconds/);
});
