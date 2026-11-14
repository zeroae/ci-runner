'use strict';
// The template's own promises, read from template.yaml as text.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const template = fs.readFileSync(path.join(__dirname, '..', 'template.yaml'), 'utf8');
// A top-level resource's block, from its name to the next blank line.
const resource = (name) => template.split(new RegExp(`\\n  ${name}:\\n`))[1].split(/\n\n/)[0] + '\n';
const launchTemplates = (s) => new Set([...s.matchAll(/launch-template\/\$\{(\w+)\}/g)].map((m) => m[1]));

test('the arm64 launch template is the x64 one with the arm64 AL2023 image', () => {
  const x64 = resource('RunnerLaunchTemplate');
  const arm = resource('Arm64RunnerLaunchTemplate');
  assert.match(x64, /ImageId: resolve:ssm:\/aws\/service\/ami-amazon-linux-latest\/al2023-ami-kernel-default-x86_64\n/);
  assert.match(arm, /ImageId: resolve:ssm:\/aws\/service\/ami-amazon-linux-latest\/al2023-ami-kernel-default-arm64\n/);
  const same = (s) => s.split('LaunchTemplateData:')[1].replace(/ImageId: .*\n/, '');
  assert.equal(same(arm), same(x64), 'disk, IMDSv2, security group, shutdown and tags');
  assert.doesNotMatch(arm, /IamInstanceProfile|UserData|InstanceType/);
  assert.match(arm, /LaunchTemplateName: !Sub "\$\{AWS::StackName\}-runner-arm64"/);
});

test('the launcher\'s role launches from both launch templates and no other', () => {
  const role = resource('LauncherRole');
  assert.deepEqual(launchTemplates(role), new Set(['RunnerLaunchTemplate', 'Arm64RunnerLaunchTemplate']));
  assert.doesNotMatch(role, /launch-template\/\*/);
  // Every statement that names one launch template names both.
  for (const stmt of role.split(/\n {14}- Effect: /).slice(1)) {
    const lts = launchTemplates(stmt);
    if (lts.size) assert.equal(lts.size, 2, stmt);
  }
  assert.match(resource('LauncherFunction'), /ARM64_LAUNCH_TEMPLATE_ID: !Ref Arm64RunnerLaunchTemplate\n/);
});

// The image push (ADR-0002).
test('GitHub\'s OIDC provider is created only when ExistingOidcProviderArn is empty', () => {
  assert.match(template, /^ {2}ExistingOidcProviderArn:\n {4}Type: String\n {4}Default: ""\n/m);
  assert.match(template, /^Conditions:\n {2}CreateProvider: !Equals \[!Ref ExistingOidcProviderArn, ""\]\n/m);
  const p = resource('GitHubOidcProvider');
  assert.match(p, /^ {4}Type: AWS::IAM::OIDCProvider\n {4}Condition: CreateProvider\n/);
  assert.match(p, /Url: https:\/\/token\.actions\.githubusercontent\.com\n/);
  assert.match(p, /ClientIdList: \[sts\.amazonaws\.com\]\n/);
});

test('the image push role trusts only zeroae/ci-runner\'s main, through whichever provider', () => {
  const r = resource('ImagePushRole');
  assert.match(r, /RoleName: !Sub "PowerUserPB-\$\{AWS::StackName\}-image-push"/);
  const trust = r.split('AssumeRolePolicyDocument:')[1].split(/\n {6}\w/)[0];
  assert.equal((trust.match(/- Effect: Allow/g) || []).length, 1, 'one trust statement');
  assert.match(trust, /Federated: !If \[CreateProvider, !Ref GitHubOidcProvider, !Ref ExistingOidcProviderArn\]/);
  assert.match(trust, /Action: sts:AssumeRoleWithWebIdentity/);
  assert.match(trust, /StringEquals:\n\s+token\.actions\.githubusercontent\.com:aud: sts\.amazonaws\.com\n\s+token\.actions\.githubusercontent\.com:sub: repo:zeroae\/ci-runner:ref:refs\/heads\/main$/);
  assert.doesNotMatch(trust, /StringLike|\*/, 'no wildcard in the trust');
});

test('the image push role may push only to the stack\'s image repo', () => {
  const policy = resource('ImagePushRole').split('PolicyDocument:')[2];
  const statements = policy.split(/\n {14}- Effect: /).slice(1);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /^Allow\n {16}Action: ecr:GetAuthorizationToken\n {16}Resource: "\*"/);
  assert.match(statements[1], /Resource: !GetAtt ImageRepository\.Arn\n$/);
  assert.doesNotMatch(statements[1], /ecr:\*|Delete|SetRepositoryPolicy|PutLifecyclePolicy/);
  assert.match(statements[1], /ecr:PutImage/);
});

test('the image repo keeps the last 4 tagged images', () => {
  const r = resource('ImageRepository');
  assert.match(r, /^ {4}Type: AWS::ECR::Repository\n/);
  const text = r.split(/LifecyclePolicyText: \|\n/)[1];
  assert.ok(text, 'no LifecyclePolicyText block');
  const { rules } = JSON.parse(text);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].selection, {
    tagStatus: 'tagged', tagPatternList: ['*'], countType: 'imageCountMoreThan', countNumber: 4,
  });
  assert.deepEqual(rules[0].action, { type: 'expire' });
});
