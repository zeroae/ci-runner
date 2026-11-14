# AGENTS.md

- Changing the stack, a function or the build: read `docs/stack.md`.
- Operating the live stack (deploy, the wizard, logs, a lost job): read `docs/runbook.md`.
- Proving a change live (deploying a branch to the shared stack): read "Proving a change live" in `docs/runbook.md` first.
- Reviewing or merging a change: apply `CODING_STANDARDS.md`, and gate the merge per `docs/agents/review-gate.md`.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `zeroae/ci-runner`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
