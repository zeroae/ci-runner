# The stack: layout and conventions

One CloudFormation stack, `ci-runner`, in `zeroae-code` / `us-east-1`.
`make help` lists the targets. The owner's procedures and the traps table are in
[runbook.md](runbook.md).

```
template.yaml               source template (valid YAML, with inline markers)
functions/<name>.js         one Lambda each: one CommonJS file, no npm deps
test/<name>.test.js         node --test tests, run against functions/<name>.js
scripts/build-template.js   template.yaml -> build/template.yaml (git-ignored)
```

## Adding a Lambda

1. Write `functions/<name>.js`. It must be self-contained: only `node:*`
   built-ins, plus `@aws-sdk/*` (shipped with the `nodejs22.x` runtime)
   required lazily inside `exports.handler`, never at the top of the file.
   The one exception is a local `require('./<other>.js')` on one line, which
   the build bundles in (the launcher bundles `cloud-config.js` this way). If
   the file sets `module.exports = {...}`, export the handler with
   `module.exports.handler = ...`, not `exports.handler`.
2. Put the logic behind a `createHandler(deps)` factory that takes its
   adapters (AWS clients, `fetch`, clock) and returns the handler. Tests
   import the file and call `createHandler` with fakes. `exports.handler`
   builds the real adapters once and delegates. `functions/setup.js` is the
   example.
3. In `template.yaml`, give it:
   - `Code: ZipFile: |` whose only line is `//@inline functions/<name>.js`,
     indented as block content. The build replaces the pair with one line,
     `ZipFile: "<the file as a JSON string>"` (YAML reads a JSON string as the
     same text). That saves the block's indentation on every line. It also drops
     the file's whole-line `//` comments, but not inside template literals.
     `Handler: index.handler`, `Runtime: nodejs22.x`.
   - a `AWS::Logs::LogGroup` `/aws/lambda/${AWS::StackName}-<name>`, wired in
     through `LoggingConfig`;
   - its own role `PowerUserPB-${AWS::StackName}-<name>`, with
     `PermissionsBoundary: arn:aws:iam::aws:policy/PowerUserAccess` and an
     inline policy of the same name granting only what that function needs.
4. A Function URL with `AuthType: NONE` needs two permissions:
   `lambda:InvokeFunctionUrl` (`FunctionUrlAuthType: NONE`) and
   `lambda:InvokeFunction` (`InvokedViaFunctionUrl: true`).

## Commands

- `make test`: `node --test test/*.test.js`.
- `make build`: writes `build/template.yaml` and prints its size against the
  **1 MB** (1,048,576-byte) limit, the largest template CloudFormation accepts
  from S3. The build fails at or over it, and `test/build.test.js` checks it
  too. The build drops whole-line `//` comments from the inlined code and
  whole-line `#` comments from the template (outside block scalars), so
  comment the source freely.
- `make deploy`: test, build, then `cloudformation deploy` with
  `CAPABILITY_NAMED_IAM` and `--s3-bucket $(BUCKET) --s3-prefix $(STACK)`, then
  print the outputs. It uploads the template to the deploy bucket and deploys
  from there, since a template sent inline must be under 51,200 bytes. It
  creates the stack the first time and updates it after. The bucket is made
  outside the stack, once per account (see "Deploy and update the stack" in
  the runbook); `BUCKET` defaults to `$(STACK)-deploy-<account id>`, looked up
  with `sts get-caller-identity`. Override `STACK`, `PROFILE`, `REGION`,
  `BUCKET` on the command line if needed.
- `make validate`: build, upload the template to the deploy bucket as
  `$(STACK)/validate.yaml`, and validate it from there.

## The setup function

`GET` on the `SetupUrl` output serves a page that auto-POSTs the App manifest
to GitHub. GitHub redirects back with `code` and `state`; setup exchanges the
code and writes `app_id`, `app_slug`, `private_key`, `webhook_secret` into the
`${StackName}/github-app` secret. Once the secret holds `private_key`, every
call answers 410.

