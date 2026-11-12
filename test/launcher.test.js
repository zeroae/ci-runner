'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createHandler } = require('../functions/launcher.js');

const T0 = Date.parse('2026-11-12T12:00:00Z');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });
const ENV = {
  GITHUB_ORG: 'zeroae', RUNNER_GROUP: 'ci-runner', STACK_NAME: 'ci-runner',
  LAUNCH_TEMPLATE_ID: 'lt-0abc', SUBNET_IDS: 'subnet-a,subnet-b,subnet-c',
};
const JIT = 'ZW5jb2RlZGppdA==';

const MSG = {
  repo: 'zeroae/app', job_id: 555, run_id: 444, head_sha: 'abc123', job_name: 'tests',
  label: 'ci-spot', labels: ['self-hosted', 'ci-spot'], installation_id: 181,
};

function verifyJwt(auth) {
  const [h, p, s] = auth.replace(/^Bearer /, '').split('.');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')), 'JWT signature');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  return JSON.parse(Buffer.from(p, 'base64url'));
}

// A fake GitHub: routes keyed "METHOD path". Records every call.
function fakeGitHub({ jobStatus = 'queued', jit = { status: 201 }, groups = [{ id: 1, name: 'Default' }, { id: 3, name: 'ci-runner' }] } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, headers: init.headers, body, search: u.search });
    const res = (status, json) => ({ ok: status < 300, status, json: async () => json, text: async () => JSON.stringify(json) });
    if (key === 'POST /app/installations/181/access_tokens') {
      const claims = verifyJwt(init.headers.authorization);
      assert.equal(String(claims.iss), '42');
      return res(201, { token: 'ghs_install', expires_at: new Date(T0 + 3600e3).toISOString() });
    }
    assert.equal(init.headers.authorization, 'Bearer ghs_install', key);
    if (key === 'GET /repos/zeroae/app/actions/jobs/555') return res(200, { id: 555, status: jobStatus });
    if (key === 'GET /orgs/zeroae/actions/runner-groups') return res(200, { total_count: groups.length, runner_groups: groups });
    if (key === 'POST /orgs/zeroae/actions/runners/generate-jitconfig') {
      return jit.status === 201 ? res(201, { runner: { id: 77, name: body.name }, encoded_jit_config: JIT }) : res(jit.status, { message: 'nope' });
    }
    if (key === 'DELETE /orgs/zeroae/actions/runners/77') return res(204, null);
    throw new Error('unexpected ' + key);
  };
  return { fetch, calls, keys: () => calls.map((c) => c.key) };
}

function fakeEc2({ fleet = { Instances: [{ InstanceIds: ['i-0123'] }], Errors: [] } } = {}) {
  const calls = [];
  return {
    calls,
    createLaunchTemplateVersion: async (input) => { calls.push(['createVersion', input]); return { LaunchTemplateVersion: { VersionNumber: 9 } }; },
    createFleet: async (input) => { calls.push(['createFleet', input]); return fleet; },
    deleteLaunchTemplateVersions: async (input) => { calls.push(['deleteVersions', input]); return {}; },
  };
}

function setup({ gh = fakeGitHub(), ec2 = fakeEc2(), env = ENV } = {}) {
  const logs = [];
  const handler = createHandler({
    secret: { get: async () => ({ app_id: 42, private_key: PEM, webhook_secret: 'w' }) },
    fetch: gh.fetch, ec2, now: () => T0, env, log: (l) => logs.push(l),
  });
  return { handler, gh, ec2, logs };
}

const sqsEvent = (...msgs) => ({ Records: msgs.map((m, i) => ({ messageId: `m${i}`, body: JSON.stringify(m) })) });
const tags = (fleetInput) => Object.fromEntries(fleetInput.TagSpecifications.find((t) => t.ResourceType === 'instance').Tags.map((t) => [t.Key, t.Value]));

test('a job that is no longer queued is dropped: no JIT config, no instance', async () => {
  for (const jobStatus of ['in_progress', 'completed', 'waiting']) {
    const { handler, gh, ec2 } = setup({ gh: fakeGitHub({ jobStatus }) });
    const res = await handler(sqsEvent(MSG));
    assert.deepEqual(res, { batchItemFailures: [] }, 'the message is consumed');
    assert.deepEqual(gh.keys(), ['POST /app/installations/181/access_tokens', 'GET /repos/zeroae/app/actions/jobs/555']);
    assert.equal(ec2.calls.length, 0);
  }
});

test('a queued job mints a JIT config in the ci-runner group with its labels', async () => {
  const { handler, gh } = setup();
  await handler(sqsEvent(MSG));
  const mint = gh.calls.find((c) => c.key === 'POST /orgs/zeroae/actions/runners/generate-jitconfig');
  assert.deepEqual(mint.body, { name: 'ci-runner-555', runner_group_id: 3, labels: ['self-hosted', 'ci-spot'], work_folder: '_work' });
});

