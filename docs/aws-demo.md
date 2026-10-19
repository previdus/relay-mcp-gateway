# AWS demo deployment

This deployment is a public, low-traffic **demo**, not a production tenant. It serves the static Relay website through a private S3 bucket and CloudFront, and runs the gateway's harmless echo demo on AWS App Runner. The public client is intentionally limited to the echo alias. The administrator key is generated into AWS Secrets Manager; the demo database is in memory and resets when App Runner replaces its instance.

## Region and cost controls

The starter uses `us-east-1` to keep the App Runner compute rate low. The small App Runner service is limited to one instance. The CloudFormation stack creates a **$10 monthly AWS Budget with email alerts at $8 actual and $10 forecasted spend**. AWS Budgets reports spend; it does not stop App Runner or guarantee a hard billing cap. App Runner charges for its provisioned memory even when idle, plus active processing, deployments and data transfer. CloudFront, S3, ECR storage, logs and network transfer can also incur charges depending on usage and account eligibility. Pause or delete the stack when the demo is not needed. Verify current rates and free-tier eligibility in your account before launch.

The default App Runner size uses 0.25 vCPU and 0.5 GB. At the US East public rates shown in AWS App Runner's pricing guide, provisioned memory is about $2.56 per 730-hour month, plus traffic and other services. The budget alarm is a monitoring threshold, not a spend limiter. See [App Runner pricing](https://aws.amazon.com/apprunner/pricing/) and [CloudFront pricing plans](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html).

## First deployment

Prerequisites: Docker, AWS CLI v2 authenticated to the intended account, and permission to create App Runner, ECR, CloudFormation, S3, CloudFront, Secrets Manager, IAM, Budgets, and SNS resources. Use a dedicated demo account or a named AWS profile. Do not commit access keys.

From the repository root in PowerShell:

```powershell
$env:AWS_PROFILE = "your-demo-profile"
$env:AWS_REGION = "us-east-1"
$env:BUDGET_EMAIL = "you@example.com"
./deploy/aws/deploy.ps1
```

The script builds the container and website, creates or reuses the ECR image repository, pushes the demo image, creates the CloudFormation stack, reads the random App Runner URL, then updates the gateway host allowlist before uploading the site. It prints the site URL, MCP URL, administrator secret ARN, budget name, and stack name. Retrieve the admin key only in your AWS Console or through `secretsmanager:GetSecretValue`; never put it in a public issue or website. The demo service key is public by design and only permits `echo`.

The AWS account must have CloudFront available and AWS Budgets enabled. The first CloudFront distribution can take several minutes to become available. `deploy.ps1 -WhatIf` validates required local tools and shows the planned stack parameters without creating cloud resources.

## Updates and shutdown

After pushing the repository, the GitHub Actions workflow can publish website and image updates using GitHub OIDC. `deploy.ps1` prints the exact variables to add under the repository's **Settings → Secrets and variables → Actions → Variables**: `AWS_ROLE_ARN`, `AWS_REGION`, `ECR_REPOSITORY_URI`, `APP_RUNNER_SERVICE_ARN`, `WEBSITE_BUCKET`, `CLOUDFRONT_DISTRIBUTION_ID`, and `RELAY_MCP_ENDPOINT`. The generated role trust policy permits only this repository's `main` branch. No long-lived AWS credentials belong in GitHub secrets.

To stop ongoing compute, pause App Runner. To remove the demo, run `./deploy/aws/remove-demo.ps1`; it empties the named website bucket and removes the named CloudFormation stack. The demo ECR repository is kept (with a ten-image retention rule) in case you redeploy or another service uses it. Delete that repository separately only after checking its consumers. The script leaves the shared GitHub OIDC provider in place because other repositories may use it.

## Production path

This demo has one App Runner instance and in-memory state. It does not demonstrate horizontally shared administration state. For a multi-replica deployment, use the included Kubernetes or Compose deployment with PostgreSQL, TLS at a trusted ingress, shared secrets, backups, bounded autoscaling and outbound network policy. The hosted echo demo does not accept customer credentials or connect to customer servers.
