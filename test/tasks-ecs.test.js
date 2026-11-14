'use strict';
// A task's lifecycle against real ECS shapes, from aws/aws-emulator
// (./aws-emulator.js): the launcher runs a task, the webhook repairs a swap
// on it (TagResource validates the characters, as ECS does), the sweeper
// stops it, and the notifier reports a reclaim from the ECS Task State Change
// the emulator publishes to EventBridge, matched by template.yaml's own rule.
// The emulator drops a task's tags once it is told to stop (AWS keeps them
// readable through DescribeTasks, measured live); the tests rely on that only
// where they say so.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { skip, startEmulator, network, taskDefinition } = require('./aws-emulator.js');
const launcher = require('../functions/launcher.js');
const webhook = require('../functions/webhook.js');
const sweeper = require('../functions/sweeper.js');
const notifier = require('../functions/notifier.js');

let aws;
let clusterArn;
let queueUrl;
const env = {
  GITHUB_ORG: 'zeroae', RUNNER_GROUP: 'ci-runner', STACK_NAME: 'ci-runner', CLUSTER: 'ci-runner',
  QUEUE_URL: 'https://sqs.example/jobs', SPOT_VCPU_CAP: '24', ONDEMAND_VCPU_CAP: '8',
  FARGATE_SPOT_VCPU_CAP: '64', FARGATE_VCPU_CAP: '64', SUBNET_AZ_IDS: 'use1-az1,use1-az2',
};

// The ECS adapters, as each function's exports.handler builds them. The SDK
// reads a timestamp as a Date; the wire carries epoch seconds.
const op = (name) => (i) => aws.ecs(name, i);
const ecs = {
  runTask: op('RunTask'),
  listTasks: op('ListTasks'),
  describeTasks: async (i) => {
    const r = await aws.ecs('DescribeTasks', i);
    for (const t of r.tasks || []) if (typeof t.createdAt === 'number') t.createdAt = new Date(t.createdAt * 1000);
    return r;
  },
  stopTask: op('StopTask'),
  tagResource: op('TagResource'),
};

// template.yaml's NotifierTaskRule pattern, with the cluster's ARN for its
// !GetAtt. The pattern is flow lists (`key: [a, b]`) and nested keys only.
function notifierTaskPattern() {
  const yaml = fs.readFileSync(path.join(__dirname, '..', 'template.yaml'), 'utf8');
  const block = yaml.split(/\n {2}NotifierTaskRule:\n/)[1].split('EventPattern:\n')[1].split(/\n(?! {8})/)[0];
  const root = {};
  const stack = [{ indent: 6, obj: root }];
  for (const line of block.split('\n')) {
    const [, sp, key, list] = line.match(/^( *)([\w-]+):(?: \[(.*)\])?$/);
    while (sp.length <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (list === undefined) stack.push({ indent: sp.length, obj: (parent[key] = {}) });
    else parent[key] = list.split(', ').map((v) => (v === '!GetAtt RunnerCluster.Arn' ? clusterArn : v));
  }
  return root;
}

before(async () => {
  if (skip) return;
  aws = await startEmulator();
  const net = await network(aws, env.SUBNET_AZ_IDS.split(','));
  env.SUBNET_IDS = net.subnets.join(',');
  env.SECURITY_GROUP_ID = net.sg;
  clusterArn = (await aws.ecs('CreateCluster', { clusterName: 'ci-runner', capacityProviders: ['FARGATE', 'FARGATE_SPOT'] })).cluster.clusterArn;
  env.TASK_DEFINITION = await taskDefinition(aws, 'ci-runner-runner', 'X86_64');
  env.ARM64_TASK_DEFINITION = await taskDefinition(aws, 'ci-runner-runner-arm64', 'ARM64');

  // Every task state change of the cluster, to an SQS queue, to read the
  // events as EventBridge delivers them.
  queueUrl = (await aws.sqs('CreateQueue', { QueueName: 'task-events' })).QueueUrl;
  const queueArn = (await aws.sqs('GetQueueAttributes', { QueueUrl: queueUrl, AttributeNames: ['QueueArn'] })).Attributes.QueueArn;
  await aws.sqs('SetQueueAttributes', { QueueUrl: queueUrl, Attributes: { Policy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: queueArn }],
  }) } });
  await aws.events('PutRule', { Name: 'all-task-changes', EventPattern: JSON.stringify({ source: ['aws.ecs'], 'detail-type': ['ECS Task State Change'], detail: { clusterArn: [clusterArn] } }) });
  await aws.events('PutTargets', { Rule: 'all-task-changes', Targets: [{ Id: 'queue', Arn: queueArn }] });
});

after(() => { if (aws) aws.stop(); });

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const secret = { get: async () => ({ app_id: 42, private_key: privateKey.export({ type: 'pkcs1', format: 'pem' }), webhook_secret: 'whsec' }) };

