'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createHandler } = require('../functions/notifier.js');

const T0 = Date.parse('2026-11-12T12:00:00Z');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });
const ENV = { GITHUB_ORG: 'zeroae', STACK_NAME: 'ci-runner' };

// The event EventBridge delivers for a Spot interruption warning.
const EVENT = {
  version: '0', id: 'e-1', 'detail-type': 'EC2 Spot Instance Interruption Warning', source: 'aws.ec2',
  account: '123456789012', time: '2026-11-12T12:00:00Z', region: 'us-east-1',
  resources: ['arn:aws:ec2:us-east-1:123456789012:instance/i-0123'],
  detail: { 'instance-id': 'i-0123', 'instance-action': 'terminate' },
};

// The tags the launcher puts on an instance, plus the launch template's.
const TAGS = {
  'ci-runner:stack': 'ci-runner', 'ci-runner:runner': 'ci-runner-20261112115500-555', 'ci-runner:runner-id': '77',
  'ci-runner:label': 'ci-spot', 'ci-runner:repo': 'zeroae/app', 'ci-runner:job-id': '555', 'ci-runner:run-id': '444',
  'ci-runner:head-sha': 'abc123', 'ci-runner:job-name': 'tests',
};
const instance = (tags) => ({ InstanceId: 'i-0123', Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) });

function verifyJwt(auth) {
  const [h, p, s] = auth.replace(/^Bearer /, '').split('.');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')), 'JWT signature');
  return JSON.parse(Buffer.from(p, 'base64url'));
}

// The job the tags name, as GitHub reports it when this machine's CI runner
// is running it.
const RUNNING = { name: 'build (x64, a)', status: 'in_progress', runner_name: 'ci-runner-20261112115500-555' };

// existing: the check runs already on the commit. jobs: what GitHub says of
// the job on each look, the last one repeating.
function fakeGitHub({ checkStatus = 201, jobStatus = 200, existing = [], jobs = [RUNNING] } = {}) {
  const calls = [];
  let looks = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, headers: init.headers, body });
    const res = (status, json) => ({ ok: status < 300, status, json: async () => json });
    if (key === 'GET /repos/zeroae/app/installation') {
      assert.equal(String(verifyJwt(init.headers.authorization).iss), '42');
      return res(200, { id: 181 });
    }
    if (key === 'POST /app/installations/181/access_tokens') {
      verifyJwt(init.headers.authorization);
      return res(201, { token: 'ghs_install', expires_at: new Date(T0 + 3600e3).toISOString() });
    }
    assert.equal(init.headers.authorization, 'Bearer ghs_install', key);
    if (key === 'POST /repos/zeroae/app/check-runs') return res(checkStatus, { id: 9 });
    if (key === 'GET /repos/zeroae/app/commits/abc123/check-runs') {
      const name = u.searchParams.get('check_name');
      return res(200, { check_runs: existing.filter((c) => c.name === name) });
    }
    if (key === 'PATCH /repos/zeroae/app/check-runs/9') return res(200, { id: 9 });
    if (key === 'GET /repos/zeroae/app/actions/jobs/555') {
      looks += 1;
      return res(jobStatus, { id: 555, ...jobs[Math.min(looks, jobs.length) - 1] });
    }
    throw new Error('unexpected ' + key);
  };
  return { fetch, calls, keys: () => calls.map((c) => c.key) };
}

// ec2.describe returns DescribeInstances' output as EC2 gives it.
// ecs.describeTasks returns DescribeTasks' output as ECS gives it.
function setup({ inst = instance(TAGS), raw = { Reservations: inst ? [{ Instances: [inst] }] : [] }, tasks = [], gh = fakeGitHub(), creds = { app_id: 42, private_key: PEM } } = {}) {
  const described = [];
  const logs = [];
  const slept = [];
  const handler = createHandler({
    secret: { get: async () => creds },
    fetch: gh.fetch,
    ec2: { describe: async (id) => { described.push(id); return raw; } },
    ecs: {
      describeTasks: async (i) => {
        described.push(i);
        return { tasks: tasks.filter((t) => i.tasks.includes(t.taskArn)), failures: [] };
      },
    },
    sleep: async (ms) => { slept.push(ms); },
    now: () => T0,
    env: ENV,
    log: (l) => logs.push(l),
  });
  return { handler, gh, described, logs, slept };
}

