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
  LAUNCH_TEMPLATE_ID: 'lt-0abc', ARM64_LAUNCH_TEMPLATE_ID: 'lt-0arm', SUBNET_IDS: 'subnet-a,subnet-b,subnet-c',
  QUEUE_URL: 'https://sqs.example/jobs', SPOT_VCPU_CAP: '24', ONDEMAND_VCPU_CAP: '8',
  CLUSTER: 'ci-runner', TASK_DEFINITION: 'arn:aws:ecs:us-east-1:1:task-definition/ci-runner-runner:3',
  ARM64_TASK_DEFINITION: 'arn:aws:ecs:us-east-1:1:task-definition/ci-runner-runner-arm64:3',
  SECURITY_GROUP_ID: 'sg-0run', SUBNET_AZ_IDS: 'use1-az1,use1-az2,use1-az4',
  FARGATE_SPOT_VCPU_CAP: '24', FARGATE_VCPU_CAP: '8',
};
const JIT = 'ZW5jb2RlZGppdA==';

const MSG = {
  repo: 'zeroae/app', job_id: 555, run_id: 444, head_sha: 'abc123', job_name: 'tests',
  label: 'ci-spot', vcpus: 4, arch: 'x64', labels: ['self-hosted', 'ci-spot'], installation_id: 181,
};

function verifyJwt(auth) {
  const [h, p, s] = auth.replace(/^Bearer /, '').split('.');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')), 'JWT signature');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  return JSON.parse(Buffer.from(p, 'base64url'));
}

// A fake GitHub: routes keyed "METHOD path". Records every call.
function fakeGitHub({ jobStatus = 'queued', jobHttp = 200, jit = { status: 201 }, groups = [{ id: 1, name: 'Default' }, { id: 3, name: 'ci-runner' }] } = {}) {
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
    if (key === 'GET /repos/zeroae/app/actions/jobs/555') return res(jobHttp, jobHttp === 200 ? { id: 555, status: jobStatus } : { message: 'x' });
    if (key === 'GET /orgs/zeroae/actions/runner-groups') return res(200, { total_count: groups.length, runner_groups: groups });
    if (key === 'POST /orgs/zeroae/actions/runners/generate-jitconfig') {
      return jit.status === 201 ? res(201, { runner: { id: 77, name: body.name }, encoded_jit_config: JIT }) : res(jit.status, { message: 'nope' });
    }
    if (key === 'DELETE /orgs/zeroae/actions/runners/77') return res(204, null);
    throw new Error('unexpected ' + key);
  };
  return { fetch, calls, keys: () => calls.map((c) => c.key) };
}

// `running` lists the stack's instances: { lifecycle: 'spot' | undefined, state,
// and the shape tags capacity, vcpus, arch, each left off when undefined }.
function fakeEc2({ fleet = { Instances: [{ InstanceIds: ['i-0123'] }], Errors: [] }, running = [] } = {}) {
  const calls = [];
  return {
    calls,
    describeInstances: async (input) => {
      calls.push(['describe', input]);
      const all = running.map((r, i) => ({ InstanceId: `i-r${i}`, State: { Name: r.state || 'running' }, ...(r.lifecycle ? { InstanceLifecycle: r.lifecycle } : {}),
        Tags: [['ci-runner:stack', 'ci-runner'], ['ci-runner:capacity', r.capacity], ['ci-runner:vcpus', r.vcpus], ['ci-runner:arch', r.arch]]
          .filter(([, v]) => v !== undefined).map(([Key, Value]) => ({ Key, Value: String(Value) })) }));
      // Two pages, to check NextToken is followed.
      if (!input.NextToken) return { Reservations: [{ Instances: all.slice(0, 1) }], NextToken: all.length > 1 ? 'p2' : undefined };
      return { Reservations: [{ Instances: all.slice(1) }] };
    },
    createLaunchTemplateVersion: async (input) => { calls.push(['createVersion', input]); return { LaunchTemplateVersion: { VersionNumber: 9 } }; },
    createFleet: async (input) => { calls.push(['createFleet', input]); return fleet; },
    deleteLaunchTemplateVersions: async (input) => { calls.push(['deleteVersions', input]); return {}; },
  };
}

