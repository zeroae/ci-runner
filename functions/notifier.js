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

// An EC2 (Key, Value) or ECS (key, value) tag list as an object,
// keyed without the ci-runner: prefix.
const tagsOf = (tags) => Object.fromEntries((tags || []).map((x) => [(x.Key ?? x.key).replace(/^ci-runner:/, ''), x.Value ?? x.value]));

// AWS warns just over 2 minutes before it takes a Spot machine, and the job
// can finish inside the warning. After posting, the notifier looks at the job
// WATCH_LOOKS times, WATCH_INTERVAL_MS apart: 150 s.
const WATCH_INTERVAL_MS = 10000;
const WATCH_LOOKS = 15;
const RECLAIMED_TITLE = 'Spot capacity reclaimed: re-run this job';
const SURVIVED_TITLE = 'The job finished despite the Spot reclaim warning';

function createHandler({ secret, fetch, sleep, ec2, ecs, now, env, log = console.log }) {
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
    let id, machine, t;
    if (d.taskArn) {
      // The event carries no tags; a stopped task is still described for an hour.
      id = d.taskArn.split('/').pop();
      machine = `task (${id})`;
      const task = (await ecs.describeTasks({ cluster: d.clusterArn, tasks: [d.taskArn], include: ['TAGS'] })).tasks?.[0];
      t = tagsOf(task?.tags);
    } else {
      id = d['instance-id'];
      machine = `instance (${id})`;
      const inst = id && (await ec2.describe(id)).Reservations?.[0]?.Instances?.[0];
      t = tagsOf(inst?.Tags);
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

    const jobPath = `/repos/${repo}/actions/jobs/${jobId}`;
    const ghJob = await gh('GET', jobPath, token);
    // A task's job-name tag has `_` for what ECS refuses (brackets, commas):
    // the check run carries the real name, from GitHub.
    const job = (d.taskArn && ghJob.name) || t['job-name'] || `job ${jobId}`;
    const run = `https://github.com/${repo}/actions/runs/${t['run-id']}`;
    const name = `ci-runner / ${job}`;
    // The commit's reclaim check run for this job, if it has one: a task's
    // reclaim matches on each of its changes, and EventBridge may repeat or
    // retry an event.
    const { check_runs: existing } = await gh('GET', `/repos/${repo}/commits/${t['head-sha']}/check-runs?filter=all&check_name=${encodeURIComponent(name)}`, token);
    const reported = existing.find((c) => c.external_id === jobId && c.output && [RECLAIMED_TITLE, SURVIVED_TITLE].includes(c.output.title));

    // A job that finishes with success was not lost: the check run no longer
    // asks for a re-run.
    async function clear(checkId) {
      await gh('PATCH', `/repos/${repo}/check-runs/${checkId}`, token, {
        conclusion: 'neutral',
        output: { title: SURVIVED_TITLE, summary: `AWS warned that it would reclaim the Spot ${machine} running \`${job}\`, but the job finished with success. No re-run is needed: ${run}` },
      });
      log(`survived ${id}: ${repo} job ${jobId}`);
    }

    if (reported) {
      // An earlier invocation's report, left standing because its watch ended
      // or failed: a job that has since finished with success clears it.
      if (reported.output.title === RECLAIMED_TITLE && ghJob.status === 'completed' && ghJob.conclusion === 'success') return clear(reported.id);
      return log(`already reported ${id}: ${repo} job ${jobId}`);
    }
    // Only a job this machine's CI runner is running can be lost with it. The
    // tags name the job the machine was launched for, or took in a swap (the
    // webhook re-tags it); a CI runner that took no job (another one served
    // its launch job) is idle, and a completed job is no loss.
    if (ghJob.status !== 'in_progress' || ghJob.runner_name !== t.runner) {
      return log(`ignored ${id}: its runner is not running job ${jobId} (${ghJob.status}, runner ${ghJob.runner_name || 'none'})`);
    }
    const { id: checkId } = await gh('POST', `/repos/${repo}/check-runs`, token, {
      name, head_sha: t['head-sha'], external_id: jobId,
      status: 'completed', conclusion: 'failure', completed_at: new Date(now()).toISOString(),
      details_url: `${run}/job/${jobId}`,
      output: {
        title: RECLAIMED_TITLE,
        summary: `AWS reclaimed the Spot ${machine} running \`${job}\`. Re-run the job: ${run}`,
      },
    });
    log(`reported ${id}: ${repo} job ${jobId}`);

    // Any other end of the job, or none in time, keeps the failure.
    for (let i = 0; i < WATCH_LOOKS; i++) {
      await sleep(WATCH_INTERVAL_MS);
      const latest = await gh('GET', jobPath, token);
      if (latest.status !== 'completed') continue;
      if (latest.conclusion === 'success') await clear(checkId);
      return;
    }
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
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ec2: { describe: (id) => ec2c.send(new EC2.DescribeInstancesCommand({ InstanceIds: [id] })) },
      ecs: { describeTasks: (i) => ecsc.send(new ECS.DescribeTasksCommand(i)) },
      now: Date.now,
      env: process.env,
    });
  }
  return live(event);
};
