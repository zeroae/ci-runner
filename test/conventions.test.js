'use strict';
// Repo conventions that are mechanical enough to check: IAM naming, the
// environment contract between template.yaml and functions/*.js, and the
// copies of the GitHub helpers. Judgement calls live in CODING_STANDARDS.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const template = read('template.yaml');

// Top-level resources: [{ name, type, body }].
const resources = template.split(/^Resources:$/m)[1].split(/^\w/m)[0]
  .split(/\n(?=  \w+:\n    Type: )/).slice(1)
  .map((b) => ({ name: b.match(/^ {2}(\w+):/)[1], type: b.match(/Type: (\S+)/)[1], body: b }));

test('every IAM role and policy is PowerUserPB-${AWS::StackName}-*, and every role has the boundary', () => {
  // GitHub's OIDC provider is named by its URL, and has no policy.
  const iam = resources.filter((r) => r.type.startsWith('AWS::IAM::') && r.type !== 'AWS::IAM::OIDCProvider');
  assert.ok(iam.length > 0);
  for (const r of iam) {
    assert.match(r.type, /^AWS::IAM::(Role|ManagedPolicy)$/, `${r.name}: inline the policy in its role instead`);
    const names = [...r.body.matchAll(/(?:RoleName|ManagedPolicyName|PolicyName): (.*)/g)].map((m) => m[1]);
    assert.ok(names.length > 0, `${r.name} has no explicit name`);
    for (const n of names) assert.match(n, /^!Sub "PowerUserPB-\$\{AWS::StackName\}-[\w-]+"$/, `${r.name}: ${n}`);
    if (r.type === 'AWS::IAM::Role') {
      // PowerUserAccess allows no iam:PassRole, so a role that passes one has
      // the account's ZAEPowerUserBoundary: PowerUserAccess plus PassRole on
      // PowerUserPB* roles only.
      const boundary = /Action: iam:PassRole\n/.test(r.body)
        ? /PermissionsBoundary: !Sub "arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:policy\/ZAEPowerUserBoundary"\n/
        : /PermissionsBoundary: arn:aws:iam::aws:policy\/PowerUserAccess\n/;
      assert.match(r.body, boundary, `${r.name} has no boundary, or the wrong one`);
    }
  }
  assert.match(read('Makefile'), /--capabilities CAPABILITY_NAMED_IAM/);
});

// Read but deliberately not set by the template: a test or hand-run override.
const OPTIONAL_ENV = new Set(['IDLE_SECONDS']);

test('every env var a function reads is set on that function in the template', () => {
  const fns = resources.filter((r) => r.type === 'AWS::Lambda::Function');
  assert.equal(fns.length, 5);
  for (const fn of fns) {
    const file = fn.body.match(/\/\/@inline (\S+)/)[1];
    const set = new Set([...(fn.body.split(/Variables:\n/)[1] || '').matchAll(/^ {10}([A-Z0-9_]+):/gm)].map((m) => m[1]));
    let src = read(file);
    for (const [, dep] of src.matchAll(/require\('\.\/([\w.-]+\.js)'\)/g)) src += read(path.join(path.dirname(file), dep));
    const used = new Set([...src.matchAll(/\benv\.([A-Z0-9_]+)/g)].map((m) => m[1]));
    for (const v of used) if (!OPTIONAL_ENV.has(v)) assert.ok(set.has(v), `${file} reads ${v}, which ${fn.name} doesn't set`);
    for (const v of set) assert.ok(used.has(v), `${fn.name} sets ${v}, which ${file} never reads`);
  }
});

test('the launcher, notifier and sweeper carry identical copies of the GitHub helpers', () => {
  const pick = (src, re) => (src.match(re) || [])[0];
  const helpers = {
    API: /^const API = .*$/m,
    b64u: /^const b64u = .*$/m,
    appJwt: /^function appJwt\([^]*?\n\}$/m,
    gh: /^ {2}async function gh\([^]*?\n {2}\}$/m,
  };
  const files = ['launcher', 'notifier', 'sweeper'].map((f) => `functions/${f}.js`);
  for (const [name, re] of Object.entries(helpers)) {
    const [first, ...rest] = files.map((f) => ({ f, code: pick(read(f), re) }));
    assert.ok(first.code, `${first.f} has no ${name}`);
    for (const o of rest) assert.equal(o.code, first.code, `${o.f}'s ${name} differs from ${first.f}'s`);
  }
});

test('the launcher and the webhook sanitize an ECS tag the same way', () => {
  // The webhook re-tags a task the launcher tagged; bundling one rule would
  // cost more template bytes than the two-line copy.
  for (const re of [/^const ECS_TAG_CHARS = .*$/m, /^const ecsTag = .*$/m]) {
    const [launcher, webhook] = ['launcher', 'webhook'].map((f) => (read(`functions/${f}.js`).match(re) || [])[0]);
    assert.ok(launcher, `the launcher has no ${re}`);
    assert.equal(webhook, launcher, `the webhook's ${re} differs from the launcher's`);
  }
});

test('the launcher, webhook and notifier read tags the same way', () => {
  // Each strips the ci-runner: prefix, so t.capacity means the same everywhere.
  const re = /^const tagsOf = .*$/m;
  const [launcher, ...rest] = ['launcher', 'webhook', 'notifier'].map((f) => ({ f, code: (read(`functions/${f}.js`).match(re) || [])[0] }));
  assert.ok(launcher.code, 'the launcher has no tagsOf');
  for (const o of rest) assert.equal(o.code, launcher.code, `${o.f}'s tagsOf differs from the launcher's`);
});
