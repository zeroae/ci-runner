'use strict';
// aws/aws-emulator (https://github.com/aws/aws-emulator), for the tests that
// need AWS's real API shapes: it validates a request as the service does and
// answers as it would. Not a test file itself (`make test` runs *.test.js).
// A test is skipped when `aws-emulator` isn't installed, unless
// REQUIRE_AWS_EMULATOR is set (CI sets it).
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const readline = require('node:readline');

const installed = spawnSync('aws-emulator', ['-v']).status === 0;
if (!installed && process.env.REQUIRE_AWS_EMULATOR) throw new Error('aws-emulator is not installed');
const skip = !installed && 'aws-emulator is not installed';

const auth = (service) => `AWS4-HMAC-SHA256 Credential=test/20261112/us-east-1/${service}/aws4_request, SignedHeaders=host, Signature=0`;

// Starts one emulator; `stop()` it after the tests.
async function startEmulator() {
  const proc = spawn('aws-emulator', ['-p', '0', '-a', 'off', '-t', 'off', '--idle-timeout', '300'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let endpoint;
  let ca;
  // The startup line names the endpoint and its CA.
  for await (const line of readline.createInterface({ input: proc.stdout })) {
    const m = line.startsWith('{') && JSON.parse(line).fields;
    if (m && m.endpoint_url) { endpoint = m.endpoint_url; ca = fs.readFileSync(m.ca_file); break; }
  }
  proc.stdout.resume();

  // One request; `headers` pick the protocol.
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

  // A JSON-protocol service, as the SDK's clients send it.
  const json = (service, target, version) => async (op, input) => {
    const r = await call(JSON.stringify(input), {
      'content-type': `application/x-amz-json-${version}`, 'x-amz-target': `${target}.${op}`, authorization: auth(service),
    });
    const out = JSON.parse(r.text || '{}');
    if (r.status >= 300) throw Object.assign(new Error(`${out.__type}: ${out.message || out.Message}`), { name: out.__type });
    return out;
  };

  // EC2 speaks the query protocol; it answers XML.
  async function ec2(params) {
    const r = await call(new URLSearchParams({ Version: '2016-11-15', ...params }).toString(), {
      'content-type': 'application/x-www-form-urlencoded', authorization: auth('ec2'),
    });
    if (r.status >= 300) throw new Error(r.text);
    return r.text;
  }

  return {
    ecs: json('ecs', 'AmazonEC2ContainerServiceV20141113', '1.1'),
    events: json('events', 'AWSEvents', '1.1'),
    sqs: json('sqs', 'AmazonSQS', '1.0'),
    ec2,
    stop: () => proc.kill('SIGTERM'),
  };
}

const idIn = (xml, tag) => xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))[1];

// The stack's network as template.yaml makes it, for a task's awsvpc
// configuration: three subnets in these AZs and a security group.
async function network(aws, azs) {
  const vpc = idIn(await aws.ec2({ Action: 'CreateVpc', CidrBlock: '10.77.0.0/16' }), 'vpcId');
  const subnets = [];
  for (const [i, az] of azs.entries()) {
    subnets.push(idIn(await aws.ec2({ Action: 'CreateSubnet', VpcId: vpc, CidrBlock: `10.77.${i}.0/24`, AvailabilityZoneId: az }), 'subnetId'));
  }
  const sg = idIn(await aws.ec2({ Action: 'CreateSecurityGroup', VpcId: vpc, GroupName: 'ci-runner', GroupDescription: 'ci-runner' }), 'groupId');
  return { subnets, sg };
}

// The runner's task definition as template.yaml makes it.
async function taskDefinition(aws, family, cpuArchitecture) {
  const r = await aws.ecs('RegisterTaskDefinition', {
    family, networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], cpu: '4096', memory: '16384',
    ephemeralStorage: { sizeInGiB: 50 }, runtimePlatform: { operatingSystemFamily: 'LINUX', cpuArchitecture },
    executionRoleArn: 'arn:aws:iam::000000000000:role/PowerUserPB-ci-runner-runner-exec',
    containerDefinitions: [{
      name: 'runner', image: '000000000000.dkr.ecr.us-east-1.amazonaws.com/ci-runner:latest', essential: true,
      entryPoint: ['/usr/local/bin/ci-runner-idle-exit'], command: ['./run.sh'], linuxParameters: { initProcessEnabled: true },
    }],
  });
  return r.taskDefinition.taskDefinitionArn;
}

module.exports = { skip, startEmulator, network, taskDefinition };
