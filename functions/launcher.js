'use strict';
// launcher: consumes the queue the webhook fills. For each job: an App JWT, an
// installation token, a check that the job is still queued, a JIT config in
// the runner group, and one machine: on EC2 the #cloud-config and one instance
// from the launch template, on Fargate one task of the runner's task
// definition. Inlined into the template; the build bundles ./cloud-config.js.
const crypto = require('node:crypto');
const { renderCloudConfig } = require('./cloud-config.js');

const API = 'https://api.github.com';
// A size label's vCPUs -> the instance size, at 4 GB per vCPU, per family.
const SIZES = { 2: 'large', 4: 'xlarge', 8: '2xlarge', 16: '4xlarge' };
// An architecture -> its families, offered at every size in the stack's AZs.
const FAMILIES = { x64: ['m8i', 'm8a', 'm7i', 'm6i', 'm6a', 'm7a'], arm64: ['m7g', 'm6g', 'm8g'] };
const CAPACITY = { 'ci-spot': 'spot', 'ci-ondemand': 'on-demand', 'ci-fargate-spot': 'fargate-spot', 'ci-fargate': 'fargate' };
// A Fargate capacity's capacity provider.
const PROVIDER = { 'ci-fargate-spot': 'FARGATE_SPOT', 'ci-fargate': 'FARGATE' };
// Fargate offers no arm64 in this AZ, so arm64 tasks skip a subnet there.
const NO_ARM64_AZ = 'use1-az3';
// ECS allows only these characters in a tag (EC2 allows any). The webhook's
// re-tag carries a copy.
const ECS_TAG_CHARS = /[^\p{L}\p{Z}\p{N}_.:/=+\-@]/gu;
const ecsTag = ([key, v]) => ({ key, value: String(v).replace(ECS_TAG_CHARS, '_').slice(0, 256) });

// An EC2 (Key, Value) or ECS (key, value) tag list as an object.
const tagsOf = (tags) => Object.fromEntries((tags || []).map((x) => [x.Key ?? x.key, x.Value ?? x.value]));

const b64u = (s) => Buffer.from(s).toString('base64url');

