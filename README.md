# ci-runner

Single-use EC2 runners for the GitHub Actions jobs of zeroae's private repos.

Each queued job labelled `ci-spot` or `ci-ondemand` gets a fresh `.xlarge`
EC2 instance. The instance runs that one job in `ghcr.io/zeroae/ci-runner:latest`
(GitHub's runner image on Ubuntu 24.04, plus general tools) and then
terminates. The instance has no IAM role, so a job finds no AWS credentials
on it. Short jobs stay on GitHub-hosted runners.

| Label in `runs-on` | Capacity | For |
|---|---|---|
| `ci-spot` | EC2 Spot, `.xlarge` (`m7i`/`m6i`/`m6a`/`m7a`) | long jobs: a job that runs longer than a CI runner takes to come up (a few minutes) |
| `ci-ondemand` | EC2 On-Demand, `.xlarge` | critical jobs: a job that, cut off half-way, leaves state a person must repair (`terraform apply`) |
| (none; `ubuntu-latest`) | GitHub-hosted | everything else |

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
       runs-on: ${{ vars.ZAE_CI_RUNNER && fromJSON('["self-hosted","ci-spot"]') || 'ubuntu-latest' }}
     apply:
       runs-on: ${{ vars.ZAE_CI_RUNNER && fromJSON('["self-hosted","ci-ondemand"]') || 'ubuntu-latest' }}
   ```

   While the variable is unset (the default), every job runs on `ubuntu-latest`,
   so the change can merge before the repo is switched on. Once the variable
   holds any value, the moved jobs run on our runners. To roll back, unset it.
3. Make the moved job's first step the repo's own toolset check: a script
   that names any missing tool and prints each tool's version.
4. Move one job first, as a canary (usually the test job). Its queued-to-started
   time is the boot time, and that tells you which other jobs are long enough to
   move.
5. Set the variable (`gh variable set ZAE_CI_RUNNER --body 1`) and watch the
   canary.

**The label contract:** `runs-on` must include `self-hosted` and exactly one of
`ci-spot` or `ci-ondemand`. The only other labels allowed are `linux` and `x64`.
A job with any other label is ignored, and it waits for a runner that never
comes.

**What the job gets:** Ubuntu 24.04, the runner as user `runner` (passwordless
sudo), Docker through the host's socket, the `docker compose` and `buildx`
plugins, `gh`, `jq`, `make`, `git`, `curl`, `zstd`, Python 3.12 as `python3`,
Node.js and AWS CLI v2. `actions/setup-*` work, but there is no warm toolcache,
so each job downloads its runtime again. The checkout is at the same path on
the host and in the container (`/home/runner/_work`), so a job's own
`docker run -v` bind mounts work. Nothing is pinned: every boot pulls
`:latest`, and the image is rebuilt weekly.

**Deploy jobs** keep their AWS access as before (typically GitHub OIDC into the
repo's own role). A trust policy that pins `runner_environment: github-hosted`
must drop that condition before a deploy job moves.

## Docs

- [docs/runbook.md](docs/runbook.md): deploy, create the App, turn repos on and
  off, read a lost job or the logs, and the traps table.
- [docs/stack.md](docs/stack.md): the stack's layout, the Lambdas, and how to
  change them.
- [The design spec](docs/superpowers/specs/2026-11-12-ci-runner-design.md).
