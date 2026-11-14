'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createHandler } = require('../functions/webhook.js');

const SECRET = 'whsec-test';

// instances: what DescribeInstances knows, as { InstanceId, Tags: { key: value } }.
// The fake applies the tag filters the way EC2 does.
function setup({ secretValue = { webhook_secret: SECRET }, instances = [] } = {}) {
  const sent = [];
  const described = [];
  const tagged = [];
  const logs = [];
  let reads = 0;
  const handler = createHandler({
    secret: { get: async () => { reads++; return secretValue; } },
    queue: { send: async (msg) => { sent.push(msg); } },
    ec2: {
      describeInstances: async (input) => {
        described.push(input);
        const match = (i) => input.Filters.every((f) => !f.Name.startsWith('tag:') || f.Values.includes(i.Tags[f.Name.slice(4)]));
        const Instances = instances.filter(match).map((i) => ({
          InstanceId: i.InstanceId, State: { Name: 'running' },
          Tags: Object.entries(i.Tags).map(([Key, Value]) => ({ Key, Value })),
        }));
        return { Reservations: Instances.length ? [{ Instances }] : [] };
      },
      createTags: async (input) => { tagged.push(input); },
    },
    env: { GITHUB_ORG: 'zeroae', STACK_NAME: 'ci-runner' },
    log: (line) => logs.push(JSON.parse(line)),
  });
  return { handler, sent, described, tagged, logs, reads: () => reads };
}

