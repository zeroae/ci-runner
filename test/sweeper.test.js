'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler: create } = require('../functions/sweeper.js');

const NOW = Date.parse('2026-11-12T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60 * 1000);
const env = { STACK_NAME: 'ci-runner', GITHUB_ORG: 'zeroae', RUNNER_GROUP: 'ci-runner', CLUSTER: 'ci-runner' };

// The cluster's tasks, as ECS answers ListTasks and DescribeTasks: ListTasks
// returns at most 100 ARNs a page and filters on the desired status.
function fakeEcs(tasks) {
  const stopped = [];
  const calls = [];
  return {
    stopped,
    calls,
    listTasks: async (i) => {
      calls.push(['listTasks', i]);
      assert.equal(i.cluster, 'ci-runner');
      const arns = tasks.filter((t) => t.desiredStatus === (i.desiredStatus || 'RUNNING')).map((t) => t.taskArn);
      const from = Number(i.nextToken || 0);
      return { taskArns: arns.slice(from, from + 100), ...(from + 100 < arns.length && { nextToken: String(from + 100) }) };
    },
    describeTasks: async (i) => {
      calls.push(['describeTasks', i]);
      assert.equal(i.cluster, 'ci-runner');
      assert.ok(i.tasks.length <= 100);
      assert.deepEqual(i.include, ['TAGS']);
      return { tasks: tasks.filter((t) => i.tasks.includes(t.taskArn)), failures: [] };
    },
    stopTask: async (i) => { calls.push(['stopTask', i]); stopped.push(i.task); return { task: {} }; },
  };
}

function task(id, minutesOld, { lastStatus = 'RUNNING', desiredStatus = 'RUNNING', tags = { 'ci-runner:stack': 'ci-runner' } } = {}) {
  return {
    taskArn: `arn:aws:ecs:us-east-1:123456789012:task/ci-runner/${id}`,
    createdAt: ago(minutesOld), lastStatus, desiredStatus,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
  };
}

// Every test runs with an empty cluster unless it brings its own.
const createHandler = (deps) => create({ ecs: fakeEcs([]), ...deps });

function instance(id, minutesOld, { state = 'running', tags = { 'ci-runner:stack': 'ci-runner' } } = {}) {
  return {
    InstanceId: id,
    State: { Name: state },
    LaunchTime: ago(minutesOld),
    Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
  };
}

function fakeEc2(instances) {
  const terminated = [];
  return {
    terminated,
    describe: async () => instances,
    terminate: async (ids) => { terminated.push(...ids); },
  };
}

// The App is not set up yet: the sweeper only handles instances.
const noApp = { get: async () => ({ state_key: 'x' }) };

test('terminates only instances carrying the stack tag that are older than 2 hours', async () => {
  const ec2 = fakeEc2([
    instance('i-old', 121),
    instance('i-young', 119),
    instance('i-old-other-stack', 300, { tags: { 'ci-runner:stack': 'other' } }),
    instance('i-old-untagged', 300, { tags: {} }),
    instance('i-old-stopped', 300, { state: 'stopped' }),
    instance('i-old-shutting', 300, { state: 'shutting-down' }),
    instance('i-old-gone', 300, { state: 'terminated' }),
  ]);
  const sweep = createHandler({ ec2, secret: noApp, fetch: assert.fail, now: () => NOW, env });
  const out = await sweep({});
  assert.deepEqual(ec2.terminated.sort(), ['i-old', 'i-old-stopped']);
  assert.deepEqual(out.terminated.sort(), ['i-old', 'i-old-stopped']);
});

test('stops the cluster\'s tasks launched over 2 hours ago', async () => {
  const ecs = fakeEcs([
    task('t-old', 121),
    task('t-young', 119),
    // A task launched by hand, without our tags, is still in the stack's cluster.
    task('t-old-hand', 300, { tags: {} }),
    // Already told to stop: ListTasks for RUNNING doesn't return it.
    task('t-old-stopping', 300, { desiredStatus: 'STOPPED', lastStatus: 'DEACTIVATING' }),
  ]);
  const out = await createHandler({ ec2: fakeEc2([]), ecs, secret: noApp, fetch: assert.fail, now: () => NOW, env })({});
  const arn = (id) => `arn:aws:ecs:us-east-1:123456789012:task/ci-runner/${id}`;
  assert.deepEqual(ecs.stopped.sort(), [arn('t-old'), arn('t-old-hand')]);
  assert.deepEqual(out.stopped.sort(), [arn('t-old'), arn('t-old-hand')]);
  for (const [op, i] of ecs.calls.filter(([op]) => op === 'stopTask')) {
    assert.equal(i.cluster, 'ci-runner', op);
    assert.match(i.reason, /2 hours/);
  }
});

test('pages through a cluster with more than 100 tasks', async () => {
  const ecs = fakeEcs(Array.from({ length: 150 }, (_, i) => task(`t${i}`, 200)));
  await createHandler({ ec2: fakeEc2([]), ecs, secret: noApp, fetch: assert.fail, now: () => NOW, env })({});
  assert.equal(ecs.stopped.length, 150);
});

test('terminates nothing when nothing is stray', async () => {
  const ec2 = fakeEc2([instance('i-young', 5)]);
  const calls = [];
  ec2.terminate = async (ids) => calls.push(ids);
  await createHandler({ ec2, secret: noApp, fetch: assert.fail, now: () => NOW, env })({});
  assert.deepEqual(calls, []);
});

// --- registrations -----------------------------------------------------------
const crypto = require('node:crypto');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
const app = { get: async () => ({ state_key: 'x', app_id: 42, private_key: pem }) };

function verifyJwt(auth) {
  const [h, p, s] = auth.replace(/^Bearer /, '').split('.');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')), 'JWT signature');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  return JSON.parse(Buffer.from(p, 'base64url'));
}

const json = (status, body) => ({ ok: status < 300, status, json: async () => body });

// A fake GitHub: the App's org installation, one runner group and its runners.
function fakeGitHub(runners, groups = [{ id: 1, name: 'Default' }, { id: 3, name: 'ci-runner' }]) {
  const deleted = [];
  const jwts = [];
  const fetch = async (url, opts = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = opts.method || 'GET';
    const auth = opts.headers.authorization;
    if (method === 'GET' && pathname === '/orgs/zeroae/installation') {
      jwts.push(verifyJwt(auth));
      return json(200, { id: 7 });
    }
    if (method === 'POST' && pathname === '/app/installations/7/access_tokens') {
      jwts.push(verifyJwt(auth));
      return json(201, { token: 'ghs_install' });
    }
    assert.equal(auth, 'Bearer ghs_install');
    assert.equal(opts.headers['x-github-api-version'], '2022-11-28');
    assert.equal(opts.headers['user-agent'], 'ci-runner');
    if (method === 'GET' && pathname === '/orgs/zeroae/actions/runner-groups') {
      const per = Number(searchParams.get('per_page'));
      const page = Number(searchParams.get('page') || 1);
      return json(200, { total_count: groups.length, runner_groups: groups.slice((page - 1) * per, page * per) });
    }
    if (method === 'GET' && pathname === '/orgs/zeroae/actions/runner-groups/3/runners') {
      const per = Number(searchParams.get('per_page'));
      const page = Number(searchParams.get('page'));
      return json(200, { total_count: runners.length, runners: runners.slice((page - 1) * per, page * per) });
    }
    const m = /^\/orgs\/zeroae\/actions\/runners\/(\d+)$/.exec(pathname);
    if (method === 'DELETE' && m) { deleted.push(Number(m[1])); return { ok: true, status: 204, json: async () => ({}) }; }
    assert.fail(`unexpected ${method} ${url}`);
  };
  return { fetch, deleted, jwts };
}

const runner = (id, name, status = 'offline') => ({ id, name, status, busy: false });

test('removes only offline registrations in the group that have no instance', async () => {
  const ec2 = fakeEc2([
    instance('i-1', 10, { tags: { 'ci-runner:stack': 'ci-runner', 'ci-runner:runner': 'ci-runner-booting' } }),
    instance('i-2', 10, { tags: { 'ci-runner:stack': 'ci-runner', 'ci-runner:runner': 'ci-runner-ending' }, state: 'shutting-down' }),
    instance('i-3', 10, { tags: { 'ci-runner:stack': 'ci-runner', 'ci-runner:runner': 'ci-runner-done' }, state: 'terminated' }),
    instance('i-4', 10, { tags: { 'ci-runner:stack': 'ci-runner', 'ci-runner:runner-id': '15' } }),
    // Another stack's instance doesn't keep this stack's registration alive.
    instance('i-5', 10, { tags: { 'ci-runner:stack': 'other', 'ci-runner:runner': 'ci-runner-elsewhere' } }),
  ]);
  const gh = fakeGitHub([
    runner(10, 'ci-runner-booting'),          // its instance is running: kept
    runner(11, 'ci-runner-ending'),           // its instance is shutting down: kept for now
    runner(12, 'ci-runner-done'),             // its instance is terminated: removed
    runner(13, 'ci-runner-orphan'),           // no instance: removed
    runner(14, 'ci-runner-online', 'online'), // online: kept
    runner(15, 'renamed'),                    // matched by its id: kept
    runner(16, 'ci-runner-elsewhere'),        // removed
  ]);
  const out = await createHandler({ ec2, secret: app, fetch: gh.fetch, now: () => NOW, env })({});
  assert.deepEqual(gh.deleted.sort(), [12, 13, 16]);
  assert.deepEqual(out.removed.sort(), [12, 13, 16]);
  for (const claims of gh.jwts) {
    assert.equal(claims.iss, '42');
    assert.ok(claims.iat <= NOW / 1000 && claims.exp > NOW / 1000 && claims.exp - claims.iat <= 600);
  }
  assert.equal(gh.jwts.length, 2);
});

test('a registration is kept while its task lives and removed once the task is gone, next to instances', async () => {
  const tags = (more) => ({ 'ci-runner:stack': 'ci-runner', ...more });
  const ec2 = fakeEc2([
    instance('i-1', 10, { tags: tags({ 'ci-runner:runner': 'ci-runner-on-ec2' }) }),
  ]);
  const ecs = fakeEcs([
    task('t-1', 10, { tags: tags({ 'ci-runner:runner': 'ci-runner-on-fargate' }) }),
    task('t-2', 10, { lastStatus: 'PROVISIONING', tags: tags({ 'ci-runner:runner-id': '53' }) }),
    // Told to stop (stopped, or on its way): its runner no longer has a machine.
    task('t-3', 10, { desiredStatus: 'STOPPED', lastStatus: 'STOPPED', tags: tags({ 'ci-runner:runner': 'ci-runner-task-gone' }) }),
    task('t-4', 10, { desiredStatus: 'STOPPED', lastStatus: 'DEPROVISIONING', tags: tags({ 'ci-runner:runner': 'ci-runner-task-stopping' }) }),
  ]);
  const gh = fakeGitHub([
    runner(50, 'ci-runner-on-ec2'),        // its instance is running: kept
    runner(51, 'ci-runner-on-fargate'),    // its task is running: kept
    runner(52, 'ci-runner-task-gone'),     // its task stopped: removed
    runner(53, 'renamed'),                 // its task carries its id: kept
    runner(54, 'ci-runner-task-stopping'), // its task is stopping: removed
    runner(55, 'ci-runner-nowhere'),       // neither: removed
  ]);
  const out = await createHandler({ ec2, ecs, secret: app, fetch: gh.fetch, now: () => NOW, env })({});
  assert.deepEqual(gh.deleted.sort(), [52, 54, 55]);
  assert.deepEqual(out, { terminated: [], stopped: [], removed: [52, 54, 55] });
});

test('an ECS failure fails the run after the terminations, and removes no registration', async () => {
  const ec2 = fakeEc2([instance('i-old', 200)]);
  const ecs = fakeEcs([]);
  ecs.listTasks = async () => { throw new Error('ThrottlingException'); };
  const gh = fakeGitHub([runner(60, 'ci-runner-orphan')]);
  await assert.rejects(createHandler({ ec2, ecs, secret: app, fetch: gh.fetch, now: () => NOW, env })({}), /Throttling/);
  assert.deepEqual(ec2.terminated, ['i-old']);
  assert.deepEqual(gh.deleted, []);
});

test('a registration minted in the last 10 minutes is left alone, even with no instance yet', async () => {
  // The launcher mints the JIT config before the instance exists. A name
  // carrying a UTC <YYYYmmddHHMMSS> stamp tells the sweeper its age.
  const gh = fakeGitHub([
    runner(20, 'ci-runner-20261112115500'),      // 5 min old: kept
    runner(21, 'ci-runner-20261112113000-981'),  // 30 min old: removed
    runner(22, 'ci-runner-hand-20261112115959'), // 1 s old: kept
  ]);
  await createHandler({ ec2: fakeEc2([]), secret: app, fetch: gh.fetch, now: () => NOW, env })({});
  assert.deepEqual(gh.deleted, [21]);
});

test('pages through a group with more than 100 runners', async () => {
  const many = Array.from({ length: 150 }, (_, i) => runner(1000 + i, `ci-runner-x${i}`));
  const gh = fakeGitHub(many);
  await createHandler({ ec2: fakeEc2([]), secret: app, fetch: gh.fetch, now: () => NOW, env })({});
  assert.equal(gh.deleted.length, 150);
});

test('finds the runner group past the first page of groups', async () => {
  const groups = Array.from({ length: 100 }, (_, i) => ({ id: 100 + i, name: `g${i}` })).concat({ id: 3, name: 'ci-runner' });
  const gh = fakeGitHub([runner(30, 'ci-runner-orphan')], groups);
  await createHandler({ ec2: fakeEc2([]), secret: app, fetch: gh.fetch, now: () => NOW, env })({});
  assert.deepEqual(gh.deleted, [30]);
});

test('logs what it did through the injected log', async (t) => {
  t.mock.method(console, 'log', () => assert.fail('logged to the console'));
  const logs = [];
  const gh = fakeGitHub([runner(40, 'ci-runner-orphan')]);
  await createHandler({ ec2: fakeEc2([instance('i-old', 200)]), secret: app, fetch: gh.fetch, now: () => NOW, env, log: (l) => logs.push(l) })({});
  assert.match(logs.join('\n'), /terminated i-old/);
  assert.match(logs.join('\n'), /removed runner ci-runner-orphan/);
});

test('a GitHub failure does not stop the terminations, but fails the run', async () => {
  const ec2 = fakeEc2([instance('i-old', 200)]);
  const fetch = async () => json(500, {});
  const sweep = createHandler({ ec2, secret: app, fetch, now: () => NOW, env });
  await assert.rejects(sweep({}), /: 500/);
  assert.deepEqual(ec2.terminated, ['i-old']);
});

// --- the template ------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');
const template = fs.readFileSync(path.join(__dirname, '..', 'template.yaml'), 'utf8');

// The text of one top-level resource in template.yaml.
function resource(name) {
  const m = new RegExp(`^  ${name}:\\n((?:    .*\\n|\\n)*)`, 'm').exec(template);
  assert.ok(m, `${name} not in template.yaml`);
  return m[1];
}

// The sweeper role's policy statements, each as its lines with indentation dropped.
function statements() {
  const role = resource('SweeperRole');
  const body = role.slice(role.indexOf('Policies:'));
  return body.split(/^ *- Effect: /m).slice(1)
    .map((s) => ('Effect: ' + s).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
}

test('the sweeper may terminate only instances carrying the stack tag', () => {
  const role = resource('SweeperRole');
  assert.match(role, /RoleName: !Sub "PowerUserPB-\$\{AWS::StackName\}-sweeper"/);
  assert.match(role, /PermissionsBoundary: arn:aws:iam::aws:policy\/PowerUserAccess/);
  assert.match(role, /PolicyName: !Sub "PowerUserPB-\$\{AWS::StackName\}-sweeper"/);

  const all = statements();
  assert.ok(all.every((s) => s[0] === 'Effect: Allow'));
  assert.ok(!/ec2:\*|"\*:|Action: "?\*/.test(role), 'no wildcard actions');

  const terminate = all.filter((s) => s.some((l) => l.includes('ec2:TerminateInstances')));
  assert.equal(terminate.length, 1, 'one statement grants TerminateInstances');
  assert.deepEqual(terminate[0], [
    'Effect: Allow',
    'Action: ec2:TerminateInstances',
    'Resource: !Sub "arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:instance/*"',
    'Condition:',
    'StringEquals:',
    'aws:ResourceTag/ci-runner:stack: !Ref AWS::StackName',
  ]);

  const describe = all.filter((s) => s.some((l) => l.includes('ec2:Describe')));
  assert.deepEqual(describe, [['Effect: Allow', 'Action: ec2:DescribeInstances', 'Resource: "*"']]);

  const secrets = all.filter((s) => s.some((l) => l.includes('secretsmanager:')));
  assert.deepEqual(secrets, [['Effect: Allow', 'Action: secretsmanager:GetSecretValue', 'Resource: !Ref AppSecret']]);

  const logs = all.filter((s) => s.some((l) => l.includes('logs:')));
  assert.equal(logs.length, 1);
  assert.equal(all.length, 6, 'nothing else is granted');
});

test('the sweeper may list, describe and stop only the tasks of the stack\'s cluster', () => {
  const ecs = statements().filter((s) => s.some((l) => l.includes('ecs:')));
  const tasks = 'Resource: !Sub "arn:${AWS::Partition}:ecs:${AWS::Region}:${AWS::AccountId}:task/${RunnerCluster}/*"';
  assert.deepEqual(ecs, [
    ['Effect: Allow', 'Action: ecs:ListTasks', 'Resource: "*"', 'Condition:', 'ArnEquals:', 'ecs:cluster: !GetAtt RunnerCluster.Arn'],
    ['Effect: Allow', 'Action: [ecs:DescribeTasks, ecs:StopTask]', tasks],
  ]);
  assert.match(resource('SweeperFunction'), /CLUSTER: !Ref RunnerCluster\n/);
});

test('the sweeper runs every 10 minutes', () => {
  const rule = resource('SweeperSchedule');
  assert.match(rule, /ScheduleExpression: rate\(10 minutes\)/);
  assert.match(rule, /Arn: !GetAtt SweeperFunction\.Arn/);
  const perm = resource('SweeperSchedulePermission');
  assert.match(perm, /Principal: events\.amazonaws\.com/);
  assert.match(perm, /SourceArn: !GetAtt SweeperSchedule\.Arn/);
  assert.match(resource('SweeperFunction'), /\/\/@inline functions\/sweeper\.js/);
});
