'use strict';
// setup: one-time GitHub App registration through the manifest flow.
// Inlined into the template by scripts/build-template.js; keep it one
// dependency-free CommonJS file.
const crypto = require('node:crypto');

const STATE_TTL_MS = 15 * 60 * 1000;
const COOKIE = 'ci_runner_state';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
}

function reply(statusCode, text, extra = {}) {
  return {
    statusCode,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    body: text + '\n',
    ...extra,
  };
}

function sign(key, payload) {
  return crypto.createHmac('sha256', key).update(payload).digest('base64url');
}

function cookie(event, name) {
  for (const c of event.cookies || []) {
    const i = c.indexOf('=');
    if (i > 0 && c.slice(0, i).trim() === name) return c.slice(i + 1).trim();
  }
  return undefined;
}

function createHandler({ secret, fetch, now, env }) {
  const org = env.GITHUB_ORG;

  function manifest(selfUrl) {
    return {
      name: env.APP_NAME,
      url: 'https://github.com/zeroae/ci-runner',
      public: false,
      redirect_url: selfUrl,
      hook_attributes: { url: env.WEBHOOK_URL, active: true },
      default_permissions: {
        organization_self_hosted_runners: 'write',
        actions: 'read',
        checks: 'write',
      },
      default_events: ['workflow_job'],
    };
  }

  function page(selfUrl, state) {
    const action = `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${encodeURIComponent(state)}`;
    const body = `<!doctype html>
<html><head><meta charset="utf-8"><title>Create the ci-runner GitHub App</title></head>
<body>
<form id="m" method="post" action="${esc(action)}">
<input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest(selfUrl)))}">
<noscript><button type="submit">Create GitHub App</button></noscript>
</form>
<script>document.getElementById('m').submit()</script>
</body></html>
`;
    return {
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      cookies: [`${COOKIE}=${state}; Max-Age=${STATE_TTL_MS / 1000}; Path=/; Secure; HttpOnly; SameSite=Lax`],
      body,
    };
  }

  // state = "<expiry ms>.<nonce>.<hmac>", keyed by the secret's state_key.
  // It must also match the cookie set on this browser by the GET.
  function validState(key, state, cookieState) {
    if (typeof state !== 'string' || state !== cookieState) return false;
    const parts = state.split('.');
    if (parts.length !== 3) return false;
    const want = Buffer.from(sign(key, `${parts[0]}.${parts[1]}`));
    const got = Buffer.from(parts[2]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
    return Number(parts[0]) > now();
  }

  // Never log `res`, its body, or anything derived from it but the status.
  async function convert(code) {
    let res;
    try {
      res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'ci-runner-setup',
        },
      });
    } catch {
      console.error('setup: manifest conversion request failed');
      return reply(502, 'could not reach GitHub; start again from this URL');
    }
    if (!res.ok) {
      console.error(`setup: manifest conversion returned HTTP ${res.status}`);
      return reply(502, `GitHub refused the code (HTTP ${res.status}); start again from this URL`);
    }
    const app = await res.json();
    if (!app || !app.owner || String(app.owner.login).toLowerCase() !== String(org).toLowerCase()) {
      console.error('setup: converted App is not owned by the expected org; not stored');
      return reply(403, `the App is not owned by ${org}; not stored`);
    }
    await secret.put({
      app_id: app.id,
      app_slug: app.slug,
      private_key: app.pem,
      webhook_secret: app.webhook_secret,
    });
    console.log(`setup: stored App ${app.slug} (id ${app.id})`);
    return reply(200, `Stored the GitHub App ${app.slug} (id ${app.id}).\n` +
      `Next: install it on the selected repositories: https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new\n` +
      'This URL now refuses every request.');
  }

  return async function handler(event) {
    const current = await secret.get();
    if (current.private_key) return reply(410, 'the GitHub App is already set up; this URL refuses every request');
    if (event.requestContext.http.method !== 'GET') return reply(405, 'method not allowed');
    const selfUrl = `https://${event.requestContext.domainName}/`;
    const q = event.queryStringParameters || {};

    if (q.code !== undefined) {
      if (!validState(current.state_key, q.state, cookie(event, COOKIE))) {
        return reply(403, 'invalid or expired state; start again from this URL');
      }
      return convert(q.code);
    }

    const expires = String(now() + STATE_TTL_MS);
    const nonce = crypto.randomBytes(16).toString('base64url');
    const state = `${expires}.${nonce}.${sign(current.state_key, `${expires}.${nonce}`)}`;
    return page(selfUrl, state);
  };
}

exports.createHandler = createHandler;

// Lambda entry point. The AWS SDK v3 ships with the nodejs22.x runtime, so it
// is required lazily here and never by the tests.
let live;
exports.handler = async (event) => {
  if (!live) {
    const sm = require('@aws-sdk/client-secrets-manager');
    const client = new sm.SecretsManagerClient({});
    const SecretId = process.env.SECRET_ARN;
    live = createHandler({
      secret: {
        get: async () => JSON.parse((await client.send(new sm.GetSecretValueCommand({ SecretId }))).SecretString),
        put: async (v) => { await client.send(new sm.PutSecretValueCommand({ SecretId, SecretString: JSON.stringify(v) })); },
      },
      fetch: globalThis.fetch,
      now: Date.now,
      env: process.env,
    });
  }
  return live(event);
};