// `tasks` lists the cluster's tasks, as { capacity, vcpus, desired, last } with
// the launcher's shape tags (left off when undefined). `run` is RunTask's
// answer; by default one task.
function fakeEcs({ tasks = [], run } = {}) {
  const calls = [];
  const all = tasks.map((t, i) => ({
    taskArn: `arn:aws:ecs:us-east-1:1:task/ci-runner/t${i}`, desiredStatus: t.desired || 'RUNNING', lastStatus: t.last || 'RUNNING',
    tags: [['ci-runner:stack', 'ci-runner'], ['ci-runner:capacity', t.capacity], ['ci-runner:vcpus', t.vcpus]]
      .filter(([, v]) => v !== undefined).map(([key, value]) => ({ key, value: String(value) })),
  }));
  return {
    calls,
    runTask: async (input) => {
      calls.push(['runTask', input]);
      if (run instanceof Error) throw run;
      return run || { tasks: [{ taskArn: 'arn:aws:ecs:us-east-1:1:task/ci-runner/new1', lastStatus: 'PROVISIONING' }], failures: [] };
    },
    // Pages of one, to check nextToken is followed.
    listTasks: async (input) => {
      calls.push(['listTasks', input]);
      const want = all.filter((t) => t.desiredStatus === (input.desiredStatus || 'RUNNING'));
      const i = input.nextToken ? Number(input.nextToken) : 0;
      return { taskArns: want.slice(i, i + 1).map((t) => t.taskArn), ...(i + 1 < want.length ? { nextToken: String(i + 1) } : {}) };
    },
    describeTasks: async (input) => {
      calls.push(['describeTasks', input]);
      const described = all.filter((t) => input.tasks.includes(t.taskArn))
        .map((t) => (input.include || []).includes('TAGS') ? t : { ...t, tags: undefined });
      return { tasks: described, failures: [] };
    },
  };
}

