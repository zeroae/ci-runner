'use strict';
// notifier: EventBridge, on an EC2 Spot Instance Interruption Warning or a
// Fargate Spot task's stop (ECS Task State Change, stopCode SpotInterruption).
// If the instance or task is this stack's and carries a job's launch tags (see
// launcher.js), it creates a failed check run on the job's commit through the App.
// The App JWT is a copy of the launcher's: bundling a shared module would cost
// more template bytes than the copy does.
const crypto = require('node:crypto');

const API = 'https://api.github.com';
const b64u = (s) => Buffer.from(s).toString('base64url');

function appJwt(appId, pem, nowMs) {
  const iat = Math.floor(nowMs / 1000) - 60; // GitHub allows for clock drift this way
  const data = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ iat, exp: iat + 540, iss: String(appId) }))}`;
  return `${data}.${crypto.sign('sha256', Buffer.from(data), pem).toString('base64url')}`;
}

function createHandler({ secret, fetch, ec2, ecs, now, env, log = console.log }) {
  async function gh(method, path, token, body) {
    const res = await fetch(API + path, {
      method, body: body && JSON.stringify(body),
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'ci-runner', authorization: `Bearer ${token}`, ...(body && { 'content-type': 'application/json' }) },
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`${method} ${path}: ${res.status} ${(json && json.message) || ''}`), { status: res.status });
    return json;
  }

  return async (event) => {
    const d = event.detail || {};
    const t = {};
    let id, machine;
    if (d.taskArn) {
      // The event carries no tags; a stopped task is still described for an hour.
      id = d.taskArn.split('/').pop();
      machine = `task (${id})`;
      const task = (await ecs.describeTasks({ cluster: d.clusterArn, tasks: [d.taskArn], include: ['TAGS'] })).tasks?.[0];
      for (const { key, value } of task?.tags || []) t[key.replace('ci-runner:', '')] = value;
    } else {
      id = d['instance-id'];
      machine = `instance (${id})`;
      const inst = id && (await ec2.describe(id)).Reservations?.[0]?.Instances?.[0];
      for (const { Key, Value } of inst?.Tags || []) t[Key.replace('ci-runner:', '')] = Value;
    }
    const repo = t.repo || '';
    const jobId = t['job-id'];
    if (t.stack !== env.STACK_NAME || !t['head-sha'] || !jobId || repo.split('/')[0] !== env.GITHUB_ORG) {
      return log(`ignored: ${id} is no job ${d.taskArn ? 'task' : 'instance'} of this stack`);
    }

    const s = await secret.get();
    if (!s.private_key) throw new Error('the App is not set up');
    const jwt = appJwt(s.app_id, s.private_key, now());
    const { id: installation } = await gh('GET', `/repos/${repo}/installation`, jwt);
    const { token } = await gh('POST', `/app/installations/${installation}/access_tokens`, jwt);

    // A task's job-name tag has `_` for what ECS refuses (brackets, commas):
    // the check run carries the real name, from GitHub.
    const real = d.taskArn && (await gh('GET', `/repos/${repo}/actions/jobs/${jobId}`, token).catch(() => null));
    const job = (real && real.name) || t['job-name'] || `job ${jobId}`;
    const run = `https://github.com/${repo}/actions/runs/${t['run-id']}`;
    const name = `ci-runner / ${job}`;
    const title = 'Spot capacity reclaimed: re-run this job';
    // A task's reclaim matches on each of its changes, and EventBridge may
    // repeat an event: one check run per job is enough.
    const { check_runs: done } = await gh('GET', `/repos/${repo}/commits/${t['head-sha']}/check-runs?filter=all&check_name=${encodeURIComponent(name)}`, token);
    if (done.some((c) => c.external_id === jobId && c.output && c.output.title === title)) return log(`already reported ${id}: ${repo} job ${jobId}`);
    await gh('POST', `/repos/${repo}/check-runs`, token, {
      name, head_sha: t['head-sha'], external_id: jobId,
      status: 'completed', conclusion: 'failure', completed_at: new Date(now()).toISOString(),
      details_url: `${run}/job/${jobId}`,
      output: {
        title,
        summary: `AWS reclaimed the Spot ${machine} running \`${job}\`. Re-run the job: ${run}`,
      },
    });
    log(`reported ${id}: ${repo} job ${jobId}`);
  };
}

module.exports = { createHandler };

let live;
module.exports.handler = async (event) => {
  if (!live) {
    const sm = require('@aws-sdk/client-secrets-manager');
    const EC2 = require('@aws-sdk/client-ec2');
    const smc = new sm.SecretsManagerClient({});
    const ECS = require('@aws-sdk/client-ecs');
    const ec2c = new EC2.EC2Client({});
    const ecsc = new ECS.ECSClient({});
    live = createHandler({
      secret: { get: async () => JSON.parse((await smc.send(new sm.GetSecretValueCommand({ SecretId: process.env.SECRET_ARN }))).SecretString) },
      fetch,
      ec2: { describe: (id) => ec2c.send(new EC2.DescribeInstancesCommand({ InstanceIds: [id] })) },
      ecs: { describeTasks: (i) => ecsc.send(new ECS.DescribeTasksCommand(i)) },
      now: Date.now,
      env: process.env,
    });
  }
  return live(event);
};
