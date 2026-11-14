'use strict';
// The launcher's RunTask against real ECS shapes, from aws/aws-emulator
// (https://github.com/aws/aws-emulator): the emulator validates the request
// as ECS does (Fargate cpu/memory pairs, capacity providers on the cluster,
// subnets that exist, the characters a tag may carry) and answers with a
// real Task. Skipped when `aws-emulator` isn't installed, unless
// REQUIRE_AWS_EMULATOR is set (CI sets it).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const readline = require('node:readline');
const { createHandler } = require('../functions/launcher.js');

const installed = spawnSync('aws-emulator', ['-v']).status === 0;
if (!installed && process.env.REQUIRE_AWS_EMULATOR) throw new Error('aws-emulator is not installed');
const skip = !installed && 'aws-emulator is not installed';

let emulator;
let endpoint;
let ca;

// One request to the emulator; `headers` pick the protocol.
function call(body, headers) {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: url.hostname, port: url.port, path: '/', method: 'POST', ca,
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ECS speaks JSON 1.1, as @aws-sdk/client-ecs sends it.
async function ecsCall(op, input) {
  const r = await call(JSON.stringify(input), {
    'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AmazonEC2ContainerServiceV20141113.${op}`,
    authorization: 'AWS4-HMAC-SHA256 Credential=test/20261112/us-east-1/ecs/aws4_request, SignedHeaders=host, Signature=0',
  });
  const json = JSON.parse(r.text || '{}');
  if (r.status >= 300) throw Object.assign(new Error(`${json.__type}: ${json.message || json.Message}`), { name: json.__type });
  return json;
}
const ecs = {
  runTask: (i) => ecsCall('RunTask', i),
  listTasks: (i) => ecsCall('ListTasks', i),
  describeTasks: (i) => ecsCall('DescribeTasks', i),
};

// EC2 speaks the query protocol; only ids are read back.
async function ec2Call(params) {
  const r = await call(new URLSearchParams({ Version: '2016-11-15', ...params }).toString(), {
    'content-type': 'application/x-www-form-urlencoded',
    authorization: 'AWS4-HMAC-SHA256 Credential=test/20261112/us-east-1/ec2/aws4_request, SignedHeaders=host, Signature=0',
  });
  assert.ok(r.status < 300, r.text);
  return r.text;
}
const idIn = (xml, tag) => xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))[1];

// The stack's shape, as template.yaml makes it: three subnets (one in
// use1-az3, to see arm64 leave it out), a security group, the cluster with
// both capacity providers, and the two task definitions.
const env = {
  GITHUB_ORG: 'zeroae', RUNNER_GROUP: 'ci-runner', STACK_NAME: 'ci-runner', CLUSTER: 'ci-runner',
  QUEUE_URL: 'https://sqs.example/jobs', SPOT_VCPU_CAP: '24', ONDEMAND_VCPU_CAP: '8',
  FARGATE_SPOT_VCPU_CAP: '64', FARGATE_VCPU_CAP: '64', SUBNET_AZ_IDS: 'use1-az1,use1-az2,use1-az3',
};
const subnetAz = {};

before(async () => {
  if (skip) return;
  emulator = spawn('aws-emulator', ['-p', '0', '-a', 'off', '-t', 'off', '--idle-timeout', '300'], { stdio: ['ignore', 'pipe', 'inherit'] });
  // The startup line names the endpoint and its CA.
  for await (const line of readline.createInterface({ input: emulator.stdout })) {
    const m = line.startsWith('{') && JSON.parse(line).fields;
    if (m && m.endpoint_url) { endpoint = m.endpoint_url; ca = fs.readFileSync(m.ca_file); break; }
  }
  emulator.stdout.resume();

  const vpc = idIn(await ec2Call({ Action: 'CreateVpc', CidrBlock: '10.77.0.0/16' }), 'vpcId');
  const subnets = [];
  for (const [i, az] of env.SUBNET_AZ_IDS.split(',').entries()) {
    const id = idIn(await ec2Call({ Action: 'CreateSubnet', VpcId: vpc, CidrBlock: `10.77.${i}.0/24`, AvailabilityZoneId: az }), 'subnetId');
    subnets.push(id);
    subnetAz[id] = az;
  }
  env.SUBNET_IDS = subnets.join(',');
  env.SECURITY_GROUP_ID = idIn(await ec2Call({ Action: 'CreateSecurityGroup', VpcId: vpc, GroupName: 'ci-runner', GroupDescription: 'ci-runner' }), 'groupId');

  await ecsCall('CreateCluster', { clusterName: 'ci-runner', capacityProviders: ['FARGATE', 'FARGATE_SPOT'] });
  for (const [k, cpuArchitecture, family] of [['TASK_DEFINITION', 'X86_64', 'ci-runner-runner'], ['ARM64_TASK_DEFINITION', 'ARM64', 'ci-runner-runner-arm64']]) {
    const r = await ecsCall('RegisterTaskDefinition', {
      family, networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], cpu: '4096', memory: '16384',
      ephemeralStorage: { sizeInGiB: 50 }, runtimePlatform: { operatingSystemFamily: 'LINUX', cpuArchitecture },
      executionRoleArn: 'arn:aws:iam::000000000000:role/PowerUserPB-ci-runner-runner-exec',
      containerDefinitions: [{
        name: 'runner', image: '000000000000.dkr.ecr.us-east-1.amazonaws.com/ci-runner:latest', essential: true,
        entryPoint: ['/usr/local/bin/ci-runner-idle-exit'], command: ['./run.sh'], linuxParameters: { initProcessEnabled: true },
      }],
    });
    env[k] = r.taskDefinition.taskDefinitionArn;
  }
});