function setup({ gh = fakeGitHub(), ec2 = fakeEc2(), ecs = fakeEcs(), env = ENV } = {}) {
  const logs = [];
  const sent = [];
  const sqs = { sendMessage: async (input) => { sent.push(input); return {}; } };
  const handler = createHandler({
    secret: { get: async () => ({ app_id: 42, private_key: PEM, webhook_secret: 'w' }) },
    fetch: gh.fetch, ec2, ecs, sqs, now: () => T0, env, log: (l) => logs.push(l),
  });
  return { handler, gh, ec2, ecs, sqs: sent, logs };
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

test('a job GitHub no longer has (404) is dropped; any other failure retries the message', async () => {
  const gone = setup({ gh: fakeGitHub({ jobHttp: 404 }) });
  assert.deepEqual(await gone.handler(sqsEvent(MSG)), { batchItemFailures: [] });
  assert.match(gone.logs.join('\n'), /job not found/);
  const down = setup({ gh: fakeGitHub({ jobHttp: 502 }) });
  assert.deepEqual(await down.handler(sqsEvent(MSG)), { batchItemFailures: [{ itemIdentifier: 'm0' }] });
  assert.match(down.logs.join('\n'), /GET \/repos\/zeroae\/app\/actions\/jobs\/555: 502/);
  for (const { ec2 } of [gone, down]) assert.equal(ec2.calls.length, 0);
});

test('a queued job mints a JIT config in the ci-runner group with its labels', async () => {
  const { handler, gh } = setup();
  await handler(sqsEvent(MSG));
  const mint = gh.calls.find((c) => c.key === 'POST /orgs/zeroae/actions/runners/generate-jitconfig');
  assert.deepEqual(mint.body, { name: 'ci-runner-20261112120000-555', runner_group_id: 3, labels: ['self-hosted', 'ci-spot'], work_folder: '_work' });
});

test('a queued job launches one Spot instance from the launch template, tagged with the job', async () => {
  const { handler, ec2, logs } = setup();
  assert.deepEqual(await handler(sqsEvent(MSG)), { batchItemFailures: [] });
  assert.deepEqual(ec2.calls.map((c) => c[0]), ['describe', 'createVersion', 'createFleet', 'deleteVersions']);

  const [, version] = ec2.calls[1];
  assert.equal(version.LaunchTemplateId, 'lt-0abc');
  assert.equal(version.SourceVersion, '$Default');
  const userData = Buffer.from(version.LaunchTemplateData.UserData, 'base64').toString();
  assert.match(userData, /^#cloud-config\n/);
  assert.ok(userData.includes(`content: ${JIT}\n`), 'the JIT config is in the user-data');
  assert.deepEqual(Object.keys(version.LaunchTemplateData), ['UserData']);

  const [, fleet] = ec2.calls[2];
  assert.equal(fleet.Type, 'instant');
  assert.deepEqual(fleet.TargetCapacitySpecification, { TotalTargetCapacity: 1, DefaultTargetCapacityType: 'spot' });
  assert.deepEqual(fleet.SpotOptions, { AllocationStrategy: 'capacity-optimized' });
  const cfg = fleet.LaunchTemplateConfigs[0];
  assert.deepEqual(cfg.LaunchTemplateSpecification, { LaunchTemplateId: 'lt-0abc', Version: '9' });
  assert.equal(cfg.Overrides.length, 18);
  assert.deepEqual(new Set(cfg.Overrides.map((o) => o.InstanceType)), new Set(['m8i.xlarge', 'm8a.xlarge', 'm7i.xlarge', 'm6i.xlarge', 'm6a.xlarge', 'm7a.xlarge']));
  assert.deepEqual(new Set(cfg.Overrides.map((o) => o.SubnetId)), new Set(['subnet-a', 'subnet-b', 'subnet-c']));
  assert.deepEqual(tags(fleet), {
    'ci-runner:runner': 'ci-runner-20261112120000-555', 'ci-runner:runner-id': '77', 'ci-runner:label': 'ci-spot', 'ci-runner:repo': 'zeroae/app',
    'ci-runner:job-id': '555', 'ci-runner:run-id': '444', 'ci-runner:head-sha': 'abc123', 'ci-runner:job-name': 'tests',
    'ci-runner:labels': 'self-hosted,ci-spot',
    'ci-runner:capacity': 'ci-spot', 'ci-runner:vcpus': '4', 'ci-runner:arch': 'x64',
  });

  assert.deepEqual(ec2.calls[3][1], { LaunchTemplateId: 'lt-0abc', Versions: ['9'] });
  assert.ok(logs.some((l) => /i-0123/.test(l)), 'the instance id is logged');
  assert.ok(!logs.some((l) => l.includes(JIT) || l.includes('ghs_install')), 'no secrets in the logs');
});

test('each size launches its instance size across the four x64 families in the three subnets', async () => {
  const sizes = { 2: 'large', 4: 'xlarge', 8: '2xlarge', 16: '4xlarge' };
  for (const [vcpus, size] of Object.entries(sizes)) {
    const { handler, ec2 } = setup();
    await handler(sqsEvent({ ...MSG, vcpus: Number(vcpus), labels: ['self-hosted', 'ci-spot', `ci-cpu-${vcpus}`, 'x64'] }));
    const fleet = ec2.calls.find((c) => c[0] === 'createFleet')[1];
    const overrides = fleet.LaunchTemplateConfigs[0].Overrides;
    const want = ['m8i', 'm8a', 'm7i', 'm6i', 'm6a', 'm7a'].flatMap((f) => ['subnet-a', 'subnet-b', 'subnet-c'].map((s) => `${f}.${size} ${s}`));
    assert.deepEqual(overrides.map((o) => `${o.InstanceType} ${o.SubnetId}`).sort(), want.sort(), `ci-cpu-${vcpus}`);
    assert.deepEqual(
      [tags(fleet)['ci-runner:capacity'], tags(fleet)['ci-runner:vcpus'], tags(fleet)['ci-runner:arch']],
      ['ci-spot', vcpus, 'x64'],
    );
  }
});

test('an arm64 job launches from the arm64 launch template, across the three Graviton families at its size', async () => {
  const sizes = { 2: 'large', 4: 'xlarge', 8: '2xlarge', 16: '4xlarge' };
  for (const label of ['ci-spot', 'ci-ondemand']) {
    for (const [vcpus, size] of Object.entries(sizes)) {
      // Budgets wide enough for a 16-vCPU On-Demand job.
      const { handler, ec2, logs } = setup({ env: { ...ENV, SPOT_VCPU_CAP: '64', ONDEMAND_VCPU_CAP: '64' } });
      const m = { ...MSG, label, vcpus: Number(vcpus), arch: 'arm64', labels: ['self-hosted', label, `ci-cpu-${vcpus}`, 'arm64'] };
      assert.deepEqual(await handler(sqsEvent(m)), { batchItemFailures: [] });
      const [version, fleet, deleted] = ['createVersion', 'createFleet', 'deleteVersions'].map((k) => ec2.calls.find((c) => c[0] === k)[1]);
      assert.equal(version.LaunchTemplateId, 'lt-0arm');
      assert.deepEqual(fleet.LaunchTemplateConfigs[0].LaunchTemplateSpecification, { LaunchTemplateId: 'lt-0arm', Version: '9' });
      assert.deepEqual(deleted, { LaunchTemplateId: 'lt-0arm', Versions: ['9'] });
      const want = ['m7g', 'm6g', 'm8g'].flatMap((f) => ['subnet-a', 'subnet-b', 'subnet-c'].map((s) => `${f}.${size} ${s}`));
      const overrides = fleet.LaunchTemplateConfigs[0].Overrides;
      assert.deepEqual(overrides.map((o) => `${o.InstanceType} ${o.SubnetId}`).sort(), want.sort(), `${label} ci-cpu-${vcpus}`);
      assert.equal(tags(fleet)['ci-runner:arch'], 'arm64');
      assert.equal(JSON.parse(logs.find((l) => l.includes('"launched"'))).arch, 'arm64');
    }
  }
});

test('an x64 job never touches the arm64 launch template', async () => {
  const { handler, ec2 } = setup();
  await handler(sqsEvent(MSG));
  assert.ok(!JSON.stringify(ec2.calls).includes('lt-0arm'));
});

test('an On-Demand job is tagged with its capacity', async () => {
  const { handler, ec2 } = setup();
  await handler(sqsEvent({ ...MSG, label: 'ci-ondemand', vcpus: 8, labels: ['self-hosted', 'ci-ondemand', 'ci-cpu-8'] }));
  const t = tags(ec2.calls.find((c) => c[0] === 'createFleet')[1]);
  assert.deepEqual([t['ci-runner:capacity'], t['ci-runner:vcpus'], t['ci-runner:arch']], ['ci-ondemand', '8', 'x64']);
});

test('a message from before the size labels (no vcpus, no arch) launches a 4-vCPU x64 .xlarge', async () => {
  const { vcpus, arch, ...old } = MSG;
  const { handler, ec2 } = setup();
  assert.deepEqual(await handler(sqsEvent(old)), { batchItemFailures: [] });
  const fleet = ec2.calls.find((c) => c[0] === 'createFleet')[1];
  assert.deepEqual(new Set(fleet.LaunchTemplateConfigs[0].Overrides.map((o) => o.InstanceType)), new Set(['m8i.xlarge', 'm8a.xlarge', 'm7i.xlarge', 'm6i.xlarge', 'm6a.xlarge', 'm7a.xlarge']));
  assert.equal(tags(fleet)['ci-runner:vcpus'], '4');
  assert.equal(tags(fleet)['ci-runner:arch'], 'x64');
});

test('a message with an unknown size or architecture is dropped as malformed', async () => {
  for (const bad of [{ vcpus: 3 }, { vcpus: 32 }, { vcpus: '8' }, { arch: 'X64' }, { arch: 'ARM64' }, { arch: 'aarch64' }]) {
    const { handler, gh, logs } = setup();
    assert.deepEqual(await handler(sqsEvent({ ...MSG, ...bad })), { batchItemFailures: [] }, JSON.stringify(bad));
    assert.equal(gh.calls.length, 0, JSON.stringify(bad));
    assert.match(logs.join('\n'), /malformed/);
  }
});

test('the launch is logged with the job\'s shape', async () => {
  const { handler, logs } = setup();
  await handler(sqsEvent({ ...MSG, vcpus: 8 }));
  const line = JSON.parse(logs.find((l) => l.includes('"launched"')));
  assert.deepEqual([line.label, line.vcpus, line.arch], ['ci-spot', 8, 'x64']);
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
  assert.deepEqual(ec2.calls.map((c) => c[0]), ['describe'], 'nothing launched');
});

test('a malformed message is dropped, not retried', async () => {
  const { handler, gh } = setup();
  const res = await handler({ Records: [{ messageId: 'x', body: 'not json' }, { messageId: 'y', body: '{"repo":"zeroae/app"}' }] });
  assert.deepEqual(res, { batchItemFailures: [] });
  assert.equal(gh.calls.length, 0);
});

// Live instances as the launcher tags them since #22, and one from before
// (no shape tags: 4 vCPUs, its capacity from InstanceLifecycle).
const spot = (vcpus, arch = 'x64') => ({ lifecycle: 'spot', capacity: 'ci-spot', vcpus, arch });
const od = (vcpus, arch = 'x64') => ({ capacity: 'ci-ondemand', vcpus, arch });
const OLD_SPOT = { lifecycle: 'spot' };
const OLD_OD = {};
const OD_MSG = { ...MSG, label: 'ci-ondemand', labels: ['self-hosted', 'ci-ondemand'] };
const launched = (ec2) => ec2.calls.some((c) => c[0] === 'createFleet');

test('the budget counts the stack\'s live instances by tag', async () => {
  const { handler, ec2 } = setup();
  await handler(sqsEvent(MSG));
  const [, input] = ec2.calls[0];
  assert.deepEqual(input.Filters, [
    { Name: 'tag:ci-runner:stack', Values: ['ci-runner'] },
    { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] },
  ]);
});

test('under the Spot budget, mixed sizes of both architectures leave room: the job launches', async () => {
  // 2 + 4 + 8 (arm64) = 14 Spot vCPUs; an 8 brings it to 22 of 24.
  const ec2 = fakeEc2({ running: [spot(2), spot(4), spot(8, 'arm64'), od(8)] });
  const { handler, sqs } = setup({ ec2 });
  await handler(sqsEvent({ ...MSG, vcpus: 8 }));
  assert.ok(launched(ec2));
  assert.deepEqual(sqs, []);
});

test('a job that brings its capacity exactly to the budget launches', async () => {
  // 4 + 16 (arm64) = 20; a 4 makes 24 of 24.
  const ec2 = fakeEc2({ running: [spot(4), spot(16, 'arm64')] });
  const { handler, sqs } = setup({ ec2 });
  await handler(sqsEvent(MSG));
  assert.ok(launched(ec2));
  assert.deepEqual(sqs, []);
});

test('a job that would go over the Spot budget goes back on the queue with a delay, logged in vCPUs', async () => {
  // 4 + 16 (arm64) = 20; an 8 would make 28 of 24.
  const msg = { ...MSG, vcpus: 8 };
  const ec2 = fakeEc2({ running: [spot(4), spot(16, 'arm64')] });
  const { handler, gh, sqs, logs } = setup({ ec2 });
  assert.deepEqual(await handler(sqsEvent(msg)), { batchItemFailures: [] }, 'the original is consumed');
  assert.deepEqual(sqs, [{ QueueUrl: 'https://sqs.example/jobs', MessageBody: JSON.stringify(msg), DelaySeconds: 60 }]);
  assert.ok(!launched(ec2));
  assert.ok(!gh.keys().some((k) => k.includes('generate-jitconfig')), 'nothing is minted');
  assert.equal(JSON.parse(logs.find((l) => l.includes('"deferred"'))).deferred, '20+8 of 24 spot vCPUs');
});

test('an instance from before the shape tags counts as 4 vCPUs, on the capacity its lifecycle says', async () => {
  // 5 old Spot = 20, plus a tagged 4 = 24: a 2 is over.
  let s = setup({ ec2: fakeEc2({ running: [...Array(5).fill(OLD_SPOT), spot(4)] }) });
  await s.handler(sqsEvent({ ...MSG, vcpus: 2 }));
  assert.ok(!launched(s.ec2));
  assert.equal(JSON.parse(s.logs.find((l) => l.includes('"deferred"'))).deferred, '24+2 of 24 spot vCPUs');

  // 1 old On-Demand = 4, plus a tagged 4 = 8 of 8: On-Demand is full, Spot isn't.
  s = setup({ ec2: fakeEc2({ running: [OLD_OD, od(4, 'arm64')] }) });
  await s.handler(sqsEvent({ ...OD_MSG, vcpus: 2 }));
  assert.ok(!launched(s.ec2));
  assert.equal(JSON.parse(s.logs.find((l) => l.includes('"deferred"'))).deferred, '8+2 of 8 on-demand vCPUs');
  s = setup({ ec2: fakeEc2({ running: [OLD_OD, od(4, 'arm64')] }) });
  await s.handler(sqsEvent(MSG));
  assert.ok(launched(s.ec2));
});

test('Spot and On-Demand have separate budgets, each across both architectures', async () => {
  // 24 Spot vCPUs: On-Demand still has room.
  let s = setup({ ec2: fakeEc2({ running: [spot(16), spot(8, 'arm64')] }) });
  await s.handler(sqsEvent({ ...OD_MSG, vcpus: 8 }));
  assert.ok(launched(s.ec2));

  // 2 x64 + 4 arm64 On-Demand = 6: a 2 fits, a 4 doesn't, and Spot has room.
  const running = [od(2), od(4, 'arm64')];
  s = setup({ ec2: fakeEc2({ running }) });
  await s.handler(sqsEvent({ ...OD_MSG, vcpus: 2 }));
  assert.ok(launched(s.ec2));
  s = setup({ ec2: fakeEc2({ running }) });
  await s.handler(sqsEvent(OD_MSG));
  assert.ok(!launched(s.ec2));
  assert.equal(JSON.parse(s.logs.find((l) => l.includes('"deferred"'))).deferred, '6+4 of 8 on-demand vCPUs');
  s = setup({ ec2: fakeEc2({ running }) });
  await s.handler(sqsEvent({ ...MSG, vcpus: 16 }));
  assert.ok(launched(s.ec2));
});

test('the budgets come from the environment', async () => {
  let s = setup({ ec2: fakeEc2({ running: [spot(2)] }), env: { ...ENV, SPOT_VCPU_CAP: '4' } });
  await s.handler(sqsEvent(MSG));
  assert.ok(!launched(s.ec2));
  assert.equal(s.sqs.length, 1);
  s = setup({ env: { ...ENV, ONDEMAND_VCPU_CAP: '16' } });
  await s.handler(sqsEvent({ ...OD_MSG, vcpus: 16 }));
  assert.ok(launched(s.ec2));
});

test('a job no longer queued is dropped before the budget is checked', async () => {
  const s = setup({ gh: fakeGitHub({ jobStatus: 'completed' }), ec2: fakeEc2({ running: [spot(16), spot(8)] }) });
  await s.handler(sqsEvent(MSG));
  assert.deepEqual(s.sqs, []);
});

// --- the Fargate capacities (#29) ------------------------------------------
const FG_MSG = { ...MSG, label: 'ci-fargate-spot', labels: ['self-hosted', 'ci-fargate-spot', 'ci-cpu-4', 'x64'] };
const runTaskInput = (ecs) => (ecs.calls.find((c) => c[0] === 'runTask') || [])[1];
const taskTags = (input) => Object.fromEntries(input.tags.map((t) => [t.key, t.value]));
const envOf = (input) => Object.fromEntries(input.overrides.containerOverrides[0].environment.map((e) => [e.name, e.value]));

test('a ci-fargate-spot job runs one Fargate Spot task with the runner as its command, and no instance', async () => {
  const { handler, ec2, ecs, logs } = setup();
  assert.deepEqual(await handler(sqsEvent(FG_MSG)), { batchItemFailures: [] });
  assert.ok(!ec2.calls.some((c) => c[0] !== 'describe'), 'no EC2 launch');
  const input = runTaskInput(ecs);
  assert.equal(input.cluster, 'ci-runner');
  assert.equal(input.taskDefinition, ENV.TASK_DEFINITION);
  assert.equal(input.count, 1);
  assert.deepEqual(input.capacityProviderStrategy, [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }]);
  assert.equal(input.launchType, undefined, 'a capacity provider strategy excludes a launch type');
  assert.deepEqual(input.networkConfiguration, { awsvpcConfiguration: {
    subnets: ['subnet-a', 'subnet-b', 'subnet-c'], securityGroups: ['sg-0run'], assignPublicIp: 'ENABLED',
  } });
  assert.equal(input.overrides.cpu, '4096');
  assert.equal(input.overrides.memory, '16384');
  const [c] = input.overrides.containerOverrides;
  assert.equal(c.name, 'runner');
  assert.deepEqual(c.command, ['./run.sh', '--jitconfig', JIT]);
  // nproc over-reports on Fargate: the job's tools get the task's vCPUs, but
  // in no CARGO*/CMAKE* variable, which Swatinem/rust-cache hashes into its key.
  assert.deepEqual(envOf(input), { CI_RUNNER_VCPUS: '4', MAKEFLAGS: '-j4' });
  assert.deepEqual(taskTags(input), {
    'ci-runner:stack': 'ci-runner',
    'ci-runner:runner': 'ci-runner-20261112120000-555', 'ci-runner:runner-id': '77', 'ci-runner:label': 'ci-fargate-spot',
    'ci-runner:repo': 'zeroae/app', 'ci-runner:job-id': '555', 'ci-runner:run-id': '444', 'ci-runner:head-sha': 'abc123',
    'ci-runner:job-name': 'tests', 'ci-runner:labels': 'self-hosted ci-fargate-spot ci-cpu-4 x64',
    'ci-runner:capacity': 'ci-fargate-spot', 'ci-runner:vcpus': '4', 'ci-runner:arch': 'x64',
  });
  const line = JSON.parse(logs.find((l) => l.includes('"launched"')));
  assert.equal(line.launched, 'arn:aws:ecs:us-east-1:1:task/ci-runner/new1');
  assert.deepEqual([line.label, line.vcpus, line.arch], ['ci-fargate-spot', 4, 'x64']);
  assert.ok(!logs.some((l) => l.includes(JIT)), 'no JIT config in the logs');
});

