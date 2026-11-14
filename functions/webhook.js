'use strict';
// webhook: GitHub workflow_job receiver behind a Function URL. Verifies the
// delivery, applies the label contract and fence 3, and enqueues the job for
// the launcher. It launches nothing itself, but repairs swaps (ADR-0003). Inlined into the template; keep it
// one dependency-free CommonJS file.
const crypto = require('node:crypto');

const CAPACITY = ['ci-spot', 'ci-ondemand'];
const DEFAULT_LABELS = ['linux', 'x64'];

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

// The label contract: `self-hosted`, exactly one capacity label, and nothing
// else but the runner's default labels. Returns the capacity label or null.
function capacityLabel(labels) {
  const ls = (labels || []).map((l) => String(l).toLowerCase());
  if (!ls.includes('self-hosted')) return null;
  const caps = ls.filter((l) => CAPACITY.includes(l));
  if (caps.length !== 1) return null;
  const rest = ls.filter((l) => l !== 'self-hosted' && !CAPACITY.includes(l));
  return rest.every((l) => DEFAULT_LABELS.includes(l)) ? caps[0] : null;
}

// The job fields the instance carries, as tags.
const JOB_TAGS = { repo: 'repo', job_id: 'job-id', run_id: 'run-id', head_sha: 'head-sha', job_name: 'job-name' };

function createHandler({ secret, queue, ec2, env, log = console.log }) {
  let key; // the webhook secret, cached once the App exists

  // A swap: a runner of this stack, named `${stack}-<stamp>-<job id>`, started
  // a job other than the one it was launched for. Re-queue that one, so the
  // launcher's "still queued?" check launches it a runner or drops it, and
  // re-tag the instance so the notifier and the sweeper name the job it runs.
  async function repairSwap(p, repo, job) {
    const name = String(job.runner_name || '');
    const m = name.match(/^(.+)-\d{14}-(\d+)$/);
    if (!m || m[1] !== env.STACK_NAME || Number(m[2]) === job.id) return reply(200, 'ignored: no swap');
    const r = await ec2.describeInstances({
      Filters: [
        { Name: 'tag:ci-runner:stack', Values: [env.STACK_NAME] },
        { Name: 'tag:ci-runner:runner', Values: [name] },
        { Name: 'instance-state-name', Values: ['pending', 'running'] },
      ],
    });
    const i = (r.Reservations || []).flatMap((x) => x.Instances || [])[0];
    if (!i) return reply(200, 'ignored: no instance');
    const t = Object.fromEntries((i.Tags || []).map((x) => [x.Key.replace(/^ci-runner:/, ''), x.Value]));
    // Already re-tagged for this job: a duplicate delivery.
    if (!t['job-id'] || Number(t['job-id']) === job.id) return reply(200, 'ignored: no swap');

    const orig = {
      repo: t.repo, job_id: Number(t['job-id']), run_id: Number(t['run-id']), head_sha: t['head-sha'],
      job_name: t['job-name'], label: t.label, labels: t.labels ? t.labels.split(',') : ['self-hosted', t.label],
      installation_id: p.installation && p.installation.id,
    };
    // Queue first: if the re-tag then fails, a redelivery still finds the
    // old tags and repairs again, rather than skip a job never re-queued.
    await queue.send(orig);
    const now = { repo: repo.full_name, job_id: job.id, run_id: job.run_id, head_sha: job.head_sha, job_name: job.name };
    await ec2.createTags({
      Resources: [i.InstanceId],
      Tags: Object.entries(JOB_TAGS).map(([f, k]) => ({ Key: `ci-runner:${k}`, Value: String(now[f]).slice(0, 256) })),
    });
    log(JSON.stringify({
      swap: name, instance: i.InstanceId, took: { repo: now.repo, job_id: now.job_id }, requeued: { repo: orig.repo, job_id: orig.job_id },
    }));
    return reply(202, 'swap repaired');
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
    if (p.action === 'in_progress') return repairSwap(p, repo, job);
    if (p.action !== 'queued') return reply(200, 'ignored: action');
    const label = capacityLabel(job.labels);
    if (!label) return reply(200, 'ignored: labels');

    const msg = {
      repo: repo.full_name, job_id: job.id, run_id: job.run_id, head_sha: job.head_sha,
      job_name: job.name, label, labels: job.labels, installation_id: p.installation && p.installation.id,
    };
    await queue.send(msg);
    log(JSON.stringify({ enqueued: msg.repo, job_id: msg.job_id, label }));
    return reply(202, 'enqueued');
  };
}

module.exports = { createHandler };

let live;
module.exports.handler = async (event) => {
  if (!live) {
    const sm = require('@aws-sdk/client-secrets-manager');
    const sqs = require('@aws-sdk/client-sqs');
    const EC2 = require('@aws-sdk/client-ec2');
    const smc = new sm.SecretsManagerClient({});
    const sqsc = new sqs.SQSClient({});
    const ec2c = new EC2.EC2Client({});
    live = createHandler({
      secret: { get: async () => JSON.parse((await smc.send(new sm.GetSecretValueCommand({ SecretId: process.env.SECRET_ARN }))).SecretString) },
      queue: { send: async (m) => { await sqsc.send(new sqs.SendMessageCommand({ QueueUrl: process.env.QUEUE_URL, MessageBody: JSON.stringify(m) })); } },
      ec2: {
        describeInstances: (i) => ec2c.send(new EC2.DescribeInstancesCommand(i)),
        createTags: (i) => ec2c.send(new EC2.CreateTagsCommand(i)),
      },
      env: process.env,
    });
  }
  return live(event);
};
