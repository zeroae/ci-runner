#!/usr/bin/env bash
# Lists every job that runs on our runners: who a label-contract change
# affects. GitHub's code search misses private repos, and every consumer is
# private, so this reads each repo in the runner group directly: every
# workflow under .github/workflows on its default branch, through the
# contents API (needs gh with admin:org, for the group's repos).
#
#   scripts/consumers.sh
#   make consumers
#
# Prints one tab-separated line per job: repo, workflow, job, runs-on (a list
# joined with commas), for each runs-on naming ci-spot, ci-ondemand,
# ci-fargate-spot or ci-fargate, plain or in the vars.ZAE_CI_RUNNER &&
# fromJSON(...) form. A workflow that names a capacity outside any runs-on (a
# matrix, a reusable workflow's input) prints one line with job "-".
# Overrides: ORG GROUP
set -euo pipefail

ORG=${ORG:-zeroae}
GROUP=${GROUP:-ci-runner}
CAPACITY='ci-(spot|ondemand|fargate-spot|fargate)([^a-z0-9-]|$)'

group_id=$(gh api "orgs/$ORG/actions/runner-groups" --paginate \
  --jq ".runner_groups[] | select(.name == \"$GROUP\") | .id")
[[ -n "$group_id" ]] || { echo "no runner group named $GROUP in $ORG" >&2; exit 1; }

# The jobs of one workflow file (on stdin) whose runs-on names a capacity.
jobs_on_capacity() {
  awk -v repo="$1" -v wf="$2" -v re="$CAPACITY" '
    function indent(s) { match(s, /^ */); return RLENGTH }
    function flush() {
      if (job != "" && runs != "" && runs ~ re) { print repo "\t" wf "\t" job "\t" runs; hit = 1 }
      runs = ""; collecting = 0
    }
    { sub(/\r$/, ""); line = $0; sub(/[ \t]+#.*$/, "", line) }
    line ~ /^[ \t]*$/ { next }
    line ~ re { named = 1 }
    { i = indent(line); text = substr(line, i + 1) }
    collecting && i > runs_indent {
      sub(/^- */, "", text); runs = runs (runs == "" ? "" : ",") text; next
    }
    collecting { flush() }
    i == 0 { flush(); in_jobs = (text ~ /^jobs:/); job = ""; job_indent = -1; next }
    in_jobs && (job_indent < 0 || i == job_indent) && text ~ /^[^ ]+:/ {
      flush(); job_indent = i; job = text; sub(/:.*/, "", job); next
    }
    in_jobs && job != "" && text ~ /^runs-on:/ {
      flush(); runs = text; sub(/^runs-on:[ \t]*/, "", runs)
      if (runs == "") { collecting = 1; runs_indent = i } else flush()
    }
    END {
      flush()
      if (!hit && named) print repo "\t" wf "\t-\t(a capacity named outside runs-on)"
    }
  '
}

gh api "orgs/$ORG/actions/runner-groups/$group_id/repositories" --paginate \
  --jq '.repositories[].name' | sort | while read -r repo; do
  files=$(gh api "repos/$ORG/$repo/contents/.github/workflows" \
    --jq '.[] | select(.type == "file") | select(.name | test("\\.ya?ml$")) | .path' 2>/dev/null) || continue
  for path in $files; do
    gh api -H 'Accept: application/vnd.github.raw' "repos/$ORG/$repo/contents/$path" \
      | jobs_on_capacity "$repo" "${path##*/}"
  done
done