`state` is `<expiry>.<nonce>.<HMAC>`, keyed by the `state_key` the secret is
created with, valid for 15 minutes, and must match a `Secure; HttpOnly;
SameSite=Lax` cookie set by the `GET`, so a code is only accepted in the
browser that started the flow. Nothing is stored for it.

## The network and the launch template

The stack has its own VPC (`10.77.0.0/16`): three public subnets in the
region's first three AZs (`MapPublicIpOnLaunch`), one route table with a
default route to an internet gateway, no NAT, no flow logs, no endpoints. The
security group `RunnerSecurityGroup` has no inbound rules.

`RunnerLaunchTemplate` holds everything a CI runner instance shares: the AL2023
image through `resolve:ssm:` (resolved at each launch), 50 GB encrypted gp3
deleted on termination, IMDSv2 required with hop limit 1, shutdown behaviour
`terminate`, the tag `ci-runner:stack=<stack>` on instance and volume. It has
**no instance profile, no instance type and no user-data**.

A launch is an EC2 Fleet of type `instant` for one instance: overrides for
`m7i`/`m6i`/`m6a`/`m7a` `.xlarge` in each of the three subnets, Spot
`capacity-optimized` for `ci-spot`. `CreateFleet` can't override user-data, so
each launch first adds a launch template version (source `$Default`, only
`UserData`), launches from it, and deletes that version again. The outputs
`LaunchTemplateId`, `SubnetIds` and `SecurityGroupId` are what a launch needs.

## The instance's user-data

`functions/cloud-config.js` exports `renderCloudConfig({ jitConfig,
idleSeconds = 900 })`, which returns the `#cloud-config` document. It has no
`require()`, so the launcher can bundle it.
`test/cloud-config.test.js` covers it. On the instance:

1. `bootcmd` creates `docker` with gid 123 before the `docker` package does.
2. `write_files` puts the JIT config in `/etc/ci-runner/jitconfig` (`0600`)
   and the start script in `/usr/local/sbin/ci-runner`.
