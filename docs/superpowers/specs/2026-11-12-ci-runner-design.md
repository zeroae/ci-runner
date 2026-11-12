# CI runners for zeroae's private repos

Status: design, agreed with the owner on 2026-11-12 (a question-by-question
session; the decisions below are the owner's unless marked *builder's call*).

## Intent

zeroae pays for GitHub Actions minutes on its private repos. The org is on the
GitHub **Free** plan: 2,000 private-repo minutes a month, then
$0.006/min for Linux 2-core (the January 2026 rate). In November 2026 the
busiest private repo alone was on track for about **12,500 billed minutes a
month (about $75)**, and a second repo had started paying too.

The money is not the point by itself. The owner wants to **run far more of each
repo's test suites in CI** (the busiest repo runs only a fraction of its suites
in CI today), and at GitHub's rate every added suite is a recurring bill. On our own Spot capacity, 1,000 extra suite-minutes cost about
$1.30 instead of $6.

So this repo provides **self-hosted GitHub Actions runners on AWS**: single-use
EC2 instances, one job each, registered at org level for `zeroae`, used by the
**long** jobs of zeroae's private repos. Short jobs stay on GitHub-hosted
runners.

In GitHub's own terms this is nothing new: it is a *self-hosted runner* in an
*org runner group*, registered with a *just-in-time (JIT) config*, run
*ephemeral*. The differences from GitHub-hosted runners (the OS image, the
toolcache, the cost model) are the part worth reading.

### Vocabulary

- **CI runner**: the machine one GitHub Actions job runs on. Either
  GitHub-hosted, or one of ours: a single-use machine that takes exactly one job
  and is then destroyed. It holds no AWS access of its own. Never write "runner"
  alone for it in a consuming repo that already has its own meaning for
  "runner".
- **Long job**: a job whose own run time is longer than the time it takes one
  of our CI runners to come up. It runs on **Spot**.
- **Critical job**: a job whose failure part-way needs a person to repair state
  by hand (the example: `terraform apply`, which leaves its S3 state lock held
  and can orphan resources). It runs on **On-Demand**, never Spot.
- **Short job**: everything else. It stays on GitHub-hosted runners.

## Goals

1. A private zeroae repo routes a long job to `ci-spot` and a critical job to
   `ci-ondemand`, and each gets a fresh EC2 instance that runs that one job and
   terminates.
2. The job's environment is Ubuntu 24.04, close enough to `ubuntu-latest` that
   existing workflows, including `actions/setup-*`, run unchanged.
3. A job lost to a Spot reclaim is reported as one, on the job's commit.
4. Nothing is left running: no instance outlives its job by long, and no runner
   registration outlives its instance.
5. Cost stays well under what the same minutes cost on GitHub (estimate below).
6. Each consuming repo can switch back to GitHub-hosted runners by unsetting
   one repo variable.

## Non-goals

- Serving public repos, personal-account repos, or any org but `zeroae`.
- Short jobs. Booting an instance for a 5-second job is slower and no cheaper.
- Automatic retry of a job lost to Spot. A lost job is red; a person re-runs it.
- Pinning the runner, the base image or the tools to versions (owner's call
  for now; see "Accepted risks").
- A pre-built machine image (AMI) or pre-pulled Docker image. Deferred until
  boot time is measured and hurts.
