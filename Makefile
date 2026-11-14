STACK   ?= ci-runner
PROFILE ?= zeroae-code/ZAEPowerUserAccess
REGION  ?= us-east-1
ORG     ?= zeroae
AWS      = aws --profile $(PROFILE) --region $(REGION)
# The deploy bucket, made outside the stack (docs/runbook.md). Looked up only when used.
BUCKET  ?= $(STACK)-deploy-$(shell $(AWS) sts get-caller-identity --query Account --output text)

.PHONY: help test build validate deploy outputs hand-launch runners sweep canary-runs
.DEFAULT_GOAL := help

help: ## List the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-12s %s\n", $$1, $$2}'
	@echo "  Layout and conventions: docs/stack.md; procedures and traps: docs/runbook.md"

test: ## Run the unit tests (node --test, no npm deps)
	node --test test/*.test.js

build: ## Inline functions/*.js into build/template.yaml and report its size
	node scripts/build-template.js

validate: build ## Ask CloudFormation to validate the built template (through the deploy bucket)
	$(AWS) s3 cp --only-show-errors build/template.yaml s3://$(BUCKET)/$(STACK)/validate.yaml
	$(AWS) cloudformation validate-template \
	  --template-url https://$(BUCKET).s3.$(REGION).amazonaws.com/$(STACK)/validate.yaml >/dev/null && echo valid

deploy: test build ## Create or update the stack ($(STACK)) through the deploy bucket
	$(AWS) cloudformation deploy --stack-name $(STACK) \
	  --template-file build/template.yaml --s3-bucket $(BUCKET) --s3-prefix $(STACK) \
	  --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset
	@$(MAKE) --no-print-directory outputs

outputs: ## Print the stack's outputs (setup URL, webhook URL, secret ARN)
	@$(AWS) cloudformation describe-stacks --stack-name $(STACK) \
	  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text

hand-launch: ## Launch one CI runner by hand for one ci-spot job of shape SIZE and ARCH, both required, e.g. SIZE=ci-cpu-4 ARCH=x64 (needs gh with admin:org)
	STACK=$(STACK) PROFILE=$(PROFILE) REGION=$(REGION) SIZE=$(SIZE) ARCH=$(ARCH) scripts/hand-launch.sh

runners: ## List the stack's CI runner instances that are not terminated
	@$(AWS) ec2 describe-instances \
	  --filters Name=tag:ci-runner:stack,Values=$(STACK) \
	    Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down \
	  --query 'Reservations[].Instances[].[InstanceId,State.Name,InstanceType,LaunchTime]' --output text

sweep: ## Run the sweeper now, and print what it terminated, stopped and removed
	@$(AWS) lambda invoke --function-name $(STACK)-sweeper /dev/stdout --query FunctionError --output text

canary-runs: ## List the canary repo's recent workflow runs (CI_RUNNER_CANARY_REPO, from .env)
	@test -f .env || { echo "no .env: run scripts/setup-github.sh first" >&2; exit 1; }
	@. ./.env && gh run list --repo $(ORG)/$$CI_RUNNER_CANARY_REPO --limit 10