test('each Fargate capacity, size and architecture: its capacity provider, task definition, cpu, memory and parallelism', async () => {
  const mem = { 2: '8192', 4: '16384', 8: '32768', 16: '65536' };
  for (const [label, provider] of [['ci-fargate-spot', 'FARGATE_SPOT'], ['ci-fargate', 'FARGATE']]) {
    for (const vcpus of [2, 4, 8, 16]) {
      for (const [arch, td] of [['x64', ENV.TASK_DEFINITION], ['arm64', ENV.ARM64_TASK_DEFINITION]]) {
        const what = `${label} ${vcpus} ${arch}`;
        const { handler, ecs } = setup({ env: { ...ENV, FARGATE_SPOT_VCPU_CAP: '64', FARGATE_VCPU_CAP: '64' } });
        const m = { ...MSG, label, vcpus, arch, labels: ['self-hosted', label, `ci-cpu-${vcpus}`, arch] };
        assert.deepEqual(await handler(sqsEvent(m)), { batchItemFailures: [] }, what);
        const input = runTaskInput(ecs);
        assert.deepEqual(input.capacityProviderStrategy, [{ capacityProvider: provider, weight: 1 }], what);
        assert.equal(input.taskDefinition, td, what);
        assert.deepEqual([input.overrides.cpu, input.overrides.memory], [String(vcpus * 1024), mem[vcpus]], what);
        assert.deepEqual(envOf(input), { CI_RUNNER_VCPUS: `${vcpus}`, MAKEFLAGS: `-j${vcpus}` }, what);
        const t = taskTags(input);
        assert.deepEqual([t['ci-runner:capacity'], t['ci-runner:vcpus'], t['ci-runner:arch']], [label, String(vcpus), arch], what);
      }
    }
  }
});

