import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';

test('CI audits locked dependencies and pins external actions to reviewed commits', async () => {
  const source = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const workflow = YAML.parse(source);
  const steps = workflow.jobs.verify.steps;

  assert.equal(workflow.permissions.contents, 'read');
  assert.deepEqual(Object.keys(workflow.permissions), ['contents']);
  assert.ok(steps.some((step) => step.run === 'npm audit --audit-level=high'));
  assert.ok(steps.some((step) => step.run === 'npm sbom --sbom-format=cyclonedx --omit=dev > gateway.sbom.cdx.json'));
  assert.ok(steps.some((step) => step.with?.name === 'gateway-production-dependencies-sbom'
    && step.with?.path === 'gateway.sbom.cdx.json'
    && step.with?.['if-no-files-found'] === 'error'
    && step.with?.['retention-days'] === 30));

  const imageBuild = steps.findIndex((step) => step.run === 'docker build -t relay-gateway:0.12.0 .');
  const imageSbom = steps.findIndex((step) => step.uses?.startsWith('anchore/sbom-action@'));
  const imageArtifact = steps.findIndex((step) => step.with?.name === 'gateway-container-image-sbom');
  const imageScan = steps.findIndex((step) => step.uses?.startsWith('anchore/scan-action@'));
  const scanReport = steps.findIndex((step) => step.with?.name === 'gateway-image-vulnerability-report');
  assert.ok(imageBuild >= 0 && imageSbom > imageBuild && imageArtifact > imageSbom,
    'the built release image must be inventoried and retained after it is built');
  assert.deepEqual(steps[imageSbom].with, {
    image: 'relay-gateway:0.12.0',
    format: 'cyclonedx-json',
    'output-file': 'gateway.image.sbom.cdx.json',
    'upload-artifact': false,
    'upload-release-assets': false
  });
  assert.ok(steps[imageArtifact].with?.path === 'gateway.image.sbom.cdx.json'
    && steps[imageArtifact].with?.['if-no-files-found'] === 'error'
    && steps[imageArtifact].with?.['retention-days'] === 30);
  assert.ok(imageScan > imageSbom && scanReport > imageScan,
    'the generated image SBOM must be scanned and the report retained');
  assert.deepEqual(steps[imageScan].with, {
    sbom: 'gateway.image.sbom.cdx.json',
    'fail-build': true,
    'severity-cutoff': 'high',
    'grype-version': 'v0.118.0',
    'output-format': 'json',
    'output-file': 'gateway.image.vulnerabilities.json'
  });
  assert.ok(steps[scanReport].if === 'always()'
    && steps[scanReport].with?.path === 'gateway.image.vulnerabilities.json'
    && steps[scanReport].with?.['retention-days'] === 30);

  const externalActions = steps.filter((step) => step.uses);
  assert.ok(externalActions.length > 0);
  for (const action of externalActions) {
    assert.match(action.uses, /^[^@]+@[0-9a-f]{40}(?:\s+#\s+v\d[^\s]*)?$/,
      `${action.uses} must use a full commit SHA and retain a readable release tag`);
  }
});
