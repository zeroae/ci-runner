# ci-runner

Single-use EC2 and Fargate runners for the GitHub Actions jobs of zeroae's
private repos.

Each queued job labelled `ci-spot` or `ci-ondemand` gets a fresh EC2
instance of the size and architecture it asks for. The instance runs that one job in `ghcr.io/zeroae/ci-runner:latest`
(GitHub's runner image on Ubuntu 24.04, plus general tools) and then
terminates. Each job labelled `ci-fargate-spot` or `ci-fargate` gets a fresh
Fargate task instead, from the same image, which runs that one job and exits.
Neither has an IAM role, so a job finds no AWS credentials on it. Short jobs
stay on GitHub-hosted runners, or go to a Fargate capacity if they need no
Docker.

| Label in `runs-on` | Capacity | For |
|---|---|---|
| `ci-spot` | EC2 Spot (`m8i`/`m8a`/`m7i`/`m6i`/`m6a`/`m7a` for `x64`, `m7g`/`m6g`/`m8g` for `arm64`) | long jobs: a job that runs well over 2 minutes, which is about how long a CI runner takes to come up |
| `ci-ondemand` | EC2 On-Demand (the same families) | critical jobs: a job that, cut off half-way, leaves state a person must repair (`terraform apply`) |
| `ci-fargate-spot` | Fargate Spot, **no Docker** | Docker-free jobs that should start fast: about 30 s from queued to started |
| `ci-fargate` | Fargate On-Demand, **no Docker** | Docker-free jobs that must not be cut off half-way |
| (none; `ubuntu-latest`) | GitHub-hosted | everything else |

A **size label** picks the vCPUs, at 4 GB of memory per vCPU, and an
**architecture label** the CPU:

| Size label | vCPUs / memory | Instance size |
|---|---|---|
| `ci-cpu-2` | 2 / 8 GB | `.large` |
| `ci-cpu-4` | 4 / 16 GB | `.xlarge` |
| `ci-cpu-8` | 8 / 32 GB | `.2xlarge` |
| `ci-cpu-16` | 16 / 64 GB | `.4xlarge` |

On a Fargate capacity the size label sets the task's vCPUs and memory the
same way.

The architecture label is `x64` (Intel and AMD) or `arm64` (Graviton). Both
architectures run the same image, built natively for each. Every job names
one size label and one architecture label: neither has a default, so a job
without them waits for a runner that never comes. A job that used to name only
its capacity got 4 vCPUs and `x64`; add `ci-cpu-4` and `x64` to keep that shape.

The CI runners hold at most 24 Spot, 8 On-Demand, 48 Fargate Spot and 8
Fargate On-Demand vCPUs at once, across all repos (six, two, twelve and two
`ci-cpu-4` runners). A job that would go over that waits in
a queue until enough finish. If an EC2 Spot reclaim kills
a job, a failed check run named `ci-runner / <job name>` appears on its
commit. Nothing retries it automatically: a person re-runs it.

Only private repos in `zeroae` are served, and only repos that have the App
installed and are in the runner group. A public repo is refused even when
it's in both.

## Moving a private repo's jobs onto it

1. Ask an owner to turn the repo on (the [runbook](docs/runbook.md#turn-a-repo-on-and-off)
   lists the steps): they install the GitHub App on the repo and add the repo
   to the `ci-runner` runner group.
2. Route each moved job through **one repo variable**, so the repo can go back
   to GitHub-hosted runners without a code change. For example, with
   `ZAE_CI_RUNNER`:

   ```yaml
   jobs:
     tests:
       runs-on: ${{ vars.ZAE_CI_RUNNER && fromJSON('["self-hosted","ci-spot","ci-cpu-8","x64"]') || 'ubuntu-latest' }}
     build-arm:
       runs-on: ${{ vars.ZAE_CI_RUNNER && fromJSON('["self-hosted","ci-spot","ci-cpu-4","arm64"]') || 'ubuntu-latest' }}
     apply:
       runs-on: ${{ vars.ZAE_CI_RUNNER && fromJSON('["self-hosted","ci-ondemand","ci-cpu-2","x64"]') || 'ubuntu-latest' }}
     lint:
       runs-on: ${{ vars.ZAE_CI_RUNNER && fromJSON('["self-hosted","ci-fargate-spot","ci-cpu-2","arm64"]') || 'ubuntu-latest' }}
     docs:
       runs-on: ${{ vars.ZAE_CI_RUNNER && fromJSON('["self-hosted","ci-fargate","ci-cpu-4","x64"]') || 'ubuntu-latest' }}
   ```

   Each `runs-on` names the full shape: capacity, size and architecture.
   A job on `ci-fargate-spot` or `ci-fargate` promises not to use Docker
   (no `services:`, `container:`, Docker actions or `docker` commands): a
   Fargate task has no Docker daemon
   ([ADR-0001](docs/adr/0001-fargate-capacities-have-no-docker.md)).

   While the variable is unset (the default), every job runs on `ubuntu-latest`,
   so the change can merge before the repo is switched on. Once the variable
   holds any value, the moved jobs run on our runners. To roll back, unset it.
3. Make the moved job's first step the repo's own toolset check: a script
   that names any missing tool and prints each tool's version.
4. Give each moved job a `timeout-minutes` under 120 (110 leaves room). The
   sweeper ends any instance or task 2 hours after launch, so a job without one
   dies with its machine instead of failing on a timeout that names it.
5. Move one job first, as a canary (usually the test job). Its queued-to-started
   time is the boot time, and that tells you which other jobs are long enough to
   move. The runbook's "Measured numbers" has what the canary repo measured.
6. Set the variable (`gh variable set ZAE_CI_RUNNER --body 1`) and watch the
   canary.

**The label contract:** `runs-on` must include `self-hosted`, exactly one of
`ci-spot`, `ci-ondemand`, `ci-fargate-spot` or `ci-fargate`, exactly one size label (`ci-cpu-2`, `ci-cpu-4`,
`ci-cpu-8`, `ci-cpu-16`) and exactly one of `x64` or `arm64`. It may also
include `linux`. None of them has a default. A job missing a size or an
architecture label, or with any other label (`aarch64`, an unknown
`ci-cpu-*`, two size labels, both `x64` and `arm64`), is ignored, and it waits
for a runner that never comes. Before changing the contract, `make consumers`
lists every job it affects.

**What the job gets:** Ubuntu 24.04, the runner as user `runner` (passwordless
sudo), Docker through the host's socket, the `docker compose` and `buildx`
plugins, `gh`, `jq`, `make`, a C and C++ compiler (`build-essential`: `cc`, `c++`), `pkg-config`, `git`, `curl`, `zstd`, Python 3.12 as `python3`,
Node.js and AWS CLI v2. `actions/setup-*` work, but there is no warm toolcache,
so each job downloads its runtime again. The job runs in a container that drives
the host's Docker daemon, so a `docker run -v` source is a path on the host.
`/tmp` and the runner's home (`/home/runner`: `$HOME`, and the work directory
`_work` with the checkout and `$RUNNER_TEMP`) are at the same paths on both, so
a bind mount from any of them works as it does on a GitHub-hosted runner,
`mktemp` files and `~/` config included. Both are on the 50 GB root disk. A mount from anywhere else (`/opt`,
`/etc`, `/var`) gets an empty host path. Nothing is pinned: every boot pulls
`:latest`, and the image is rebuilt weekly, for linux/amd64 and linux/arm64,
each built and smoke-tested on its own native runner.

**On a Fargate capacity** the job gets the same image, user, tools, paths and
50 GB, with three differences:

- **No Docker.** There is no daemon and no socket (the `docker` CLI is still
  there, and fails). Picking `ci-fargate-spot` or `ci-fargate` is the job's
  promise never to use Docker: no `services:`, no `container:`, no Docker
  actions, no `docker build`. A job that breaks it fails at that step
  ([ADR-0001](docs/adr/0001-fargate-capacities-have-no-docker.md)).
- **Older CPUs.** A Fargate task starts in about 30 s against EC2's 100 s,
  but its CPUs are older: a 4-minute Rust build ran about 45% longer. So
  Fargate wins for short jobs, and is even at about 4 minutes; for builds
  much longer than that, EC2 is faster (the runbook's "Measured numbers").
- **`nproc` over-reports.** Inside a task, `nproc` can show twice the task's
  vCPUs. The runner caps cargo's jobs at the task's vCPUs (in
  `~/.cargo/config.toml`, so `Swatinem/rust-cache` shares its cache with EC2)
  and sets `MAKEFLAGS=-j<n>` and `CI_RUNNER_VCPUS=<n>`. A tool that sizes
  itself by `nproc` some other way should be given `-j$CI_RUNNER_VCPUS`.

`/tmp`, `$HOME` and `_work` are the container's own paths on its 50 GB disk.

**Deploy jobs** keep their AWS access as before (typically GitHub OIDC into the
repo's own role). A trust policy that pins `runner_environment: github-hosted`
must drop that condition before a deploy job moves.

## Docs

- [docs/runbook.md](docs/runbook.md): deploy, create the App, turn repos on and
  off, read a lost job or the logs, prove a change live.
- [docs/traps.md](docs/traps.md): symptoms and their causes.
- [docs/stack.md](docs/stack.md): the stack's layout, the Lambdas, and how to
  change them.
- [The design spec](docs/superpowers/specs/2026-11-12-ci-runner-design.md).
