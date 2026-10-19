# AWS deployment files

- `template.yaml` provisions the public echo demo, static site origin, GitHub OIDC deploy role, generated administrator secret, and budget alert.
- `deploy.ps1` builds and publishes the first demo image, deploys the stack, pins the App Runner host, and uploads the generated website.

Read [the AWS demo deployment guide](../../docs/aws-demo.md) before deploying. The budget is a notification threshold, not an automatic spend limit.
