# The stack: layout and conventions

One CloudFormation stack, `ci-runner`, in `zeroae-code` / `us-east-1`.
`make help` lists the targets.

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
2. Put the logic behind a `createHandler(deps)` factory that takes its
   adapters (AWS clients, `fetch`, clock) and returns the handler. Tests
   import the file and call `createHandler` with fakes. `exports.handler`
   builds the real adapters once and delegates. `functions/setup.js` is the
   example.
3. In `template.yaml`, give it:
   - `Code: ZipFile: |` whose only line is `//@inline functions/<name>.js`,
     indented as block content. The build replaces that line with the file,
     indented to match. `Handler: index.handler`, `Runtime: nodejs22.x`.
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
  **51,200-byte** limit (the largest template `aws cloudformation deploy` sends
  without an S3 bucket). The build fails at or over it, and
  `test/build.test.js` checks it too.
- `make deploy`: test, build, then `cloudformation deploy` with
  `CAPABILITY_NAMED_IAM`, then print the outputs. It creates the stack the
  first time and updates it after. Override `STACK`, `PROFILE`, `REGION` on the
  command line if needed.

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
`require()`, so the launcher can inline it.
`test/cloud-config.test.js` covers it. On the instance:

1. `bootcmd` creates `docker` with gid 123 before the `docker` package does.
2. `write_files` puts the JIT config in `/etc/ci-runner/jitconfig` (`0600`)
   and the start script in `/usr/local/sbin/ci-runner`.
3. `runcmd` starts Docker and runs the start script, which pulls
   `ghcr.io/zeroae/ci-runner:latest` and runs it with the host's socket and
   `/home/runner/_work` mounted at the same path, as `./run.sh --jitconfig`.
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