3. `runcmd` starts Docker and runs the start script, which pulls
   `ghcr.io/zeroae/ci-runner:latest`, copies the image's `/home/runner` (the
   runner itself) onto the host, and runs the image with the host's socket,
   `/tmp` and `/home/runner` mounted at the same paths (the host's `/tmp` is
   Amazon Linux's tmpfs, so a root-disk directory is bind-mounted over it first), as
   `./run.sh --jitconfig`. A job's `docker run -v` goes to the host's daemon,
   so its source must be a host path; sharing those two gives a job the same
   paths as a GitHub-hosted runner.
   If the container's log has no `Running job` line after `idleSeconds`, the
   script stops the container. When the container exits, the script's `EXIT`
   trap runs `shutdown -h now`, which terminates the instance.

A runner stopped by the idle exit stays registered, offline, until the
sweeper (or GitHub, for ephemeral runners) removes it.

## Launching one by hand

`make hand-launch` (`scripts/hand-launch.sh`) mints an org JIT config for the
`ci-runner` group with labels `self-hosted`, `ci-spot` through the owner's
`gh`, which needs `admin:org`. It then renders the user-data and launches one
instance as above. It prints the instance id. `IDLE_SECONDS=120` shortens the
idle exit for a test. `make runners` lists the stack's instances that are not
terminated.

## The sweeper

`functions/sweeper.js` runs every 10 minutes (an EventBridge rule). Each run:

1. Reads the secret. Once it holds `private_key`, it signs an App JWT
   (RS256, `iss` = `app_id`), gets the org installation's token, and lists the
   runners in the `ci-runner` group. Before the App exists it skips this.
2. Describes the instances tagged `ci-runner:stack=<stack>`, and terminates
   those `pending`, `running`, `stopping` or `stopped` and launched over
   **2 hours** ago.
3. Removes each runner in the group that is `offline`, not busy, and has no
   instance (see below). A GitHub failure doesn't stop step 2, but fails the
   run.

Runners are listed before instances are described, so a runner whose
instance launches between the two is still seen with its instance.

Its role allows `GetSecretValue` on the secret, `ec2:DescribeInstances`, and
`ec2:TerminateInstances` only on instances whose `aws:ResourceTag/ci-runner:stack`
is the stack's name. A `TerminateInstances` naming an untagged instance, or
another stack's, is denied.

### How a runner finds its instance

Whatever launches a runner (`scripts/hand-launch.sh`, the launcher) must:

- tag the instance `ci-runner:runner=<runner name>`, the name it gave
  `generate-jitconfig`. It may also tag `ci-runner:runner-id=<runner id>`;
  either tag matching keeps the registration.
- put a UTC `YYYYmmddHHMMSS` timestamp of the mint in the name as its own
  `-`-separated token, for example `ci-runner-20261112113000-<job id>`.
  The registration exists before its instance does, so the sweeper leaves a
  runner alone for 10 minutes after that time. A name with no stamp gets no
  grace.

Every instance not yet `terminated` counts, so a runner whose instance is
shutting down is removed on a later run.

## Launching for queued jobs: webhook, queue, launcher

**webhook** (`functions/webhook.js`, the `WebhookUrl` Function URL, which the
App's webhook points at), for each delivery:

1. Verifies `X-Hub-Signature-256` against the secret's `webhook_secret`
   (`401` otherwise; `503` before the App exists).
2. Ignores (`200`) any event but `workflow_job`.
3. **Fence 3:** refuses (`403`, logged) unless `repository.visibility` is
   `private` and the owner is `GITHUB_ORG`.
4. On `in_progress`, repairs a swap (below) and answers.
5. Ignores (`200`) actions other than `queued`, and jobs outside the label
   contract: `self-hosted`, exactly one of `ci-spot`/`ci-ondemand`, and
   otherwise only `linux`/`x64` (case-insensitive).
6. Enqueues `{repo, job_id, run_id, head_sha, job_name, label, labels,
   installation_id}` (`label` is the capacity label, lower case) and answers
   `202`.

**Swap repair** (ADR-0003). GitHub gives a queued job to any idle runner whose
labels cover it, so a runner launched for job Y may take job X. Left alone,
X's own message is later dropped as not queued, and Y never gets a runner.
On `workflow_job` `in_progress` the webhook reads `runner_name`:

- a name that isn't `${stack}-<14-digit stamp>-<job id>` (a hand launch, a
  GitHub-hosted runner, another stack), or whose job id is the event's, is
  ignored (`200`) with no AWS call;
- otherwise it describes the stack's `pending`/`running` instance tagged
  `ci-runner:runner=<name>`. No instance, or a `ci-runner:job-id` tag already
  equal to the event's job (a repeated delivery), is ignored too;
- otherwise it **re-queues** the instance's job, rebuilt from its tags
  (`repo`, `job-id`, `run-id`, `head-sha`, `job-name`, `label`, `labels`; the
  event's installation id), so the launcher's "still queued?" check launches
  it a runner or drops it. An instance without `ci-runner:labels` (launched
  before the tag existed) re-queues with `self-hosted` and its capacity label;
- then **re-tags** the instance with the event's job (`ci-runner:repo`,
  `job-id`, `run-id`, `head-sha`, `job-name`), so the notifier reports a
  reclaim on the commit of the job it really ran, and logs
  `{"swap": <runner>, "instance", "took": {repo, job_id}, "requeued": {repo,
  job_id}}`, answering `202`.

It queues before it tags: if the tag fails, a redelivery still sees the old
tags and repairs again. Re-queueing a job that another runner already took is
harmless: the launcher drops it.

Its role allows `GetSecretValue` on the secret, `SendMessage` on the queue,
`ec2:DescribeInstances`, and `ec2:CreateTags` only on instances tagged
`ci-runner:stack=<stack>` and only for the five job tag keys.

**The queue** `${stack}-jobs` has a 120 s visibility timeout. A message that
fails 5 receives goes to `${stack}-jobs-dlq` (kept 14 days). The outputs are
`JobQueueUrl` and `JobDeadLetterQueueUrl`.

**launcher** (`functions/launcher.js`, fed one message at a time, reporting
failures per message), for each job:

1. Drops a malformed message, or one whose repo isn't in `GITHUB_ORG`.
2. Signs an App JWT and gets an installation token for the job's
   installation. The token is cached until 5 minutes before it expires.
3. `GET /repos/{repo}/actions/jobs/{job_id}`: anything but `queued` (or a
   `404`) is dropped, and the message is consumed.
4. **The cap:** counts the stack's instances (`ci-runner:stack` tag) that are
   `pending`, `running`, `stopping` or `stopped`, split by capacity: an
   instance with `InstanceLifecycle: spot` is Spot, any other is On-Demand.
   At the job's cap (`SpotCap`, default 6; `OnDemandCap`, default 2) it
   sends the message to the queue again with a 60 s delay and consumes the
   original, so waiting doesn't count towards the dead-letter queue. Nothing
   is minted. It's a soft cap: messages checked at the same moment can
   overshoot it. A shutting-down instance no longer counts.
5. Looks up the `RunnerGroup` parameter's group id by name (cached), and
   mints a JIT config with the job's labels. The runner is named
   `${stack}-<UTC YYYYmmddHHMMSS>-<job id>`, as the sweeper requires.
6. Renders the `#cloud-config` and launches one instance as in "Launching one
   by hand": Spot `capacity-optimized` for `ci-spot`, On-Demand `lowest-price`
   for `ci-ondemand`. Tags: `ci-runner:runner`, `ci-runner:runner-id`,
   `ci-runner:label`, `ci-runner:repo`, `ci-runner:job-id`, `ci-runner:run-id`,
   `ci-runner:head-sha`, `ci-runner:job-name` and `ci-runner:labels` (the
   job's labels, comma-joined, for the swap repair), plus the launch template's
   `ci-runner:stack`.
7. If no instance launches, it removes the registration it just minted and
   fails the message, which comes back 120 s later.

There is no de-duplication on job id. A duplicate delivery launches a second
runner at worst, and the idle exit and the sweeper remove it.

`cloudformation deploy` keeps a parameter's previous value unless it's
overridden, so after lowering a cap for a test, restore it explicitly
(`--parameter-overrides SpotCap=6 OnDemandCap=2`).

The launcher's role allows `GetSecretValue`, the queue's receive, delete and
send, `ec2:DescribeInstances` (for the cap),
`Create`/`DeleteLaunchTemplateVersions` on the launch template, and
`CreateFleet`/`RunInstances` pinned to the launch template, the three subnets
and the security group. It also allows `CreateTags` only while creating
(`ec2:CreateAction`), and `ssm:GetParameters` on the public AL2023 parameters,
which the launch template's `resolve:ssm:` image needs. It has no
`iam:PassRole`. `CreateFleet`'s check on the instances, volumes and network
interfaces it creates carries no launch-template key, so those resources
are granted to `CreateFleet` without one. `RunInstances` keeps the condition.

## Reporting a Spot reclaim: the notifier

`functions/notifier.js` runs on every **EC2 Spot Instance Interruption
Warning** in the region (the rule `${stack}-notifier`; an event pattern can't
match on tags). For each warning it:

1. Describes the instance, and ignores it (logged) unless it carries
   `ci-runner:stack=<stack>`, `ci-runner:head-sha`, `ci-runner:job-id` and a
   `ci-runner:repo` in `GITHUB_ORG`: the launcher's tags. An instance from
   `make hand-launch` has no job tags and is ignored.
2. Signs an App JWT, finds the repo's installation
   (`GET /repos/{repo}/installation`) and gets its token.
3. Creates a check run on the head sha: name `ci-runner / <job name>` (or
   `job <id>` with no name), `completed`, conclusion `failure`, title
   `Spot capacity reclaimed: re-run this job`, a summary naming the job and
   the instance and linking the run, and `details_url` the job's page.

A GitHub failure fails the invocation, and EventBridge's async invoke retries
it. A duplicate event creates a second, identical check run.

The launcher, the notifier and the sweeper each carry their own copy of
`appJwt()` and `gh()`, because bundling a shared module costs more template
bytes than the copies. `test/conventions.test.js` fails if the copies differ,
so change all three at once.

Its role allows `GetSecretValue` on the secret and `ec2:DescribeInstances`.
