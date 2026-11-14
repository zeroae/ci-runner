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
  assert.match(trust, /StringEquals:\n\s+token\.actions\.githubusercontent\.com:aud: sts\.amazonaws\.com\n\s+token\.actions\.githubusercontent\.com:sub: repo:zeroae@11018406\/ci-runner@1455021495:ref:refs\/heads\/main$/);
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

// The Fargate capacities (#29, ADR-0001).
const statements = (policy) => policy.split(/\n {14}- Effect: /).slice(1);

test('the cluster offers both Fargate capacity providers', () => {
  const c = resource('RunnerCluster');
  assert.match(c, /^ {4}Type: AWS::ECS::Cluster\n/);
  assert.match(c, /CapacityProviders: \[FARGATE, FARGATE_SPOT\]\n/);
  assert.match(c, /ClusterName: !Ref AWS::StackName\n/);
});

test('the two task definitions differ only in architecture and family: ECR image, wrapper, 50 GB, no task role', () => {
  const x64 = resource('RunnerTaskDefinition');
  const arm = resource('Arm64RunnerTaskDefinition');
  assert.match(x64, /CpuArchitecture: X86_64 \}/);
  assert.match(arm, /CpuArchitecture: ARM64 \}/);
  assert.match(x64, /Family: !Sub "\$\{AWS::StackName\}-runner"\n/);
  assert.match(arm, /Family: !Sub "\$\{AWS::StackName\}-runner-arm64"\n/);
  const same = (s) => s.split('Properties:')[1].replace(/Family: .*\n/, '').replace(/CpuArchitecture: \w+/, '');
  assert.equal(same(arm), same(x64));
  assert.match(x64, /^ {4}Type: AWS::ECS::TaskDefinition\n/);
  assert.match(x64, /RequiresCompatibilities: \[FARGATE\]\n/);
  assert.match(x64, /NetworkMode: awsvpc\n/);
  assert.match(x64, /EphemeralStorage: \{ SizeInGiB: 50 \}\n/);
  assert.match(x64, /ExecutionRoleArn: !GetAtt RunnerExecutionRole\.Arn\n/);
  assert.doesNotMatch(x64, /TaskRoleArn/, 'no task role: a job finds no AWS credentials');
  assert.match(x64, /Image: !Sub "\$\{ImageRepository\.RepositoryUri\}:latest"\n/);
  assert.match(x64, /- Name: runner\n/);
  assert.match(x64, /EntryPoint: \[\/usr\/local\/bin\/ci-runner-idle-exit\]\n/);
  assert.match(x64, /awslogs-group: !Ref RunnerTaskLogGroup\n/);
  assert.doesNotMatch(x64, /Privileged|docker\.sock/, 'no Docker on Fargate');
});

test('the image itself sets no entrypoint, so EC2 runs it as before', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'image', 'Dockerfile'), 'utf8');
  assert.doesNotMatch(dockerfile, /^\s*(ENTRYPOINT|CMD)\b/m);
  assert.match(dockerfile, /^COPY --chmod=0755 ci-runner-idle-exit \/usr\/local\/bin\/ci-runner-idle-exit$/m);
});

test('the tasks log to /ecs/<stack>-runner, kept 7 days', () => {
  const g = resource('RunnerTaskLogGroup');
  assert.match(g, /LogGroupName: !Sub "\/ecs\/\$\{AWS::StackName\}-runner"\n/);
  assert.match(g, /RetentionInDays: 7\n/);
});

test('the execution role may only pull the stack\'s image and write the task log group', () => {
  const r = resource('RunnerExecutionRole');
  assert.match(r, /RoleName: !Sub "PowerUserPB-\$\{AWS::StackName\}-runner-exec"/);
  assert.match(r, /Principal: \{ Service: ecs-tasks\.amazonaws\.com \}/);
  const st = statements(r.split('PolicyDocument:')[2]);
  assert.equal(st.length, 3);
  assert.match(st[0], /^Allow\n {16}Action: ecr:GetAuthorizationToken\n {16}Resource: "\*"\n?$/);
  assert.match(st[1], /^Allow\n {16}Action: \[ecr:BatchGetImage, ecr:GetDownloadUrlForLayer, ecr:BatchCheckLayerAvailability\]\n {16}Resource: !GetAtt ImageRepository\.Arn\n?$/);
  assert.match(st[2], /^Allow\n {16}Action: \[logs:CreateLogStream, logs:PutLogEvents\]\n {16}Resource: !GetAtt RunnerTaskLogGroup\.Arn\n?$/);
});

