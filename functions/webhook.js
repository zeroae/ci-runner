'use strict';
// webhook: GitHub workflow_job receiver behind a Function URL. Verifies the
// delivery, applies the label contract and fence 3, and enqueues the job for
// the launcher. It launches nothing itself. Inlined into the template; keep it
// one dependency-free CommonJS file.
const crypto = require('node:crypto');

const CAPACITY = ['ci-spot', 'ci-ondemand'];
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
// a default, so a swap only happens between runners of the same shape.
// Returns the job's shape, or null outside it.
function shape(labels) {
  const ls = (labels || []).map((l) => String(l).toLowerCase());
  const of = (set) => ls.filter((l) => set.includes(l));
  const caps = of(CAPACITY);
  const sizes = of(Object.keys(SIZE));
  const archs = of(ARCH);
  if (!ls.includes('self-hosted') || caps.length !== 1 || sizes.length !== 1 || archs.length !== 1) return null;
  const known = ['self-hosted', 'linux', ...CAPACITY, ...Object.keys(SIZE), ...ARCH];
  if (!ls.every((l) => known.includes(l))) return null;
  return { label: caps[0], vcpus: SIZE[sizes[0]], arch: archs[0] };
}

function createHandler({ secret, queue, env }) {
  let key; // the webhook secret, cached once the App exists

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
      console.log(JSON.stringify({ refused: repo.full_name, visibility: repo.visibility, job_id: job.id }));
      return reply(403, 'refused: only private repos of ' + env.GITHUB_ORG);
    }
    if (p.action !== 'queued') return reply(200, 'ignored: action');
    const sh = shape(job.labels);
    if (!sh) return reply(200, 'ignored: labels');

    const msg = {
      repo: repo.full_name, job_id: job.id, run_id: job.run_id, head_sha: job.head_sha,
      job_name: job.name, ...sh, labels: job.labels, installation_id: p.installation && p.installation.id,
    };
    await queue.send(msg);
    console.log(JSON.stringify({ enqueued: msg.repo, job_id: msg.job_id, ...sh }));
    return reply(202, 'enqueued');
  };
}

module.exports = { createHandler };

let live;
module.exports.handler = async (event) => {
  if (!live) {
    const sm = require('@aws-sdk/client-secrets-manager');
    const sqs = require('@aws-sdk/client-sqs');
    const smc = new sm.SecretsManagerClient({});
    const sqsc = new sqs.SQSClient({});
    live = createHandler({
      secret: { get: async () => JSON.parse((await smc.send(new sm.GetSecretValueCommand({ SecretId: process.env.SECRET_ARN }))).SecretString) },
      queue: { send: async (m) => { await sqsc.send(new sqs.SendMessageCommand({ QueueUrl: process.env.QUEUE_URL, MessageBody: JSON.stringify(m) })); } },
      env: process.env,
    });
  }
  return live(event);
};
