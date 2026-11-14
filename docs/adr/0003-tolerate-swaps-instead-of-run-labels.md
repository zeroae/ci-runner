# Tolerate swaps instead of requiring a run label

GitHub gives a queued job to any idle runner whose labels cover the job's, so a CI runner often runs a job other than the one it was launched for: a swap. We don't prevent swaps. The label contract requires a capacity, a size and an architecture label, so a swap only ever happens between runners of the same shape. The system repairs the bookkeeping instead. When the webhook gets `workflow_job` `in_progress`, it reads `runner_name`. If that runner was launched for another job, the webhook re-queues that other job, so it isn't stranded, and re-tags the runner's instance or task with the job it actually runs, so a Spot reclaim is reported on the right commit.

## Considered Options

- **A run label and a per-job label, as CodeBuild-hosted runners do** (`codebuild-<project>-${{ github.run_id }}-${{ github.run_attempt }}` plus a unique label per job). We rejected it: every consumer's `runs-on` grows two expressions, matrix jobs need a hand-written label each, and the system would still need to repair the swaps that get through.
