[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$Region = 'us-east-1',
  [string]$StackName = 'relay-mcp-gateway-demo'
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw 'AWS CLI v2 is required.' }
$stack = aws cloudformation describe-stacks --stack-name $StackName --region $Region --output json 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host "Stack '$StackName' was not found in $Region."; return }
$outputs = ($stack | ConvertFrom-Json).Stacks[0].Outputs
$bucket = ($outputs | Where-Object OutputKey -eq 'WebsiteBucketName' | Select-Object -First 1).OutputValue
if (-not $PSCmdlet.ShouldProcess("AWS $Region / $StackName and its website files", 'Remove Relay demo infrastructure')) { return }
aws s3 rm "s3://$bucket" --recursive --region $Region
if ($LASTEXITCODE -ne 0) { throw 'Could not empty the website bucket; stack removal was stopped.' }
aws cloudformation delete-stack --stack-name $StackName --region $Region
if ($LASTEXITCODE -ne 0) { throw 'Could not start CloudFormation stack removal.' }
aws cloudformation wait stack-delete-complete --stack-name $StackName --region $Region
if ($LASTEXITCODE -ne 0) { throw 'CloudFormation did not finish removing the demo stack.' }
Write-Host 'Relay demo stack resources were removed. The shared GitHub OIDC provider and demo image repository were left in place.'
Write-Host 'The ECR repository keeps only its ten newest images. Remove it separately only after checking that no other service uses it:'
Write-Host "aws ecr delete-repository --repository-name relay-mcp-gateway-demo --force --region $Region"
