# Review gate

A change merges to `main` only after a `/code-review` over everything since
the last reviewed commit (the **fixed point**), applying
`CODING_STANDARDS.md`.

The review ends by posting a commit status on the head it reviewed:

```bash
gh api repos/zeroae/ci-runner/statuses/<sha> -f state=success \
  -f context=code-review -f description="<fixed point>..<sha>"
```

`main`'s ruleset requires the `code-review` status on the head being merged.
The status belongs to one SHA, so any later push (a fix, a merge of `main`,
a small landing PR) needs a new review of the delta: the fixed point becomes
the last reviewed SHA, and the new status goes on the new head.

The gate guards against forgetting the review. It is not a security control:
anyone with push access can post the status.
