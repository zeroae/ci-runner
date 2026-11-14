#!/usr/bin/env bash
# PROTOTYPE, throwaway (issue #28). Not part of the stack; kept on the branch
# prototype/fargate-spot only. It answers #18's gate: is a Fargate Spot runner
# faster to start than EC2's ~100 s, or cheaper per job?
#
# One run:
#   1. creates a temporary execution role, log group, cluster (FARGATE_SPOT) and
#      an X86_64 and an ARM64 task definition (4 vCPU / 16 GB / 50 GB), all
#      tagged ci-runner:spike=28;
#   2. pushes a throwaway branch to the canary repo whose workflow runs the same
#      Rust build four times: on [self-hosted, ci-fargate-spot, ci-cpu-4, x64|arm64]
#      (runners this script launches; the live stack ignores ci-fargate-spot) and
#      on [self-hosted, spike28-ec2-spot, ci-cpu-4, x64|arm64]: EC2 Spot runners
#      this script hand-launches with scripts/hand-launch.sh (LABEL=spike28-ec2-spot),
#      the same launch templates and fleet as the launcher's, but outside the
#      live stack's spot vCPU budget (other repos' jobs filled it during run 1);
#   3. right after the push, mints a JIT config per architecture (as
#      hand-launch.sh does) and runs one Fargate Spot task each, with the
#      runner as the container's command: ./run.sh --jitconfig <cfg>;
#   4. waits for the tasks and the run, then writes every timestamp to $OUT;
#   5. deletes everything it created, on success or failure (EXIT trap).
#
#   scripts/prototype-fargate-spike.sh            # OUT defaults to ./spike-28-out
set -euo pipefail

PROFILE=${PROFILE:-zeroae-code/ZAEPowerUserAccess}
REGION=${REGION:-us-east-1}
ORG=zeroae
GROUP=ci-runner
CANARY=zeroae/ci-runner-canary
BRANCH=spike-28-fargate
NAME=ci-runner-spike-28
ROLE=PowerUserPB-ci-runner-spike-exec
LOGS=/ecs/$NAME
IMAGE=733153035800.dkr.ecr.us-east-1.amazonaws.com/ci-runner:latest
REPO_ARN=arn:aws:ecr:us-east-1:733153035800:repository/ci-runner
OUT=${OUT:-$PWD/spike-28-out}
TAGS='[{"key":"ci-runner:spike","value":"28"}]'
aws() { command aws --profile "$PROFILE" --region "$REGION" "$@"; }
# timeout(1) can't run a shell function, so the waits name the binary.
awsc=(aws --profile "$PROFILE" --region "$REGION")
log() { echo "$(date -u +%FT%TZ) $*" >&2; }
mkdir -p "$OUT"; chmod 700 "$OUT"

output() {
  aws cloudformation describe-stacks --stack-name ci-runner \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

cleanup() {
  set +e
  log "cleanup"
  live=$(aws ecs list-tasks --cluster "$NAME" --query taskArns --output text 2>/dev/null)
  for t in $live; do
    aws ecs stop-task --cluster "$NAME" --task "$t" --reason "spike cleanup" >/dev/null
  done
  # delete-cluster refuses a cluster whose tasks are still stopping.
  [[ -n $live ]] && timeout 300 "${awsc[@]}" ecs wait tasks-stopped --cluster "$NAME" --tasks $live
  # Keep the runners' output before the log group goes.
  aws logs filter-log-events --log-group-name "$LOGS" --query 'events[].[logStreamName,message]' \
    --output text > "$OUT/task-logs.txt" 2>/dev/null
  # --family-prefix matches a whole family name, so ask for each family.
  for fam in "$NAME-x86_64" "$NAME-arm64"; do
    for td in $(aws ecs list-task-definitions --family-prefix "$fam" --status ACTIVE --query taskDefinitionArns --output text); do
      aws ecs deregister-task-definition --task-definition "$td" >/dev/null
    done
    tds=$(aws ecs list-task-definitions --family-prefix "$fam" --status INACTIVE --query taskDefinitionArns --output text)
    [[ -n $tds ]] && aws ecs delete-task-definitions --task-definitions $tds >/dev/null
  done
  aws ecs delete-cluster --cluster "$NAME" >/dev/null
  for f in "$OUT"/instance-x64 "$OUT"/instance-arm64; do
    [[ -s $f ]] && aws ec2 terminate-instances --instance-ids "$(cat "$f")" >/dev/null
  done
  aws logs delete-log-group --log-group-name "$LOGS"
  aws iam delete-role-policy --role-name "$ROLE" --policy-name "$ROLE"
  aws iam delete-role --role-name "$ROLE"
  gh api -X DELETE "repos/$CANARY/git/refs/heads/$BRANCH" 2>/dev/null
  # A JIT runner whose task never took a job stays registered: remove it.
  for id in $(gh api "orgs/$ORG/actions/runners?per_page=100" \
      --jq '.runners[] | select(.name | startswith("spike28-") or startswith("ci-runner-hand-")) | .id'); do
    gh api -X DELETE "orgs/$ORG/actions/runners/$id"
  done
  rm -f "$OUT"/jit-*
  log "cleanup done"
}
trap cleanup EXIT

# --- 1. temporary AWS resources -------------------------------------------
log "creating role, log group, cluster, task definitions"
aws iam create-role --role-name "$ROLE" \
  --permissions-boundary arn:aws:iam::aws:policy/PowerUserAccess \
  --tags Key=ci-runner:spike,Value=28 \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  --query Role.Arn --output text > "$OUT/role-arn"
role_arn=$(cat "$OUT/role-arn")
aws iam put-role-policy --role-name "$ROLE" --policy-name "$ROLE" --policy-document "$(jq -nc \
  --arg repo "$REPO_ARN" --arg logs "arn:aws:logs:$REGION:733153035800:log-group:$LOGS:*" '{
  Version: "2012-10-17", Statement: [
    {Effect: "Allow", Action: "ecr:GetAuthorizationToken", Resource: "*"},
    {Effect: "Allow", Action: ["ecr:BatchGetImage","ecr:GetDownloadUrlForLayer","ecr:BatchCheckLayerAvailability"], Resource: $repo},
    {Effect: "Allow", Action: ["logs:CreateLogStream","logs:PutLogEvents"], Resource: $logs}]}')"