// A workflow_job payload as GitHub sends it (only the fields that matter).
function job({ action = 'queued', labels = ['self-hosted', 'ci-spot', 'ci-cpu-4', 'x64'], visibility = 'private', owner = 'zeroae', runner } = {}) {
  return {
    action,
    workflow_job: {
      id: 555, run_id: 444, head_sha: 'abc123', name: 'tests', labels,
      ...(runner && { runner_name: runner, runner_id: 77 }),
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
    label: 'ci-spot', vcpus: 4, arch: 'x64', labels: ['self-hosted', 'ci-spot', 'ci-cpu-4', 'x64'], installation_id: 181,
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

test('a job missing its size label or its architecture label is outside the contract', async () => {
  for (const labels of [
    ['self-hosted', 'ci-spot', 'x64'],
    ['self-hosted', 'ci-ondemand', 'arm64'],
    ['self-hosted', 'ci-spot', 'ci-cpu-4'],
    ['self-hosted', 'linux', 'ci-ondemand', 'ci-cpu-8'],
    ['self-hosted', 'ci-spot'],
    ['self-hosted', 'linux', 'ci-ondemand'],
  ]) {
    const { handler, sent } = setup();
    assert.equal((await handler(delivery(job({ labels })))).statusCode, 200, labels.join(','));
    assert.equal(sent.length, 0, labels.join(','));
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
  await handler(delivery(job({ labels: ['Self-Hosted', 'CI-Spot', 'CI-CPU-4', 'ARM64'] })));
  assert.deepEqual([sent[0].vcpus, sent[0].arch], [4, 'arm64']);
});

test('the label contract: self-hosted, exactly one capacity, size and architecture label, and linux', async () => {
  const accepted = [
    ['self-hosted', 'ci-spot', 'ci-cpu-4', 'x64'],
    ['self-hosted', 'ci-ondemand', 'ci-cpu-4', 'x64'],
    ['self-hosted', 'linux', 'x64', 'ci-cpu-2', 'ci-spot'],
    ['Self-Hosted', 'CI-Spot', 'CI-CPU-4', 'X64'],
    ['self-hosted', 'ci-spot', 'ci-cpu-8', 'x64'],
    ['self-hosted', 'linux', 'ci-ondemand', 'ci-cpu-2', 'arm64'],
    ['self-hosted', 'ci-spot', 'ci-cpu-16', 'arm64'],
    ['self-hosted', 'linux', 'ci-spot', 'ci-cpu-8', 'arm64'],
  ];
  const ignored = [
    ['ci-spot'],
    ['self-hosted'],
    ['self-hosted', 'ci-spot', 'ci-ondemand', 'ci-cpu-4', 'x64'],
    ['self-hosted', 'ci-spot', 'ci-cpu-4', 'x64', 'gpu'],
    ['self-hosted', 'ci-spot', 'ci-cpu-4', 'ci-cpu-8', 'x64'],
    ['self-hosted', 'ci-spot', 'ci-cpu-8', 'ci-cpu-8', 'x64'],
    ['self-hosted', 'ci-spot', 'ci-cpu-3', 'x64'],
    ['self-hosted', 'ci-spot', 'ci-cpu-32', 'x64'],
    ['self-hosted', 'ci-spot', 'ci-cpu-4', 'x64', 'arm64'],
    ['self-hosted', 'ci-spot', 'ci-cpu-8', 'ARM64', 'x64'],
    ['self-hosted', 'ci-spot', 'ci-cpu-4', 'arm64', 'arm64'],
    ['self-hosted', 'ci-spot', 'ci-cpu-4', 'aarch64'],
    ['self-hosted', 'ci-spot', 'ci-cpu-4', 'x64', 'x64'],
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
  await handler(delivery(job({ labels: ['self-hosted', 'CI-OnDemand', 'ci-cpu-4', 'x64'] })));
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
    delivery(job({ action: 'completed' })),
    delivery({ zen: 'hi' }, { eventName: 'ping' }),
  ]) {
    const { handler, sent } = setup();
    assert.equal((await handler(d)).statusCode, 200);
    assert.equal(sent.length, 0);
  }
});

// A runner the launcher started for job 999 of run 888, and its instance.
const RUNNER = 'ci-runner-20261113120000-999';
const instance = (tags = {}) => ({
  InstanceId: 'i-0abc',
  Tags: {
    'ci-runner:stack': 'ci-runner', 'ci-runner:runner': RUNNER, 'ci-runner:runner-id': '77',
    'ci-runner:label': 'ci-spot', 'ci-runner:labels': 'self-hosted,ci-spot,ci-cpu-8,arm64,linux',
    'ci-runner:capacity': 'ci-spot', 'ci-runner:vcpus': '8', 'ci-runner:arch': 'arm64',
    'ci-runner:repo': 'zeroae/lib', 'ci-runner:job-id': '999', 'ci-runner:run-id': '888',
    'ci-runner:head-sha': 'fff000', 'ci-runner:job-name': 'build',
    ...tags,
  },
});

test('a swap: the runner\'s own job is re-queued from its tags, and the instance is re-tagged with the job it runs', async () => {
  const { handler, sent, tagged, logs } = setup({ instances: [instance()] });
  const res = await handler(delivery(job({ action: 'in_progress', runner: RUNNER })));
  assert.equal(res.statusCode, 202);
  assert.deepEqual(sent, [{
    repo: 'zeroae/lib', job_id: 999, run_id: 888, head_sha: 'fff000', job_name: 'build',
    label: 'ci-spot', vcpus: 8, arch: 'arm64', labels: ['self-hosted', 'ci-spot', 'ci-cpu-8', 'arm64', 'linux'], installation_id: 181,
  }]);
  assert.deepEqual(tagged, [{
    Resources: ['i-0abc'],
    Tags: [
      { Key: 'ci-runner:repo', Value: 'zeroae/app' }, { Key: 'ci-runner:job-id', Value: '555' },
      { Key: 'ci-runner:run-id', Value: '444' }, { Key: 'ci-runner:head-sha', Value: 'abc123' },
      { Key: 'ci-runner:job-name', Value: 'tests' },
    ],
  }]);
  assert.deepEqual(logs, [{
    swap: RUNNER, instance: 'i-0abc', took: { repo: 'zeroae/app', job_id: 555 }, requeued: { repo: 'zeroae/lib', job_id: 999 },
  }]);
});

test('in_progress on a runner running its own job does nothing', async () => {
  const own = 'ci-runner-20261113120000-555';
  const { handler, sent, described, tagged, logs } = setup({ instances: [instance({ 'ci-runner:runner': own, 'ci-runner:job-id': '555' })] });
  assert.equal((await handler(delivery(job({ action: 'in_progress', runner: own })))).statusCode, 200);
  assert.deepEqual([sent, described, tagged, logs], [[], [], [], []]);
});

test('in_progress on a runner that isn\'t the stack\'s is ignored', async () => {
  const others = [
    'GitHub Actions 2', 'other-stack-20261113120000-999', 'ci-runner-hand-20261113120000',
    'ci-runner-2026111312-999', undefined,
  ];
  for (const runner of others) {
    const { handler, sent, tagged } = setup({ instances: [instance({ 'ci-runner:runner': runner })] });
    assert.equal((await handler(delivery(job({ action: 'in_progress', runner })))).statusCode, 200, String(runner));
    assert.deepEqual([sent, tagged], [[], []], String(runner));
  }
  // The stack's name, but no instance of the stack carries it.
  const { handler, sent, tagged } = setup({ instances: [instance({ 'ci-runner:stack': 'other' })] });
  assert.equal((await handler(delivery(job({ action: 'in_progress', runner: RUNNER })))).statusCode, 200);
  assert.deepEqual([sent, tagged], [[], []]);
});

test('a repeated in_progress after the re-tag does nothing more', async () => {
  const { handler, sent, tagged } = setup({ instances: [instance({ 'ci-runner:job-id': '555' })] });
  assert.equal((await handler(delivery(job({ action: 'in_progress', runner: RUNNER })))).statusCode, 200);
  assert.deepEqual([sent, tagged], [[], []]);
});

test('a swap on an instance launched before the labels and shape tags re-queues a ci-cpu-4 x64 job with self-hosted and its capacity label', async () => {
  const old = instance();
  for (const k of ['labels', 'capacity', 'vcpus', 'arch']) delete old.Tags[`ci-runner:${k}`];
  const { handler, sent } = setup({ instances: [old] });
  await handler(delivery(job({ action: 'in_progress', runner: RUNNER })));
  assert.deepEqual([sent[0].labels, sent[0].vcpus, sent[0].arch], [['self-hosted', 'ci-spot'], 4, 'x64']);
});

test('in_progress from outside the fence is refused before any lookup', async () => {
  const { handler, sent, described } = setup({ instances: [instance()] });
  assert.equal((await handler(delivery(job({ action: 'in_progress', runner: RUNNER, visibility: 'public' })))).statusCode, 403);
  assert.deepEqual([sent, described], [[], []]);
});