test('an interruption of one of our instances creates a failed check run on the job\'s commit', async () => {
  const { handler, gh, described } = setup({ gh: fakeGitHub({ jobs: [RUNNING, DONE('failure')] }) });
  await handler(EVENT);
  assert.deepEqual(described, ['i-0123']);
  assert.deepEqual(gh.keys(), [
    'GET /repos/zeroae/app/installation', 'POST /app/installations/181/access_tokens',
    'GET /repos/zeroae/app/actions/jobs/555', 'GET /repos/zeroae/app/commits/abc123/check-runs', 'POST /repos/zeroae/app/check-runs',
    'GET /repos/zeroae/app/actions/jobs/555', // the watch: the job failed too, so the check run stays
  ]);
  const { body } = gh.calls[4];
  const runUrl = 'https://github.com/zeroae/app/actions/runs/444';
  assert.equal(body.name, 'ci-runner / tests');
  assert.equal(body.head_sha, 'abc123');
  assert.equal(body.status, 'completed');
  assert.equal(body.conclusion, 'failure');
  assert.equal(body.completed_at, '2026-11-12T12:00:00.000Z');
  assert.equal(body.details_url, `${runUrl}/job/555`);
  assert.equal(body.external_id, '555');
  assert.equal(body.output.title, 'Spot capacity reclaimed: re-run this job');
  assert.match(body.output.summary, /`tests`/);
  assert.ok(body.output.summary.includes(runUrl), 'links the run');
  assert.match(body.output.summary, /i-0123/);
  for (const c of gh.calls) {
    assert.equal(c.headers['x-github-api-version'], '2022-11-28');
    assert.equal(c.headers['user-agent'], 'ci-runner');
  }
});

// A machine is reported only for the job its CI runner is running. The tags
// say which job it was launched for, or took in a swap (the webhook re-tags it).
for (const [why, job] of [
  ['an idle CI runner, whose launch job another CI runner took', { ...RUNNING, runner_name: 'ci-runner-20261112115400-777' }],
  ['a CI runner whose job is still queued', { ...RUNNING, status: 'queued', runner_name: null }],
  ['a CI runner whose job already completed', { ...RUNNING, status: 'completed', conclusion: 'success' }],
]) {
  test(`${why} is not reported`, async () => {
    const { handler, gh, logs } = setup({ gh: fakeGitHub({ jobs: [job] }) });
    await handler(EVENT);
    assert.ok(!gh.keys().includes('POST /repos/zeroae/app/check-runs'));
    assert.match(logs.join('\n'), /not running job 555/);
  });
}

test('a swapped CI runner is reported for the job it took, not the one it was launched for', async () => {
  // The webhook re-tagged the instance with job 555; its runner is still named for job 999.
  const runner = 'ci-runner-20261112115400-999';
  const inst = instance({ ...TAGS, 'ci-runner:runner': runner });
  const { handler, gh } = setup({ inst, gh: fakeGitHub({ jobs: [{ ...RUNNING, runner_name: runner }] }) });
  await handler(EVENT);
  const { body } = gh.calls.find((c) => c.key === 'POST /repos/zeroae/app/check-runs');
  assert.equal(body.external_id, '555');
  assert.equal(body.name, 'ci-runner / tests');
});

// AWS gives a 2-minute warning, and a job can finish inside it. The check run
// is posted at the warning, then the notifier watches the job.
const SURVIVED = 'The job finished despite the Spot reclaim warning';
const DONE = (conclusion) => ({ ...RUNNING, status: 'completed', conclusion });
const patchOf = (gh) => gh.calls.find((c) => c.key === 'PATCH /repos/zeroae/app/check-runs/9');

test('a job that finishes with success after the warning turns its check run neutral', async () => {
  const gh = fakeGitHub({ jobs: [RUNNING, RUNNING, DONE('success')] });
  const { handler, slept, logs } = setup({ gh });
  await handler(EVENT);
  const { body } = patchOf(gh);
  assert.equal(body.conclusion, 'neutral');
  assert.equal(body.output.title, SURVIVED);
  assert.match(body.output.summary, /`tests`/);
  assert.deepEqual(slept, [10000, 10000]);
  assert.match(logs.join('\n'), /survived i-0123: zeroae\/app job 555/);
});

for (const conclusion of ['failure', 'cancelled']) {
  test(`a job that completes with ${conclusion} after the warning keeps its failure`, async () => {
    const gh = fakeGitHub({ jobs: [RUNNING, DONE(conclusion)] });
    await setup({ gh }).handler(EVENT);
    assert.equal(patchOf(gh), undefined);
  });
}

test('a job still running when the watch ends keeps its failure', async () => {
  const gh = fakeGitHub({ jobs: [RUNNING] });
  const { handler, slept } = setup({ gh });
  await handler(EVENT);
  assert.equal(patchOf(gh), undefined);
  assert.equal(slept.length, 15);
  assert.equal(slept.reduce((a, b) => a + b), 150000);
});

test('a reclaim whose check run turned neutral is not reported again', async () => {
  const gh = fakeGitHub({ existing: [{ name: 'ci-runner / tests', external_id: '555', output: { title: SURVIVED } }] });
  const { handler } = setup({ gh });
  await handler(EVENT);
  assert.ok(!gh.keys().includes('POST /repos/zeroae/app/check-runs'));
});

