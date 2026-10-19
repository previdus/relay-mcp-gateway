# Security policy

Relay is an evolving open-source gateway. Review [the security boundaries](docs/security.md), [enterprise deployment guidance](docs/enterprise-security.md), and [feature coverage](docs/coverage.md) before using it with sensitive systems.

## Reporting a vulnerability

Until a private security contact is configured for this repository, do not include exploit details, credentials, or customer data in public issues. Ask a repository maintainer for a private reporting channel, or use the hosting platform's private vulnerability reporting feature if enabled.

Please include the affected version or commit, deployment mode, impact, and a safe reproduction outline. The project will coordinate triage and a fix before public disclosure where practical.

## Deployment responsibilities

The gateway source does not automatically configure cloud IAM, ingress TLS, network egress policy, managed secret storage, database backups, immutable audit retention, or production identity-provider settings. Operators must configure and verify these controls in their environment.