// GitHub, faked: every job is queued and keeps its real name, the group
// exists, JIT configs mint, and runners and check runs are recorded (and a
// commit's check runs listed).
const JOB_NAMES = { 999: 'build (x64, a)', 555: 'test (x64, b)' };
function fakeGitHub(runners = []) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const key = `${init.method || 'GET'} ${pathname}`;
    calls.push({ key, body: init.body && JSON.parse(init.body) });
    const res = (status, json) => ({ ok: status < 300, status, json: async () => json });
    if (key.endsWith('/installation')) return res(200, { id: 181 });
    if (key.endsWith('/access_tokens')) return res(201, { token: 't', expires_at: new Date(Date.now() + 3600e3).toISOString() });
    const job = pathname.match(/\/actions\/jobs\/(\d+)$/);
    if (job) return res(200, { id: Number(job[1]), status: 'queued', name: JOB_NAMES[job[1]] });
    if (key.endsWith('/actions/runner-groups')) return res(200, { runner_groups: [{ id: 3, name: 'ci-runner' }] });
    if (key.endsWith('/runner-groups/3/runners')) return res(200, { total_count: runners.length, runners });
    if (key.endsWith('/generate-jitconfig')) return res(201, { runner: { id: 77 }, encoded_jit_config: 'ZW5jb2RlZGppdA==' });
    if (key.startsWith('GET ') && key.endsWith('/check-runs')) {
      const name = new URL(url).searchParams.get('check_name');
      return res(200, { check_runs: calls.filter((c) => c.key.startsWith('POST ') && c.key.endsWith('/check-runs') && c.body.name === name).map((c) => c.body) });
    }
    if (key.startsWith('DELETE ') || key.endsWith('/check-runs')) return res(201, {});
    throw new Error('unexpected ' + key);
  };
  return { fetch, calls };
}

// The launcher runs one task for job 999; returns its ARN and runner name.
async function launch() {
  const logs = [];
  const h = launcher.createHandler({
    secret, fetch: fakeGitHub().fetch, ecs, ec2: {}, sqs: {}, now: Date.now, env, log: (l) => logs.push(l),
  });
  const body = JSON.stringify({
    repo: 'zeroae/lib', job_id: 999, run_id: 888, head_sha: 'fff000', job_name: JOB_NAMES[999],
    label: 'ci-fargate-spot', vcpus: 4, arch: 'x64', labels: ['self-hosted', 'ci-fargate-spot', 'ci-cpu-4', 'x64', 'linux'], installation_id: 181,
  });
  assert.deepEqual(await h({ Records: [{ messageId: 'm', body }] }), { batchItemFailures: [] }, logs.join('\n'));
  const l = JSON.parse(logs.find((x) => x.includes('"launched"')));
  return { arn: l.launched, runner: l.runner };
}

const tagsOf = async (arn) => Object.fromEntries((await ecs.describeTasks({ cluster: 'ci-runner', tasks: [arn], include: ['TAGS'] }))
  .tasks[0].tags.map((t) => [t.key, t.value]));

test('a swap on a task: the job is re-queued from the task\'s tags, and ECS takes the re-tag', { skip }, async () => {
  const { arn, runner } = await launch();
  const sent = [];
  const logs = [];
  const h = webhook.createHandler({
    secret, queue: { send: async (m) => sent.push(m) },
    ec2: { describeInstances: async () => ({ Reservations: [] }), createTags: assert.fail },
    ecs, env, log: (l) => logs.push(l),
  });
  const raw = JSON.stringify({
    action: 'in_progress',
    workflow_job: { id: 555, run_id: 444, head_sha: 'abc123', name: JOB_NAMES[555], labels: ['self-hosted', 'ci-fargate-spot', 'ci-cpu-4', 'x64'], runner_name: runner },
    repository: { full_name: 'zeroae/app', visibility: 'private', owner: { login: 'zeroae' } },
    installation: { id: 181 },
  });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'whsec').update(raw).digest('hex');
  const res = await h({ headers: { 'x-github-event': 'workflow_job', 'x-hub-signature-256': sig }, body: raw });
  assert.equal(res.statusCode, 202, logs.join('\n'));

  assert.equal(sent.length, 1);
  assert.deepEqual(
    { ...sent[0], job_name: undefined },
    { repo: 'zeroae/lib', job_id: 999, run_id: 888, head_sha: 'fff000', job_name: undefined, label: 'ci-fargate-spot',
      vcpus: 4, arch: 'x64', labels: ['self-hosted', 'ci-fargate-spot', 'ci-cpu-4', 'x64', 'linux'], installation_id: 181 },
  );
  const tags = await tagsOf(arn);
  assert.deepEqual(
    ['repo', 'job-id', 'run-id', 'head-sha', 'job-name'].map((k) => tags[`ci-runner:${k}`]),
    ['zeroae/app', '555', '444', 'abc123', 'test _x64_ b_'],
  );
  assert.equal(tags['ci-runner:runner'], runner, 'the other tags stay');
  await ecs.stopTask({ cluster: 'ci-runner', task: arn });
});

