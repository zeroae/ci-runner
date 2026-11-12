'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../functions/setup.js');

const SETUP_HOST = 'abc123.lambda-url.us-east-1.on.aws';
const WEBHOOK_URL = 'https://hook456.lambda-url.us-east-1.on.aws/';
const T0 = Date.parse('2026-11-12T12:00:00Z');

// In-memory stand-in for the stack's secret.
function fakeSecret(initial) {
  const s = { value: initial, puts: [] };
  s.get = async () => s.value;
  s.put = async (v) => { s.puts.push(v); s.value = v; };
  return s;
}

function setup({ secret = fakeSecret({ state_key: 'k'.repeat(64) }), fetch, now = () => T0 } = {}) {
  const handler = createHandler({
    secret,
    fetch: fetch || (async () => { throw new Error('fetch not expected'); }),
    now,
    env: { WEBHOOK_URL, GITHUB_ORG: 'zeroae', APP_NAME: 'zeroae-ci-runner' },
  });
  return { handler, secret };
}

function get({ query = {}, cookies } = {}) {
  return {
    rawPath: '/',
    queryStringParameters: Object.keys(query).length ? query : undefined,
    cookies,
    requestContext: { domainName: SETUP_HOST, http: { method: 'GET', path: '/' } },
  };
}

function htmlUnescape(s) {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// Parses the page the way a browser would see the form.
function parsePage(body) {
  const action = /<form[^>]*action="([^"]+)"/.exec(body)[1];
  const manifest = JSON.parse(htmlUnescape(/name="manifest" value="([^"]*)"/.exec(body)[1]));
  return { action: htmlUnescape(action), manifest };
}

async function startFlow(handler) {
  const res = await handler(get());
  const { action } = parsePage(res.body);
  const state = new URL(action).searchParams.get('state');
  return { res, state, cookies: res.cookies };
}

test('GET serves a page that auto-POSTs the App manifest to the org', async () => {
  const { handler } = setup();
  const res = await handler(get());
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.match(res.body, /\.submit\(\)/);

  const { action, manifest } = parsePage(res.body);
  const url = new URL(action);
  assert.equal(url.origin + url.pathname, 'https://github.com/organizations/zeroae/settings/apps/new');
  assert.ok(url.searchParams.get('state').length >= 32);
  assert.deepEqual(manifest, {
    name: 'zeroae-ci-runner',
    url: 'https://github.com/zeroae/ci-runner',
    public: false,
    redirect_url: `https://${SETUP_HOST}/`,
    hook_attributes: { url: WEBHOOK_URL, active: true },
    default_permissions: {
      organization_self_hosted_runners: 'write',
      actions: 'read',
      checks: 'write',
    },
    default_events: ['workflow_job'],
  });
});

test('redirect with a forged state is refused, and GitHub is never called', async () => {
  const { handler, secret } = setup();
  const { cookies } = await startFlow(handler);
  const forged = `${T0 + 60_000}.bm9uY2U.c2lnbmF0dXJl`;
  const res = await handler(get({ query: { code: 'c0de', state: forged }, cookies: [forged.replace(/^/, 'ci_runner_state=')] }));
  assert.equal(res.statusCode, 403);
  assert.equal(secret.puts.length, 0);
  // the real cookie with a forged query state is refused too
  const res2 = await handler(get({ query: { code: 'c0de', state: forged }, cookies: cookies.map((c) => c.split(';')[0]) }));
  assert.equal(res2.statusCode, 403);
});

test('redirect with a missing state is refused', async () => {
  const { handler, secret } = setup();
  const res = await handler(get({ query: { code: 'c0de' } }));
  assert.equal(res.statusCode, 403);
  assert.equal(secret.puts.length, 0);
});

test('redirect with an expired state is refused', async () => {
  let t = T0;
  const { handler, secret } = setup({ now: () => t });
  const { state, cookies } = await startFlow(handler);
  t = T0 + 16 * 60 * 1000;
  const res = await handler(get({ query: { code: 'c0de', state }, cookies: cookies.map((c) => c.split(';')[0]) }));
  assert.equal(res.statusCode, 403);
  assert.equal(secret.puts.length, 0);
});

