STACK   ?= ci-runner
PROFILE ?= zeroae-code/AWSPowerUserAccess
REGION  ?= us-east-1
AWS      = aws --profile $(PROFILE) --region $(REGION)

.PHONY: help test build validate deploy outputs
.DEFAULT_GOAL := help

help: ## List the targets
	@grep -E '^[a-z]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-9s %s\n", $$1, $$2}'
	@echo "  Layout and conventions: docs/stack.md"

test: ## Run the unit tests (node --test, no npm deps)
	node --test test/*.test.js

build: ## Inline functions/*.js into build/template.yaml and report its size
	node scripts/build-template.js

validate: build ## Ask CloudFormation to validate the built template
	$(AWS) cloudformation validate-template --template-body file://build/template.yaml >/dev/null && echo valid

deploy: test build ## Create or update the stack ($(STACK)) from one command
	$(AWS) cloudformation deploy --stack-name $(STACK) \
	  --template-file build/template.yaml \
	  --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset
	@$(MAKE) --no-print-directory outputs

outputs: ## Print the stack's outputs (setup URL, webhook URL, secret ARN)
	@$(AWS) cloudformation describe-stacks --stack-name $(STACK) \
	  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text
