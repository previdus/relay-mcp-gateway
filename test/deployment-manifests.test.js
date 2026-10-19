import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseAllDocuments } from 'yaml';

test('Kubernetes release manifest is parseable, hardened and aligned to the package version', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const source = await readFile(new URL('../deploy/kubernetes.yaml', import.meta.url), 'utf8');
  const docs = parseAllDocuments(source);
  assert.ok(docs.every(document => document.errors.length === 0));
  const objects = docs.map(document => document.toJSON()).filter(Boolean);
  const deployment = objects.find(object => object.kind === 'Deployment');
  const service = objects.find(object => object.kind === 'Service');
  const autoscaler = objects.find(object => object.kind === 'HorizontalPodAutoscaler');
  const gateway = deployment.spec.template.spec.containers.find(container => container.name === 'gateway');
  assert.equal(deployment.spec.replicas, 2);
  assert.equal(gateway.image, `relay-gateway:${pkg.version}`);
  assert.equal(deployment.spec.template.spec.securityContext.runAsNonRoot, true);
  assert.equal(deployment.spec.template.spec.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(deployment.spec.template.spec.terminationGracePeriodSeconds, 135);
  assert.equal(deployment.spec.strategy.rollingUpdate.maxUnavailable, 0);
  assert.equal(deployment.spec.strategy.rollingUpdate.maxSurge, 1);
  assert.equal(deployment.spec.template.spec.topologySpreadConstraints.length, 2);
  assert.equal(gateway.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(gateway.securityContext.capabilities.drop, ['ALL']);
  assert.equal(gateway.startupProbe.httpGet.path, '/healthz');
  assert.equal(gateway.startupProbe.failureThreshold * gateway.startupProbe.periodSeconds, 300);
  assert.ok(gateway.env.some(entry => entry.name === 'GATEWAY_SHUTDOWN_TIMEOUT_MS' && entry.value === '120000'));
  assert.equal(gateway.readinessProbe.httpGet.path, '/readyz');
  assert.equal(gateway.resources.requests.memory, '384Mi');
  assert.equal(gateway.resources.limits.memory, '1Gi');
  assert.equal(service.spec.ports[0].targetPort, gateway.ports[0].containerPort);
  assert.equal(autoscaler.spec.minReplicas, 2);
  assert.ok(autoscaler.spec.maxReplicas >= autoscaler.spec.minReplicas);
});

test('disposable PostgreSQL service enables TLS with a test-only certificate and protected key permissions', async () => {
  const compose = parseAllDocuments(await readFile(new URL('../deploy/compose.test.yaml', import.meta.url), 'utf8'))[0].toJSON();
  const postgres = compose.services.postgres;
  assert.equal(postgres.build.dockerfile, 'deploy/postgres-test.Dockerfile');
  const dockerfile = await readFile(new URL('../deploy/postgres-test.Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY test\/fixtures\/postgres-test\.crt/);
  assert.match(dockerfile, /COPY test\/fixtures\/postgres-test\.key/);
  assert.match(dockerfile, /chmod 600 \/etc\/postgresql\/test-server\.key/);
  assert.match(dockerfile, /"ssl=on"/);
  const cert = await readFile(new URL('../test/fixtures/postgres-test.crt', import.meta.url), 'utf8');
  assert.match(cert, /BEGIN CERTIFICATE/);
});