test('redirect with a valid state but no matching browser cookie is refused', async () => {
  const { handler, secret } = setup();
  const { state } = await startFlow(handler);
  const res = await handler(get({ query: { code: 'c0de', state } }));
  assert.equal(res.statusCode, 403);
  assert.equal(secret.puts.length, 0);
});

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretPEMbody\n-----END RSA PRIVATE KEY-----\n';
const CONVERSION = {
  id: 424242,
  slug: 'zeroae-ci-runner',
  client_id: 'Iv23liClientId',
  client_secret: 'clientSecretValue',
  webhook_secret: 'webhookSecretValue',
  pem: PEM,
  owner: { login: 'zeroae', type: 'Organization' },
};
const SECRET_BITS = ['MIIEsecretPEMbody', 'clientSecretValue', 'webhookSecretValue', 'k'.repeat(64)];

function captureConsole(t) {
  const lines = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, m, (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')));
  }
  return lines;
}

function assertNothingSecret(text) {
  for (const bit of SECRET_BITS) assert.ok(!text.includes(bit), `leaked ${bit.slice(0, 8)}...`);
}

async function redirect(handler, state, cookies, code = 'c0de') {
  return handler(get({ query: { code, state }, cookies: cookies.map((c) => c.split(';')[0]) }));
}

test('a valid redirect exchanges the code and writes the App into the secret, logging nothing secret', async (t) => {
  const logs = captureConsole(t);
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 201, json: async () => CONVERSION };
  };
  const { handler, secret } = setup({ fetch });
  const { state, cookies } = await startFlow(handler);
  const res = await redirect(handler, state, cookies);

  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/app-manifests/c0de/conversions');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(secret.puts, [{
    app_id: 424242,
    app_slug: 'zeroae-ci-runner',
    private_key: PEM,
    webhook_secret: 'webhookSecretValue',
  }]);
  assertNothingSecret(res.body);
  assertNothingSecret(logs.join('\n'));
  assert.match(res.body, /zeroae-ci-runner/); // tells the person what to do next
});

test('a conversion owned by another account is not stored', async (t) => {
  captureConsole(t);
  const fetch = async () => ({ ok: true, status: 201, json: async () => ({ ...CONVERSION, owner: { login: 'someone-else' } }) });
  const { handler, secret } = setup({ fetch });
  const { state, cookies } = await startFlow(handler);
  const res = await redirect(handler, state, cookies);
  assert.equal(res.statusCode, 403);
  assert.equal(secret.puts.length, 0);
});

test('a failed conversion is reported without logging its body', async (t) => {
  const logs = captureConsole(t);
  const fetch = async () => ({ ok: false, status: 404, json: async () => CONVERSION, text: async () => JSON.stringify(CONVERSION) });
  const { handler, secret } = setup({ fetch });
  const { state, cookies } = await startFlow(handler);
  const res = await redirect(handler, state, cookies);
  assert.equal(res.statusCode, 502);
  assert.equal(secret.puts.length, 0);
  assertNothingSecret(logs.join('\n'));
  assertNothingSecret(res.body);
});

test('once the secret holds a key, every call is refused', async (t) => {
  const logs = captureConsole(t);
  let fetched = 0;
  const fetch = async () => { fetched++; return { ok: true, status: 201, json: async () => CONVERSION }; };
  const { handler, secret } = setup({ fetch });
  const { state, cookies } = await startFlow(handler);
  assert.equal((await redirect(handler, state, cookies)).statusCode, 200);

  const calls = [
    get(),
    get({ query: { code: 'again', state }, cookies: cookies.map((c) => c.split(';')[0]) }),
    { ...get(), requestContext: { domainName: SETUP_HOST, http: { method: 'POST', path: '/' } } },
  ];
  for (const ev of calls) {
    const res = await handler(ev);
    assert.equal(res.statusCode, 410);
    assert.ok(!/<form/.test(res.body));
    assertNothingSecret(res.body);
  }
  assert.equal(fetched, 1);
  assert.equal(secret.puts.length, 1);
  assertNothingSecret(logs.join('\n'));
});