test('an arm64 task leaves out a subnet in use1-az3, where Fargate has no arm64; an x64 task keeps it', async () => {
  const env = { ...ENV, SUBNET_AZ_IDS: 'use1-az1,use1-az3,use1-az4' };
  let s = setup({ env });
  await s.handler(sqsEvent({ ...FG_MSG, arch: 'arm64' }));
  assert.deepEqual(runTaskInput(s.ecs).networkConfiguration.awsvpcConfiguration.subnets, ['subnet-a', 'subnet-c']);
  s = setup({ env });
  await s.handler(sqsEvent(FG_MSG));
  assert.deepEqual(runTaskInput(s.ecs).networkConfiguration.awsvpcConfiguration.subnets, ['subnet-a', 'subnet-b', 'subnet-c']);
});

test('a task\'s tags carry only characters ECS allows', async () => {
  const { handler, ecs } = setup();
  await handler(sqsEvent({ ...FG_MSG, job_name: 'build (x64, release) #1' }));
  const t = taskTags(runTaskInput(ecs));
  assert.equal(t['ci-runner:job-name'], 'build _x64_ release_ _1');
  for (const { key, value } of runTaskInput(ecs).tags) assert.match(key + value, /^[\p{L}\p{Z}\p{N}_.:/=+\-@]*$/u);
});

