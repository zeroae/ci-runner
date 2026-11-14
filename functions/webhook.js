'use strict';
// webhook: GitHub workflow_job receiver behind a Function URL. Verifies the
// delivery, applies the label contract and fence 3, and enqueues the job for
// the launcher. It launches nothing itself, but repairs swaps (ADR-0003).
// Inlined into the template; keep it one dependency-free CommonJS file.
const crypto = require('node:crypto');

const CAPACITY = ['ci-spot', 'ci-ondemand', 'ci-fargate-spot', 'ci-fargate'];
const SIZE = { 'ci-cpu-2': 2, 'ci-cpu-4': 4, 'ci-cpu-8': 8, 'ci-cpu-16': 16 };
const ARCH = ['x64', 'arm64'];
// The shape of an instance launched before the shape tags.
const DEFAULT_SHAPE = { vcpus: 4, arch: 'x64' };

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

// The job fields the instance or task carries, as tags.
const JOB_TAGS = { repo: 'repo', job_id: 'job-id', run_id: 'run-id', head_sha: 'head-sha', job_name: 'job-name' };
// ECS allows only these characters in a tag (EC2 allows any). A copy of the
// launcher's, so a re-tag reads as the launch did.
const ECS_TAG_CHARS = /[^\p{L}\p{Z}\p{N}_.:/=+\-@]/gu;
const ecsTag = ([key, v]) => ({ key, value: String(v).replace(ECS_TAG_CHARS, '_').slice(0, 256) });

function createHandler({ secret, queue, ec2, ecs, env, log = console.log }) {
  // The runner's task in the cluster, not yet told to stop, with its tags.
  async function findTask(name) {
    let nextToken;
    do {
      const r = await ecs.listTasks({ cluster: env.CLUSTER, desiredStatus: 'RUNNING', nextToken });
      if ((r.taskArns || []).length) {
        const d = await ecs.describeTasks({ cluster: env.CLUSTER, tasks: r.taskArns, include: ['TAGS'] });
        const t = (d.tasks || []).find((x) => (x.tags || []).some((g) => g.key === 'ci-runner:runner' && g.value === name));
        if (t) return t;
      }
      nextToken = r.nextToken;
    } while (nextToken);
    return undefined;
  }

  let key; // the webhook secret, cached once the App exists

  // A swap: a runner of this stack, named `${stack}-<stamp>-<job id>`, started
  // a job other than the one it was launched for. Re-queue that one, so the
  // launcher's "still queued?" check launches it a runner or drops it, and
  // re-tag the instance or task so the notifier names the job it runs.
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
    const task = !i && (await findTask(name));
    if (!i && !task) return reply(200, 'ignored: no instance or task');
    const t = Object.fromEntries(i
      ? (i.Tags || []).map((x) => [x.Key.replace(/^ci-runner:/, ''), x.Value])
      : (task.tags || []).map((x) => [x.key.replace(/^ci-runner:/, ''), x.value]));
    // Already re-tagged for this job: a duplicate delivery.
    if (!t['job-id'] || Number(t['job-id']) === job.id) return reply(200, 'ignored: no swap');

    const orig = {
      repo: t.repo, job_id: Number(t['job-id']), run_id: Number(t['run-id']), head_sha: t['head-sha'],
      job_name: t['job-name'], label: t.label, vcpus: Number(t.vcpus) || DEFAULT_SHAPE.vcpus, arch: t.arch || DEFAULT_SHAPE.arch,
      // A task's labels are space-joined: ECS refuses a comma in a tag.
      labels: t.labels ? t.labels.split(i ? ',' : ' ') : ['self-hosted', t.label],
      installation_id: p.installation && p.installation.id,
    };
    // Queue first: if the re-tag then fails, a redelivery still finds the
    // old tags and repairs again, rather than skip a job never re-queued.
    await queue.send(orig);
    const now = { repo: repo.full_name, job_id: job.id, run_id: job.run_id, head_sha: job.head_sha, job_name: job.name };
    const tags = Object.entries(JOB_TAGS).map(([f, k]) => [`ci-runner:${k}`, now[f]]);
    if (i) await ec2.createTags({ Resources: [i.InstanceId], Tags: tags.map(([Key, v]) => ({ Key, Value: String(v).slice(0, 256) })) });
    else await ecs.tagResource({ resourceArn: task.taskArn, tags: tags.map(ecsTag) });
    log(JSON.stringify({
      swap: name, ...(i ? { instance: i.InstanceId } : { task: task.taskArn }),
      took: { repo: now.repo, job_id: now.job_id }, requeued: { repo: orig.repo, job_id: orig.job_id },
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
    const sh = shape(job.labels);
    if (!sh) return reply(200, 'ignored: labels');

    const msg = {
      repo: repo.full_name, job_id: job.id, run_id: job.run_id, head_sha: job.head_sha,
      job_name: job.name, ...sh, labels: job.labels, installation_id: p.installation && p.installation.id,
    };
    await queue.send(msg);
    log(JSON.stringify({ enqueued: msg.repo, job_id: msg.job_id, ...sh }));
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
    const ECS = require('@aws-sdk/client-ecs');
    const ec2c = new EC2.EC2Client({});
    const ecsc = new ECS.ECSClient({});
    live = createHandler({
      secret: { get: async () => JSON.parse((await smc.send(new sm.GetSecretValueCommand({ SecretId: process.env.SECRET_ARN }))).SecretString) },
      queue: { send: async (m) => { await sqsc.send(new sqs.SendMessageCommand({ QueueUrl: process.env.QUEUE_URL, MessageBody: JSON.stringify(m) })); } },
      ec2: {
        describeInstances: (i) => ec2c.send(new EC2.DescribeInstancesCommand(i)),
        createTags: (i) => ec2c.send(new EC2.CreateTagsCommand(i)),
      },
      ecs: {
        listTasks: (i) => ecsc.send(new ECS.ListTasksCommand(i)),
        describeTasks: (i) => ecsc.send(new ECS.DescribeTasksCommand(i)),
        tagResource: (i) => ecsc.send(new ECS.TagResourceCommand(i)),
      },
      env: process.env,
    });
  }
  return live(event);
};