aws logs create-log-group --log-group-name "$LOGS" --tags ci-runner:spike=28
aws logs put-retention-policy --log-group-name "$LOGS" --retention-in-days 1
aws ecs create-cluster --cluster-name "$NAME" --capacity-providers FARGATE_SPOT \
  --default-capacity-provider-strategy capacityProvider=FARGATE_SPOT,weight=1 \
  --tags "$TAGS" >/dev/null
for arch in X86_64 ARM64; do
  jq -n --arg fam "$NAME-${arch,,}" --arg arch "$arch" --arg role "$role_arn" --arg image "$IMAGE" \
    --arg logs "$LOGS" --arg region "$REGION" --argjson tags "$TAGS" '{
    family: $fam, networkMode: "awsvpc", requiresCompatibilities: ["FARGATE"],
    cpu: "4096", memory: "16384", ephemeralStorage: {sizeInGiB: 50},
    runtimePlatform: {operatingSystemFamily: "LINUX", cpuArchitecture: $arch},
    executionRoleArn: $role, tags: $tags,
    containerDefinitions: [{name: "runner", image: $image, essential: true,
      logConfiguration: {logDriver: "awslogs", options: {
        "awslogs-group": $logs, "awslogs-region": $region, "awslogs-stream-prefix": "runner"}}}]}' \
    > "$OUT/taskdef-$arch.json"
  aws ecs register-task-definition --cli-input-json "file://$OUT/taskdef-$arch.json" \
    --query taskDefinition.taskDefinitionArn --output text > "$OUT/taskdef-$arch.arn"
done
# A brand-new role takes a few seconds before ECS can assume it.
sleep 15

IFS=, read -r -a subnets <<<"$(output SubnetIds)"
sg=$(output SecurityGroupId)
group_id=$(gh api "orgs/$ORG/actions/runner-groups" --paginate \
  --jq ".runner_groups[] | select(.name == \"$GROUP\") | .id")

# --- 2. the throwaway canary branch, whose push queues the four jobs --------
workflow=$(cat <<'YAML'
# PROTOTYPE, throwaway (zeroae/ci-runner#28): one Rust build (ruff) on Fargate Spot and on EC2 Spot.
name: spike-28 rust build
on:
  push:
    branches: [spike-28-fargate]
jobs:
  build:
    name: build ${{ matrix.capacity }} ${{ matrix.arch }}
    strategy:
      fail-fast: false
      matrix:
        capacity: [ci-fargate-spot, spike28-ec2-spot]
        arch: [x64, arm64]
    runs-on: [self-hosted, "${{ matrix.capacity }}", ci-cpu-4, "${{ matrix.arch }}"]
    timeout-minutes: 30
    env:
      CARGO_TERM_COLOR: never
    steps:
      - name: Where am I
        run: |
          echo "runner $RUNNER_NAME  home $HOME  workspace $GITHUB_WORKSPACE"; id; nproc; free -g
          df -hT /tmp "$HOME"; grep -m1 -E 'model name|CPU part' /proc/cpuinfo || true; lscpu | grep -m1 'Model name' || true
          ls -l /var/run/docker.sock 2>&1 || true
          echo "cpu.max $(cat /sys/fs/cgroup/cpu.max 2>&1)  memory.max $(cat /sys/fs/cgroup/memory.max 2>&1)"
      - uses: dtolnay/rust-toolchain@stable
      - name: Fetch ruff 0.17.5, its toolchain and its crates
        run: |
          git clone -q --depth 1 --branch 0.17.5 https://github.com/astral-sh/ruff
          cd ruff && rustup show active-toolchain && cargo fetch --locked
      - name: Build (cargo build -p ruff, debug)
        working-directory: ruff
        run: cargo build --locked -p ruff
YAML
)
main_sha=$(gh api "repos/$CANARY/git/ref/heads/main" --jq .object.sha)
main_tree=$(gh api "repos/$CANARY/git/commits/$main_sha" --jq .tree.sha)
tree=$(jq -n --arg base "$main_tree" --arg c "$workflow" \
  '{base_tree: $base, tree: [{path: ".github/workflows/spike-28.yml", mode: "100644", type: "blob", content: $c}]}' \
  | gh api -X POST "repos/$CANARY/git/trees" --input - --jq .sha)