test('IDLE_SECONDS on the launcher reaches the task, for a test', async () => {
  const { handler, ecs } = setup({ env: { ...ENV, IDLE_SECONDS: '120' } });
  await handler(sqsEvent(FG_MSG));
  assert.equal(envOf(runTaskInput(ecs)).IDLE_SECONDS, '120');
});

const fgSpot = (vcpus) => ({ capacity: 'ci-fargate-spot', vcpus });
const fg = (vcpus) => ({ capacity: 'ci-fargate', vcpus });
const FGOD_MSG = { ...FG_MSG, label: 'ci-fargate', labels: ['self-hosted', 'ci-fargate', 'ci-cpu-4', 'x64'] };
const ran = (ecs) => ecs.calls.some((c) => c[0] === 'runTask');

test('the Fargate budget lists the cluster\'s tasks, running and told to stop, and reads their tags', async () => {
  const ecs = fakeEcs({ tasks: [fgSpot(4), fgSpot(2), { ...fgSpot(2), desired: 'STOPPED' }] });
  const { handler } = setup({ ecs });
  await handler(sqsEvent(FG_MSG));
  const lists = ecs.calls.filter((c) => c[0] === 'listTasks').map((c) => c[1]);
  assert.deepEqual(lists, [
    { cluster: 'ci-runner', desiredStatus: 'RUNNING', nextToken: undefined },
    { cluster: 'ci-runner', desiredStatus: 'RUNNING', nextToken: '1' },
    { cluster: 'ci-runner', desiredStatus: 'STOPPED', nextToken: undefined },
  ]);
  for (const [, d] of ecs.calls.filter((c) => c[0] === 'describeTasks')) {
    assert.equal(d.cluster, 'ci-runner');
    assert.deepEqual(d.include, ['TAGS']);
  }
});

