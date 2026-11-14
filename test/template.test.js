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
