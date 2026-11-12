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

function fakeGitHub({ checkStatus = 201 } = {}) {
  const calls = [];
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
    throw new Error('unexpected ' + key);
  };
  return { fetch, calls, keys: () => calls.map((c) => c.key) };
}

// ec2.describe returns DescribeInstances' output as EC2 gives it.
function setup({ inst = instance(TAGS), raw = { Reservations: inst ? [{ Instances: [inst] }] : [] }, gh = fakeGitHub(), creds = { app_id: 42, private_key: PEM } } = {}) {
  const described = [];
  const logs = [];
  const handler = createHandler({
    secret: { get: async () => creds },
    fetch: gh.fetch,
    ec2: { describe: async (id) => { described.push(id); return raw; } },
    now: () => T0,
    env: ENV,
    log: (l) => logs.push(l),
  });
  return { handler, gh, described, logs };
}

test('an interruption of one of our instances creates a failed check run on the job\'s commit', async () => {
  const { handler, gh, described } = setup();
  await handler(EVENT);
  assert.deepEqual(described, ['i-0123']);
  assert.deepEqual(gh.keys(), ['GET /repos/zeroae/app/installation', 'POST /app/installations/181/access_tokens', 'POST /repos/zeroae/app/check-runs']);
  const { body } = gh.calls[2];
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

test('a job name falls back to the job id when the tag is empty', async () => {
  const { handler, gh } = setup({ inst: instance({ ...TAGS, 'ci-runner:job-name': '' }) });
  await handler(EVENT);
  assert.equal(gh.calls[2].body.name, 'ci-runner / job 555');
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

test('a GitHub failure fails the invocation, so EventBridge retries it', async () => {
  const { handler } = setup({ gh: fakeGitHub({ checkStatus: 422 }) });
  await assert.rejects(handler(EVENT), /check-runs.*422/);
});

test('before the App exists the invocation fails', async () => {
  const { handler } = setup({ creds: { state_key: 'x' } });
  await assert.rejects(handler(EVENT), /not set up/);
});
