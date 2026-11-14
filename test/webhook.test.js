'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createHandler } = require('../functions/webhook.js');

const SECRET = 'whsec-test';

function setup({ secretValue = { webhook_secret: SECRET } } = {}) {
  const sent = [];
  let reads = 0;
  const handler = createHandler({
    secret: { get: async () => { reads++; return secretValue; } },
    queue: { send: async (msg) => { sent.push(msg); } },
    env: { GITHUB_ORG: 'zeroae' },
  });
  return { handler, sent, reads: () => reads };
}

// A workflow_job payload as GitHub sends it (only the fields that matter).
function job({ action = 'queued', labels = ['self-hosted', 'ci-spot'], visibility = 'private', owner = 'zeroae' } = {}) {
  return {
    action,
    workflow_job: {
      id: 555, run_id: 444, head_sha: 'abc123', name: 'tests', labels,
    },
    repository: { full_name: `${owner}/app`, name: 'app', visibility, private: visibility !== 'public', owner: { login: owner } },
    installation: { id: 181 },
  };
}

function delivery(payload, { secret = SECRET, eventName = 'workflow_job', base64 = false, sig } = {}) {
  const body = JSON.stringify(payload);
  const signature = sig || 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  return {
    headers: { 'x-github-event': eventName, 'x-hub-signature-256': signature, 'content-type': 'application/json' },
    body: base64 ? Buffer.from(body).toString('base64') : body,
    isBase64Encoded: base64,
    requestContext: { http: { method: 'POST', path: '/' } },
  };
}

test('an accepted ci-spot job is enqueued with every field', async () => {
  const { handler, sent } = setup();
  const res = await handler(delivery(job()));
  assert.equal(res.statusCode, 202);
  assert.deepEqual(sent, [{
    repo: 'zeroae/app', job_id: 555, run_id: 444, head_sha: 'abc123', job_name: 'tests',
    label: 'ci-spot', vcpus: 4, arch: 'x64', labels: ['self-hosted', 'ci-spot'], installation_id: 181,
  }]);
});

test('every size label is enqueued with its vCPUs and the architecture', async () => {
  for (const [size, vcpus] of [['ci-cpu-2', 2], ['ci-cpu-4', 4], ['ci-cpu-8', 8], ['ci-cpu-16', 16]]) {
    for (const cap of ['ci-spot', 'ci-ondemand']) {
      const labels = ['self-hosted', cap, size, 'x64'];
      const { handler, sent } = setup();
      assert.equal((await handler(delivery(job({ labels })))).statusCode, 202, labels.join(','));
      assert.deepEqual(
        { label: sent[0].label, vcpus: sent[0].vcpus, arch: sent[0].arch, labels: sent[0].labels },
        { label: cap, vcpus, arch: 'x64', labels },
      );
    }
  }
});

test('a missing size or architecture label defaults to ci-cpu-4 and x64', async () => {
  for (const labels of [['self-hosted', 'ci-spot', 'x64'], ['self-hosted', 'ci-spot', 'ci-cpu-4'], ['self-hosted', 'linux', 'ci-ondemand']]) {
    const { handler, sent } = setup();
    await handler(delivery(job({ labels })));
    assert.equal(sent[0].vcpus, 4, labels.join(','));
    assert.equal(sent[0].arch, 'x64', labels.join(','));
  }
});

test('the size label is read case-insensitively', async () => {
  const { handler, sent } = setup();
  await handler(delivery(job({ labels: ['Self-Hosted', 'CI-Spot', 'CI-CPU-16', 'X64'] })));
  assert.equal(sent[0].vcpus, 16);
});

test('a base64-encoded body is verified on its decoded bytes', async () => {
  const { handler, sent } = setup();
  assert.equal((await handler(delivery(job(), { base64: true }))).statusCode, 202);
  assert.equal(sent.length, 1);
});

test('a bad, missing or wrong-key signature is refused and nothing is enqueued', async () => {
  const { handler, sent } = setup();
  assert.equal((await handler(delivery(job(), { secret: 'other' }))).statusCode, 401);
  assert.equal((await handler(delivery(job(), { sig: 'sha256=00' }))).statusCode, 401);
  const unsigned = delivery(job());
  delete unsigned.headers['x-hub-signature-256'];
  assert.equal((await handler(unsigned)).statusCode, 401);
  const tampered = delivery(job());
  tampered.body = tampered.body.replace('"private"', '"public"');
  assert.equal((await handler(tampered)).statusCode, 401);
  assert.equal(sent.length, 0);
});

