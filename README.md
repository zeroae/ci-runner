# ci-runner

Single-use EC2 runners for the GitHub Actions jobs of zeroae's private repos.

Each queued job labelled `ci-spot` or `ci-ondemand` gets a fresh EC2
instance of the size it asks for (a `.xlarge` by default). The instance runs that one job in `ghcr.io/zeroae/ci-runner:latest`
(GitHub's runner image on Ubuntu 24.04, plus general tools) and then
terminates. The instance has no IAM role, so a job finds no AWS credentials
on it. Short jobs stay on GitHub-hosted runners.

| Label in `runs-on` | Capacity | For |
|---|---|---|
| `ci-spot` | EC2 Spot (`m7i`/`m6i`/`m6a`/`m7a`) | long jobs: a job that runs well over 2 minutes, which is about how long a CI runner takes to come up |
| `ci-ondemand` | EC2 On-Demand (the same families) | critical jobs: a job that, cut off half-way, leaves state a person must repair (`terraform apply`) |
| (none; `ubuntu-latest`) | GitHub-hosted | everything else |

A **size label** picks the vCPUs, at 4 GB of memory per vCPU, and an
**architecture label** the CPU:

| Size label | vCPUs / memory | Instance size |
|---|---|---|
| `ci-cpu-2` | 2 / 8 GB | `.large` |
| `ci-cpu-4` | 4 / 16 GB | `.xlarge` |
| `ci-cpu-8` | 8 / 32 GB | `.2xlarge` |
| `ci-cpu-16` | 16 / 64 GB | `.4xlarge` |

The architecture label is `x64`; `arm64` isn't served yet. For now both are
optional and default to `ci-cpu-4` and `x64`, so today's `runs-on` keeps
working. **They will become required**: add `ci-cpu-4` and `x64` (or the size
you want) to every moved job now, so the change to the required contract
doesn't strand it.

At most 6 Spot and 2 On-Demand CI runners run at once, across all repos. A
job over the cap waits in a queue until one finishes. If a Spot reclaim kills
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
     apply:
       runs-on: ${{ vars.ZAE_CI_RUNNER && fromJSON('["self-hosted","ci-ondemand","ci-cpu-2","x64"]') || 'ubuntu-latest' }}
   ```

   While the variable is unset (the default), every job runs on `ubuntu-latest`,
   so the change can merge before the repo is switched on. Once the variable
   holds any value, the moved jobs run on our runners. To roll back, unset it.
3. Make the moved job's first step the repo's own toolset check: a script
   that names any missing tool and prints each tool's version.
4. Give each moved job a `timeout-minutes` under 120 (110 leaves room). The
   sweeper terminates any instance 2 hours after launch, so a job without one
   dies with its machine instead of failing on a timeout that names it.
5. Move one job first, as a canary (usually the test job). Its queued-to-started
   time is the boot time, and that tells you which other jobs are long enough to
   move. The runbook's "Measured numbers" has what the canary repo measured.
6. Set the variable (`gh variable set ZAE_CI_RUNNER --body 1`) and watch the
   canary.

**The label contract:** `runs-on` must include `self-hosted` and exactly one of
`ci-spot` or `ci-ondemand`. It may include at most one size label
(`ci-cpu-2`, `ci-cpu-4`, `ci-cpu-8`, `ci-cpu-16`), `x64` and `linux`. A job
with any other label (`arm64`, an unknown `ci-cpu-*`, two size labels) is
ignored, and it waits for a runner that never comes.

**What the job gets:** Ubuntu 24.04, the runner as user `runner` (passwordless
sudo), Docker through the host's socket, the `docker compose` and `buildx`
plugins, `gh`, `jq`, `make`, `git`, `curl`, `zstd`, Python 3.12 as `python3`,
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

**Deploy jobs** keep their AWS access as before (typically GitHub OIDC into the
repo's own role). A trust policy that pins `runner_environment: github-hosted`
must drop that condition before a deploy job moves.

## Docs

- [docs/runbook.md](docs/runbook.md): deploy, create the App, turn repos on and
  off, read a lost job or the logs, and the traps table.
- [docs/stack.md](docs/stack.md): the stack's layout, the Lambdas, and how to
  change them.
- [The design spec](docs/superpowers/specs/2026-11-12-ci-runner-design.md).
