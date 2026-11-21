'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createHandler } = require('../functions/webhook.js');

const SECRET = 'whsec-test';

function setup({ secretValue = { webhook_secret: SECRET } } = {}) {
  const sent = [];
  const notified = [];
  const logs = [];
  let reads = 0;
  const handler = createHandler({
    secret: { get: async () => { reads++; return secretValue; } },
    queue: { send: async (msg) => { sent.push(msg); } },
    notifier: { send: async (msg) => { notified.push(msg); } },
    env: { GITHUB_ORG: 'zeroae', STACK_NAME: 'ci-runner' },
    log: (line) => logs.push(JSON.parse(line)),
  });
  return { handler, sent, notified, logs, reads: () => reads };
}

// The job label of the payload's job: run 444, attempt 2, key tests, index 0.
const JOB_LABEL = 'ci-job-444-2-tests-0';

// A workflow_job payload as GitHub sends it (only the fields that matter).
// The job carries JOB_LABEL after `labels`, unless `labels` has a job label of
// its own or jobLabel is false.
function job({ action = 'queued', labels = ['self-hosted', 'ci-spot', 'ci-cpu-4', 'x64'], jobLabel = true, visibility = 'private', owner = 'zeroae', runner, conclusion } = {}) {
  const all = jobLabel && !labels.some((l) => /^ci-job-/i.test(l)) ? [...labels, JOB_LABEL] : labels;
  return {
    action,
    workflow_job: {
      id: 555, run_id: 444, run_attempt: 2, head_sha: 'abc123', name: 'tests', labels: all,
      ...(runner && { runner_name: runner, runner_id: 77 }),
      ...(conclusion && { conclusion }),
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
    label: 'ci-spot', vcpus: 4, arch: 'x64', labels: ['self-hosted', 'ci-spot', 'ci-cpu-4', 'x64', JOB_LABEL], installation_id: 181,
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
        { label: cap, vcpus, arch: 'x64', labels: [...labels, JOB_LABEL] },
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

// A runner the launcher started for job 999 of run 888.
const RUNNER = 'ci-runner-20261113120000-999';

// The notifier is told when a job of this stack's runners finishes with
// success, so it can clear a reclaim report for a job that survived the warning.
test('a job that completes with success on one of our runners is passed to the notifier', async () => {
  const { handler, notified, sent } = setup();
  const res = await handler(delivery(job({ action: 'completed', runner: RUNNER, conclusion: 'success' })));
  assert.equal(res.statusCode, 202);
  assert.deepEqual(notified, [{ jobSucceeded: { repo: 'zeroae/app', job_id: 555, run_id: 444, head_sha: 'abc123', job_name: 'tests', installation_id: 181 } }]);
  assert.equal(sent.length, 0);
});

for (const [why, opts] of [
  ['a job that failed', { runner: RUNNER, conclusion: 'failure' }],
  ['a job that was cancelled', { runner: RUNNER, conclusion: 'cancelled' }],
  ['a job on a GitHub-hosted runner', { runner: 'GitHub Actions 12', conclusion: 'success' }],
  ['a job on another stack\'s runner', { runner: 'other-20261113120000-999', conclusion: 'success' }],
  ['a job that never had a runner', { conclusion: 'success' }],
]) {
  test(`${why} is not passed to the notifier`, async () => {
    const { handler, notified } = setup();
    assert.equal((await handler(delivery(job({ action: 'completed', ...opts })))).statusCode, 200);
    assert.deepEqual(notified, []);
  });
}
// A runner of this stack is named `${stack}-<14-digit stamp>-<job id>`, for
// the job it was launched for. The job label means it takes no other job, so
// one that does is logged and left alone (ADR-0004).
test('a job in progress on a runner launched for another job is logged, and nothing is re-queued', async () => {
  const { handler, sent, logs } = setup();
  const res = await handler(delivery(job({ action: 'in_progress', runner: RUNNER })));
  assert.deepEqual([res.statusCode, res.body], [200, 'logged: runner of another job\n']);
  assert.deepEqual(sent, []);
  assert.deepEqual(logs, [{ anomaly: 'runner of another job', runner: RUNNER, launched_for: 999, took: { repo: 'zeroae/app', job_id: 555 } }]);
});

test('in_progress on a runner running its own job does nothing', async () => {
  const { handler, sent, logs } = setup();
  const res = await handler(delivery(job({ action: 'in_progress', runner: 'ci-runner-20261113120000-555' })));
  assert.deepEqual([res.statusCode, res.body, sent, logs], [200, 'ignored: no swap\n', [], []]);
});

test('in_progress on a runner that isn\'t the stack\'s is ignored', async () => {
  for (const runner of ['GitHub Actions 2', 'other-stack-20261113120000-999', 'ci-runner-hand-20261113120000', 'ci-runner-2026111312-999', undefined]) {
    const { handler, sent, logs } = setup();
    const res = await handler(delivery(job({ action: 'in_progress', runner })));
    assert.deepEqual([res.statusCode, res.body, sent, logs], [200, 'ignored: no swap\n', [], []], String(runner));
  }
});

test('in_progress from outside the fence is refused', async () => {
  const { handler, sent } = setup();
  assert.equal((await handler(delivery(job({ action: 'in_progress', runner: RUNNER, visibility: 'public' })))).statusCode, 403);
  assert.deepEqual(sent, []);
});

// The Fargate capacities (#29): Docker-free jobs, ADR-0001.
test('both Fargate capacities are enqueued with every size and architecture', async () => {
  for (const cap of ['ci-fargate-spot', 'ci-fargate']) {
    for (const [size, vcpus] of [['ci-cpu-2', 2], ['ci-cpu-4', 4], ['ci-cpu-8', 8], ['ci-cpu-16', 16]]) {
      for (const arch of ['x64', 'arm64']) {
        const labels = ['self-hosted', cap, size, arch];
        const { handler, sent } = setup();
        assert.equal((await handler(delivery(job({ labels })))).statusCode, 202, labels.join(','));
        assert.deepEqual(
          { label: sent[0].label, vcpus: sent[0].vcpus, arch: sent[0].arch, labels: sent[0].labels },
          { label: cap, vcpus, arch, labels: [...labels, JOB_LABEL] },
        );
      }
    }
  }
  const { handler, sent } = setup();
  await handler(delivery(job({ labels: ['Self-Hosted', 'CI-Fargate-Spot', 'ci-cpu-4', 'ARM64', 'Linux'] })));
  assert.equal(sent[0].label, 'ci-fargate-spot');
});

test('a Fargate job follows the same contract: no default size or architecture, one capacity', async () => {
  for (const labels of [
    ['self-hosted', 'ci-fargate-spot'],
    ['self-hosted', 'ci-fargate', 'x64'],
    ['self-hosted', 'ci-fargate-spot', 'ci-cpu-4'],
    ['self-hosted', 'ci-fargate', 'ci-cpu-4', 'ci-cpu-8', 'x64'],
    ['self-hosted', 'ci-fargate-spot', 'ci-cpu-4', 'x64', 'arm64'],
    ['self-hosted', 'ci-fargate', 'ci-fargate-spot', 'ci-cpu-4', 'x64'],
    ['self-hosted', 'ci-fargate-spot', 'ci-spot', 'ci-cpu-4', 'x64'],
    ['self-hosted', 'ci-fargate', 'ci-ondemand', 'ci-cpu-4', 'x64'],
  ]) {
    const { handler, sent } = setup();
    assert.equal((await handler(delivery(job({ labels })))).statusCode, 200, labels.join(','));
    assert.equal(sent.length, 0);
  }
});

// The job label: ci-job-<run_id>-<run_attempt>-<job key>-<matrix index>, here
// for run 444, attempt 2 (the payload's).
const SHAPE = ['self-hosted', 'ci-spot', 'ci-cpu-4', 'x64'];

test('a queued job with the job label of its own run and attempt is enqueued with the label', async () => {
  const labels = [...SHAPE, 'ci-job-444-2-tests-0'];
  const { handler, sent, logs } = setup();
  assert.equal((await handler(delivery(job({ labels })))).statusCode, 202);
  assert.deepEqual(sent.map((m) => [m.label, m.vcpus, m.arch, m.labels]), [['ci-spot', 4, 'x64', labels]]);
  assert.equal(logs[0].enqueued, 'zeroae/app');
});

for (const [label, why, what] of [
  ['ci-job-443-2-tests-0', 'job label of another run', 'names another run'],
  ['ci-job-444-1-tests-0', 'job label of another attempt', 'names another attempt'],
  ['ci-job-444-tests-0', 'job label without its run and attempt', 'leaves out the attempt'],
  ['ci-job-444-2', 'job label without its run and attempt', 'stops at the attempt'],
  [`ci-job-444-2-${'k'.repeat(243)}`, 'job label over 255 characters', 'is 256 characters long'],
]) {
  test(`a job whose job label ${what} is ignored, and the log says why`, async () => {
    const { handler, sent, logs } = setup();
    const res = await handler(delivery(job({ labels: [...SHAPE, label] })));
    assert.deepEqual([res.statusCode, res.body], [200, 'ignored: job label\n']);
    assert.equal(sent.length, 0);
    assert.deepEqual(logs, [{ ignored: 'zeroae/app', job_id: 555, label, why }]);
  });
}

test('a job with two job labels is ignored, and the log says why', async () => {
  const { handler, sent, logs } = setup();
  const res = await handler(delivery(job({ labels: [...SHAPE, 'ci-job-444-2-tests-0', 'ci-job-444-2-lint-0'] })));
  assert.deepEqual([res.statusCode, res.body, sent.length], [200, 'ignored: job label\n', 0]);
  assert.deepEqual(logs, [{ ignored: 'zeroae/app', job_id: 555, label: 'ci-job-444-2-tests-0,ci-job-444-2-lint-0', why: 'two job labels' }]);
});

test('a job label with nothing after its run and attempt is ignored, and the log says why', async () => {
  const { handler, sent, logs } = setup();
  const res = await handler(delivery(job({ labels: [...SHAPE, 'ci-job-444-2-'] })));
  assert.deepEqual([res.statusCode, res.body, sent.length], [200, 'ignored: job label\n', 0]);
  assert.deepEqual(logs, [{ ignored: 'zeroae/app', job_id: 555, label: 'ci-job-444-2-', why: 'job label names no job' }]);
});

test('the job label is read case-insensitively', async () => {
  const labels = [...SHAPE, 'CI-Job-444-2-Tests-0'];
  const { handler, sent } = setup();
  assert.equal((await handler(delivery(job({ labels })))).statusCode, 202);
  assert.deepEqual(sent[0].labels, labels);
});

test('a job label just under GitHub\'s 255-character limit is accepted', async () => {
  const labels = [...SHAPE, `ci-job-444-2-${'k'.repeat(242)}`];
  const { handler, sent } = setup();
  assert.equal((await handler(delivery(job({ labels })))).statusCode, 202);
  assert.deepEqual(sent[0].labels, labels);
});

test('a job outside the label contract is ignored without a log line, whatever its job label', async () => {
  const { handler, sent, logs } = setup();
  const res = await handler(delivery(job({ labels: ['ubuntu-latest', 'ci-job-1-1-tests-0'] })));
  assert.deepEqual([res.statusCode, res.body, sent.length, logs.length], [200, 'ignored: labels\n', 0, 0]);
});

test('a queued job without a job label is ignored, and the log says why', async () => {
  const { handler, sent, logs } = setup();
  const res = await handler(delivery(job({ labels: SHAPE, jobLabel: false })));
  assert.deepEqual([res.statusCode, res.body, sent.length], [200, 'ignored: labels\n', 0]);
  assert.deepEqual(logs, [{ ignored: 'zeroae/app', job_id: 555, why: 'no job label' }]);
});
