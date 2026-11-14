# The ci-runner image: GitHub's official runner image plus general tools only.
# Nothing is pinned: the weekly build picks up the base image and the tools.
FROM ghcr.io/actions/actions-runner:latest

ARG TARGETARCH
USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# apt tools, plus the gh and Node.js (current LTS) repositories.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
 && apt-get install -y --no-install-recommends \
      gh jq make git curl zstd unzip python3 python3-venv python3-pip nodejs \
      build-essential pkg-config \
 && rm -rf /var/lib/apt/lists/*

# docker compose plugin, next to the base image's buildx.
RUN case "$TARGETARCH" in amd64) a=x86_64 ;; arm64) a=aarch64 ;; *) a=$TARGETARCH ;; esac \
 && curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose \
      "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$a" \
 && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# AWS CLI v2.
RUN case "$TARGETARCH" in amd64) a=x86_64 ;; arm64) a=aarch64 ;; *) a=$TARGETARCH ;; esac \
 && tmp=$(mktemp -d) \
 && curl -fsSL -o "$tmp/awscliv2.zip" "https://awscli.amazonaws.com/awscli-exe-linux-$a.zip" \
 && unzip -q "$tmp/awscliv2.zip" -d "$tmp" \
 && "$tmp/aws/install" \
 && rm -rf "$tmp"

# The toolcache actions/setup-* expect, owned by runner.
ENV AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache \
    RUNNER_TOOL_CACHE=/opt/hostedtoolcache
RUN install -d -o runner -g runner /opt/hostedtoolcache

USER runner
