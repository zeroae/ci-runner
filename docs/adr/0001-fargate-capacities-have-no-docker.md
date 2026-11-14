# Fargate capacities have no Docker daemon

The two Fargate capacities, `ci-fargate` and `ci-fargate-spot`, run a job with no Docker daemon and no socket. Picking one is the job author's promise that the job never uses Docker: no `services:`, no `container:` jobs, no Docker actions, no `docker build`. A job that breaks the promise fails at that step, and nothing detects it beforehand.

We accepted that because the jobs it serves (Rust builds, for example) need CPU, memory and disk, not containers. Fargate allows no privileged mode, so the only ways to give a job Docker there are rootless daemons or remote builders, which each add a moving part to every job. Jobs that need Docker stay on the EC2 capacities, `ci-spot` and `ci-ondemand`, which keep the host's daemon.
