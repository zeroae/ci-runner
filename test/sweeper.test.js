'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../functions/sweeper.js');

const NOW = Date.parse('2026-11-12T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60 * 1000);
const env = { STACK: 'ci-runner', GITHUB_ORG: 'zeroae', RUNNER_GROUP: 'ci-runner' };

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
function fakeGitHub(runners) {
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
    if (method === 'GET' && pathname === '/orgs/zeroae/actions/runner-groups') {
      return json(200, { total_count: 2, runner_groups: [{ id: 1, name: 'Default' }, { id: 3, name: 'ci-runner' }] });
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

test('a GitHub failure does not stop the terminations, but fails the run', async () => {
  const ec2 = fakeEc2([instance('i-old', 200)]);
  const fetch = async () => json(500, {});
  const sweep = createHandler({ ec2, secret: app, fetch, now: () => NOW, env });
  await assert.rejects(sweep({}), /HTTP 500/);
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
  assert.equal(all.length, 4, 'nothing else is granted');
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