test('a task told to stop counts towards the Fargate budget until it is STOPPED', async () => {
  // 16 running + 8 told to stop but still deprovisioning = 24 of 24; the 8
  // already STOPPED no longer counts.
  const tasks = [fgSpot(16), { ...fgSpot(8), desired: 'STOPPED', last: 'DEPROVISIONING' },
    { ...fgSpot(8), desired: 'STOPPED', last: 'STOPPED' }];
  const s = setup({ ecs: fakeEcs({ tasks }) });
  await s.handler(sqsEvent({ ...FG_MSG, vcpus: 2 }));
  assert.ok(!ran(s.ecs));
  assert.equal(JSON.parse(s.logs.find((l) => l.includes('"deferred"'))).deferred, '24+2 of 24 fargate-spot vCPUs');
});

test('Fargate budgets sum mixed sizes across tasks; a job over the budget waits, logged in vCPUs', async () => {
  // 2 + 4 + 8 + 8 = 22 Fargate Spot vCPUs: a 2 fits exactly, a 4 doesn't.
  const tasks = [fgSpot(2), fgSpot(4), fgSpot(8), fgSpot(8), fg(8)];
  let s = setup({ ecs: fakeEcs({ tasks }) });
  await s.handler(sqsEvent({ ...FG_MSG, vcpus: 2 }));
  assert.ok(ran(s.ecs));
  s = setup({ ecs: fakeEcs({ tasks }) });
  assert.deepEqual(await s.handler(sqsEvent(FG_MSG)), { batchItemFailures: [] });
  assert.ok(!ran(s.ecs));
  assert.equal(s.sqs.length, 1);
  assert.equal(s.sqs[0].DelaySeconds, 60);
  assert.ok(!s.gh.keys().some((k) => k.includes('generate-jitconfig')), 'nothing is minted');
  assert.equal(JSON.parse(s.logs.find((l) => l.includes('"deferred"'))).deferred, '22+4 of 24 fargate-spot vCPUs');
});

