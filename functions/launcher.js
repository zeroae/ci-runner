'use strict';
// launcher: consumes the queue the webhook fills. For each job: an App JWT, an
// installation token, a check that the job is still queued, a JIT config in
// the runner group, the #cloud-config, and one instance from the launch
// template. Inlined into the template; the build bundles ./cloud-config.js.
const crypto = require('node:crypto');
const { renderCloudConfig } = require('./cloud-config.js');

const API = 'https://api.github.com';
const TYPES = ['m7i.xlarge', 'm6i.xlarge', 'm6a.xlarge', 'm7a.xlarge'];
const CAPACITY = { 'ci-spot': 'spot', 'ci-ondemand': 'on-demand' };

const b64u = (s) => Buffer.from(s).toString('base64url');

function appJwt(appId, pem, nowMs) {
  const iat = Math.floor(nowMs / 1000) - 60; // GitHub allows for clock drift this way
  const data = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ iat, exp: iat + 540, iss: String(appId) }))}`;
  return `${data}.${crypto.sign('sha256', Buffer.from(data), pem).toString('base64url')}`;
}

function valid(m, org) {
  return m && typeof m.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(m.repo) && m.repo.split('/')[0] === org
    && Number.isInteger(m.job_id) && Number.isInteger(m.installation_id) && m.label in CAPACITY
    && Array.isArray(m.labels);
}

function createHandler({ secret, fetch, ec2, now, env, log = console.log }) {
  const org = env.GITHUB_ORG;
  const subnets = env.SUBNET_IDS.split(',');
  const tokens = new Map(); // installation id -> { token, until }
  let app;
  let groupId;

  async function gh(method, path, token, body) {
    const res = await fetch(API + path, {
      method,
      headers: {
        accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        'user-agent': 'ci-runner', authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, json };
  }

  async function must(method, path, token, body) {
    const r = await gh(method, path, token, body);
    if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${(r.json && r.json.message) || ''}`);
    return r.json;
  }

  async function installationToken(id) {
    const c = tokens.get(id);
    if (c && c.until > now()) return c.token;
    if (!app) {
      const s = await secret.get();
      if (!s.private_key) throw new Error('the App is not set up');
      app = { id: s.app_id, key: s.private_key };
    }
    const r = await must('POST', `/app/installations/${id}/access_tokens`, appJwt(app.id, app.key, now()));
    tokens.set(id, { token: r.token, until: Date.parse(r.expires_at) - 5 * 60e3 });
    return r.token;
  }

  async function runnerGroup(token) {
    if (groupId) return groupId;
    for (let page = 1; ; page++) {
      const r = await must('GET', `/orgs/${org}/actions/runner-groups?per_page=100&page=${page}`, token);
      const g = r.runner_groups.find((x) => x.name === env.RUNNER_GROUP);
      if (g) return (groupId = g.id);
      if (r.runner_groups.length < 100) throw new Error(`no runner group named ${env.RUNNER_GROUP}`);
    }
  }

  async function launchInstance(m, name, runnerId, jitConfig) {
    const lt = env.LAUNCH_TEMPLATE_ID;
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
          Overrides: TYPES.flatMap((InstanceType) => subnets.map((SubnetId) => ({ InstanceType, SubnetId }))),
        }],
        TagSpecifications: [{
          ResourceType: 'instance',
          Tags: [
            tag('ci-runner:runner', name), tag('ci-runner:runner-id', runnerId), tag('ci-runner:label', m.label), tag('ci-runner:repo', m.repo),
            tag('ci-runner:job-id', m.job_id), tag('ci-runner:run-id', m.run_id), tag('ci-runner:head-sha', m.head_sha),
            tag('ci-runner:job-name', m.job_name),
          ],
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
    const j = await gh('GET', `/repos/${m.repo}/actions/jobs/${m.job_id}`, token);
    if (j.status === 404) return log(JSON.stringify({ ...job, dropped: 'job not found' }));
    if (j.status >= 300) throw new Error(`job status: ${j.status}`);
    if (j.json.status !== 'queued') return log(JSON.stringify({ ...job, dropped: j.json.status }));

    // The sweeper reads the UTC mint stamp in the name as the registration's
    // grace period, and matches the runner to its instance by these tags.
    const stamp = new Date(now()).toISOString().replace(/\D/g, '').slice(0, 14);
    const name = `${env.STACK_NAME}-${stamp}-${m.job_id}`;
    const r = await gh('POST', `/orgs/${org}/actions/runners/generate-jitconfig`, token, {
      name, runner_group_id: await runnerGroup(token), labels: m.labels, work_folder: '_work',
    });
    if (r.status >= 300) throw new Error(`generate-jitconfig: ${r.status} ${(r.json && r.json.message) || ''}`);

    try {
      const instance = await launchInstance(m, name, r.json.runner.id, r.json.encoded_jit_config);
      log(JSON.stringify({ ...job, launched: instance, runner: name, label: m.label }));
    } catch (e) {
      // Unregister now rather than leave it to the sweeper; the retry mints anew.
      await gh('DELETE', `/orgs/${org}/actions/runners/${r.json.runner.id}`, token).catch(() => {});
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

module.exports = { createHandler, appJwt };

let live;
module.exports.handler = async (event) => {
  if (!live) {
    const sm = require('@aws-sdk/client-secrets-manager');
    const EC2 = require('@aws-sdk/client-ec2');
    const smc = new sm.SecretsManagerClient({});
    const ec2c = new EC2.EC2Client({});
    live = createHandler({
      secret: { get: async () => JSON.parse((await smc.send(new sm.GetSecretValueCommand({ SecretId: process.env.SECRET_ARN }))).SecretString) },
      fetch: globalThis.fetch,
      ec2: {
        createLaunchTemplateVersion: (i) => ec2c.send(new EC2.CreateLaunchTemplateVersionCommand(i)),
        createFleet: (i) => ec2c.send(new EC2.CreateFleetCommand(i)),
        deleteLaunchTemplateVersions: (i) => ec2c.send(new EC2.DeleteLaunchTemplateVersionsCommand(i)),
      },
      now: Date.now,
      env: process.env,
    });
  }
  return live(event);
};