after(() => { if (emulator) emulator.kill('SIGTERM'); });

// GitHub, faked: the job is queued, the group exists, the JIT config mints.
function fakeFetch() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${new URL(url).pathname}`;
    calls.push(key);
    const res = (status, json) => ({ ok: status < 300, status, json: async () => json });
    if (key.endsWith('/access_tokens')) return res(201, { token: 't', expires_at: new Date(Date.now() + 3600e3).toISOString() });
    if (key.includes('/actions/jobs/')) return res(200, { status: 'queued' });
    if (key.endsWith('/runner-groups')) return res(200, { runner_groups: [{ id: 3, name: 'ci-runner' }] });
    if (key.endsWith('/generate-jitconfig')) return res(201, { runner: { id: 77 }, encoded_jit_config: 'ZW5jb2RlZGppdA==' });
    if (key.startsWith('DELETE ')) return res(204, null);
    throw new Error('unexpected ' + key);
  };
  return { fetch, calls };
}

const { privateKey } = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
function launcher(gh) {
  const logs = [];
  const handler = createHandler({
    secret: { get: async () => ({ app_id: 42, private_key: privateKey.export({ type: 'pkcs1', format: 'pem' }) }) },
    fetch: gh.fetch, ecs, ec2: {}, sqs: { sendMessage: async () => ({}) }, now: Date.now, env, log: (l) => logs.push(l),
  });
  return { handler, logs };
}
const job = (label, vcpus, arch, extra = {}) => ({ Records: [{ messageId: 'm0', body: JSON.stringify({
  repo: 'zeroae/app', job_id: 555, run_id: 444, head_sha: 'abc123', job_name: 'build (x64, release)',
  label, vcpus, arch, labels: ['self-hosted', label, `ci-cpu-${vcpus}`, arch], installation_id: 181, ...extra,
}) }] });

test('ECS accepts the launcher\'s RunTask for every Fargate capacity, size and architecture', { skip }, async () => {
  for (const [label, provider] of [['ci-fargate-spot', 'FARGATE_SPOT'], ['ci-fargate', 'FARGATE']]) {
    for (const vcpus of [2, 4, 8, 16]) {
      for (const arch of ['x64', 'arm64']) {
        const what = `${label} ${vcpus} ${arch}`;
        const { handler, logs } = launcher(fakeFetch());
        assert.deepEqual(await handler(job(label, vcpus, arch)), { batchItemFailures: [] }, `${what}: ${logs.join('\n')}`);
        const arn = JSON.parse(logs.find((l) => l.includes('"launched"'))).launched;
        const [task] = (await ecs.describeTasks({ cluster: 'ci-runner', tasks: [arn], include: ['TAGS'] })).tasks;
        assert.equal(task.capacityProviderName, provider, what);
        assert.equal(task.taskDefinitionArn, arch === 'arm64' ? env.ARM64_TASK_DEFINITION : env.TASK_DEFINITION, what);
        assert.deepEqual([task.overrides.cpu, task.overrides.memory], [String(vcpus * 1024), String(vcpus * 4096)], what);
        const tags = Object.fromEntries(task.tags.map((t) => [t.key, t.value]));
        assert.equal(tags['ci-runner:stack'], 'ci-runner', what);
        assert.equal(tags['ci-runner:vcpus'], String(vcpus), what);
        const subnet = task.attachments[0].details.find((d) => d.name === 'subnetId').value;
        if (arch === 'arm64') assert.notEqual(subnetAz[subnet], 'use1-az3', what);
      }
    }
  }
});

test('ECS refuses a size Fargate doesn\'t offer, and the launcher unregisters the runner', { skip }, async () => {
  // A 32-vCPU message can't come from the webhook; it stands in for any
  // RunTask that ECS refuses.
  const gh = fakeFetch();
  const { handler: h } = launcher(gh);
  const refused = await ecs.runTask({
    cluster: 'ci-runner', taskDefinition: env.TASK_DEFINITION, capacityProviderStrategy: [{ capacityProvider: 'FARGATE', weight: 1 }],
    networkConfiguration: { awsvpcConfiguration: { subnets: env.SUBNET_IDS.split(','), securityGroups: [env.SECURITY_GROUP_ID] } },
    overrides: { cpu: '2048', memory: '3000' },
  }).then(() => null, (e) => e);
  assert.match(String(refused), /InvalidParameterException/);
  // A capacity provider the cluster lacks fails the launcher's own call the same way.
  const saved = env.CLUSTER;
  await ecsCall('CreateCluster', { clusterName: 'no-providers' });
  env.CLUSTER = 'no-providers';
  try {
    assert.deepEqual(await h(job('ci-fargate-spot', 4, 'x64')), { batchItemFailures: [{ itemIdentifier: 'm0' }] });
  } finally { env.CLUSTER = saved; }
  assert.ok(gh.calls.includes('DELETE /orgs/zeroae/actions/runners/77'));
});

test('ECS refuses a comma in a tag, which the launcher\'s task tags never carry', { skip }, async () => {
  const err = await ecs.runTask({
    cluster: 'ci-runner', taskDefinition: env.TASK_DEFINITION, capacityProviderStrategy: [{ capacityProvider: 'FARGATE', weight: 1 }],
    networkConfiguration: { awsvpcConfiguration: { subnets: env.SUBNET_IDS.split(','), securityGroups: [env.SECURITY_GROUP_ID] } },
    tags: [{ key: 'ci-runner:labels', value: 'self-hosted,ci-fargate' }],
  }).then(() => null, (e) => e);
  assert.match(String(err), /invalid characters/);
});
