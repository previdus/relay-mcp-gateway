import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { parseAllDocuments, parseDocument } from 'yaml';
const files = ['deploy/kubernetes.yaml', 'deploy/kubernetes.test.yaml', 'deploy/compose.test.yaml', 'deploy/aws/template.yaml', 'compose.yaml', '.github/workflows/ci.yml', '.github/workflows/deploy-aws.yml'];
for (const file of files) {
  const documents = parseAllDocuments(await readFile(file, 'utf8'), { uniqueKeys: true });
  for (const document of documents) if (document.errors.length) throw new Error(`${file}: ${document.errors.map(error => error.message).join('; ')}`);
}
const aws = parseDocument(await readFile('deploy/aws/template.yaml', 'utf8'), { uniqueKeys: true }).contents;
const value = (node, key) => node?.items?.find(item => item.key?.value === key)?.value;
const resources = value(aws, 'Resources');
const service = value(resources, 'GatewayService');
const imageConfig = value(value(value(value(service, 'Properties'), 'SourceConfiguration'), 'ImageRepository'), 'ImageConfiguration');
assert.equal(imageConfig?.constructor.name, 'YAMLMap');
assert.equal(value(imageConfig, 'RuntimeEnvironmentVariables')?.constructor.name, 'YAMLSeq', 'App Runner environment variables must use list entries');
assert.equal(value(imageConfig, 'RuntimeEnvironmentSecrets')?.constructor.name, 'YAMLSeq', 'App Runner environment secrets must use list entries');
const serviceProperties = value(service, 'Properties');
assert.equal(value(serviceProperties, 'ServiceName')?.value, '${AWS::StackName}-gateway', 'App Runner service names must be stack-scoped for safe parallel recovery');
const scalingProperties = value(value(resources, 'DemoAutoScaling'), 'Properties');
assert.equal(value(scalingProperties, 'AutoScalingConfigurationName'), undefined, 'CloudFormation should generate a unique scaling configuration name');
const distributionProperties = value(value(resources, 'WebsiteDistribution'), 'Properties');
assert.equal(value(distributionProperties, 'Tags')?.constructor.name, 'YAMLSeq', 'CloudFront tags belong on the distribution resource');
assert.equal(value(value(distributionProperties, 'DistributionConfig'), 'Tags'), undefined, 'CloudFront tags cannot be nested in DistributionConfig');
console.log('Deployment and CI YAML syntax checks passed.');
