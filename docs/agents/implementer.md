# Implementer

What every implementer subagent working a ticket here does. The brief names
the ticket and the **integration branch**; it overrides this file where they
differ.

1. **Base** your branch on the integration branch: `git fetch origin`, then
   `git merge-base --is-ancestor origin/<integration> HEAD`; if that fails,
   `git reset --hard origin/<integration>`.
2. **Build** test-first with the Skill `tdd`, at the `createHandler(deps)`
   seams (`docs/stack.md` "Adding a Lambda"). Where a test needs AWS's real
   request and response shapes (ECS, EC2), use aws/aws-emulator through
   `test/aws-emulator.js`.
3. **AWS** runs under the profile `zeroae-code/ZAEPowerUserAccess`. Only the
   owner runs `aws sso login`; when the session expires, report blocked.
4. **Deploy** only as `docs/runbook.md` "Proving a change live" says.
5. **Commit** with the `Co-Authored-By` trailer the harness gives.
6. **Before reporting**: merge the integration branch's tip, then
   `make test`, `make build`, and push your branch.
7. **Report** once, when done or blocked: the branch, its head SHA, and what
   is unverified.

Merging into the integration branch, opening PRs and closing issues belong
to the controller, unless the brief hands them to you. Waiting on commands
follows the subagent rules in the user's global `CLAUDE.md`.