test('the sweeper keeps a live task\'s registration, stops the task after 2 hours, then removes the registration', { skip }, async () => {
  const { arn, runner } = await launch();
  const later = Date.now() + 3 * 3600e3;
  const sweep = (now, runners) => {
    const gh = fakeGitHub(runners);
    const h = sweeper.createHandler({ ec2: { describe: async () => [], terminate: assert.fail }, ecs, secret, fetch: gh.fetch, now: () => now, env, log: () => {} });
    return h({}).then((out) => ({ out, deleted: gh.calls.filter((c) => c.key.startsWith('DELETE ')).map((c) => c.key) }));
  };
  const runners = [{ id: 77, name: runner, status: 'offline', busy: false }];

  // 3 hours on: the task is stopped, but listed this run, so its runner stays.
  let r = await sweep(later, runners);
  assert.deepEqual(r.out.stopped, [arn]);
  assert.deepEqual(r.deleted, []);
  const [task] = (await ecs.describeTasks({ cluster: 'ci-runner', tasks: [arn] })).tasks;
  assert.equal(task.desiredStatus, 'STOPPED');

  // The next run: the task is gone, so the offline registration goes.
  r = await sweep(later, runners);
  assert.deepEqual(r.out.stopped, []);
  assert.deepEqual(r.deleted, ['DELETE /orgs/zeroae/actions/runners/77']);
});

// The task's state changes as EventBridge delivers them, until `done` holds
// (each receive waits up to 1 s for one).
async function changesOf(arn, done) {
  const out = [];
  for (let i = 0; i < 10 && !done(out); i++) {
    const m = await aws.sqs('ReceiveMessage', { QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 });
    for (const x of m.Messages || []) {
      const e = JSON.parse(x.Body);
      if (e.detail.taskArn === arn) out.push(e);
    }
  }
  return out;
}

test('a Fargate Spot reclaim: template.yaml\'s rule matches each change of the stop, and the notifier reports it once', { skip }, async () => {
  const { arn } = await launch();
  const pattern = JSON.stringify(notifierTaskPattern());
  const matches = async (e) => (await aws.events('TestEventPattern', { EventPattern: pattern, Event: JSON.stringify(e) })).Result;
  // AWS stops a reclaimed task with SpotInterruption, the emulator only with
  // UserInitiated, so the code is swapped in. The warning: the task's change,
  // as ECS publishes it, once it is told to stop and still runs.
  const [first] = await changesOf(arn, (c) => c.length > 0);
  assert.equal(await matches(first), false, 'a task starting is no reclaim');
  const warning = { ...first, detail: { ...first.detail, desiredStatus: 'STOPPED', stopCode: 'SpotInterruption' } };
  assert.equal(await matches(warning), true);

  const gh = fakeGitHub();
  const logs = [];
  const h = notifier.createHandler({ secret, fetch: gh.fetch, ec2: { describe: assert.fail }, ecs, now: Date.now, env, log: (l) => logs.push(l) });
  await h(warning);
  const check = gh.calls.find((c) => c.key === 'POST /repos/zeroae/lib/check-runs');
  assert.ok(check, logs.join('\n'));
  assert.equal(check.body.name, 'ci-runner / build (x64, a)');
  assert.equal(check.body.head_sha, 'fff000');
  assert.equal(check.body.output.title, 'Spot capacity reclaimed: re-run this job');
  assert.ok(check.body.output.summary.includes(`task (${arn.split('/').pop()})`));

  // The stop's later changes match too. The emulator has dropped the task's tags by
  // then, so the notifier finds no job on it, and reports nothing more.
  await ecs.stopTask({ cluster: 'ci-runner', task: arn, reason: 'test' });
  const stopping = await changesOf(arn, (c) => c.some((e) => e.detail.lastStatus === 'STOPPED'));
  const user = stopping.find((e) => e.detail.lastStatus === 'STOPPED');
  assert.equal(user.detail.stopCode, 'UserInitiated');
  assert.equal(await matches(user), false, 'a UserInitiated stop is no reclaim');
  const reclaimed = stopping.filter((e) => e.detail.stopCode).map((e) => ({ ...e, detail: { ...e.detail, stopCode: 'SpotInterruption' } }));
  assert.ok(reclaimed.length >= 2, 'a stopping change and the stopped one');
  for (const e of reclaimed) {
    assert.equal(await matches(e), true, e.detail.lastStatus);
    await h(e);
  }
  assert.equal(gh.calls.filter((c) => c.key === 'POST /repos/zeroae/lib/check-runs').length, 1);
  assert.deepEqual((await ecs.describeTasks({ cluster: 'ci-runner', tasks: [arn], include: ['TAGS'] })).tasks[0].tags, []);
});