test('the launcher\'s role runs only the two task definitions in the cluster, and passes only the execution role', () => {
  const st = statements(resource('LauncherRole'));
  const run = st.find((s) => /Action: ecs:RunTask\n/.test(s));
  assert.ok(run, 'no ecs:RunTask statement');
  assert.match(run, /Resource: \[!Ref RunnerTaskDefinition, !Ref Arm64RunnerTaskDefinition\]\n/);
  assert.match(run, /ArnEquals:\n\s+ecs:cluster: !GetAtt RunnerCluster\.Arn/);
  const pass = st.filter((s) => /Action: iam:PassRole/.test(s));
  assert.equal(pass.length, 1);
  assert.match(pass[0], /Resource: !GetAtt RunnerExecutionRole\.Arn\n/);
  assert.match(pass[0], /iam:PassedToService: ecs-tasks\.amazonaws\.com/);
  const tag = st.find((s) => /Action: ecs:TagResource\n/.test(s));
  assert.match(tag, /ecs:CreateAction: RunTask/);
  // The budget reads the cluster's tasks; nothing else on ECS.
  for (const s of st.filter((x) => /ecs:/.test(x))) {
    assert.doesNotMatch(s, /Action: .*(ecs:\*|StopTask|ecs:(Create|Delete|Update|Register))/, s);
    assert.match(s, /RunnerCluster|RunnerTaskDefinition/, `${s}: not limited to the cluster`);
  }
});

// Tasks get the instances' lifecycle (#30).
test('a second notifier rule matches every change of a Fargate Spot reclaim in the cluster', () => {
  const rule = resource('NotifierTaskRule');
  assert.match(rule, /^ {4}Type: AWS::Events::Rule\n/);
  assert.match(rule, /Name: !Sub "\$\{AWS::StackName\}-notifier-tasks"\n/);
  assert.equal(rule.split('EventPattern:\n')[1].split(/\n {6}\w/)[0], [
    '        source: [aws.ecs]',
    '        detail-type: [ECS Task State Change]',
    '        detail:',
    '          clusterArn: [!GetAtt RunnerCluster.Arn]',
    '          stopCode: [SpotInterruption]',
  ].join('\n'));
  assert.match(rule, /Arn: !GetAtt NotifierFunction\.Arn\n/);
  const perm = resource('NotifierTaskRulePermission');
  assert.match(perm, /Principal: events\.amazonaws\.com\n/);
  assert.match(perm, /SourceArn: !GetAtt NotifierTaskRule\.Arn\n/);
});

test('the notifier may describe only the cluster\'s tasks, and nothing else on ECS', () => {
  const ecs = statements(resource('NotifierRole')).filter((s) => /ecs:/.test(s));
  assert.deepEqual(ecs, [
    'Allow\n                Action: ecs:DescribeTasks\n                Resource: !Sub "arn:${AWS::Partition}:ecs:${AWS::Region}:${AWS::AccountId}:task/${RunnerCluster}/*"\n',
  ]);
});

test('the webhook may find and re-tag only the cluster\'s tasks, and only with the job tags', () => {
  const ecs = statements(resource('WebhookRole')).filter((s) => /ecs:/.test(s));
  const tasks = 'Resource: !Sub "arn:${AWS::Partition}:ecs:${AWS::Region}:${AWS::AccountId}:task/${RunnerCluster}/*"';
  const at = (n) => '\n' + ' '.repeat(n);
  assert.deepEqual(ecs, [
    `Allow${at(16)}Action: ecs:ListTasks${at(16)}Resource: "*"${at(16)}Condition:${at(18)}ArnEquals:${at(20)}ecs:cluster: !GetAtt RunnerCluster.Arn`,
    `Allow${at(16)}Action: ecs:DescribeTasks${at(16)}${tasks}`,
    `Allow${at(16)}Action: ecs:TagResource${at(16)}${tasks}${at(16)}Condition:${at(18)}ForAllValues:StringEquals:${at(20)}`
      + 'aws:TagKeys: [ci-runner:repo, ci-runner:job-id, ci-runner:run-id, ci-runner:head-sha, ci-runner:job-name]\n',
  ]);
  assert.match(resource('WebhookFunction'), /CLUSTER: !Ref RunnerCluster\n/);
});