- More than one instance size. Start with `.xlarge`; flavours come later.
- Per-repo caps or a per-repo cost split.
- Any deploy permission. AWS access for deploys stays exactly as each consuming
  repo has it today (typically GitHub OIDC into the repo's own deploy role).

## Anti-goals (a failure even if it works)

- **A CI runner that holds AWS credentials worth stealing.** The instance has
  no IAM role at all.
- **A public repo's code running on our runners.** A public repo's fork PRs
  are outsiders' code.
- **An `apply` killed by a Spot reclaim.**
- **Instances that keep running and billing** because a job never arrived,
  a boot failed, or a webhook fired twice.

## Constraints (verified unless marked)

- **AWS account: `zeroae-code`.** Its SSO permission set `AWSPowerUserAccess`
  may create IAM roles and policies only when the name matches `PowerUserPB-*`
  **and** the permissions boundary `arn:aws:iam::aws:policy/PowerUserAccess` is
  attached. So every role and policy is named `PowerUserPB-${AWS::StackName}-<suffix>`,
  carries that boundary, and the stack deploys with `CAPABILITY_NAMED_IAM`.
  The only roles are the Lambdas' execution roles (the instances have none).
  **Not verified:** that the permission set allows `iam:PassRole` on such a
  role, which CloudFormation needs to create each function. **This is the
  first milestone's gate**:
  check it before writing anything else, because it decides whether the stack
  can be deployed by the owner's SSO login at all. If it can't, stop and bring
  it to the owner.
- **Region: `us-east-1`** (*builder's call*, where the prices were taken).
  The account's EC2 vCPU quotas must allow the caps: at least 24 Spot vCPUs and
  8 On-Demand standard vCPUs. Check them at the same gate; a new account's
  defaults can be lower.
- **Deploy access is unaffected.** A consuming repo's OIDC trust is keyed on the
  token's `sub` claim (`repo:zeroae/<repo>:...`), which doesn't depend on the
  runner; the first consumer's trust policy was checked and has no
  `runner_environment` condition. A repo whose trust policy *does* pin
  `runner_environment: github-hosted` must change it before moving a deploy job.
- **GitHub: org `zeroae`, Free plan.** The org can create runner groups beyond
  Default (the owner checked in the UI), and a group can be limited to selected
  repositories and kept off public repositories.
- **GitHub has no API that creates a GitHub App.** The only route is the
  manifest flow: a browser POSTs a manifest to
  `https://github.com/organizations/zeroae/settings/apps/new`, a person presses
  *Create GitHub App*, GitHub redirects to the manifest's `redirect_url` with a
  `code` valid for one hour, and `POST /app-manifests/{code}/conversions`
  returns the App id, its **private key** and its webhook secret. That response
  is the only moment the private key exists in retrievable form.
- **CodeBuild has no Spot capacity, and isn't cheaper.** Its on-demand Linux
  prices (us-east-1, AWS pricing API, 2026-11-12) are $0.005/min (small,
  2 vCPU, 3 GB), $0.010 (medium), $0.020 (large). Reserved fleets bill around
  the clock (the smallest is about $110 a month). That is why this design uses
  plain EC2.
- **ECS Fargate can't run Docker** (no privileged mode, no daemon), and the jobs
  build images and start containers. ECS on EC2 would put several jobs on one
  host and give every host the ECS agent's IAM role. Both were ruled out.
- **Self-hosted minutes are free on GitHub today.** GitHub announced a
  $0.002/min "cloud platform" charge for self-hosted runners in December 2025,
  then postponed it with no new date. If it returns, it eats into the saving.

## Design

### 1. What runs where

| Label in `runs-on` | Capacity | For |
|---|---|---|
| `ci-spot` | EC2 Spot, `.xlarge` | long jobs |
| `ci-ondemand` | EC2 On-Demand, `.xlarge` | critical jobs |
| (none; `ubuntu-latest`) | GitHub-hosted | short jobs |

A consuming repo chooses per job. Each one routes through a repo variable so it
can fall back without a code change (the variable's name is the repo's own):
set, a moved job asks for `[self-hosted, ci-spot]` or
`[self-hosted, ci-ondemand]`; unset, it asks for `ubuntu-latest`.

**Rollout, per repo:** one job moves first as a canary (typically its test
job). Its measured queued-to-started time *is* the boot time, and that number
decides which other jobs are long enough to move. Which jobs move is each
consuming repo's change, not this repo's.

### 2. GitHub side

- **A new GitHub App**, owned by `zeroae`, with exactly three permissions:
  - organization *Self-hosted runners: write*: mint org-level JIT configs,
    remove runners;
  - repository *Actions: read*: check that a queued job is still queued (not
    started elsewhere, not cancelled) before launching for it;
  - repository *Checks: write*: report a Spot reclaim on the job's commit.

  It subscribes to the `workflow_job` event. It is installed on **selected
  repositories**: the private repos the owner wants served.
- **A runner group `ci-runner`**, repository access *Selected repositories*
  (the same repos), **public repositories not allowed**. Every runner registers
  into it.
- **Three fences, deliberately redundant:**
  1. the App's installation: GitHub sends no webhook from a repo it isn't
     installed on;
  2. the runner group: GitHub gives a runner only to a job from a repo the group
     allows, never a public one;
  3. the webhook Lambda: it refuses any job whose `repository.visibility` is not
     `private` or whose owner isn't `zeroae`, whatever the other two say.

  The list of served repos lives in GitHub (installation and group), not in
  this stack.

### 3. AWS side: one CloudFormation stack in `zeroae-code`

#### Network
A VPC of its own; nothing is shared with any workload VPC.
- Public subnets in three Availability Zones (Spot needs the spread), an
  internet gateway, one route table with a default route to it.
- **No NAT gateway** (about $32 a month saved; public IPs instead), no flow logs,
  no VPC endpoints.
- One security group: **no inbound rules**; outbound open.

Network cost is about $0. Each running instance pays $0.005/h for its public
IPv4 address.

#### Launch template and capacity
- Amazon Linux 2023, latest, through its public SSM parameter alias.
- `.xlarge` (4 vCPU, 16 GB) from the `m7i`, `m6i`, `m6a` and `m7a` families,
  capacity-optimized Spot allocation for `ci-spot`; On-Demand for
  `ci-ondemand`. *Builder's call:* whether that's one launch template with
  overrides or `CreateFleet` of type `instant`; whatever launches one instance
  with that spread.
- 50 GB gp3 root volume, deleted on termination.
- **IMDSv2 required, hop limit 1**, so the Docker containers a job starts
  can't reach the instance metadata service.
- `InstanceInitiatedShutdownBehavior: terminate`.
- **Caps:** at most **6 Spot and 2 On-Demand** CI runners at once, across all
  repos, counted by tag. It is a soft cap: two launches at the same moment may
  overshoot it by one, which is fine (*builder's call*).

#### Launching: a queue, so a capped job is never lost
Every accepted job goes through one SQS queue (with a dead-letter queue):
1. The **webhook** verifies the event and enqueues the job (repo, job id, run
   id, head sha, label). It launches nothing itself.
2. The **launcher** takes a message and asks GitHub (*Actions: read*) whether
   that job is **still queued**. Started elsewhere, cancelled or finished: drop
   the message. Still queued and below the cap: launch. Still queued but at the
   cap: put it back with a delay (a minute or two; *builder's call*).
3. Belt and suspenders: a runner that is **never given a job within 15 minutes**
   exits and its instance terminates. That covers a job taken by another runner
   in the meantime, a launch that raced the check, and a duplicate delivery.

#### No instance role
**The instance has no IAM instance profile at all.** The JIT config travels in
the instance's **user-data**, so there is nothing for the instance to fetch
from AWS, no SSM parameter, no KMS key, and no credentials on the box: no
Session Manager, no CloudWatch agent, no ECR, no S3, no STS. There is no shell
on a CI runner; the job log is the record.

#### What an instance does: a `#cloud-config` user-data
The user-data is a cloud-init `#cloud-config` document, rendered per launch by
the launcher, so start-up steps and files stay declarative (`groups`,
`packages`, `write_files`, `runcmd`):
1. `groups`: `docker` with **gid 123**, created *before* Docker is installed
   (the runner image's `runner` user is in gid 123; with the host socket
   mounted, the socket's group must match).
2. `packages`: `docker`; then enable and start it.
3. `write_files`: the JIT config, root-only (`0600`), and the start script.
   It is single-use: once the runner has registered with it, it is worthless.
4. `runcmd`: run `ghcr.io/zeroae/ci-runner:latest` with:
   - the host's Docker socket mounted;
   - the work directory **mounted at the same path on the host and in the
     container** (`/home/runner/_work`). `docker run -v <path>:...` issued by a
     job is resolved on the host, so any other path breaks every bind mount a
     job makes;
   - the JIT config handed to the runner (`run.sh --jitconfig ...`), which makes
     it ephemeral: it takes one job and exits.
5. `runcmd`, alongside: the 15-minute idle exit (stop the container if the
   runner hasn't started a job by then; *builder's call* how it tells, e.g. the
   runner's own log line for a job starting).
6. When the container exits, `shutdown -h now`, which terminates the instance.

Two user-data limits: 16 KB raw, which a JIT config fits comfortably; and
cloud-init keeps a root-only copy of it on the host, which is harmless once the
config is spent.

#### Reporting a Spot reclaim
No process on the host can write into a job's step log, and the host has no
credentials to tell GitHub anything. So the report comes from AWS:
- An EventBridge rule on **EC2 Spot Instance Interruption Warning** for the
  stack's instances invokes the **notifier**.
- The notifier reads the instance's launch tags (repo, job id, run id, head
  sha, job name) and creates a **check run** on that commit through the App
  (*Checks: write*): conclusion `failure`, title
  `Spot capacity reclaimed: re-run this job`, naming the job and linking the
  run. It shows in the PR's checks next to the job GitHub marks as lost.
- A check run created by our App is its own entry, not an annotation inside
  GitHub Actions' check (only the Actions app can write that one). Its name is
  *builder's call* (e.g. `ci-runner / <job name>`).

#### The `ci-runner` image
- `FROM ghcr.io/actions/actions-runner:latest`. That is GitHub's official runner
  image (`actions/runner`, `images/Dockerfile`): Ubuntu 24.04 (Noble), from
  `mcr.microsoft.com/dotnet/runtime-deps:8.0-noble`, with the runner, the
  Docker CLI and the `buildx` plugin, and a `runner` user (passwordless sudo) in
  `docker` gid 123. It follows GitHub's own choice of Ubuntu when they move.
- Adds general tools only: the `docker compose` plugin, `gh`, `jq`, `make`,
  `git`, `curl`, `zstd`, Python 3.12 as `python3`, Node.js, AWS CLI v2.
  Anything a single repo needs beyond that, the repo installs in its own job or
  container.
- Sets `AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache` and
  `RUNNER_TOOL_CACHE=/opt/hostedtoolcache`, owned by `runner`.
  `actions/setup-python`'s prebuilt Linux Pythons expect that path. **Not
  verified:** confirm on the canary with one `setup-python` and one
  `setup-node` step. Each job downloads its runtime afresh; there is no warm
  toolcache.
- Published as **`ghcr.io/zeroae/ci-runner`**, a **public** package, pulled
  anonymously (so the instance needs no registry permission and no token sits
  on the box).
- Built by a workflow in this repo on `ubuntu-latest` (this repo is public, so
  its minutes are free): on a push to `main` that changes the Dockerfile, and
  weekly, so it picks up the base image and tools. Tagged `:latest` (and
  *builder's call:* a date or sha tag too, for looking back).

#### The Lambdas
Node.js (current LTS runtime), **no dependencies** (the runtime ships `crypto`
and the AWS SDK v3), **inline in the template** (`Code.ZipFile`). The current
CloudFormation reference limits inline code only by its zip (4 MB), so the real
limit is the template's: 51,200 bytes when passed directly. Keep the five
functions (setup, webhook, launcher, notifier, sweeper) and the template under
that; *builder's call* whether two of them share one function with several
triggers. A container image is the fallback only
if they can't be. Inline Node is CommonJS (`exports.handler`, `require`). Each
function has its own role, named per the `PowerUserPB-*` rule.

**setup** (permanent; behind a Lambda Function URL):
- `GET`: generates a random `state`, stores it with a short expiry, and serves a
  page that auto-POSTs the App manifest to GitHub (manifest `redirect_url` =
  this function's URL; `hook_attributes.url` = the webhook's URL; the three
  permissions above; event `workflow_job`).
- GitHub's redirect: accepts only a matching, unexpired `state`; exchanges the
  `code` itself (`POST /app-manifests/{code}/conversions`); writes App id,
  private key and webhook secret into the stack's secret. The key never exists
  outside AWS and never on anyone's laptop.
- **Refuses every call once the secret holds a key.** Re-registering means
  emptying the secret first, on purpose.
- The only function allowed `secretsmanager:PutSecretValue`.
- Never logs the conversion response or any part of the secret.

**webhook** (behind a Lambda Function URL):
- Verifies `X-Hub-Signature-256` against the webhook secret; refuses anything
  else.
- Acts on `workflow_job` with action `queued` whose labels include
  `self-hosted` and exactly one of `ci-spot` or `ci-ondemand`, and otherwise only
  the runner's default labels (`linux`, `x64`); ignores the rest. That is the
  label contract for consuming repos (*builder's call*).
- Takes the installation id from the event's `installation.id`, and finds the
  `ci-runner` group's id by name at runtime (cached), since the group is created
  after the stack (*builder's call*).
- Refuses (fence 3) unless `repository.visibility` is `private` and the owner is
  `zeroae`.
- Enqueues the accepted job and returns. Allowed: `secretsmanager:GetSecretValue`
  on the one secret, `sqs:SendMessage` on the one queue. Nothing else.

**launcher** (consumes the queue):
- Signs an App JWT (RS256, `crypto`) and gets an installation token for the
  job's installation.
- Checks the job is still queued (`GET /repos/{owner}/{repo}/actions/jobs/{job_id}`);
  drops it otherwise.
- Below the cap: calls `POST /orgs/zeroae/actions/runners/generate-jitconfig`
  with the `ci-runner` group's id and the job's labels, renders the
  `#cloud-config` with that config, and launches one instance with that label's
  capacity, tagged with the stack tag and the job's repo, job id, run id, head
  sha and name. At the cap: re-enqueues with a delay.
- A duplicate (GitHub can deliver one event twice) launches a second runner at
  worst; the idle exit removes it. *Builder's call* whether to also de-duplicate
  on the job id.
- Allowed: `secretsmanager:GetSecretValue` on the one secret; receive, delete and
  send on the one queue; `ec2:RunInstances`/`CreateFleet` limited to the launch
  template and the stack's subnets and security group; `ec2:CreateTags` on
  launch; `ec2:DescribeInstances` (for the cap). No `iam:PassRole`: there is no
  instance role to pass.

**notifier** (EventBridge, Spot interruption warnings): see "Reporting a Spot
reclaim". Allowed: `secretsmanager:GetSecretValue`, `ec2:DescribeInstances`.

**sweeper** (scheduled, e.g. every 10 minutes):
- Terminates any CI runner instance older than **2 hours** (boot failed, the
  idle exit didn't fire, runner hung).
- Removes the group's runner registrations that are offline and have no
  instance.
- Allowed: `secretsmanager:GetSecretValue`; `ec2:DescribeInstances`;
  `ec2:TerminateInstances` only on instances carrying the stack's tag.

#### Secrets
One Secrets Manager secret holding App id, private key and webhook secret.
Readable by webhook, launcher, notifier and sweeper; writable only by setup.
About $0.40 a month.

### 4. Cost (estimate, us-east-1, at the busiest repo's November volume)

| Item | Per month |
|---|---|
| Spot `.xlarge`, about 210 h including boot (at about $0.08/h; Spot moves) | about $17 |
| On-Demand `.xlarge` for `apply`, about 60 h (about $0.20/h) | about $12 |
| gp3 50 GB, only while running | about $1.50 |
| Public IPv4, only while running | about $1.35 |
| Secrets Manager, Lambda, SQS, EventBridge, logs | under $1 |
| **Total** | **about $33** |
| The same minutes on GitHub today | about $62 |

### 5. Docs this repo carries
- The README: what it is, how a repo opts in (install the App on it, add it to
  the runner group, use the labels behind a repo variable).
- A runbook: deploy the stack, create the App (open the setup URL, press
  *Create*, install it on the selected repos), create the runner group, turn a
  repo on and off, read a lost job, and a **traps table**, starting with:

  | Symptom | Cause |
  |---|---|
  | A job's `docker run -v ...` sees an empty directory | the work directory isn't at the same path on host and container |
  | `permission denied` on `/var/run/docker.sock` | the host's `docker` group isn't gid 123 |
  | `setup-python` fails, or picks up a broken Python | `AGENT_TOOLSDIRECTORY` isn't `/opt/hostedtoolcache` |
  | A deploy waits 60 minutes, then fails on the state lock | an `apply` ran on Spot and was reclaimed; it must be `ci-ondemand` |
  | A job sits "Waiting for a runner" | the cap is reached, the repo isn't in the group, the App isn't installed on it, or the repo is public |
  | A job fails "The runner has received a shutdown signal" or "lost communication", next to a failed `ci-runner / <job>` check | Spot reclaim: re-run the job |

- Each consuming repo's own toolset check (a script as the first step of each
  moved job, naming any missing tool and printing each version) lives in
  **that** repo, not here.

## Accepted risks (the owner's calls)

- **Nothing is pinned.** Every boot pulls `ci-runner:latest`; every weekly build
  takes the newest `actions-runner` base and tools. A breaking upstream change
  shows up as a red job whose version lines (from the consumer's tool check)
  say what changed.
- **The setup function's URL stays public for good.** Its only guard is that it
  refuses everything once the secret holds a key.
- **A JIT config sits in the instance's user-data,** readable by anyone in
  `zeroae-code` with `ec2:DescribeInstanceAttribute` until the runner registers
  with it. It is single-use and short-lived; chosen over an SSM parameter
  because it lets the instance have no IAM role at all.
- **The App holds three permissions**, two of them repository-wide on every
  installed repo: *Actions: read* (job status) and *Checks: write* (check runs on
  commits). Its key lives only in the stack's secret.
- **Spot reclaims.** Expected to be rare for jobs of 1–15 minutes (a guess, not
  a measurement); a lost job is re-run by a person.

## Left to the builder

- Everything marked *builder's call* above.
- Template layout (one file or nested), naming beyond the IAM rule, the
  sweeper's schedule, log retention.
- How the stack is deployed and updated (a `make` target is fine) and the
  order: stack, then the App through setup, then the runner group, then a
  repo's variable.
- Proving it: a canary job in one consuming repo that shows, live, a Spot job,
  an On-Demand job, a `setup-python` step, a job that bind-mounts its checkout,
  an instance with no credentials (the metadata service returns no role), a Spot reclaim producing its check run, a capped job launched later, a cancelled job dropped from the queue, the sweeper killing a stray
  instance, and a public repo refused.

## Deferred (follow-up issues)

- A pre-built AMI or pre-pulled image (after boot time is measured).
- Pinning the runner, base image and tools.
- More instance sizes, and per-repo caps.