test('each Fargate capacity has its own budget, and EC2 instances count towards neither', async () => {
  // Fargate On-Demand holds 8 of 8; Fargate Spot and EC2 Spot are free.
  const ecs = () => fakeEcs({ tasks: [fg(4), fg(4), fgSpot(16)] });
  let s = setup({ ecs: ecs() });
  await s.handler(sqsEvent({ ...FGOD_MSG, vcpus: 2 }));
  assert.ok(!ran(s.ecs));
  assert.equal(JSON.parse(s.logs.find((l) => l.includes('"deferred"'))).deferred, '8+2 of 8 fargate vCPUs');
  s = setup({ ecs: ecs() });
  await s.handler(sqsEvent({ ...FG_MSG, vcpus: 8 }));
  assert.ok(ran(s.ecs), '16+8 of 24 Fargate Spot');
  // 24 EC2 Spot vCPUs held: Fargate Spot doesn't see them, and EC2 doesn't see tasks.
  s = setup({ ec2: fakeEc2({ running: [spot(16), spot(8)] }) });
  await s.handler(sqsEvent(FG_MSG));
  assert.ok(ran(s.ecs));
  assert.deepEqual(s.ec2.calls, [], 'a Fargate job describes no instances');
  s = setup({ ecs: fakeEcs({ tasks: [fgSpot(16), fgSpot(8)] }) });
  await s.handler(sqsEvent(MSG));
  assert.ok(launched(s.ec2));
  assert.deepEqual(s.ecs.calls, [], 'an EC2 job lists no tasks');
});

test('the Fargate budgets come from the environment', async () => {
  let s = setup({ ecs: fakeEcs({ tasks: [fgSpot(2)] }), env: { ...ENV, FARGATE_SPOT_VCPU_CAP: '4' } });
  await s.handler(sqsEvent(FG_MSG));
  assert.ok(!ran(s.ecs));
  s = setup({ env: { ...ENV, FARGATE_VCPU_CAP: '16' } });
  await s.handler(sqsEvent({ ...FGOD_MSG, vcpus: 16 }));
  assert.ok(ran(s.ecs));
});

test('a failed RunTask removes the registration and fails the message, as a failed fleet does', async () => {
  const failed = { tasks: [], failures: [{ arn: 'x', reason: 'Capacity is unavailable at this time', detail: 'FARGATE_SPOT' }] };
  for (const run of [failed, Object.assign(new Error('AccessDeniedException: no'), { name: 'AccessDeniedException' })]) {
    const { handler, gh, logs } = setup({ ecs: fakeEcs({ run }) });
    assert.deepEqual(await handler(sqsEvent(FG_MSG)), { batchItemFailures: [{ itemIdentifier: 'm0' }] });
    assert.ok(gh.keys().includes('DELETE /orgs/zeroae/actions/runners/77'), 'the registration is removed');
    const err = JSON.parse(logs.find((l) => l.includes('"error"'))).error;
    assert.match(err, run === failed ? /^no task launched: Capacity is unavailable at this time: FARGATE_SPOT$/ : /AccessDenied/);
  }
});
