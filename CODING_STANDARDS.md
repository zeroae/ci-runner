# Coding standards

Read by the reviewer. These are the judgement calls; the mechanical rules
(IAM naming, the env-var contract, identical helper copies, the template size
limit) are tests in `test/conventions.test.js` and `test/build.test.js`, and
CI runs them.

## Repo-neutral

This is a public repo. It names no repo that uses the CI runners, and nothing
of their internals: examples use generic names. The one allowed name is the
adoption variable `ZAE_CI_RUNNER`.

## Lambdas

- **No dependencies.** Each function is one CommonJS file under `functions/`,
  using only Node.js 22 built-ins and the `@aws-sdk` clients the runtime
  ships. The build inlines it into the template, so every byte counts against
  the 1 MB limit.
- **A `createHandler(deps)` factory** holds the logic and takes every side
  effect (AWS clients, `fetch`, `now`, `env`, `log`) as a dependency, so the
  tests run the real code with fakes. `exports.handler` only wires the real
  dependencies in; `@aws-sdk` is loaded there and nowhere else, so the tests
  never load it.
- **Export only what the tests or the handler use.**
- **Comments** say why, in whole lines (the build strips them, so they're
  free); a trailing comment costs template bytes.

## IAM

Grant the least the function does, scoped by the stack's tag
(`ci-runner:stack`) or its own resources, never `*` on a write action
without a condition. A new condition is checked live: some EC2 calls don't
carry the keys their docs suggest (see the traps table in `docs/runbook.md`).
