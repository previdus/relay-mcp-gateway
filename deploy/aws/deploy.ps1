[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Region = 'us-east-1',
  [string]$StackName = 'relay-mcp-gateway-demo'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Set-Location $root

foreach ($tool in @('aws', 'docker', 'node', 'npm')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Required tool not found: $tool" }
}
if ($WhatIfPreference) {
  Write-Host "Plan: build the public echo container; create/update stack '$StackName' in $Region; configure a $10 monthly budget alert; publish the static site; enable the gateway host allowlist. No cloud resources were changed."
  return
}

$null = aws sts get-caller-identity --region $Region 2>$null
if ($LASTEXITCODE -ne 0) { throw 'AWS sign-in was not available for this profile. Configure AWS CLI credentials with IAM Identity Center or a named profile, then retry.' }
$owner = Read-Host 'GitHub account or organization that owns relay-mcp-gateway'
$budgetEmail = Read-Host 'Email for the $10 monthly spend warning'
if (-not $owner -or $owner -notmatch '^[A-Za-z0-9-]+$') { throw 'Enter a valid GitHub owner.' }
if (-not $budgetEmail -or $budgetEmail -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { throw 'Enter a valid budget notification email.' }

$accountId = aws sts get-caller-identity --query Account --output text --region $Region
$registry = "$accountId.dkr.ecr.$Region.amazonaws.com"
$repository = 'relay-mcp-gateway-demo'
$imageUri = "${registry}/${repository}:latest"
$repo = aws ecr describe-repositories --repository-names $repository --region $Region 2>$null
if ($LASTEXITCODE -ne 0) {
  aws ecr create-repository --repository-name $repository --image-scanning-configuration scanOnPush=true --image-tag-mutability MUTABLE --encryption-configuration encryptionType=AES256 --tags Key=Project,Value=relay-mcp-gateway-demo --region $Region | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the ECR image repository.' }
} else {
  $existingRepositoryArn = ($repo | ConvertFrom-Json).repositories[0].repositoryArn
  $repositoryTags = aws ecr list-tags-for-resource --resource-arn $existingRepositoryArn --region $Region | ConvertFrom-Json
  if (-not ($repositoryTags.tags | Where-Object { $_.Key -eq 'Project' -and $_.Value -eq 'relay-mcp-gateway-demo' })) {
    throw "ECR repository '$repository' already exists and is not tagged as this Relay demo. Refusing to change it."
  }
}
$lifecycle = '{"rules":[{"rulePriority":1,"description":"Keep the ten newest Relay demo images","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}}]}'
aws ecr put-lifecycle-policy --repository-name $repository --lifecycle-policy-text $lifecycle --region $Region | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not set the bounded image-retention policy.' }

aws ecr get-login-password --region $Region | docker login --username AWS --password-stdin $registry
if ($LASTEXITCODE -ne 0) { throw 'Could not sign Docker in to the AWS image registry.' }
docker build --pull -t $imageUri .
if ($LASTEXITCODE -ne 0) { throw 'Container build failed.' }
docker push $imageUri
if ($LASTEXITCODE -ne 0) { throw 'Container upload failed.' }

$providers = aws iam list-open-id-connect-providers --output json | ConvertFrom-Json
$provider = $providers.OpenIDConnectProviderList | Where-Object { $_.Arn -like 'arn:*:oidc-provider/token.actions.githubusercontent.com' } | Select-Object -First 1
if ($provider) {
  $providerArn = $provider.Arn
} else {
  $providerArn = aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com --query OpenIDConnectProviderArn --output text
  if ($LASTEXITCODE -ne 0 -or -not $providerArn) { throw 'Could not register the GitHub Actions identity provider.' }
}

$template = Join-Path $PSScriptRoot 'template.yaml'
$baseParameters = @("ImageUri=$imageUri", "GitHubOwner=$owner", 'GitHubRepository=relay-mcp-gateway', "GitHubOidcProviderArn=$providerArn", "BudgetEmail=$budgetEmail", 'GatewayAllowedHosts=')
if (-not $PSCmdlet.ShouldProcess("AWS $Region / $StackName", 'Create the public Relay demo, static website, and $10 monthly budget alert')) { return }
aws cloudformation deploy --template-file $template --stack-name $StackName --capabilities CAPABILITY_NAMED_IAM --region $Region --parameter-overrides $baseParameters
if ($LASTEXITCODE -ne 0) { throw 'CloudFormation failed while creating the AWS demo stack.' }

$endpoint = aws cloudformation describe-stacks --stack-name $StackName --region $Region --query "Stacks[0].Outputs[?OutputKey=='McpEndpoint'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0 -or -not $endpoint.StartsWith('https://')) { throw 'Could not read the App Runner MCP endpoint.' }
$allowedHost = ([uri]$endpoint).Host
$finalParameters = @("ImageUri=$imageUri", "GitHubOwner=$owner", 'GitHubRepository=relay-mcp-gateway', "GitHubOidcProviderArn=$providerArn", "BudgetEmail=$budgetEmail", "GatewayAllowedHosts=$allowedHost")
aws cloudformation deploy --template-file $template --stack-name $StackName --capabilities CAPABILITY_NAMED_IAM --region $Region --parameter-overrides $finalParameters
if ($LASTEXITCODE -ne 0) { throw 'Could not apply the generated App Runner hostname allowlist.' }

$outputs = aws cloudformation describe-stacks --stack-name $StackName --region $Region --query 'Stacks[0].Outputs' --output json | ConvertFrom-Json
$getOutput = { param($key) ($outputs | Where-Object OutputKey -eq $key | Select-Object -First 1).OutputValue }
$websiteUrl = & $getOutput 'WebsiteUrl'
$bucket = & $getOutput 'WebsiteBucketName'
$distribution = & $getOutput 'CloudFrontDistributionId'
$serviceArn = & $getOutput 'AppRunnerServiceArn'
$repositoryUri = & $getOutput 'EcrRepositoryUri'
$roleArn = & $getOutput 'GitHubDeployRoleArn'
$env:RELAY_MCP_ENDPOINT = $endpoint
npm run website:build
if ($LASTEXITCODE -ne 0) { throw 'Static website build failed.' }
aws s3 sync website/dist "s3://$bucket" --delete --region $Region
if ($LASTEXITCODE -ne 0) { throw 'Website upload failed.' }
aws cloudfront create-invalidation --distribution-id $distribution --paths '/*' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not refresh the public website cache.' }

Write-Host ''
Write-Host 'Relay AWS demo deployment is ready.'
Write-Host "Website: $websiteUrl"
Write-Host "MCP endpoint: $endpoint"
Write-Host "Admin key secret ARN: $(& $getOutput 'GatewayAdminSecretArn')"
Write-Host "GitHub deploy role: $roleArn"
Write-Host 'Set these GitHub Actions repository variables to enable deployments from main:'
Write-Host "AWS_ROLE_ARN=$roleArn"
Write-Host "AWS_REGION=$Region"
Write-Host "ECR_REPOSITORY_URI=$repositoryUri"
Write-Host "APP_RUNNER_SERVICE_ARN=$serviceArn"
Write-Host "WEBSITE_BUCKET=$bucket"
Write-Host "CLOUDFRONT_DISTRIBUTION_ID=$distribution"
Write-Host "RELAY_MCP_ENDPOINT=$endpoint"
Write-Host "Monthly spend warning: $10 (notifications to $budgetEmail; this is not an automatic shutdown)."
Write-Host 'The public demo key only grants the echo tool.'
