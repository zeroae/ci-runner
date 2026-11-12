'use strict';
// sweeper: scheduled. Terminates the stack's CI runner instances older than
// MAX_AGE, and removes the runner group's registrations that are offline and
// have no instance. Inlined into the template by scripts/build-template.js;
// keep it one dependency-free CommonJS file.
const crypto = require('node:crypto');

const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const STACK_TAG = 'ci-runner:stack';
// The launcher tags each instance with its runner's name (and, when it has
// it, the runner's id); that is how a registration finds its instance.
const RUNNER_TAG = 'ci-runner:runner';
const RUNNER_ID_TAG = 'ci-runner:runner-id';
// A registration is minted before its instance exists. A name carrying a UTC
// <YYYYmmddHHMMSS> token is left alone for GRACE after that time.
const GRACE_MS = 10 * 60 * 1000;
const STAMP = /(?:^|-)(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:-|$)/;
const API = 'https://api.github.com';

const b64u = (s) => Buffer.from(s).toString('base64url');

function appJwt(appId, pem, nowMs) {
  const iat = Math.floor(nowMs / 1000) - 60; // GitHub allows for clock drift this way
  const data = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ iat, exp: iat + 540, iss: String(appId) }))}`;
  return `${data}.${crypto.sign('sha256', Buffer.from(data), pem).toString('base64url')}`;
}

const tagOf = (inst, key) => ((inst.Tags || []).find((t) => t.Key === key) || {}).Value;

function createHandler({ ec2, secret, fetch, now, env, log = console.log }) {
  const org = env.GITHUB_ORG;
  // Instances that can still be (or become) a runner: everything not terminated.
  const alive = (i) => i.State.Name !== 'terminated';
  // Instances we may terminate: shutting-down ones are already on their way.
  const killable = (i) => ['pending', 'running', 'stopping', 'stopped'].includes(i.State.Name);

  async function sweepInstances(instances) {
    const strays = instances
      .filter((i) => tagOf(i, STACK_TAG) === env.STACK_NAME && killable(i))
      .filter((i) => now() - new Date(i.LaunchTime).getTime() > MAX_AGE_MS)
      .map((i) => i.InstanceId);
    if (strays.length) {
      await ec2.terminate(strays);
      log(`sweeper: terminated ${strays.join(' ')}`);
    }
    return strays;
  }

  async function gh(method, path, token, body) {
    const res = await fetch(API + path, {
      method, body: body && JSON.stringify(body),
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'ci-runner', authorization: `Bearer ${token}`, ...(body && { 'content-type': 'application/json' }) },
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`${method} ${path}: ${res.status} ${(json && json.message) || ''}`), { status: res.status });
    return json;
  }

  async function installationToken(creds) {
    const jwt = appJwt(creds.app_id, creds.private_key, now());
    const inst = await gh('GET', `/orgs/${org}/installation`, jwt);
    return (await gh('POST', `/app/installations/${inst.id}/access_tokens`, jwt)).token;
  }

  async function listGroupRunners(token) {
    let group;
    for (let page = 1; !group; page++) {
      const r = await gh('GET', `/orgs/${org}/actions/runner-groups?per_page=100&page=${page}`, token);
      group = r.runner_groups.find((g) => g.name === env.RUNNER_GROUP);
      if (!group && r.runner_groups.length < 100) { log(`sweeper: no runner group named ${env.RUNNER_GROUP} yet`); return []; }
    }
    const runners = [];
    for (let page = 1; ; page++) {
      const r = await gh('GET', `/orgs/${org}/actions/runner-groups/${group.id}/runners?per_page=100&page=${page}`, token);
      runners.push(...r.runners);
      if (r.runners.length < 100 || runners.length >= r.total_count) return runners;
    }
  }

  function minted(name) {
    const m = STAMP.exec(name);
    return m ? Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]) : undefined;
  }

  async function sweepRunners(token, runners, instances) {
    const present = instances.filter(alive);
    const names = new Set(present.map((i) => tagOf(i, RUNNER_TAG)).filter(Boolean));
    const ids = new Set(present.map((i) => tagOf(i, RUNNER_ID_TAG)).filter(Boolean));
    const young = (r) => { const t = minted(r.name); return t !== undefined && now() - t < GRACE_MS; };
    const orphans = runners.filter((r) => r.status === 'offline' && !r.busy
      && !names.has(r.name) && !ids.has(String(r.id)) && !young(r));
    for (const r of orphans) {
      await gh('DELETE', `/orgs/${org}/actions/runners/${r.id}`, token);
      log(`sweeper: removed runner ${r.name} (id ${r.id})`);
    }
    return orphans.map((r) => r.id);
  }

  return async function handler() {
    // Registrations are listed before instances are described, so a runner
    // whose instance launches in between is still seen with its instance.
    let token, runners, failure;
    try {
      const creds = await secret.get();
      if (creds.private_key) {
        token = await installationToken(creds);
        runners = await listGroupRunners(token);
      } else {
        log('sweeper: the GitHub App is not set up yet; registrations skipped');
      }
    } catch (err) { failure = err; }

    const instances = (await ec2.describe()).filter((i) => tagOf(i, STACK_TAG) === env.STACK_NAME);
    const terminated = await sweepInstances(instances);
    if (failure) throw failure;
    const removed = runners ? await sweepRunners(token, runners, instances) : [];
    return { terminated, removed };
  };
}

exports.createHandler = createHandler;

// Lambda entry point. The AWS SDK v3 ships with the nodejs22.x runtime, so it
// is required lazily here and never by the tests.
let live;
exports.handler = async (event) => {
  if (!live) {
    const sm = require('@aws-sdk/client-secrets-manager');
    const ec2sdk = require('@aws-sdk/client-ec2');
    const smc = new sm.SecretsManagerClient({});
    const ec2c = new ec2sdk.EC2Client({});
    const SecretId = process.env.SECRET_ARN;
    live = createHandler({
      secret: {
        get: async () => JSON.parse((await smc.send(new sm.GetSecretValueCommand({ SecretId }))).SecretString),
      },
      ec2: {
        describe: async () => {
          const out = [];
          const pages = ec2sdk.paginateDescribeInstances({ client: ec2c },
            { Filters: [{ Name: `tag:${STACK_TAG}`, Values: [process.env.STACK_NAME] }] });
          for await (const page of pages) for (const r of page.Reservations || []) out.push(...r.Instances);
          return out;
        },
        terminate: async (InstanceIds) => { await ec2c.send(new ec2sdk.TerminateInstancesCommand({ InstanceIds })); },
      },
      fetch: globalThis.fetch,
      now: Date.now,
      env: process.env,
    });
  }
  return live(event);
};
