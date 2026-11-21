# A job label pins each runner to its job

Supersedes [ADR 0003](0003-tolerate-swaps-instead-of-run-labels.md).

GitHub gives a queued job to any idle runner whose labels cover the job's. ADR 0003 let that happen, so a CI runner often ran a job other than the one it was launched for (a swap), and the system repaired the bookkeeping afterwards. Swaps turned out to be routine (the webhook logged three in five seconds on 2026-11-20), and every piece built on top had to allow for them: the swap repair, and #51's re-check, which finds a job's machines by the job-id tag because the runner's name can't be trusted. We now prevent swaps instead.

Every job must carry one label unique to it, the **job label**:

```
ci-job-<run_id>-<run_attempt>-<job key>-<matrix index>
```

The launcher registers each runner with its job's labels, so the runner launched for a job carries that job's label, and GitHub can give it no job with another job label. GitHub gives a job to a runner whose labels include all of the job's, so a runner could still take a job of its shape that has no job label: that is why every job must carry one. The webhook accepts a job label only when it names the job's own run and attempt (`workflow_job.run_id` and `run_attempt`) and has something after them. A job with two, or with one for another run or attempt, is ignored.

The rest of the label is the consumer's to make unique within the run. GitHub can't do it for them: inside `runs-on`, `github.job` evaluates to an empty string (measured on 2026-11-20 in a scratch repo, by reading the labels of the queued jobs back from the API), so the job key is written by hand. `strategy.job-index` does work there, and is `0` in a job with no matrix. A reusable workflow sees only its own job keys and its own matrix, so two calls in one run would make the same label: the caller passes something unique into it, as an input.

Rollout was in two steps. First the label was accepted and checked but not required: a job without it was served as before, and swaps were still repaired, including a labelled job's runner taking a job without the label. Once the consumers carried it, the label became required: a job of our shape without one is ignored, like any other job outside the label contract, and the webhook logs why. The swap repair is removed, and with it the webhook's EC2 and ECS permissions. A runner that runs a job other than its own, which only a job still without the label can make it do, is logged as an anomaly and not repaired; the job it was launched for is relaunched by #51's re-check, which takes a runner busy while its job is still queued as no longer serving it. The re-check also covers runners that never take their job for other reasons (a concurrency group, a failed boot).

## Considered Options

- **Tolerate swaps and repair them** (ADR 0003). Reversed: the repair is code that only exists because runners are interchangeable, and it can't explain a runner that registers for a job and runs nothing anyone can find.
- **A run label only** (`ci-job-<run_id>-<run_attempt>`, as CodeBuild-hosted runners use). Rejected: jobs of one run would still swap with each other.