function appJwt(appId, pem, nowMs) {
  const iat = Math.floor(nowMs / 1000) - 60; // GitHub allows for clock drift this way
  const data = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ iat, exp: iat + 540, iss: String(appId) }))}`;
  return `${data}.${crypto.sign('sha256', Buffer.from(data), pem).toString('base64url')}`;
}

// The shape of a message enqueued before the size labels (no vcpus or arch),
// and of an instance or task launched before the shape tags.
const DEFAULT_SHAPE = { vcpus: 4, arch: 'x64' };
const shapeOf = (m) => ({ vcpus: m.vcpus === undefined ? DEFAULT_SHAPE.vcpus : m.vcpus, arch: m.arch === undefined ? DEFAULT_SHAPE.arch : m.arch });

function valid(m, org) {
  return m && typeof m.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(m.repo) && m.repo.split('/')[0] === org
    && Number.isInteger(m.job_id) && Number.isInteger(m.installation_id) && m.label in CAPACITY
    && Array.isArray(m.labels) && Number.isInteger(shapeOf(m).vcpus) && Object.hasOwn(SIZES, shapeOf(m).vcpus)
    && Object.hasOwn(FAMILIES, shapeOf(m).arch);
}

function createHandler({ secret, fetch, ec2, ecs, sqs, now, env, log = console.log }) {
  const org = env.GITHUB_ORG;
  const subnets = env.SUBNET_IDS.split(',');
  const budgets = { spot: env.SPOT_VCPU_CAP, 'on-demand': env.ONDEMAND_VCPU_CAP, 'fargate-spot': env.FARGATE_SPOT_VCPU_CAP, fargate: env.FARGATE_VCPU_CAP };
  const tokens = new Map(); // installation id -> { token, until }
  let app;
  let groupId;

  async function gh(method, path, token, body) {
    const res = await fetch(API + path, {
      method, body: body && JSON.stringify(body),
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'ci-runner', authorization: `Bearer ${token}`, ...(body && { 'content-type': 'application/json' }) },
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`${method} ${path}: ${res.status} ${(json && json.message) || ''}`), { status: res.status });
    return json;
  }

  async function installationToken(id) {
    const c = tokens.get(id);
    if (c && c.until > now()) return c.token;
    if (!app) {
      const s = await secret.get();
      if (!s.private_key) throw new Error('the App is not set up');
      app = { id: s.app_id, key: s.private_key };
    }
    const r = await gh('POST', `/app/installations/${id}/access_tokens`, appJwt(app.id, app.key, now()));
    tokens.set(id, { token: r.token, until: Date.parse(r.expires_at) - 5 * 60e3 });
    return r.token;
  }

  async function runnerGroup(token) {
    if (groupId) return groupId;
    for (let page = 1; ; page++) {
      const r = await gh('GET', `/orgs/${org}/actions/runner-groups?per_page=100&page=${page}`, token);
      const g = r.runner_groups.find((x) => x.name === env.RUNNER_GROUP);
      if (g) return (groupId = g.id);
      if (r.runner_groups.length < 100) throw new Error(`no runner group named ${env.RUNNER_GROUP}`);
    }
  }

  // vCPUs of this stack's live instances on one capacity, from the shape tags.
  // An instance launched before them has no tags: it has the default shape's
  // vCPUs, and its capacity is Spot only with the Spot marker (On-Demand has
  // no InstanceLifecycle).
  async function vcpusIn(type) {
    let n = 0;
    let NextToken;
    do {
      const r = await ec2.describeInstances({
        Filters: [
          { Name: 'tag:ci-runner:stack', Values: [env.STACK_NAME] },
          { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] },
        ],
        NextToken,
      });
      for (const res of r.Reservations || []) {
        for (const i of res.Instances || []) {
          const t = tagsOf(i.Tags);
          const capacity = CAPACITY[t['ci-runner:capacity']] || (i.InstanceLifecycle === 'spot' ? 'spot' : 'on-demand');
          if (capacity === type) n += Number(t['ci-runner:vcpus']) || DEFAULT_SHAPE.vcpus;
        }
      }
      NextToken = r.NextToken;
    } while (NextToken);
    return n;
  }

  // The tags a runner's instance or task carries: the job, for the swap
  // repair and the notifier, and the shape, for the budgets.
  function jobTags(m, name, runnerId, labelsSep) {
    const { vcpus, arch } = shapeOf(m);
    return [
      ['ci-runner:runner', name], ['ci-runner:runner-id', runnerId], ['ci-runner:label', m.label], ['ci-runner:repo', m.repo],
      ['ci-runner:job-id', m.job_id], ['ci-runner:run-id', m.run_id], ['ci-runner:head-sha', m.head_sha],
      ['ci-runner:job-name', m.job_name], ['ci-runner:labels', m.labels.join(labelsSep)],
      ['ci-runner:capacity', m.label], ['ci-runner:vcpus', vcpus], ['ci-runner:arch', arch],
    ];
  }

  // One Fargate task. The image's entrypoint (ci-runner-idle-exit, named by
  // the task definition) runs the command and gives it the idle exit.
  async function launchTask(m, name, runnerId, jitConfig) {
    const { vcpus, arch } = shapeOf(m);
    const azs = env.SUBNET_AZ_IDS.split(',');
    // Inside a task nproc can report the host's CPUs, not the task's, so
    // tools that size their parallelism from it get the task's vCPUs here.
    // The runner's environment reaches every step. No CARGO* or CMAKE*
    // variable: Swatinem/rust-cache hashes them into its key, and a Fargate
    // job would miss the cache an EC2 job saved. The image's entrypoint turns
    // CI_RUNNER_VCPUS into cargo's jobs in ~/.cargo/config.toml instead.
    const environment = [['CI_RUNNER_VCPUS', vcpus], ['MAKEFLAGS', `-j${vcpus}`],
      ...(env.IDLE_SECONDS ? [['IDLE_SECONDS', env.IDLE_SECONDS]] : [])].map(([n, v]) => ({ name: n, value: String(v) }));
    const r = await ecs.runTask({
      cluster: env.CLUSTER, count: 1,
      taskDefinition: arch === 'arm64' ? env.ARM64_TASK_DEFINITION : env.TASK_DEFINITION,
      capacityProviderStrategy: [{ capacityProvider: PROVIDER[m.label], weight: 1 }],
      networkConfiguration: { awsvpcConfiguration: {
        subnets: subnets.filter((s, i) => arch !== 'arm64' || azs[i] !== NO_ARM64_AZ),
        securityGroups: [env.SECURITY_GROUP_ID], assignPublicIp: 'ENABLED',
      } },
      overrides: {
        cpu: String(vcpus * 1024), memory: String(vcpus * 4096),
        containerOverrides: [{ name: 'runner', command: ['./run.sh', '--jitconfig', jitConfig], environment }],
      },
      // Labels joined by spaces: ECS refuses a comma in a tag.
      tags: [['ci-runner:stack', env.STACK_NAME], ...jobTags(m, name, runnerId, ' ')].map(ecsTag),
    });
    const arn = r.tasks && r.tasks[0] && r.tasks[0].taskArn;
    if (!arn) {
      const errs = [...new Set((r.failures || []).map((f) => `${f.reason}${f.detail ? `: ${f.detail}` : ''}`))];
      throw new Error(`no task launched: ${errs.join('; ') || 'no failure given'}`);
    }
    return arn;
  }

  // vCPUs of the cluster's tasks on one Fargate capacity, from the shape
  // tags. A task counts until it is STOPPED: one told to stop (desired
  // STOPPED) still holds its vCPUs while it deprovisions.
  async function taskVcpusIn(type) {
    let n = 0;
    for (const desiredStatus of ['RUNNING', 'STOPPED']) {
      let nextToken;
      do {
        const r = await ecs.listTasks({ cluster: env.CLUSTER, desiredStatus, nextToken });
        if ((r.taskArns || []).length) {
          const d = await ecs.describeTasks({ cluster: env.CLUSTER, tasks: r.taskArns, include: ['TAGS'] });
          for (const task of d.tasks || []) {
            const t = tagsOf(task.tags);
            if (task.lastStatus !== 'STOPPED' && CAPACITY[t['ci-runner:capacity']] === type) n += Number(t['ci-runner:vcpus']) || DEFAULT_SHAPE.vcpus;
          }
        }
        nextToken = r.nextToken;
      } while (nextToken);
    }
    return n;
  }

  async function launchInstance(m, name, runnerId, jitConfig) {
    const { vcpus, arch } = shapeOf(m);
    // Each architecture has its own launch template, for its own AL2023 image.
    const lt = arch === 'arm64' ? env.ARM64_LAUNCH_TEMPLATE_ID : env.LAUNCH_TEMPLATE_ID;
    const userData = renderCloudConfig({ jitConfig, ...(env.IDLE_SECONDS ? { idleSeconds: Number(env.IDLE_SECONDS) } : {}) });
    // CreateFleet can't override user-data: a version per launch carries it.
    const v = await ec2.createLaunchTemplateVersion({
      LaunchTemplateId: lt, SourceVersion: '$Default', VersionDescription: name,
      LaunchTemplateData: { UserData: Buffer.from(userData).toString('base64') },
    });
    const version = String(v.LaunchTemplateVersion.VersionNumber);
    const type = CAPACITY[m.label];
    const tag = (Key, Value) => ({ Key, Value: String(Value).slice(0, 256) });
    try {
      const fleet = await ec2.createFleet({
        Type: 'instant',
        TargetCapacitySpecification: { TotalTargetCapacity: 1, DefaultTargetCapacityType: type },
        ...(type === 'spot' ? { SpotOptions: { AllocationStrategy: 'capacity-optimized' } } : { OnDemandOptions: { AllocationStrategy: 'lowest-price' } }),
        LaunchTemplateConfigs: [{
          LaunchTemplateSpecification: { LaunchTemplateId: lt, Version: version },
          Overrides: FAMILIES[arch].flatMap((f) => subnets.map((SubnetId) => ({ InstanceType: `${f}.${SIZES[vcpus]}`, SubnetId }))),
        }],
        TagSpecifications: [{
          ResourceType: 'instance',
          Tags: jobTags(m, name, runnerId, ',').map(([k, v]) => tag(k, v)),
        }],
      });
      const id = fleet.Instances && fleet.Instances[0] && fleet.Instances[0].InstanceIds[0];
      if (!id) {
        const errs = [...new Set((fleet.Errors || []).map((e) => `${e.ErrorCode}: ${e.ErrorMessage}`))];
        throw new Error(`no instance launched: ${errs.join('; ') || 'no error given'}`);
      }
      return id;
    } finally {
      await ec2.deleteLaunchTemplateVersions({ LaunchTemplateId: lt, Versions: [version] });
    }
  }

  async function handle(m) {
    const job = { repo: m.repo, job_id: m.job_id };
    const token = await installationToken(m.installation_id);
    const j = await gh('GET', `/repos/${m.repo}/actions/jobs/${m.job_id}`, token).catch((e) => { if (e.status !== 404) throw e; });
    if (!j) return log(JSON.stringify({ ...job, dropped: 'job not found' }));
    if (j.status !== 'queued') return log(JSON.stringify({ ...job, dropped: j.status }));

    // A soft budget: launches checked at the same moment may overshoot it. A
    // job that would go over it goes back on the queue as a new message, so
    // retries don't pile up towards the dead-letter queue.
    const type = CAPACITY[m.label];
    const budget = Number(budgets[type]);
    const held = await (PROVIDER[m.label] ? taskVcpusIn(type) : vcpusIn(type));
    const { vcpus } = shapeOf(m);
    if (held + vcpus > budget) {
      await sqs.sendMessage({ QueueUrl: env.QUEUE_URL, MessageBody: JSON.stringify(m), DelaySeconds: 60 });
      return log(JSON.stringify({ ...job, deferred: `${held}+${vcpus} of ${budget} ${type} vCPUs` }));
    }

    // The sweeper reads the UTC mint stamp in the name as the registration's
    // grace period, and matches the runner to its instance by these tags.
    const stamp = new Date(now()).toISOString().replace(/\D/g, '').slice(0, 14);
    const name = `${env.STACK_NAME}-${stamp}-${m.job_id}`;
    const r = await gh('POST', `/orgs/${org}/actions/runners/generate-jitconfig`, token, {
      name, runner_group_id: await runnerGroup(token), labels: m.labels, work_folder: '_work',
    });

    try {
      const launch = PROVIDER[m.label] ? launchTask : launchInstance;
      const machine = await launch(m, name, r.runner.id, r.encoded_jit_config);
      log(JSON.stringify({ ...job, launched: machine, runner: name, label: m.label, ...shapeOf(m) }));
    } catch (e) {
      // Unregister now rather than leave it to the sweeper; the retry mints anew.
      await gh('DELETE', `/orgs/${org}/actions/runners/${r.runner.id}`, token).catch(() => {});
      throw e;
    }
  }

  return async (event) => {
    const batchItemFailures = [];
    for (const rec of event.Records || []) {
      let m;
      try { m = JSON.parse(rec.body); } catch { m = null; }
      if (!valid(m, org)) { log(JSON.stringify({ dropped: 'malformed message', messageId: rec.messageId })); continue; }
      try {
        await handle(m);
      } catch (e) {
        log(JSON.stringify({ repo: m.repo, job_id: m.job_id, error: String(e.message || e) }));
        batchItemFailures.push({ itemIdentifier: rec.messageId });
      }
    }
    return { batchItemFailures };
  };
}

module.exports = { createHandler };

let live;
module.exports.handler = async (event) => {
  if (!live) {
    const sm = require('@aws-sdk/client-secrets-manager');
    const EC2 = require('@aws-sdk/client-ec2');
    const SQS = require('@aws-sdk/client-sqs');
    const ECS = require('@aws-sdk/client-ecs');
    const sqsc = new SQS.SQSClient({});
    const ecsc = new ECS.ECSClient({});
    const smc = new sm.SecretsManagerClient({});
    const ec2c = new EC2.EC2Client({});
    live = createHandler({
      secret: { get: async () => JSON.parse((await smc.send(new sm.GetSecretValueCommand({ SecretId: process.env.SECRET_ARN }))).SecretString) },
      fetch: globalThis.fetch,
      ec2: {
        createLaunchTemplateVersion: (i) => ec2c.send(new EC2.CreateLaunchTemplateVersionCommand(i)),
        createFleet: (i) => ec2c.send(new EC2.CreateFleetCommand(i)),
        deleteLaunchTemplateVersions: (i) => ec2c.send(new EC2.DeleteLaunchTemplateVersionsCommand(i)),
        describeInstances: (i) => ec2c.send(new EC2.DescribeInstancesCommand(i)),
      },
      ecs: {
        runTask: (i) => ecsc.send(new ECS.RunTaskCommand(i)),
        listTasks: (i) => ecsc.send(new ECS.ListTasksCommand(i)),
        describeTasks: (i) => ecsc.send(new ECS.DescribeTasksCommand(i)),
      },
      sqs: { sendMessage: (i) => sqsc.send(new SQS.SendMessageCommand(i)) },
      now: Date.now,
      env: process.env,
    });
  }
  return live(event);
};
