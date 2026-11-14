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
      assert.match(r.body, /PermissionsBoundary: arn:aws:iam::aws:policy\/PowerUserAccess\n/, `${r.name} has no boundary`);
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

// The image push (ADR-0002). The template is read as text, so these pin the
// lines that matter rather than parse CloudFormation.
const resource = (name) => {
  const r = resources.find((x) => x.name === name);
  assert.ok(r, `no ${name} in the template`);
  return r;
};

test('GitHub\'s OIDC provider is created only when ExistingOidcProviderArn is empty', () => {
  assert.match(template, /^ {2}ExistingOidcProviderArn:\n {4}Type: String\n {4}Default: ""\n/m);
  assert.match(template, /^Conditions:\n {2}CreateProvider: !Equals \[!Ref ExistingOidcProviderArn, ""\]\n/m);
  const p = resource('GitHubOidcProvider');
  assert.equal(p.type, 'AWS::IAM::OIDCProvider');
  assert.match(p.body, /^ {4}Condition: CreateProvider\n/m);
  assert.match(p.body, /Url: https:\/\/token\.actions\.githubusercontent\.com\n/);
  assert.match(p.body, /ClientIdList: \[sts\.amazonaws\.com\]\n/);
});

test('the image push role trusts only zeroae/ci-runner\'s main, through whichever provider', () => {
  const r = resource('ImagePushRole');
  assert.match(r.body, /RoleName: !Sub "PowerUserPB-\$\{AWS::StackName\}-image-push"/);
  const trust = r.body.split('AssumeRolePolicyDocument:')[1].split(/\n {6}\w/)[0];
  assert.equal((trust.match(/- Effect: Allow/g) || []).length, 1, 'one trust statement');
  assert.match(trust, /Federated: !If \[CreateProvider, !Ref GitHubOidcProvider, !Ref ExistingOidcProviderArn\]/);
  assert.match(trust, /Action: sts:AssumeRoleWithWebIdentity/);
  assert.match(trust, /StringEquals:\n\s+token\.actions\.githubusercontent\.com:aud: sts\.amazonaws\.com\n\s+token\.actions\.githubusercontent\.com:sub: repo:zeroae\/ci-runner:ref:refs\/heads\/main$/);
  assert.doesNotMatch(trust, /StringLike|\*/, 'no wildcard in the trust');
});

test('the image push role may push only to the stack\'s image repo', () => {
  const policy = resource('ImagePushRole').body.split('PolicyDocument:')[2];
  const statements = policy.split(/\n {14}- Effect: /).slice(1);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /^Allow\n {16}Action: ecr:GetAuthorizationToken\n {16}Resource: "\*"/);
  assert.match(statements[1], /Resource: !GetAtt ImageRepository\.Arn(\n|$)/);
  assert.doesNotMatch(statements[1], /ecr:\*|Delete|SetRepositoryPolicy|PutLifecyclePolicy/);
  assert.match(statements[1], /ecr:PutImage/);
});

test('the image repo keeps the last 4 tagged images', () => {
  const r = resource('ImageRepository');
  assert.equal(r.type, 'AWS::ECR::Repository');
  const text = r.body.split(/LifecyclePolicyText: \|\n/)[1];
  assert.ok(text, 'no LifecyclePolicyText block');
  const { rules } = JSON.parse(text);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].selection, {
    tagStatus: 'tagged', tagPatternList: ['*'], countType: 'imageCountMoreThan', countNumber: 4,
  });
  assert.deepEqual(rules[0].action, { type: 'expire' });
});
