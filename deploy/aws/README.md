# AWS deployment files

- `template.yaml` provisions the public echo demo, static site origin, GitHub OIDC deploy role, and generated administrator secret.
- `deploy.ps1` builds and publishes the first demo image, deploys the stack, pins the App Runner host, and uploads the generated website.

Read [the AWS demo deployment guide](../../docs/aws-demo.md) before deploying. No AWS budget alert is configured; monitor costs in Billing and Cost Management.