commit=$(jq -n --arg t "$tree" --arg p "$main_sha" \
  '{message: "PROTOTYPE spike-28: Rust build on Fargate Spot and EC2 Spot (throwaway)", tree: $t, parents: [$p]}' \
  | gh api -X POST "repos/$CANARY/git/commits" --input - --jq .sha)
gh api -X POST "repos/$CANARY/git/refs" -f ref="refs/heads/$BRANCH" -f sha="$commit" >/dev/null
date -u +%FT%TZ > "$OUT/pushed-at"
log "pushed $BRANCH at $commit"

# --- 3. one EC2 Spot and one Fargate Spot runner per architecture ----------
for arch in x64 arm64; do
  case $arch in x64) cpu=X86_64 ;; arm64) cpu=ARM64 ;; esac
  name="spike28-fargate-$arch-$(date -u +%Y%m%d%H%M%S)"
  gh api -X POST "orgs/$ORG/actions/runners/generate-jitconfig" \
    -f name="$name" -F runner_group_id="$group_id" -f work_folder=_work \
    -f 'labels[]=self-hosted' -f 'labels[]=ci-fargate-spot' -f 'labels[]=ci-cpu-4' -f "labels[]=$arch" \
    --jq .encoded_jit_config > "$OUT/jit-$arch"
  jq -n --rawfile jit "$OUT/jit-$arch" \
    '{containerOverrides: [{name: "runner", command: ["./run.sh", "--jitconfig", ($jit | rtrimstr("\n"))]}]}' \
    > "$OUT/jit-overrides-$arch.json"
  net=$(jq -nc --arg sg "$sg" '{awsvpcConfiguration: {subnets: $ARGS.positional, securityGroups: [$sg], assignPublicIp: "ENABLED"}}' \
    --args "${subnets[@]}")
  aws ecs run-task --cluster "$NAME" --task-definition "$(cat "$OUT/taskdef-$cpu.arn")" \
    --capacity-provider-strategy capacityProvider=FARGATE_SPOT,weight=1 --platform-version LATEST \
    --network-configuration "$net" --overrides "file://$OUT/jit-overrides-$arch.json" \
    --tags key=ci-runner:spike,value=28 key=ci-runner:runner,value="$name" \
    --query 'tasks[0].taskArn' --output text > "$OUT/task-$arch.arn"
  echo "$name" > "$OUT/runner-$arch"
  log "$arch task $(cat "$OUT/task-$arch.arn") runner $name"
done
here=$(cd "$(dirname "$0")" && pwd)
for arch in x64 arm64; do
  date -u +%FT%T.%3NZ > "$OUT/instance-$arch.called-at"
  ARCH=$arch LABEL=spike28-ec2-spot STACK=ci-runner PROFILE="$PROFILE" "$here/hand-launch.sh" \
    > "$OUT/instance-$arch" 2> "$OUT/hand-launch-$arch.log" || log "hand-launch $arch failed"
  date -u +%FT%T.%3NZ > "$OUT/instance-$arch.launched-at"
  log "$arch instance $(cat "$OUT/instance-$arch") $(cat "$OUT/hand-launch-$arch.log")"
done
tasks=("$(cat "$OUT/task-x64.arn")" "$(cat "$OUT/task-arm64.arn")")

# --- 4. wait, then keep every timestamp --------------------------------------
timeout 600 "${awsc[@]}" ecs wait tasks-running --cluster "$NAME" --tasks "${tasks[@]}" || log "tasks-running wait failed"
gh run list -R "$CANARY" -b "$BRANCH" -L 1 --json databaseId --jq '.[0].databaseId' > "$OUT/run-id"
log "run $(cat "$OUT/run-id")"
timeout 1500 "${awsc[@]}" ecs wait tasks-stopped --cluster "$NAME" --tasks "${tasks[@]}" \
  || timeout 1500 "${awsc[@]}" ecs wait tasks-stopped --cluster "$NAME" --tasks "${tasks[@]}" || log "tasks-stopped wait failed"
# Without the overrides, which hold the JIT configs.
aws ecs describe-tasks --cluster "$NAME" --tasks "${tasks[@]}" --output json \
  | jq 'del(.tasks[].overrides)' > "$OUT/tasks.json"
timeout 1500 gh run watch "$(cat "$OUT/run-id")" -R "$CANARY" --exit-status >/dev/null || log "run did not succeed"
gh api "repos/$CANARY/actions/runs/$(cat "$OUT/run-id")/jobs" > "$OUT/jobs.json"
log "done; outputs in $OUT"