test('a queued job launches one Spot instance from the launch template, tagged with the job', async () => {
  const { handler, ec2, logs } = setup();
  assert.deepEqual(await handler(sqsEvent(MSG)), { batchItemFailures: [] });
  assert.deepEqual(ec2.calls.map((c) => c[0]), ['createVersion', 'createFleet', 'deleteVersions']);

  const [, version] = ec2.calls[0];
  assert.equal(version.LaunchTemplateId, 'lt-0abc');
  assert.equal(version.SourceVersion, '$Default');
  const userData = Buffer.from(version.LaunchTemplateData.UserData, 'base64').toString();
  assert.match(userData, /^#cloud-config\n/);
  assert.ok(userData.includes(`content: ${JIT}\n`), 'the JIT config is in the user-data');
  assert.deepEqual(Object.keys(version.LaunchTemplateData), ['UserData']);

  const [, fleet] = ec2.calls[1];
  assert.equal(fleet.Type, 'instant');
  assert.deepEqual(fleet.TargetCapacitySpecification, { TotalTargetCapacity: 1, DefaultTargetCapacityType: 'spot' });
  assert.deepEqual(fleet.SpotOptions, { AllocationStrategy: 'capacity-optimized' });
  const cfg = fleet.LaunchTemplateConfigs[0];
  assert.deepEqual(cfg.LaunchTemplateSpecification, { LaunchTemplateId: 'lt-0abc', Version: '9' });
  assert.equal(cfg.Overrides.length, 12);
  assert.deepEqual(new Set(cfg.Overrides.map((o) => o.InstanceType)), new Set(['m7i.xlarge', 'm6i.xlarge', 'm6a.xlarge', 'm7a.xlarge']));
  assert.deepEqual(new Set(cfg.Overrides.map((o) => o.SubnetId)), new Set(['subnet-a', 'subnet-b', 'subnet-c']));
  assert.deepEqual(tags(fleet), {
    'ci-runner:runner': 'ci-runner-555', 'ci-runner:label': 'ci-spot', 'ci-runner:repo': 'zeroae/app',
    'ci-runner:job-id': '555', 'ci-runner:run-id': '444', 'ci-runner:head-sha': 'abc123', 'ci-runner:job-name': 'tests',
  });

  assert.deepEqual(ec2.calls[2][1], { LaunchTemplateId: 'lt-0abc', Versions: ['9'] });
  assert.ok(logs.some((l) => /i-0123/.test(l)), 'the instance id is logged');
  assert.ok(!logs.some((l) => l.includes(JIT) || l.includes('ghs_install')), 'no secrets in the logs');
});

test('a ci-ondemand job launches On-Demand capacity', async () => {
  const { handler, ec2 } = setup();
  await handler(sqsEvent({ ...MSG, label: 'ci-ondemand', labels: ['self-hosted', 'ci-ondemand'] }));
  const fleet = ec2.calls.find((c) => c[0] === 'createFleet')[1];
  assert.equal(fleet.TargetCapacitySpecification.DefaultTargetCapacityType, 'on-demand');
  assert.equal(fleet.SpotOptions, undefined);
});

test('the group id and the installation token are cached across messages', async () => {
  const { handler, gh } = setup();
  await handler(sqsEvent(MSG, MSG));
  assert.equal(gh.keys().filter((k) => k.endsWith('/runner-groups')).length, 1);
  assert.equal(gh.keys().filter((k) => k.endsWith('/access_tokens')).length, 1);
});

test('a runner already minted for the job (a duplicate delivery) is dropped without a launch', async () => {
  const { handler, ec2 } = setup({ gh: fakeGitHub({ jit: { status: 409 } }) });
  assert.deepEqual(await handler(sqsEvent(MSG)), { batchItemFailures: [] });
  assert.equal(ec2.calls.length, 0);
});

test('a failed launch removes the registration, deletes the version, and retries the message', async () => {
  const ec2 = fakeEc2({ fleet: { Instances: [], Errors: [{ ErrorCode: 'InsufficientInstanceCapacity', ErrorMessage: 'none' }] } });
  const { handler, gh, logs } = setup({ ec2 });
  assert.deepEqual(await handler(sqsEvent(MSG)), { batchItemFailures: [{ itemIdentifier: 'm0' }] });
  assert.ok(gh.keys().includes('DELETE /orgs/zeroae/actions/runners/77'));
  assert.equal(ec2.calls.at(-1)[0], 'deleteVersions');
  assert.ok(logs.some((l) => /InsufficientInstanceCapacity/.test(l)));
});

test('a missing runner group fails the message so it is retried', async () => {
  const { handler, ec2 } = setup({ gh: fakeGitHub({ groups: [{ id: 1, name: 'Default' }] }) });
  assert.deepEqual(await handler(sqsEvent(MSG)), { batchItemFailures: [{ itemIdentifier: 'm0' }] });
  assert.equal(ec2.calls.length, 0);
});

test('a malformed message is dropped, not retried', async () => {
  const { handler, gh } = setup();
  const res = await handler({ Records: [{ messageId: 'x', body: 'not json' }, { messageId: 'y', body: '{"repo":"zeroae/app"}' }] });
  assert.deepEqual(res, { batchItemFailures: [] });
  assert.equal(gh.calls.length, 0);
});
