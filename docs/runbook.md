# Runbook

The owner's procedures for the `ci-runner` stack. The layout and the
Lambdas are in [stack.md](stack.md), and the design is in
[the spec](superpowers/specs/2026-11-12-ci-runner-design.md).

Everything runs in `zeroae-code` / `us-east-1`, under the SSO profile
`zeroae-code/AWSPowerUserAccess`. The commands below use:

```bash
AWS="aws --profile zeroae-code/AWSPowerUserAccess --region us-east-1"
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
stack takes the defaults (`SpotVcpuCap` 24, `OnDemandVcpuCap` 8, `AppName`
`zeroae-ci-runner`, `RunnerGroup` `ci-runner`, `LogRetentionDays` 30), and an
existing stack keeps whatever values it already has.

To change a parameter, build, then deploy with an override:

```bash
make build
$AWS cloudformation deploy --stack-name ci-runner \
  --template-file build/template.yaml --s3-bucket "$B" --s3-prefix ci-runner \
  --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset \
  --parameter-overrides SpotVcpuCap=24 OnDemandVcpuCap=8
```

`SpotVcpuCap` draws on the EC2 Spot vCPU quota (`L-34B43A08`) and
`OnDemandVcpuCap` on the EC2 On-Demand one (`L-1216C47A`); each covers x64 and
arm64 runners together.

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

When AWS reclaims a Spot instance, GitHub marks the job failed, with *The
runner has received a shutdown signal*, *lost communication with the server*,
or (seen in the live FIS test) just *Process completed with exit code 130*
on the running step. On the same commit there is a failed check run from the App, named
`ci-runner / <job name>` and titled `Spot capacity reclaimed: re-run this job`.
Its summary names the instance and links the run. That is the whole story:
re-run the failed job. Nothing retries it automatically.

To list those check runs on a commit:

```bash
gh api repos/zeroae/<repo>/commits/<sha>/check-runs \
  --jq '.check_runs[] | select(.name | startswith("ci-runner /")) | [.name, .conclusion, .output.title] | @tsv'
```

A job lost **without** that check run wasn't a Spot reclaim. Look in the
notifier's log for a line `reported <instance>: <repo> job <id>`. An instance
from `make hand-launch` carries no job tags, so the notifier ignores it and
logs `ignored: <instance> is no job instance of this stack`. A job that sits
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
for a job from any repo but a private `zeroae` one (fence 3). Everything else it
ignores without a log line.

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

**The sweeper** runs every 10 minutes and logs only what it did:
`sweeper: terminated i-...` (an instance launched over 2 hours ago),
`sweeper: removed runner <name> (id <id>)` (an offline registration with no
instance), or that it skipped the registrations: `the GitHub App is not set up
yet`, or `no runner group named ci-runner yet`.

```bash
make runners     # the stack's instances that are not terminated
make sweep       # run the sweeper now; prints {"terminated": [...], "removed": [...]}
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

## Measured numbers

Measured on the canary repo when the stack first went live (2026-11-12).
Re-measure after any change to the image, the cloud-config or the instance
types.

- **Boot time:** about 100 s from queued to started, so a job is worth
  moving when it runs well over 2 minutes. The first job after a deploy took
  about 3½ minutes, while the stack's functions were still cold. A hand
  launch (`make hand-launch`) took about 97 s to pick up its job.
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

  The Fargate budgets aren't in the stack yet; their rows are for when the
  Fargate capacities land.

- **Template size:** 50,301 bytes, 5% of the S3 deploy's 1 MB limit. It's
  already over the 51,200 bytes a template can be sent inline, so it deploys
  only through the deploy bucket.

## Traps

| Symptom | Cause |
|---|---|
| A job's `docker run -v ...` sees an empty directory, fails `error mounting "...": not a directory`, or hits `read-only file system` inside a mounted config directory, only on our runners | the source isn't under a path shared with the host, so Docker mounts an empty host path (for a missing file, a directory it creates). Only `/tmp` and `/home/runner` are shared, at the same paths; mount from one of those. If `/tmp` or `$HOME` itself fails, the start script's mounts (`functions/cloud-config.js`) changed |
| `permission denied` on `/var/run/docker.sock` | the host's `docker` group isn't gid 123 |
| `setup-python` fails, or picks up a broken Python | `AGENT_TOOLSDIRECTORY` isn't `/opt/hostedtoolcache` |
| A deploy waits 60 minutes, then fails on the state lock | an `apply` ran on Spot and was reclaimed; it must be `ci-ondemand` |
| A job sits "Waiting for a runner" | its capacity's vCPU budget is full, the repo isn't in the group, the App isn't installed on it, or the repo is public. Also check the label contract: `self-hosted`, exactly one of `ci-spot`/`ci-ondemand`, at most one size label (`ci-cpu-2`/`-4`/`-8`/`-16`), at most one of `x64`/`arm64`, and otherwise only `linux`. The launcher's log tells the first case (`deferred`) apart from the rest (no line at all). A job that queued before the repo was turned on stays waiting after the fix: cancel and re-run it |
| An `arm64` runner's instance comes up and terminates without taking its job, and its console shows `no matching manifest for linux/arm64` | `ghcr.io/zeroae/ci-runner:latest` has no arm64 entry yet: the image workflow hasn't pushed a multi-arch `:latest` since it began building arm64. Run the image workflow on `main`, then re-run the job |
| A job fails "The runner has received a shutdown signal", "lost communication" or "exit code 130", next to a failed `ci-runner / <job>` check | Spot reclaim: re-run the job |
| A budget lowered for a test is still low after the next `make deploy` | `cloudformation deploy` keeps a parameter's previous value unless it's overridden; restore it with `--parameter-overrides SpotVcpuCap=24 OnDemandVcpuCap=8`. `SpotVcpuCap` draws on the EC2 Spot vCPU quota (`L-34B43A08`), `OnDemandVcpuCap` on the EC2 On-Demand one (`L-1216C47A`) |
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
