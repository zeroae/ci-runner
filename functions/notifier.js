'use strict';
// notifier: EventBridge, on an EC2 Spot Instance Interruption Warning or a
// Fargate Spot task's stop (ECS Task State Change, stopCode SpotInterruption).
// If the instance or task is this stack's and carries a job's launch tags (see
// launcher.js), it creates a failed check run on the job's commit through the App.
// The webhook also invokes it when a job of this stack's runners succeeds: a
// reclaim report for that job turns neutral.
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

const RECLAIMED_TITLE = 'Spot capacity reclaimed: re-run this job';
const SURVIVED_TITLE = 'The job finished despite the Spot reclaim warning';

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

  // An installation token for the repo. The webhook passes the installation id
  // it already has; an EventBridge event carries none.
  async function tokenFor(repo, installationId) {
    const s = await secret.get();
    if (!s.private_key) throw new Error('the App is not set up');
    const jwt = appJwt(s.app_id, s.private_key, now());
    const installation = installationId || (await gh('GET', `/repos/${repo}/installation`, jwt)).id;
    return (await gh('POST', `/app/installations/${installation}/access_tokens`, jwt)).token;
  }

  // The commit's reclaim check runs under a job's name. A task's reclaim
  // matches on each of its changes, and EventBridge may repeat or retry an
  // event: one check run per job is enough.
  async function reportsNamed(repo, token, sha, name) {
    const { check_runs: existing } = await gh('GET', `/repos/${repo}/commits/${sha}/check-runs?filter=all&check_name=${encodeURIComponent(name)}`, token);
    return existing.filter((c) => c.output && [RECLAIMED_TITLE, SURVIVED_TITLE].includes(c.output.title));
  }

  // A job that finished with success was not lost: its check run no longer
  // asks for a re-run.
  async function clear(repo, token, checkId, job, run) {
    await gh('PATCH', `/repos/${repo}/check-runs/${checkId}`, token, {
      conclusion: 'neutral',
      output: { title: SURVIVED_TITLE, summary: `AWS warned that it would reclaim the Spot machine running \`${job}\`, but the job finished with success. No re-run is needed: ${run}` },
    });
    log(`survived: ${repo} ${job}`);
  }

  // The webhook says a job of this stack's runners finished with success. A
  // job that had a reclaim report (AWS warns 2 minutes before it takes the
  // machine, and a job can finish inside that) is cleared. So is the report
  // of an earlier attempt of the job, which a re-run of the run left behind:
  // its details_url is under the same run.
  async function jobSucceeded(j) {
    const token = await tokenFor(j.repo, j.installation_id);
    const run = `https://github.com/${j.repo}/actions/runs/${j.run_id}`;
    const standing = (await reportsNamed(j.repo, token, j.head_sha, `ci-runner / ${j.job_name}`))
      .filter((c) => c.output.title === RECLAIMED_TITLE && (c.details_url || '').startsWith(`${run}/`));
    if (!standing.length) return log(`nothing to clear: ${j.repo} job ${j.job_id}`);
    for (const c of standing) await clear(j.repo, token, c.id, j.job_name, run);
  }

  return async (event) => {
    if (event.jobSucceeded) return jobSucceeded(event.jobSucceeded);
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

    const token = await tokenFor(repo);
    const jobPath = `/repos/${repo}/actions/jobs/${jobId}`;
    const ghJob = await gh('GET', jobPath, token);
    // The check run carries the job's real name, from GitHub, as the webhook's
    // word does: a task's job-name tag has `_` for what ECS refuses (brackets,
    // commas), and every tag is cut at 256 characters.
    const job = ghJob.name || t['job-name'] || `job ${jobId}`;
    const run = `https://github.com/${repo}/actions/runs/${t['run-id']}`;
    const name = `ci-runner / ${job}`;
    const finishedWithSuccess = (j) => j.status === 'completed' && j.conclusion === 'success';

    const reported = (await reportsNamed(repo, token, t['head-sha'], name)).find((c) => c.external_id === jobId);
    if (reported) {
      // An earlier event's report, left standing: the job finished with
      // success after the webhook's word, or before the report existed.
      if (reported.output.title === RECLAIMED_TITLE && finishedWithSuccess(ghJob)) return clear(repo, token, reported.id, job, run);
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
    // The job may have finished while this ran, and the webhook's word then
    // found no report to clear.
    if (finishedWithSuccess(await gh('GET', jobPath, token))) await clear(repo, token, checkId, job, run);
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