test('a job name falls back to the job id when the tag is empty', async () => {
  const { handler, gh } = setup({ inst: instance({ ...TAGS, 'ci-runner:job-name': '' })});
  await handler(EVENT);
  assert.equal(gh.calls.find((c) => c.key === 'POST /repos/zeroae/app/check-runs').body.name, 'ci-runner / job 555');
});

for (const [why, inst] of [
  ['an instance without our tags', instance({ Name: 'something-else' })],
  ['another stack\'s instance', instance({ ...TAGS, 'ci-runner:stack': 'other' })],
  ['an instance launched by hand (no job tags)', instance({ 'ci-runner:stack': 'ci-runner', 'ci-runner:runner': 'x' })],
  ['an instance whose repo is outside the org', instance({ ...TAGS, 'ci-runner:repo': 'elsewhere/app' })],
  ['an instance EC2 no longer returns', null],
]) {
  test(`${why} is ignored`, async () => {
    const { handler, gh, logs } = setup({ inst });
    await handler(EVENT);
    assert.deepEqual(gh.keys(), []);
    assert.match(logs.join('\n'), /ignored/);
  });
}

for (const raw of [{}, { Reservations: [] }, { Reservations: [{}] }, { Reservations: [{ Instances: [] }] }]) {
  test(`an empty DescribeInstances result ${JSON.stringify(raw)} is treated as not ours`, async () => {
    const { handler, gh, logs } = setup({ raw });
    await handler(EVENT);
    assert.deepEqual(gh.keys(), []);
    assert.match(logs.join('\n'), /ignored/);
  });
}

test('an event with no instance id is ignored without describing anything', async () => {
  const { handler, gh, described } = setup();
  await handler({ detail: {} });
  assert.deepEqual(described, []);
  assert.deepEqual(gh.keys(), []);
});

test('a reclaim already reported on the commit is not reported again', async () => {
  const title = 'Spot capacity reclaimed: re-run this job';
  const gh = fakeGitHub({ existing: [
    { name: 'ci-runner / tests', external_id: '555', output: { title } },
  ] });
  const { handler, logs } = setup({ gh });
  await handler(EVENT);
  assert.ok(!gh.keys().includes('POST /repos/zeroae/app/check-runs'));
  assert.match(logs.join('\n'), /already reported i-0123/);
  // Another job's check, or a check of that name that isn't ours, doesn't count.
  for (const other of [{ name: 'ci-runner / tests', external_id: '554', output: { title } }, { name: 'ci-runner / tests', external_id: '555', output: { title: 'Lint' } }]) {
    const g = fakeGitHub({ existing: [other] });
    await setup({ gh: g }).handler(EVENT);
    assert.ok(g.keys().includes('POST /repos/zeroae/app/check-runs'), JSON.stringify(other));
  }
});

test('a GitHub failure fails the invocation, so EventBridge retries it', async () => {
  const { handler } = setup({ gh: fakeGitHub({ checkStatus: 422 }) });
  await assert.rejects(handler(EVENT), /check-runs.*422/);
});

test('before the App exists the invocation fails', async () => {
  const { handler } = setup({ creds: { state_key: 'x' } });
  await assert.rejects(handler(EVENT), /not set up/);
});

// --- Fargate Spot -------------------------------------------------------------
const CLUSTER_ARN = 'arn:aws:ecs:us-east-1:123456789012:cluster/ci-runner';
const TASK_ARN = 'arn:aws:ecs:us-east-1:123456789012:task/ci-runner/0f1e2d3c4b5a69788796a5b4c3d2e1f0';

// The first ECS Task State Change the rule matches: the reclaimed task, told
// to stop. The detail carries no tags. The shape is ECS's, as aws-emulator
// publishes it (see test/tasks-ecs.test.js).
const TASK_EVENT = {
  version: '0', id: 'e-2', 'detail-type': 'ECS Task State Change', source: 'aws.ecs',
  account: '123456789012', time: '2026-11-12T12:00:00Z', region: 'us-east-1', resources: [TASK_ARN],
  detail: {
    taskArn: TASK_ARN, clusterArn: CLUSTER_ARN, lastStatus: 'RUNNING', desiredStatus: 'STOPPED',
    capacityProviderName: 'FARGATE_SPOT', stopCode: 'SpotInterruption', stoppedReason: 'Your Spot Task was interrupted.',
  },
};

// A task's tags, as the launcher sets them: ECS refuses brackets and commas,
// so the job name's are `_` and the labels are space-joined.
const TASK_TAGS = {
  ...TAGS, 'ci-runner:label': 'ci-fargate-spot', 'ci-runner:job-name': 'build _x64_ a_',
  'ci-runner:labels': 'self-hosted ci-fargate-spot ci-cpu-4 x64',
};
const task = (tags) => ({ taskArn: TASK_ARN, lastStatus: 'RUNNING', tags: Object.entries(tags).map(([key, value]) => ({ key, value })) });

