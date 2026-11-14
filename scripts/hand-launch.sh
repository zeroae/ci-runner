#!/usr/bin/env bash
# Launches one CI runner by hand: mints an org JIT config for the runner group
# (with the owner's gh, which needs admin:org), renders its #cloud-config and
# launches one Spot instance of size SIZE from the stack's launch template for
# ARCH (x64 or arm64). The instance takes one job labelled [self-hosted, LABEL,
# SIZE, ARCH] (or a subset of them) and terminates; given no job, it terminates
# after the idle exit (15 minutes; IDLE_SECONDS overrides it).
#
#   scripts/hand-launch.sh                  # or: make hand-launch
#   SIZE=ci-cpu-8 scripts/hand-launch.sh    # or: make hand-launch SIZE=ci-cpu-8
#   ARCH=arm64 scripts/hand-launch.sh       # or: make hand-launch ARCH=arm64
#
# Prints the instance id. Overrides: STACK PROFILE REGION ORG GROUP LABEL SIZE ARCH IDLE_SECONDS
set -euo pipefail

STACK=${STACK:-ci-runner}
PROFILE=${PROFILE:-zeroae-code/AWSPowerUserAccess}
REGION=${REGION:-us-east-1}
ORG=${ORG:-zeroae}
GROUP=${GROUP:-ci-runner}
LABEL=${LABEL:-ci-spot}
SIZE=${SIZE:-ci-cpu-4}
ARCH=${ARCH:-x64}
# The size label's instance size, at 4 GB per vCPU, as the launcher maps it.
case $SIZE in
  ci-cpu-2) size=large ;; ci-cpu-4) size=xlarge ;; ci-cpu-8) size=2xlarge ;; ci-cpu-16) size=4xlarge ;;
  *) echo "unknown size $SIZE: one of ci-cpu-2, ci-cpu-4, ci-cpu-8, ci-cpu-16" >&2; exit 1 ;;
esac
# The architecture's launch template and families, as the launcher picks them.
case $ARCH in
  x64) lt_output=LaunchTemplateId; TYPES=(m7i.$size m6i.$size m6a.$size m7a.$size) ;;
  arm64) lt_output=Arm64LaunchTemplateId; TYPES=(m7g.$size m6g.$size m8g.$size) ;;
  *) echo "unknown architecture $ARCH: one of x64, arm64" >&2; exit 1 ;;
esac
aws() { command aws --profile "$PROFILE" --region "$REGION" "$@"; }
here=$(cd "$(dirname "$0")" && pwd)

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
lt=$(output $lt_output)
IFS=, read -r -a subnets <<<"$(output SubnetIds)"

group_id=$(gh api "orgs/$ORG/actions/runner-groups" --paginate \
  --jq ".runner_groups[] | select(.name == \"$GROUP\") | .id")
[[ -n $group_id ]] || { echo "no runner group named $GROUP in $ORG" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

name="$STACK-hand-$(date -u +%Y%m%d%H%M%S)"
gh api -X POST "orgs/$ORG/actions/runners/generate-jitconfig" \
  -f name="$name" -F runner_group_id="$group_id" -f work_folder=_work \
  -f 'labels[]=self-hosted' -f "labels[]=$LABEL" -f "labels[]=$SIZE" -f "labels[]=$ARCH" \
  --jq .encoded_jit_config > "$work/jit"
node "$here/render-cloud-config.js" < "$work/jit" | base64 -w0 > "$work/user-data"

# A launch template version per launch carries the user-data, because
# CreateFleet can't override it. It is deleted again once the fleet returns.
version=$(aws ec2 create-launch-template-version --launch-template-id "$lt" \
  --source-version '$Default' --version-description "$name" \
  --launch-template-data "{\"UserData\":\"$(cat "$work/user-data")\"}" \
  --query LaunchTemplateVersion.VersionNumber --output text)

overrides=$(for t in "${TYPES[@]}"; do for s in "${subnets[@]}"; do
  printf '{"InstanceType":"%s","SubnetId":"%s"},' "$t" "$s"; done; done)
cat > "$work/fleet.json" <<JSON
{
  "Type": "instant",
  "TargetCapacitySpecification": {"TotalTargetCapacity": 1, "DefaultTargetCapacityType": "spot"},
  "SpotOptions": {"AllocationStrategy": "capacity-optimized"},
  "LaunchTemplateConfigs": [{
    "LaunchTemplateSpecification": {"LaunchTemplateId": "$lt", "Version": "$version"},
    "Overrides": [${overrides%,}]
  }],
  "TagSpecifications": [{"ResourceType": "instance", "Tags": [
    {"Key": "ci-runner:runner", "Value": "$name"},
    {"Key": "ci-runner:label", "Value": "$LABEL"},
    {"Key": "ci-runner:capacity", "Value": "$LABEL"},
    {"Key": "ci-runner:vcpus", "Value": "${SIZE#ci-cpu-}"},
    {"Key": "ci-runner:arch", "Value": "$ARCH"}
  ]}]
}
JSON
fleet=$(aws ec2 create-fleet --cli-input-json "file://$work/fleet.json" --output json) || fleet=
aws ec2 delete-launch-template-versions --launch-template-id "$lt" \
  --versions "$version" >/dev/null

instance=$(jq -r '.Instances[0].InstanceIds[0] // empty' <<<"$fleet")
if [[ -z $instance ]]; then
  echo "no instance launched:" >&2
  jq -r '.Errors[]? | "  \(.ErrorCode): \(.ErrorMessage)"' <<<"$fleet" | sort -u >&2
  echo "the JIT runner $name stays registered until removed" >&2
  exit 1
fi
echo "$instance  runner $name  labels $LABEL $SIZE $ARCH" >&2
echo "$instance"
