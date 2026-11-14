# Push the runner image to ECR from CI, not through a pull-through cache

Fargate pulls the whole image (about 820 MB) for every task and caches nothing, so start time depends on lazy loading (SOCI), and that works only from private ECR. The public `image.yml` job therefore pushes the image to an ECR repo that this stack owns, both architectures with a SOCI v2 index, through GitHub OIDC. The OIDC setup follows foresight's `github-deploy-zae.json`: the provider is created only when the account doesn't already have one. EC2 runners keep pulling from GHCR, because an instance with no instance profile can't pull from private ECR.

## Considered Options

- **ECR pull-through cache from ghcr.io.** CI wouldn't change at all. We rejected it for three reasons: ghcr.io upstream needs a GitHub token in Secrets Manager even for a public image, so someone must keep rotating it; a cached `:latest` can be up to 24 hours stale; and no AWS document says SOCI works through the cache, while a cached repo can't be pushed to, so we couldn't add an index ourselves.