test('a Fargate Spot reclaim creates the same check run as an EC2 one, with the job\'s real name', async () => {
  const ec2 = setup({ inst: instance({ ...TAGS, 'ci-runner:job-name': 'build (x64, a)' }) });
  await ec2.handler(EVENT);
  const fargate = setup({ inst: null, tasks: [task(TASK_TAGS)] });
  await fargate.handler(TASK_EVENT);

  assert.deepEqual(fargate.described, [{ cluster: CLUSTER_ARN, tasks: [TASK_ARN], include: ['TAGS'] }]);
  const check = (s) => s.gh.calls.find((c) => c.key === 'POST /repos/zeroae/app/check-runs').body;
  const a = check(ec2);
  const b = check(fargate);
  assert.equal(b.name, 'ci-runner / build (x64, a)');
  assert.match(b.output.summary, /task \(0f1e2d3c4b5a69788796a5b4c3d2e1f0\)/);
  const machine = (c) => ({ ...c, output: { ...c.output, summary: c.output.summary.replace(/instance \(i-0123\)|task \(\w+\)/, '<machine>') } });
  assert.deepEqual(machine(b), machine(a));
  assert.match(fargate.logs.join('\n'), /reported 0f1e2d3c4b5a69788796a5b4c3d2e1f0: zeroae\/app job 555/);
});

test('a task\'s job name falls back to its tag when GitHub gives none', async () => {
  const { handler, gh } = setup({ inst: null, tasks: [task(TASK_TAGS)], gh: fakeGitHub({ jobs: [{ ...RUNNING, name: undefined }] }) });
  await handler(TASK_EVENT);
  assert.equal(gh.calls.find((c) => c.key === 'POST /repos/zeroae/app/check-runs').body.name, 'ci-runner / build _x64_ a_');
});

for (const [why, tasks] of [
  ['a task without job tags (run by hand)', [task({ 'ci-runner:stack': 'ci-runner', 'ci-runner:runner': 'ci-runner-hand-20261112115500' })]],
  ['another stack\'s task', [task({ ...TASK_TAGS, 'ci-runner:stack': 'other' })]],
  ['a task ECS no longer returns', []],
]) {
  test(`${why} is ignored`, async () => {
    const { handler, gh, logs } = setup({ inst: null, tasks });
    await handler(TASK_EVENT);
    assert.deepEqual(gh.keys(), []);
    assert.match(logs.join('\n'), /ignored/);
  });
}

// A task's runner is named for its launch job too, and the webhook re-tags a
// swapped task the same way, so the same rules hold.
const TASK_RUNNING = { ...RUNNING, name: 'build (x64, a)' };

for (const [why, job] of [
  ['an idle Fargate CI runner', { ...TASK_RUNNING, runner_name: 'ci-runner-20261112115400-777' }],
  ['a Fargate CI runner whose job is still queued', { ...TASK_RUNNING, status: 'queued', runner_name: null }],
  ['a Fargate CI runner whose job already completed', { ...TASK_RUNNING, status: 'completed', conclusion: 'success' }],
]) {
  test(`${why} is not reported`, async () => {
    const { handler, gh, logs } = setup({ inst: null, tasks: [task(TASK_TAGS)], gh: fakeGitHub({ jobs: [job] }) });
    await handler(TASK_EVENT);
    assert.ok(!gh.keys().includes('POST /repos/zeroae/app/check-runs'));
    assert.match(logs.join('\n'), /not running job 555/);
  });
}

test('a swapped Fargate CI runner is reported for the job it took', async () => {
  const runner = 'ci-runner-20261112115400-999';
  const tags = { ...TASK_TAGS, 'ci-runner:runner': runner };
  const { handler, gh } = setup({ inst: null, tasks: [task(tags)], gh: fakeGitHub({ jobs: [{ ...TASK_RUNNING, runner_name: runner }] }) });
  await handler(TASK_EVENT);
  assert.equal(gh.calls.find((c) => c.key === 'POST /repos/zeroae/app/check-runs').body.external_id, '555');
});

test('a Fargate job that finishes with success after the warning turns its check run neutral', async () => {
  const gh = fakeGitHub({ jobs: [TASK_RUNNING, { ...TASK_RUNNING, status: 'completed', conclusion: 'success' }] });
  await setup({ inst: null, tasks: [task(TASK_TAGS)], gh }).handler(TASK_EVENT);
  const { body } = patchOf(gh);
  assert.equal(body.conclusion, 'neutral');
  assert.match(body.output.summary, /task \(0f1e2d3c4b5a69788796a5b4c3d2e1f0\)/);
});