test('before the App exists (no webhook_secret) every delivery is refused', async () => {
  const { handler, sent } = setup({ secretValue: { state_key: 'k' } });
  assert.equal((await handler(delivery(job()))).statusCode, 503);
  assert.equal(sent.length, 0);
});

test('the webhook secret is read once and cached', async () => {
  const { handler, reads } = setup();
  await handler(delivery(job()));
  await handler(delivery(job()));
  assert.equal(reads(), 1);
});

test('an arm64 job is enqueued with arch arm64, on either capacity and at every size', async () => {
  for (const cap of ['ci-spot', 'ci-ondemand']) {
    for (const size of ['ci-cpu-2', 'ci-cpu-4', 'ci-cpu-8', 'ci-cpu-16']) {
      const labels = ['self-hosted', cap, size, 'arm64'];
      const { handler, sent } = setup();
      assert.equal((await handler(delivery(job({ labels })))).statusCode, 202, labels.join(','));
      assert.equal(sent[0].arch, 'arm64', labels.join(','));
    }
  }
  const { handler, sent } = setup();
  await handler(delivery(job({ labels: ['Self-Hosted', 'CI-Spot', 'ARM64'] })));
  assert.deepEqual([sent[0].vcpus, sent[0].arch], [4, 'arm64']);
});

test('the label contract: self-hosted, exactly one capacity label, at most one size and one architecture label, and linux', async () => {
  const accepted = [
    ['self-hosted', 'ci-spot'],
    ['self-hosted', 'ci-ondemand'],
    ['self-hosted', 'linux', 'x64', 'ci-spot'],
    ['Self-Hosted', 'CI-Spot'],
    ['self-hosted', 'ci-spot', 'ci-cpu-8', 'x64'],
    ['self-hosted', 'linux', 'ci-ondemand', 'ci-cpu-2'],
    ['self-hosted', 'ci-spot', 'arm64'],
    ['self-hosted', 'linux', 'ci-spot', 'ci-cpu-8', 'arm64'],
  ];
  const ignored = [
    ['ci-spot'],
    ['self-hosted'],
    ['self-hosted', 'ci-spot', 'ci-ondemand'],
    ['self-hosted', 'ci-spot', 'gpu'],
    ['self-hosted', 'ci-spot', 'ci-cpu-4', 'ci-cpu-8'],
    ['self-hosted', 'ci-spot', 'ci-cpu-8', 'ci-cpu-8'],
    ['self-hosted', 'ci-spot', 'ci-cpu-3'],
    ['self-hosted', 'ci-spot', 'ci-cpu-32'],
    ['self-hosted', 'ci-spot', 'x64', 'arm64'],
    ['self-hosted', 'ci-spot', 'ci-cpu-8', 'ARM64', 'x64'],
    ['self-hosted', 'ci-spot', 'arm64', 'arm64'],
    ['self-hosted', 'ci-spot', 'aarch64'],
    ['self-hosted', 'ci-spot', 'x64', 'x64'],
    ['ubuntu-latest'],
    [],
  ];
  for (const labels of accepted) {
    const { handler, sent } = setup();
    assert.equal((await handler(delivery(job({ labels })))).statusCode, 202, labels.join(','));
    assert.equal(sent.length, 1);
  }
  for (const labels of ignored) {
    const { handler, sent } = setup();
    assert.equal((await handler(delivery(job({ labels })))).statusCode, 200, labels.join(','));
    assert.equal(sent.length, 0, labels.join(','));
  }
});

test('the capacity label is reported in lower case', async () => {
  const { handler, sent } = setup();
  await handler(delivery(job({ labels: ['self-hosted', 'CI-OnDemand'] })));
  assert.equal(sent[0].label, 'ci-ondemand');
});

test('fence 3: public or internal repos, and owners other than zeroae, are refused', async () => {
  for (const p of [job({ visibility: 'public' }), job({ visibility: 'internal' }), job({ owner: 'someone-else' })]) {
    const { handler, sent } = setup();
    assert.equal((await handler(delivery(p))).statusCode, 403);
    assert.equal(sent.length, 0);
  }
  const noVisibility = job();
  delete noVisibility.repository.visibility;
  const { handler, sent } = setup();
  assert.equal((await handler(delivery(noVisibility))).statusCode, 403);
  assert.equal(sent.length, 0);
});

test('other actions and other events are ignored', async () => {
  for (const d of [
    delivery(job({ action: 'in_progress' })),
    delivery(job({ action: 'completed' })),
    delivery({ zen: 'hi' }, { eventName: 'ping' }),
  ]) {
    const { handler, sent } = setup();
    assert.equal((await handler(d)).statusCode, 200);
    assert.equal(sent.length, 0);
  }
});
