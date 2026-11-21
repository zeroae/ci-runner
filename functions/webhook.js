'use strict';
// webhook: GitHub workflow_job receiver behind a Function URL. Verifies the
// delivery, applies the label contract, the job label (ADR-0004) and fence 3,
// and enqueues the job for the launcher. It launches nothing itself, but
// logs a runner that runs another job than its own, which the job label
// should make impossible, and tells the notifier when a job of this stack's
// runners succeeds.
// Inlined into the template; keep it one dependency-free CommonJS file.
const crypto = require('node:crypto');

const CAPACITY = ['ci-spot', 'ci-ondemand', 'ci-fargate-spot', 'ci-fargate'];
const SIZE = { 'ci-cpu-2': 2, 'ci-cpu-4': 4, 'ci-cpu-8': 8, 'ci-cpu-16': 16 };
const ARCH = ['x64', 'arm64'];

function reply(statusCode, text) {
  return { statusCode, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: text + '\n' };
}

function header(event, name) {
  const h = event.headers || {};
  for (const k of Object.keys(h)) if (k.toLowerCase() === name) return h[k];
  return undefined;
}

function signatureOk(key, raw, sig) {
  if (typeof sig !== 'string' || !sig.startsWith('sha256=')) return false;
  const want = crypto.createHmac('sha256', key).update(raw).digest();
  const got = Buffer.from(sig.slice(7), 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// The label contract: `self-hosted`, exactly one capacity label, exactly one
// size label, exactly one architecture label, and optionally `linux`. None has
// a default. The job label, checked by jobLabelFault after, is no part of the
// shape.
// Returns the job's shape, or null outside it.
function shapeOf(labels) {
  const ls = (labels || []).filter((l) => !isJobLabel(l)).map((l) => String(l).toLowerCase());
  const of = (set) => ls.filter((l) => set.includes(l));
  const capacities = of(CAPACITY);
  const sizes = of(Object.keys(SIZE));
  const archs = of(ARCH);
  if (!ls.includes('self-hosted') || capacities.length !== 1 || sizes.length !== 1 || archs.length !== 1) return null;
  const known = ['self-hosted', 'linux', ...CAPACITY, ...Object.keys(SIZE), ...ARCH];
  if (!ls.every((l) => known.includes(l))) return null;
  return { capacity: capacities[0], vcpus: SIZE[sizes[0]], arch: archs[0] };
}

// The job label (ADR-0004), `ci-job-<run_id>-<run_attempt>-<job key>-<matrix
// index>`: unique to one job, so the runner launched for the job, which
// registers with the job's labels, can take no other. Required: GitHub gives
// a job to any runner whose labels include all of the job's, so a job without
// one could take any runner of its shape (a swap). Returns why a job's job
// label breaks it, as { label, why }, or null; the handler checks first that
// it has one.
const isJobLabel = (l) => String(l).toLowerCase().startsWith('ci-job-');
function jobLabelFault(labels, job) {
  const ls = (labels || []).filter(isJobLabel).map(String);
  if (ls.length > 1) return { label: ls.join(','), why: 'two job labels' };
  const label = ls[0];
  const m = label.toLowerCase().match(/^ci-job-(\d+)-(\d+)-(.*)$/);
  if (!m) return { label, why: 'job label without its run and attempt' };
  const [, run, attempt, rest] = m;
  if (run !== String(job.run_id)) return { label, why: 'job label of another run' };
  if (attempt !== String(job.run_attempt)) return { label, why: 'job label of another attempt' };
  if (!rest) return { label, why: 'job label names no job' };
  // GitHub refuses a longer runner label, and cuts a 256-character one to
  // 255, so the runner would not carry it (generate-jitconfig, 2026-11-20).
  if (label.length > 255) return { label, why: 'job label over 255 characters' };
  return null;
}

function createHandler({ secret, queue, notifier, env, log = console.log }) {
  let key; // the webhook secret, cached once the App exists

  // The job id a runner of this stack was launched for, from its name
  // `${stack}-<14-digit stamp>-<job id>`; null for any other runner.
  function launchJobOf(runnerName) {
    const m = String(runnerName || '').match(/^(.+)-\d{14}-(\d+)$/);
    return m && m[1] === env.STACK_NAME ? Number(m[2]) : null;
  }

  // A job on a runner of this stack launched for another job: a swap, which
  // the job label should make impossible (ADR-0004). It is logged, not
  // repaired; if the runner's own job is stranded, the launcher's re-check
  // (#51) launches it another runner.
  function checkRunner(repo, job) {
    const launchedFor = launchJobOf(job.runner_name);
    if (launchedFor === null || launchedFor === job.id) return reply(200, 'ignored: no swap');
    log(JSON.stringify({
      anomaly: 'runner of another job', runner: job.runner_name, launched_for: launchedFor,
      took: { repo: repo.full_name, job_id: job.id },
    }));
    return reply(200, 'logged: runner of another job');
  }

  // A job that finished with success on a runner of this stack. The notifier
  // clears its reclaim report for the job, if the job had one: AWS warns 2
  // minutes before it takes a Spot machine, and a job can finish inside that.
  async function reportSuccess(p, repo, job) {
    if (job.conclusion !== 'success' || launchJobOf(job.runner_name) === null) return reply(200, 'ignored: not a success of ours');
    await notifier.send({ jobSucceeded: {
      repo: repo.full_name, job_id: job.id, run_id: job.run_id, head_sha: job.head_sha, job_name: job.name,
      installation_id: p.installation && p.installation.id,
    } });
    return reply(202, 'notifier told');
  }

  return async (event) => {
    if (!key) key = (await secret.get()).webhook_secret;
    if (!key) return reply(503, 'not set up');

    const raw = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8');
    if (!signatureOk(key, raw, header(event, 'x-hub-signature-256'))) return reply(401, 'bad signature');

    if (header(event, 'x-github-event') !== 'workflow_job') return reply(200, 'ignored: event');
    let p;
    try { p = JSON.parse(raw.toString('utf8')); } catch { return reply(400, 'bad json'); }
    const repo = p.repository || {};
    const job = p.workflow_job || {};

    // Fence 3: whatever the App installation and the runner group say.
    if (repo.visibility !== 'private' || !repo.owner || repo.owner.login !== env.GITHUB_ORG) {
      log(JSON.stringify({ refused: repo.full_name, visibility: repo.visibility, job_id: job.id }));
      return reply(403, 'refused: only private repos of ' + env.GITHUB_ORG);
    }
    if (p.action === 'in_progress') return checkRunner(repo, job);
    if (p.action === 'completed') return reportSuccess(p, repo, job);
    if (p.action !== 'queued') return reply(200, 'ignored: action');
    const shape = shapeOf(job.labels);
    if (!shape) return reply(200, 'ignored: labels');
    // A job with no job label breaks the label contract, as one with no size
    // does, but its own repo's workflow is waiting on it: say so in the log.
    if (!job.labels.some(isJobLabel)) {
      log(JSON.stringify({ ignored: repo.full_name, job_id: job.id, why: 'no job label' }));
      return reply(200, 'ignored: labels');
    }
    const fault = jobLabelFault(job.labels, job);
    if (fault) {
      log(JSON.stringify({ ignored: repo.full_name, job_id: job.id, ...fault }));
      return reply(200, 'ignored: job label');
    }

    // The shape as the queue message carries it. The message's `label` is the
    // capacity label, as queued messages carry it.
    const queuedShape = { label: shape.capacity, vcpus: shape.vcpus, arch: shape.arch };
    const msg = {
      repo: repo.full_name, job_id: job.id, run_id: job.run_id, head_sha: job.head_sha,
      job_name: job.name, ...queuedShape, labels: job.labels, installation_id: p.installation && p.installation.id,
    };
    await queue.send(msg);
    log(JSON.stringify({ enqueued: msg.repo, job_id: msg.job_id, ...queuedShape }));
    return reply(202, 'enqueued');
  };
}

module.exports = { createHandler };

let live;
module.exports.handler = async (event) => {
  if (!live) {
    const sm = require('@aws-sdk/client-secrets-manager');
    const sqs = require('@aws-sdk/client-sqs');
    const LAMBDA = require('@aws-sdk/client-lambda');
    const smc = new sm.SecretsManagerClient({});
    const sqsc = new sqs.SQSClient({});
    const lambdac = new LAMBDA.LambdaClient({});
    live = createHandler({
      secret: { get: async () => JSON.parse((await smc.send(new sm.GetSecretValueCommand({ SecretId: process.env.SECRET_ARN }))).SecretString) },
      queue: { send: async (m) => { await sqsc.send(new sqs.SendMessageCommand({ QueueUrl: process.env.QUEUE_URL, MessageBody: JSON.stringify(m) })); } },
      notifier: {
        send: async (m) => { await lambdac.send(new LAMBDA.InvokeCommand({ FunctionName: process.env.NOTIFIER_FUNCTION, InvocationType: 'Event', Payload: JSON.stringify(m) })); },
      },
      env: process.env,
    });
  }
  return live(event);
};
