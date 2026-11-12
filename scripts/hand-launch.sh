#!/usr/bin/env bash
# Launches one CI runner by hand: mints an org JIT config for the runner group
# (with the owner's gh, which needs admin:org), renders its #cloud-config and
# launches one Spot .xlarge from the stack's launch template. The instance
# takes one job labelled [self-hosted, LABEL] and terminates; given no job, it
# terminates after the idle exit (15 minutes; IDLE_SECONDS overrides it).
#
#   scripts/hand-launch.sh            # or: make hand-launch
#
# Prints the instance id. Overrides: STACK PROFILE REGION ORG GROUP LABEL IDLE_SECONDS
set -euo pipefail

STACK=${STACK:-ci-runner}
PROFILE=${PROFILE:-zeroae-code/AWSPowerUserAccess}
REGION=${REGION:-us-east-1}
ORG=${ORG:-zeroae}
GROUP=${GROUP:-ci-runner}
LABEL=${LABEL:-ci-spot}
TYPES=(m7i.xlarge m6i.xlarge m6a.xlarge m7a.xlarge)
aws() { command aws --profile "$PROFILE" --region "$REGION" "$@"; }
here=$(cd "$(dirname "$0")" && pwd)

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
lt=$(output LaunchTemplateId)
IFS=, read -r -a subnets <<<"$(output SubnetIds)"

group_id=$(gh api "orgs/$ORG/actions/runner-groups" --paginate \
  --jq ".runner_groups[] | select(.name == \"$GROUP\") | .id")
[[ -n $group_id ]] || { echo "no runner group named $GROUP in $ORG" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

name="$STACK-hand-$(date +%Y%m%d%H%M%S)"
gh api -X POST "orgs/$ORG/actions/runners/generate-jitconfig" \
  -f name="$name" -F runner_group_id="$group_id" -f work_folder=_work \
  -f 'labels[]=self-hosted' -f "labels[]=$LABEL" \
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
    {"Key": "ci-runner:label", "Value": "$LABEL"}
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
echo "$instance  runner $name  label $LABEL" >&2
echo "$instance"
