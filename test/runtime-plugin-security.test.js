import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SqliteStore } from '../dist/store.js';
import { createRuntime } from '../dist/runtime.js';
import { createModernDemoServer } from '../dist/demo-modern.js';
import { listen, serviceToken, adminToken } from './helpers.js';

test('health checks work before a cloud hostname is assigned while gateway routes still enforce the host allow-list', async t => {
  const store = new SqliteStore(':memory:', { allowLocalHttp: true, clients: [{ id: 'health-probe', tokenEnv: 'SERVICE_TOKEN', allow: ['never'] }], upstreams: [] });
  t.after(() => store.close());
  const gatewayUrl = await listen(createRuntime(store, { adminKey: adminToken, environment: {}, allowedHosts: ['gateway.example'] }), t);

  const health = await fetch(`${gatewayUrl}/healthz`, { headers: { Host: 'internal-load-balancer.local' } });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const admin = await fetch(`${gatewayUrl}/admin/`, { headers: { Host: 'internal-load-balancer.local' } });
  assert.notEqual(admin.status, 200, 'normal routes remain protected by host validation');
});

test('the MCP router receives the same deployment host allow-list as the outer runtime', async t => {
  const store = new SqliteStore(':memory:', { allowLocalHttp: true, clients: [{ id: 'health-probe', tokenEnv: 'SERVICE_TOKEN', allow: ['never'] }], upstreams: [] });
  t.after(() => store.close());
  const gatewayUrl = await listen(createRuntime(store, { adminKey: adminToken, environment: { SERVICE_TOKEN: serviceToken }, allowedHosts: ['gateway.example'] }), t);
  const response = await new Promise((resolve, reject) => {
    const request = httpRequest(new URL(`${gatewayUrl}/mcp`), {
      method: 'POST',
      headers: { host: 'gateway.example', Authorization: `Bearer ${serviceToken}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
    }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'host-validation-test', version: '1' } } }));
  });
  assert.equal(response.status, 200, response.body);
  const message = response.body.match(/^data: (.+)$/m)?.[1];
  assert.ok(message, response.body);
  assert.equal(JSON.parse(message).result.protocolVersion, '2025-11-25');
});

test('an injected authorizer adds restrictions and cannot replace deployment allow-list or OPA policy', async t => {
  let opaDecision = false, opaChecks = 0, applicationChecks = 0;
  const opa = express(); opa.use(express.json());
  opa.post('/decision', (_req, res) => { opaChecks++; res.json({ result: opaDecision }); });
  const opaUrl = await listen(opa, t);
  const alphaUrl = await listen(createModernDemoServer('alpha'), t);
  const betaUrl = await listen(createModernDemoServer('beta'), t);
  const config = {
    allowLocalHttp: true,
    clients: [{ id: 'agent', tokenEnv: 'SERVICE_TOKEN', allow: ['alpha__*'] }],
    upstreams: [{ id: 'alpha', url: `${alphaUrl}/mcp` }, { id: 'beta', url: `${betaUrl}/mcp` }]
  };
  const store = new SqliteStore(':memory:', config);
  t.after(() => store.close());
  const gatewayUrl = await listen(createRuntime(store, {
    adminKey: adminToken,
    environment: { SERVICE_TOKEN: serviceToken, OPA_DECISION_URL: `${opaUrl}/decision`, OPA_ALLOW_LOCAL_HTTP: 'true' },
    plugins: () => ({ authorizer: { async canCall() { applicationChecks++; return true; } } })
  }), t);
  const client = new Client({ name: 'authorizer-composition-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));

  assert.deepEqual((await client.listTools()).tools, [], 'an application plugin cannot override a deployment OPA denial');
  assert.ok(opaChecks > 0);
  assert.equal(applicationChecks, 0, 'the composed policy short-circuits after deployment denial');

  opaDecision = true;
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['alpha__echo'], 'the injected policy can add restrictions but the deployment allow-list still limits tools');
  assert.ok(applicationChecks > 0);
});

test('runtime extensions cannot weaken strict egress or replace deployment authentication and approval controls', async t => {
  let upstreamRequests = 0;
  const upstreamApp = express();
  upstreamApp.use((_req, _res, next) => { upstreamRequests++; next(); });
  upstreamApp.use(createModernDemoServer('private-upstream'));
  const upstreamUrl = await listen(upstreamApp, t);
  const egressConfig = {
    allowLocalHttp: true,
    clients: [{ id: 'agent', tokenEnv: 'SERVICE_TOKEN', allow: ['alpha__*'] }],
    upstreams: [{ id: 'alpha', url: `${upstreamUrl}/mcp` }]
  };
  const egressStore = new SqliteStore(':memory:', egressConfig);
  t.after(() => egressStore.close());
  const egressGateway = await listen(createRuntime(egressStore, {
    adminKey: adminToken,
    environment: { SERVICE_TOKEN: serviceToken, GATEWAY_REQUIRE_EGRESS_VALIDATION: 'true' },
    plugins: () => ({ egressPolicy: { allowedPrivateCidrs: ['127.0.0.0/8'] } })
  }), t);
  const egressClient = new Client({ name: 'strict-egress-merge-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  t.after(() => egressClient.close());
  await egressClient.connect(new StreamableHTTPClientTransport(new URL(`${egressGateway}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
  assert.deepEqual((await egressClient.listTools()).tools, [], 'application plugin cannot allow a loopback destination that deployment strict-egress policy denies');
  assert.equal(upstreamRequests, 0, 'the denied endpoint receives no connection');

  const conflicts = [
    {
      config: egressConfig,
      environment: { SERVICE_TOKEN: serviceToken, GATEWAY_RESOURCE_URL: 'https://gateway.example/mcp', JWT_ISSUER: 'https://issuer.example', JWT_AUDIENCE: 'gateway', JWT_JWKS_URL: 'https://issuer.example/keys' },
      plugins: () => ({ authenticator: { async authenticate() { return { id: 'agent', allow: ['alpha__*'] }; } } })
    },
    {
      config: { ...egressConfig, approvalRequiredTools: ['alpha__transfer'] },
      environment: { SERVICE_TOKEN: serviceToken, APPROVAL_DECISION_URL: 'https://approval.example/decide', APPROVAL_BEARER_TOKEN: 'approval-service-secret' },
      plugins: () => ({ approvalGate: { async requestOrConsume() { return { decision: 'allow' }; } } })
    }
  ];
  for (const conflict of conflicts) {
    const store = new SqliteStore(':memory:', conflict.config);
    t.after(() => store.close());
    const url = await listen(createRuntime(store, { adminKey: adminToken, environment: conflict.environment, plugins: conflict.plugins }), t);
    assert.equal((await fetch(`${url}/readyz`)).status, 503, 'a plugin conflict with a deployment security control must make the runtime unready');
  }
});
