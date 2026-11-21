# ci-runner

Single-use self-hosted GitHub Actions runners for the private repos of the `zeroae` org.

## Language

**CI runner**:
A self-hosted runner created for one queued job. It runs that job and is then gone.
_Avoid_: agent, worker, pool member

**Capacity**:
The kind of compute a CI runner runs on: EC2 Spot, EC2 On-Demand, Fargate Spot or Fargate On-Demand.
_Avoid_: pool, warm pool (nothing is started before its job queues)

**Capacity label**:
The `runs-on` label that picks a job's capacity: `ci-spot`, `ci-ondemand`, `ci-fargate-spot` or `ci-fargate`.

**Size label**:
The `runs-on` label that picks a CI runner's vCPU count: `ci-cpu-2`, `ci-cpu-4`, `ci-cpu-8` or `ci-cpu-16`, with 4 GB of memory per vCPU. It has no default.
_Avoid_: instance type, xlarge, instance-size

**Architecture label**:
The `runs-on` label that picks a CI runner's CPU architecture: `x64` or `arm64`. It has no default.

**Shape**:
A CI runner's capacity, size and architecture together. Runners of the same shape are interchangeable.

**Label contract**:
The labels a job must carry to be served: `self-hosted`, exactly one capacity label, exactly one size label and exactly one architecture label, plus `linux` if the job wants it, and a job label. Nothing else is allowed. It holds on every capacity.

**Job label**:
The `runs-on` label unique to one job: `ci-job-<run_id>-<run_attempt>-<job key>-<matrix index>`. The CI runner launched for the job registers with it, so it can take no job with another job label. The job key is written by hand, since `github.job` is empty inside `runs-on`.
_Avoid_: run label (that names a run, shared by its jobs)

**Swap**:
A CI runner taking a queued job other than the one it was launched for. GitHub gives a job only to a runner whose labels include all of the job's, and each runner carries its own job's job label, so no job that carries one can swap. A job of our shape without one gets no runner of its own but can still take another job's, so swaps end only once every such job carries its label. The webhook logs a swap as an anomaly, and repairs nothing.

**Fargate capacity**:
Fargate Spot or Fargate On-Demand, the two capacities with no Docker daemon. A job that picks one promises not to use Docker.
_Avoid_: Fargate pool

**vCPU budget**:
The most vCPUs that the CI runners of one capacity may hold at once. A job that would go over it waits.
_Avoid_: "cap" in prose (that was the old runner count). The parameters that set the budgets are still named `*VcpuCap` (`SpotVcpuCap`, `OnDemandVcpuCap`, `FargateSpotVcpuCap`, `FargateVcpuCap`).

**Spot reclaim**:
AWS taking back Spot capacity, EC2 or Fargate, while a job runs. The job is lost, unless it finishes inside AWS's 2-minute warning, and a lost job is reported as a reclaim on its commit.
