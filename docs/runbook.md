# Runbook

The owner's procedures for the `ci-runner` stack. The layout and the
Lambdas are in [stack.md](stack.md), and the design is in
[the spec](superpowers/specs/2026-11-12-ci-runner-design.md).

Everything runs in `zeroae-code` / `us-east-1`, under the SSO profile
`zeroae-code/ZAEPowerUserAccess` (`make deploy`'s default `PROFILE`). Unlike
`AWSPowerUserAccess`, it allows `iam:UpdateAssumeRolePolicy`, which a change
to a role's trust needs. Its roles must be named `PowerUserPB*`, with the
boundary `arn:aws:iam::aws:policy/PowerUserAccess` (the stack's) or
`ZAEPowerUserBoundary`. The commands below use:

```bash
AWS="aws --profile zeroae-code/ZAEPowerUserAccess --region us-east-1"
```

You need `aws`, `gh`, `jq`, `curl` and `node`. For anything that touches the
runner group, your `gh` login also needs the `admin:org` scope
(`gh auth refresh -h github.com -s admin:org`).

The order the first time is: create the deploy bucket, deploy the stack,
create the App, create the runner group, then turn repos on one at a time.

## Deploy and update the stack

`make deploy` uploads the template to the **deploy bucket**,
`ci-runner-deploy-<account id>`, and deploys from there. The bucket isn't part of the stack, so
it outlives a deleted stack and exists before the first deploy. Make it once
per account, private and encrypted:

```bash
B=ci-runner-deploy-$($AWS sts get-caller-identity --query Account --output text)
$AWS s3api create-bucket --bucket "$B"
$AWS s3api put-public-access-block --bucket "$B" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
$AWS s3api put-bucket-encryption --bucket "$B" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

(`create-bucket` takes no `--create-bucket-configuration` in `us-east-1`; in
any other region it needs `LocationConstraint=<region>`.) Each deploy uploads
the template as `ci-runner/<md5>.template`; the objects are small and can be
deleted at any time. A stack named other than `ci-runner` uses
`<stack>-deploy-<account id>`, or pass `BUCKET=<name>`.

```bash
make deploy      # make test, make build, cloudformation deploy, then print the outputs
make outputs     # SetupUrl, WebhookUrl, AppSecretArn, LaunchTemplateId, Arm64LaunchTemplateId, SubnetIds, ...
```

The first run creates the stack `ci-runner`, and later runs update it. A run
with no changes does nothing. `make deploy` never passes parameters, so a new
stack takes the defaults (`SpotVcpuCap` 24, `OnDemandVcpuCap` 8,
`FargateSpotVcpuCap` 24, `FargateVcpuCap` 8, `AppName`
`zeroae-ci-runner`, `RunnerGroup` `ci-runner`, `LogRetentionDays` 30,
`ExistingOidcProviderArn` empty), and an existing stack keeps whatever values
it already has. In `zeroae-code` GitHub's OIDC provider already exists, so
the first deploy that adds the image push must pass its ARN (see "Push the
image to ECR"); an empty value would try to create a second provider for the
same URL, and fail.

To change a parameter, build, then deploy with an override:

```bash
make build
$AWS cloudformation deploy --stack-name ci-runner \
  --template-file build/template.yaml --s3-bucket "$B" --s3-prefix ci-runner \
  --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset \
  --parameter-overrides SpotVcpuCap=24 OnDemandVcpuCap=8 FargateSpotVcpuCap=24 FargateVcpuCap=8
```

`SpotVcpuCap` draws on the EC2 Spot vCPU quota (`L-34B43A08`),
`OnDemandVcpuCap` on the EC2 On-Demand one (`L-1216C47A`),
`FargateSpotVcpuCap` on the Fargate Spot vCPU quota (`L-36FBB829`) and
`FargateVcpuCap` on the Fargate On-Demand one (`L-3032A538`); each covers x64
and arm64 runners together.

A budget is **soft**: a burst can go over it. The launcher handles queue
messages in parallel, and each one counts only the runners already running, so
jobs that queue at the same moment all see the same headroom. Seen live on
2026-11-13: a consumer repo queued 8 Spot jobs at once, and all 8 launched,
putting 36 of 24 Spot vCPUs in use. The owner chose to keep it soft. Size the
EC2 quotas for the burst, not the budget.

An override **sticks**: every later `make deploy` keeps it. After lowering a
budget for a test, restore it explicitly, as above. To see the current values:

```bash
$AWS cloudformation describe-stacks --stack-name ci-runner \
  --query 'Stacks[0].Parameters' --output table
```

Before raising a budget, check its quota still covers it (see "Measured
numbers").

The built template must stay under 1 MB, the S3 deploy's limit (`make build`
prints its size and fails at the limit).

## Push the image to ECR

`image.yml` pushes the runner image, with a SOCI v2 index, to the stack's
ECR repo on every `main` build (see "The runner image in ECR" in
[stack.md](stack.md)). There is nothing to rotate: the push assumes
`PowerUserPB-ci-runner-image-push` through GitHub OIDC, and no AWS key or
GitHub token is stored anywhere. Set it up once:

1. Deploy with the account's existing GitHub provider. In `zeroae-code` it
   is owned by another stack (see the traps table):

   ```bash
   OIDC=$($AWS iam list-open-id-connect-providers --output text \
     --query "OpenIDConnectProviderList[?ends_with(Arn, '/token.actions.githubusercontent.com')].Arn")
   echo "$OIDC"     # arn:aws:iam::<account id>:oidc-provider/token.actions.githubusercontent.com
   make build
   $AWS cloudformation deploy --stack-name ci-runner \
     --template-file build/template.yaml --s3-bucket "$B" --s3-prefix ci-runner \
     --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset \
     --parameter-overrides ExistingOidcProviderArn="$OIDC"
   ```

   The override sticks, so later `make deploy`s keep it. In an account with
   no provider, leave it empty and the stack creates one.
2. Give `image.yml` the stack's outputs as repo variables:

   ```bash
   out() { $AWS cloudformation describe-stacks --stack-name ci-runner \
     --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
   gh variable set ECR_IMAGE --repo zeroae/ci-runner --body "$(out ImageRepositoryUri)"
   gh variable set AWS_IMAGE_PUSH_ROLE_ARN --repo zeroae/ci-runner --body "$(out ImagePushRoleArn)"
   ```

   Until both are set, a `main` build skips the ECR push and publishes only
   to GHCR.
3. Run a `main` build (`gh workflow run image.yml --repo zeroae/ci-runner --ref main`),
   then check that `:latest` is an index with both architectures and a SOCI
   index for each:

   ```bash
   $AWS ecr batch-get-image --repository-name ci-runner --image-ids imageTag=latest \
     --accepted-media-types application/vnd.oci.image.index.v1+json \
     --query 'images[0].imageManifest' --output text \
     | jq '[.manifests[] | {artifactType, arch: .platform.architecture}]'
   ```

   It should list `amd64` and `arm64` twice each: once with no
   `artifactType` (the image) and once with
   `application/vnd.amazon.soci.index.v2+json`.

## Create the App and the runner group (the wizard)

GitHub has no API that creates an App. The stack's setup URL posts the App
manifest from your browser, and you press one button. The wizard walks you
through it:

```bash
scripts/setup-github.sh
```

Its five stages:

1. **AWS session and the stack's URLs.** It finds the stack and its
   `SetupUrl`.
2. **Create the GitHub App.** It opens the setup URL. Sign in as an owner of
   `zeroae`, leave the name and settings as they are, and press *Create
   GitHub App*. GitHub sends you back to a page that says `Stored the GitHub
   App ...`. The setup function has exchanged the code and written `app_id`,
   `app_slug`, `private_key` and `webhook_secret` into the stack's secret. The
   key never leaves AWS. The wizard then checks that the setup URL answers
   **410**: from now on it refuses every request.
3. **Install the App on one private canary repo.** It asks for the repo's name
   (it must be private) and saves it as `CI_RUNNER_CANARY_REPO` in `.env`. On
   the install page, choose *Only select repositories* and pick only that
   repo.
4. **Create the `ci-runner` runner group.** It creates the org group
   `ci-runner` with *Selected repositories* (only the canary) and public
   repositories not allowed. It asks first, with a **y/N** prompt: type `y`,
   then Enter. Enter on its own means no. If the group already exists, the
   wizard makes sure it's selected-only with public repos off, and adds the
   canary.
5. **Verify.** It checks the group's settings and repos, and checks, through
   the App's own token, that the installation covers only the canary and that
   it subscribes to `workflow_job`.

The wizard can be re-run. Each stage skips what's already done, and `.env`
remembers the canary's name.

If GitHub says the App's name is taken, deploy with another name
(`--parameter-overrides AppName=<name>`, as above), then re-run the wizard.

To create the group by hand instead (`<repo>` is the first repo it serves):

```bash
REPO_ID=$(gh api repos/zeroae/<repo> --jq .id)
jq -n --argjson r "$REPO_ID" \
  '{name:"ci-runner", visibility:"selected", selected_repository_ids:[$r], allows_public_repositories:false}' \
  | gh api -X POST orgs/zeroae/actions/runner-groups --input -
```

## Turn a repo on and off

A repo is served when all of these hold:

1. it is private, in `zeroae`;
2. the App is installed on it;
3. it is in the `ci-runner` runner group;
4. its routing variable is set (for example `ZAE_CI_RUNNER`; see the
   [README](../README.md#moving-a-private-repos-jobs-onto-it)).

**On:**

1. Install the App on the repo. In the org's settings, open *GitHub Apps*,
   then *Configure* next to the App (`zeroae-ci-runner` unless `AppName` was
   changed). Under *Repository access*, add the repo, then *Save*. Keep *Only
   select repositories*.
2. Add the repo to the runner group:

   ```bash
   GROUP_ID=$(gh api orgs/zeroae/actions/runner-groups --paginate \
     --jq '.runner_groups[] | select(.name == "ci-runner") | .id')
   REPO_ID=$(gh api repos/zeroae/<repo> --jq .id)
   gh api -X PUT orgs/zeroae/actions/runner-groups/$GROUP_ID/repositories/$REPO_ID
   gh api orgs/zeroae/actions/runner-groups/$GROUP_ID/repositories --jq '.repositories[].name'
   ```

3. Set the variable last, once the repo's workflow routes through it:

   ```bash
   gh variable set ZAE_CI_RUNNER --repo zeroae/<repo> --body 1
   ```

   A job that queued while a step above was missing never gets a runner, even
   after the step is done: the webhook acts only on a job's `queued` event,
   and that came before the repo was served. Cancel the job and re-run it.

**Off:**

- **Quick, no code change** (the rollback): unset the variable. The next run
  goes back to `ubuntu-latest`.

  ```bash
  gh variable delete ZAE_CI_RUNNER --repo zeroae/<repo>
  ```

- **For good:** also remove the repo from the group, and from the App's
  installation (*Configure*, then remove it under *Repository access*).

  ```bash
  gh api -X DELETE orgs/zeroae/actions/runner-groups/$GROUP_ID/repositories/$REPO_ID
  ```

## Read a lost job

When AWS reclaims a Spot instance or a Fargate Spot task, GitHub marks the job failed, with *The
runner has received a shutdown signal*, *lost communication with the server*,
or (seen in the live FIS test) just *Process completed with exit code 130*
on the running step. On the same commit there is a failed check run from the App, named
`ci-runner / <job name>` and titled `Spot capacity reclaimed: re-run this job`.
Its summary names the instance (or the task's id) and links the run. That is
the whole story: re-run the failed job. Nothing retries it automatically.
One check run per job: the notifier skips a job whose commit has it already.

To list those check runs on a commit:

```bash
gh api repos/zeroae/<repo>/commits/<sha>/check-runs \
  --jq '.check_runs[] | select(.name | startswith("ci-runner /")) | [.name, .conclusion, .output.title] | @tsv'
```

A job lost **without** that check run wasn't a Spot reclaim. Look in the
notifier's log for a line `reported <instance or task id>: <repo> job <id>`
(or `already reported ...`). An instance from `make hand-launch`, or a task
run by hand, carries no job tags, so the notifier ignores it and logs
`ignored: <instance> is no job instance of this stack` (`... no job task
...` for a task). A task's stop code is in `describe-tasks` (below):
`SpotInterruption` is a reclaim. A job that sits
*Waiting for a runner* is not lost: see the traps table, then the launcher's
log.

## Read the logs

Each Lambda logs to `/aws/lambda/ci-runner-<name>` (kept 30 days):

```bash
$AWS logs tail /aws/lambda/ci-runner-launcher --since 1h            # add --follow to watch
$AWS logs tail /aws/lambda/ci-runner-webhook  --since 1h
$AWS logs tail /aws/lambda/ci-runner-sweeper  --since 1h
$AWS logs tail /aws/lambda/ci-runner-notifier --since 1d
```

**The webhook** logs one JSON line per accepted job, `{"enqueued": "<repo>",
"job_id": ..., "label": ...}`, and `{"refused": "<repo>", "visibility": ...}`
for a job from any repo but a private `zeroae` one (fence 3), and `{"swap":
"<runner>", "instance": "i-...", "took": {...}, "requeued": {...}}` (with
`"task": "<task ARN>"` for a Fargate runner) for each swap it repairs: the runner launched for the `requeued` job started the `took`
job instead. Everything else it ignores without a log line.

**The launcher** logs one JSON line per job, carrying the job's fields plus one
of:

| Field | Meaning |
|---|---|
| `"launched": "i-..."`, `"runner"`, `"label"` | an instance is up for the job |
| `"deferred": "20+8 of 24 spot vCPUs"` | the job's 8 vCPUs would take the capacity's 20 over its budget of 24; the job is back on the queue in 60 s |
| `"dropped": "completed"` (or another status) | the job no longer waits (cancelled, or taken by another runner); nothing launched |
| `"dropped": "job not found"` | GitHub answered 404 for the job |
| `"dropped": "malformed message"` | a message it can't read, consumed |
| `"error": "..."` | the attempt failed; the message comes back in 120 s, and after 5 failures it goes to the dead-letter queue. `no instance launched: <code>: <message>` carries EC2 Fleet's errors |

To count what is waiting, and what has failed for good:

```bash
for q in JobQueueUrl JobDeadLetterQueueUrl; do
  url=$($AWS cloudformation describe-stacks --stack-name ci-runner \
    --query "Stacks[0].Outputs[?OutputKey=='$q'].OutputValue" --output text)
  echo "$q $($AWS sqs get-queue-attributes --queue-url "$url" \
    --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)"
done
```

**A Fargate task's runner** logs to `/ecs/ci-runner-runner` (kept 7 days),
one stream per task, `runner/runner/<task id>`: `Listening for Jobs`, then
`Running job: <name>`, or the idle exit's `ci-runner: no job within 900s,
stopping`. The launcher's `launched` line names the task's ARN; its last part
is the task id.

```bash
$AWS logs tail /ecs/ci-runner-runner --since 1h --format short
$AWS ecs list-tasks --cluster ci-runner                     # the live tasks
$AWS ecs describe-tasks --cluster ci-runner --tasks <arn> --include TAGS \
  --query 'tasks[].[lastStatus,capacityProviderName,stopCode,stoppedReason]'
```

**The sweeper** runs every 10 minutes and logs only what it did:
`sweeper: terminated i-...` (an instance launched over 2 hours ago),
`sweeper: stopped arn:aws:ecs:...:task/ci-runner/<id>` (a task launched over
2 hours ago; its `stoppedReason` says `ci-runner sweeper`),
`sweeper: removed runner <name> (id <id>)` (an offline registration with no
instance or task), or that it skipped the registrations: `the GitHub App is
not set up yet`, or `no runner group named ci-runner yet`.

```bash
make runners     # the stack's instances that are not terminated
make sweep       # run the sweeper now; prints {"terminated": [...], "stopped": [...], "removed": [...]}
```

## Re-register the App

The setup URL refuses everything once the secret holds a key. Re-registering
(a lost or leaked key, a new App) means emptying the secret **on purpose**.
Until a new App is stored, the webhook answers 503, the launcher fails every
job (the jobs wait, then reach the dead-letter queue), and the sweeper skips
registrations. So unset each repo's variable first if jobs should keep running
on GitHub-hosted runners in the meantime.

1. Delete the old App on GitHub: in the org's settings, open *Developer
   settings*, *GitHub Apps*, the App, then *Advanced* and *Delete GitHub App*.
   This also frees its name. To keep the old App, deploy with another `AppName`
   instead.
2. Replace the secret's value with a fresh `state_key` and nothing else. The
   setup function signs its `state` with that key, so `{}` is not enough:

   ```bash
   ARN=$($AWS cloudformation describe-stacks --stack-name ci-runner \
     --query "Stacks[0].Outputs[?OutputKey=='AppSecretArn'].OutputValue" --output text)
   $AWS secretsmanager put-secret-value --secret-id "$ARN" \
     --secret-string "{\"state_key\":\"$(openssl rand -hex 32)\"}"
   ```

3. Check that the setup URL serves the page again (`200`, not `410`):

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' "$(make -s outputs | awk '$1=="SetupUrl"{print $2}')"
   ```

4. Re-run `scripts/setup-github.sh`. It creates the App, installs it on the
   canary, and keeps the existing runner group. Then install the App on every
   other repo it served before (see "Turn a repo on and off"), and set their
   variables again.
5. Restart the webhook and the launcher. A warm webhook keeps the old App's
   webhook secret, and a warm launcher keeps the old key, until Lambda replaces
   its execution environment. Any configuration change replaces it, so change
   each one's description (the template's text comes back on the next deploy
   that changes the function). This step hasn't been tried live yet:

   ```bash
   for fn in webhook launcher; do
     $AWS lambda update-function-configuration --function-name ci-runner-$fn \
       --description "restarted $(date -u +%FT%TZ) after re-registering the App" >/dev/null
   done
   ```

## Run a task by hand

To test the Fargate path without the launcher (the idle exit, say), mint a
JIT config as `scripts/hand-launch.sh` does and run one task of the stack's
task definition. Its labels should match no queued job, so nothing takes it;
`IDLE_SECONDS` in the override shortens its idle exit, for this task only:

```bash
out() { $AWS cloudformation describe-stacks --stack-name ci-runner \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
GROUP_ID=$(gh api orgs/zeroae/actions/runner-groups --paginate \
  --jq '.runner_groups[] | select(.name == "ci-runner") | .id')
NAME=ci-runner-hand-$(date -u +%Y%m%d%H%M%S)
JIT=$(gh api -X POST orgs/zeroae/actions/runners/generate-jitconfig -f name="$NAME" \
  -F runner_group_id="$GROUP_ID" -f work_folder=_work \
  -f 'labels[]=self-hosted' -f 'labels[]=hand-test' --jq .encoded_jit_config)
NET=$(jq -nc --arg sg "$(out SecurityGroupId)" --arg s "$(out SubnetIds)" \
  '{awsvpcConfiguration: {subnets: ($s | split(",")), securityGroups: [$sg], assignPublicIp: "ENABLED"}}')
$AWS ecs run-task --cluster ci-runner --task-definition "$(out TaskDefinitionArn)" \
  --capacity-provider-strategy capacityProvider=FARGATE_SPOT,weight=1 --network-configuration "$NET" \
  --overrides "$(jq -nc --arg jit "$JIT" '{containerOverrides: [{name: "runner",
    command: ["./run.sh", "--jitconfig", $jit], environment: [{name: "IDLE_SECONDS", value: "120"}]}]}')" \
  --tags key=ci-runner:stack,value=ci-runner key=ci-runner:runner,value="$NAME" \
  --query 'tasks[0].taskArn' --output text
```

The task stops about 2 minutes after `Listening for Jobs`. Its registration
stays, offline, until the sweeper removes it. A hand-run task that never
stops is stopped by the sweeper 2 hours after launch, as any task in the
cluster is.

## Measured numbers

Measured on the canary repo when the stack first went live (2026-11-12).
Re-measure after any change to the image, the cloud-config or the instance
types.

- **Boot time:** about 100 s from queued to started, so a job is worth
  moving when it runs well over 2 minutes. The first job after a deploy took
  about 3½ minutes, while the stack's functions were still cold. A hand
  launch (`make hand-launch`) took about 97 s to pick up its job.
- **Fargate Spot against EC2 Spot** (the #28 spike, 2026-11-14, with
  `scripts/prototype-fargate-spike.sh` on the `prototype/fargate-spot`
  branch). One job, `cargo build --locked -p ruff` (ruff 0.17.5, debug,
  cold: no cache), at 4 vCPU / 16 GB / 50 GB, the Fargate task running the
  ECR image with its SOCI v2 index and `./run.sh --jitconfig` as its command.
  The EC2 runners were hand-launched (`hand-launch.sh`, the launcher's
  templates and fleet) because other repos' jobs held the stack's Spot budget
  at the time:

  | | Fargate x64 | EC2 x64 | Fargate arm64 | EC2 arm64 |
  |---|---|---|---|---|
  | CPU | Xeon 8259CL (Cascade Lake) | `m6a.xlarge` (EPYC 7R13) | Graviton3 | `m8g.xlarge` (Graviton4) |
  | Queued to started | **27 s** | 102 s | **30 s** | 92 s |
  | `RunTask` to `pullStartedAt` (provisioning) | 19.3 s | | 20.6 s | |
  | `pullStartedAt` to `pullStoppedAt` (820 MB image) | 2.8 s | | 2.6 s | |
  | Task started to `Listening for Jobs` | 4 s | | 4 s | |
  | Build step | 248 s | 171 s | 168 s | 115 s |
  | Queued to completed | 316 s | 306 s | 227 s | 230 s |
  | Billed time | 321 s | ~316 s | 234 s | ~234 s |
  | Price per hour | $0.0879 | $0.0700 + $0.0055 EBS | $0.0710 | $0.0926 + $0.0055 EBS |
  | Cost per job | $0.0078 | $0.0066 | $0.0046 | $0.0064 |

  A first run (ripgrep, a 22 s build) gave Fargate 22 s and 57 s queued to
  started: in the 57 s, the arm64 runner was listening 33 s before GitHub
  gave it the job. The pull takes about 3 s, so SOCI lazy-loads; the
  provisioning before it (13 to 21 s) is the bulk of a Fargate start. A
  task reaches `STOPPED` 24 to 29 s after its job completes, and is billed
  until then. Fargate's CPUs are
  older than the EC2 families' (one x64 task got a Sapphire Rapids 8488C, the
  other a Cascade Lake), so the same build ran about 45% longer on both
  architectures. Inside 3 of the 4 tasks, `nproc` said 8 and `free` 30 GB:
  the task's limits aren't what a job that sizes itself by `nproc` sees.
  Fargate prices: 4 vCPU and 16 GB at the Fargate Spot rates, plus 30 GB of
  ephemeral storage over the free 20 GB; EC2: the Spot price of that type and
  AZ at launch, plus 50 GB of gp3. An EC2 instance's end is estimated at 15 s
  after its job, since a self-shutdown leaves no timestamp.

- **vCPU quotas** in `us-east-1`, read 2026-11-13. Each budget draws on one
  quota, shared with every other workload in the account:

  | Quota | Code | Value | AWS default | Budget default | Account peak, 14 days |
  |---|---|---|---|---|---|
  | EC2 Spot (All Standard Spot Instance Requests) | `L-34B43A08` | 256 | 5 | 24 | 32 |
  | EC2 On-Demand (Running On-Demand Standard instances) | `L-1216C47A` | 384 | 5 | 8 | 4 |
  | Fargate Spot vCPU resource count | `L-36FBB829` | 140 | 6 | 24 | 0 |
  | Fargate On-Demand vCPU resource count | `L-3032A538` | 140 | 6 | 8 | 0 |

  All four cover the default budgets with room to spare, so no increase was
  requested. The peak is the `AWS/Usage` `ResourceCount` maximum, and it
  includes this stack's own runners. Check the quota, and the peak, before
  raising a budget:

  ```bash
  $AWS service-quotas get-service-quota --service-code ec2 --quota-code L-34B43A08      # EC2 Spot
  $AWS service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A      # EC2 On-Demand
  $AWS service-quotas get-service-quota --service-code fargate --quota-code L-36FBB829  # Fargate Spot
  $AWS service-quotas get-service-quota --service-code fargate --quota-code L-3032A538  # Fargate On-Demand
  $AWS cloudwatch get-metric-statistics --namespace AWS/Usage --metric-name ResourceCount \
    --dimensions Name=Service,Value=Fargate Name=Type,Value=Resource Name=Resource,Value=vCPU \
      Name=Class,Value=Standard/Spot \
    --start-time "$(date -u -d '-14 days' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
    --period 86400 --statistics Maximum --query 'max(Datapoints[].Maximum)'
  ```

  For the other three peaks, use `Service` `EC2` and `Class`
  `Standard/OnDemand` as fits.

  A Fargate quota at its AWS default of 6 vCPUs is below its budget: with
  the default budgets, a job then fails to launch instead of waiting (see the
  traps table).

- **Template size:** 55,871 bytes, 5% of the S3 deploy's 1 MB limit. It's
  already over the 51,200 bytes a template can be sent inline, so it deploys
  only through the deploy bucket.

## Traps

| Symptom | Cause |
|---|---|
| A job's `docker run -v ...` sees an empty directory, fails `error mounting "...": not a directory`, or hits `read-only file system` inside a mounted config directory, only on our runners | the source isn't under a path shared with the host, so Docker mounts an empty host path (for a missing file, a directory it creates). Only `/tmp` and `/home/runner` are shared, at the same paths; mount from one of those. If `/tmp` or `$HOME` itself fails, the start script's mounts (`functions/cloud-config.js`) changed |
| `permission denied` on `/var/run/docker.sock` | the host's `docker` group isn't gid 123 |
| `setup-python` fails, or picks up a broken Python | `AGENT_TOOLSDIRECTORY` isn't `/opt/hostedtoolcache` |
| A deploy waits 60 minutes, then fails on the state lock | an `apply` ran on Spot and was reclaimed; it must be `ci-ondemand` |
| A job sits "Waiting for a runner" | its capacity's vCPU budget is full, the repo isn't in the group, the App isn't installed on it, or the repo is public. Also check the label contract: `self-hosted`, exactly one of `ci-spot`/`ci-ondemand`/`ci-fargate-spot`/`ci-fargate`, exactly one size label (`ci-cpu-2`/`-4`/`-8`/`-16`), exactly one of `x64`/`arm64`, and otherwise only `linux`. The launcher's log tells the first case (`deferred`) apart from the rest (no line at all). A job that queued before the repo was turned on stays waiting after the fix: cancel and re-run it |
| A job that ran on our runners before now sits "Waiting for a runner", and the webhook's log shows no `enqueued` line for it | missing size or architecture label: its `runs-on` names only its capacity (`self-hosted`, `ci-spot`). There are no defaults; add a size and an architecture label (`ci-cpu-4` and `x64` keep the old shape), then cancel and re-run the job |
| An `arm64` runner's instance comes up and terminates without taking its job, and its console shows `no matching manifest for linux/arm64` | `ghcr.io/zeroae/ci-runner:latest` has no arm64 entry yet: the image workflow hasn't pushed a multi-arch `:latest` since it began building arm64. Run the image workflow on `main`, then re-run the job |
| A job's runner was launched for another job (`$RUNNER_NAME` ends in another job id), and that other job sits "Waiting for a runner" | a swap. The webhook repairs it on the job's `in_progress` (its log says `swap`), and the launcher then launches a runner for the other job. No `swap` line: check the webhook's log for errors (its role needs `ec2:DescribeInstances` and `ec2:CreateTags`, and for a task `ecs:ListTasks`, `ecs:DescribeTasks` and `ecs:TagResource`); cancel and re-run the waiting job |
| A Fargate Spot job was lost (its task's `stopCode` is `SpotInterruption`) and its commit has no `ci-runner / <job>` check run | the notifier logged `ignored: <task id> is no job task of this stack` for every change of the stop: it found no job tags on the task. ECS keeps a stopped task's tags readable through `DescribeTasks` (measured live), so check the task's tags (`describe-tasks --include TAGS`, within an hour of the stop; `list-tags-for-resource` refuses a stopped task) and the notifier's role. Re-run the job |
| A job fails "The runner has received a shutdown signal", "lost communication" or "exit code 130", next to a failed `ci-runner / <job>` check | Spot reclaim: re-run the job |
| A budget lowered for a test is still low after the next `make deploy` | `cloudformation deploy` keeps a parameter's previous value unless it's overridden; restore it with `--parameter-overrides SpotVcpuCap=24 OnDemandVcpuCap=8 FargateSpotVcpuCap=24 FargateVcpuCap=8`. Each draws on its own vCPU quota (see "Deploy and update the stack") |
| A job on `ci-fargate-spot` or `ci-fargate` fails at a Docker step: `failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running`, or a `services:`/`container:` job or Docker action fails to start | Docker used on Fargate. A Fargate capacity has no Docker daemon, by design (ADR-0001): move the job to `ci-spot` or `ci-ondemand`, or drop its Docker use |
| The launcher logs `no task launched:` with a reason about a vCPU limit, and the job's message keeps coming back until the dead-letter queue | a Fargate quota at its default (6 vCPUs, `L-36FBB829` Spot, `L-3032A538` On-Demand) or below the capacity's budget. Request an increase (Service Quotas, service `fargate`) or lower `FargateSpotVcpuCap`/`FargateVcpuCap` under the quota; then re-run the job. The quota counts every Fargate task in the account, not only ours |
| A Fargate job's build is slow, or runs out of memory, with many more compiler processes than the size's vCPUs | `nproc` over-reports inside a task. The job's environment caps `CARGO_BUILD_JOBS`, `CMAKE_BUILD_PARALLEL_LEVEL` and `MAKEFLAGS`; a tool that reads `nproc` any other way needs `-j` from one of them |
| The launcher logs `not authorized to perform: iam:PassRole on resource: ...runner-exec because no permissions boundary allows the iam:PassRole action` for every Fargate job | the launcher's role has the `PowerUserAccess` boundary, which allows no `iam:PassRole`. It must have `ZAEPowerUserBoundary` (see "The Fargate capacities" in stack.md); in an account without that policy, the Fargate capacities can't launch |
| A Fargate task logs `ci-runner: no job within ...s, stopping` but keeps running | the image's idle exit predates its session-wide stop: run the image workflow on `main`. Stop the task by hand meanwhile (`$AWS ecs stop-task --cluster ci-runner --task <arn>`) |
| A Fargate task stops at once, its `stoppedReason` naming `ci-runner-idle-exit` (no such file) | the ECR image's `:latest` predates the idle-exit wrapper: run the image workflow on `main`, then re-run the job |
| A Fargate task sits `PROVISIONING`, then stops `TaskFailedToStart` with `CannotPullContainerError` | the execution role can't pull from the stack's ECR repo, or `:latest` isn't there (see "Push the image to ECR") |
| The launcher logs `no instance launched`, with an authorization error from `CreateFleet` | `CreateFleet`'s check on the instance, volumes and network interfaces it creates carries no `ec2:LaunchTemplate` key, so a policy that adds that condition to them denies the launch. Grant those to `CreateFleet` without the condition; `RunInstances` keeps it |
| The wizard stops with `runner group not created` | Enter at its **y/N** prompt means no. Re-run it, and type `y` at that prompt |
| Offline runners pile up in the `ci-runner` group | a runner stopped by the 15-minute idle exit stays registered, offline. The sweeper removes it on its next run, once it's 10 minutes past the stamp in its name (`make sweep` to run it now). If they stay, the sweeper's log says why |
| `make deploy` or `make validate` fails `NoSuchBucket`, or `AccessDenied` on the upload | the deploy bucket `ci-runner-deploy-<account id>` doesn't exist in this account yet; make it (see "Deploy and update the stack") |
| A deploy without `--s3-bucket` fails `Templates with a size greater than 51,200 bytes must be deployed via an S3 Bucket` | the template is over the inline limit; deploy with `make deploy`, or pass `--s3-bucket` as in "Deploy and update the stack" |
| `make build` fails at or over 1,048,576 bytes | the largest template CloudFormation accepts from S3. Trim the inlined code |
| The setup URL answers 410 `the GitHub App is already set up` | that's by design once the secret holds a key; see "Re-register the App" |
| The setup page fails on GitHub: the App's name is taken | App names are global on GitHub; deploy with another `AppName` |
| The webhook answers 503 | the secret holds no App yet (or was emptied): run the wizard |
| After re-registering, every delivery gets 401, or the launcher still can't get a token | a warm webhook or launcher still holds the old App's secret or key; restart both (step 5 of "Re-register the App") |
| After an update, the App's key is gone from the secret | the template's `GenerateSecretString` changed, so CloudFormation generated a new value. Never edit it; re-register the App |
| A deploy job moved to our runners can't assume its AWS role | the role's trust policy pins `runner_environment: github-hosted`; drop that condition |
| A deploy fails creating `GitHubOidcProvider`: the provider already exists | the account already has GitHub's OIDC provider, and an account holds one per URL. Deploy with `ExistingOidcProviderArn=<its ARN>` (see "Push the image to ECR") |
| `image.yml`'s ECR push fails `Not authorized to perform sts:AssumeRoleWithWebIdentity`, after it worked before | in `zeroae-code`, GitHub's OIDC provider is the resource `GitHubOIDCProvider` of the stack **`zael-github-e2e`**, not ours. If that stack was deleted, the provider went with it. Create the provider again once with `zeroae-code/ZAEFederation` (outside any stack; `ZAEPowerUserAccess` can't), then deploy with its ARN as `ExistingOidcProviderArn`. Asking that stack to retain the provider (`DeletionPolicy: Retain`) avoids this |
| `image.yml`'s ECR push fails `Not authorized to perform sts:AssumeRoleWithWebIdentity` on a branch, tag or pull request | by design: the push role trusts only `repo:zeroae@11018406/ci-runner@1455021495:ref:refs/heads/main` (the immutable subject). Branch runs push only to the job's local registry |
| `image.yml`'s ECR push fails `Not authorized to perform sts:AssumeRoleWithWebIdentity` on `main`, the first time | the trust's `sub` doesn't match the token's. This repo uses GitHub's immutable subject (`repo:<owner>@<id>/<repo>@<id>:...`); compare the role's trust with `gh api repos/zeroae/ci-runner/actions/oidc/customization/sub` |
| `image.yml` on `main` publishes to GHCR but skips both ECR steps | the repo variables `AWS_IMAGE_PUSH_ROLE_ARN` and `ECR_IMAGE` aren't set; set them from the stack's outputs (see "Push the image to ECR") |
| A deploy fails updating `ImagePushRole`'s trust with an access-denied `iam:UpdateAssumeRolePolicy` | it was deployed under `AWSPowerUserAccess`, which lacks that action; deploy under `zeroae-code/ZAEPowerUserAccess`, the default `PROFILE` |
