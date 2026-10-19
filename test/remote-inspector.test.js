import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { RemoteInspector } from '../dist/remote-inspector.js';
import { createModernDemoServer } from '../dist/demo-modern.js';
import { createRuntime, environmentPlugins } from '../dist/runtime.js';
import { SqliteStore } from '../dist/store.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { adminToken, listen, serviceToken } from './helpers.js';

const inspectorToken = 'remote-inspection-service-credential';
const sampleContext = overrides => ({
  requestId: 'request-123',
  principal: { id: 'agent-7', tenantId: 'tenant-a', subject: 'user-11', roles: ['writer'], authScheme: 'api-key', token: serviceToken },
  requestedTool: 'public-transfer', upstreamId: 'payments', upstreamTool: 'transfer',
  arguments: { recipient: 'customer-1', amount: 12 }, signal: new AbortController().signal,
  ...overrides
});

async function service(t, decide) {
  const app = express(); app.use(express.json({ limit: '2mb' }));
  app.post('/inspect', (req, res) => decide(req, res));
  return listen(app, t);
}

test('environment-configured remote inspector receives only the documented identity and call/result snapshot', async t => {
  const upstream = await listen(createModernDemoServer('inspected'), t);
  const decisions = [];
  const endpoint = await service(t, (req, res) => {
    decisions.push({ body: req.body, authorization: req.headers.authorization });
    res.json({ decision: req.body.phase === 'afterCall' && req.body.arguments.text === 'deny marker' ? 'deny' : 'allow' });
  });
  const config = {
    allowLocalHttp: true,
    clients: [{ id: 'inspect-agent', tokenEnv: 'SERVICE_TOKEN', allow: ['alpha__echo'] }],
    upstreams: [{ id: 'alpha', url: `${upstream}/mcp` }]
  };
  let localInspectorCalls = 0;
  const store = new SqliteStore(':memory:', config); t.after(() => store.close());
  const gateway = await listen(createRuntime(store, { adminKey: adminToken, environment: {
    SERVICE_TOKEN: serviceToken,
    INSPECTOR_DECISION_URL: `${endpoint}/inspect`,
    INSPECTOR_BEARER_TOKEN: inspectorToken,
    INSPECTOR_TOOLS: 'alpha__echo',
    INSPECTOR_DATA_MODE: 'full',
    INSPECTOR_ALLOW_LOCAL_HTTP: 'true',
    GATEWAY_REQUIRE_EGRESS_VALIDATION: 'true',
    GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS: '127.0.0.1/32'
  }, plugins: () => ({ inspectors: [{ id: 'deployment-domain-check', beforeCall: context => { localInspectorCalls++; return context.arguments.text === 'local block' ? 'deny' : 'allow'; } }] }) }), t);
  const client = new Client({ name: 'remote-inspector-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
  t.after(() => client.close());
  const result = await client.callTool({ name: 'alpha__echo', arguments: { text: 'classified marker' } });
  assert.equal(result.content[0].text, 'inspected: classified marker');
  await assert.rejects(client.callTool({ name: 'alpha__echo', arguments: { text: 'deny marker' } }), /may already have completed|do not retry/i);
  await assert.rejects(client.callTool({ name: 'alpha__echo', arguments: { text: 'local block' } }), /unavailable|inspection/i);
  assert.deepEqual(decisions.map(entry => entry.body.phase), ['beforeCall', 'afterCall', 'beforeCall', 'afterCall']);
  assert.equal(localInspectorCalls, 3);
  assert.equal(JSON.stringify(decisions).includes('local block'), false);
  for (const { body, authorization } of decisions) {
    assert.equal(authorization, `Bearer ${inspectorToken}`);
    assert.equal(body.principal.id, 'inspect-agent');
    assert.deepEqual(body.principal, { id: 'inspect-agent' });
    assert.equal(JSON.stringify(body).includes(serviceToken), false);
    assert.equal(JSON.stringify(body).includes(inspectorToken), false);
    assert.equal(Object.hasOwn(body, 'headers'), false);
  }
  assert.deepEqual(decisions[0].body.arguments, { text: 'classified marker' });
  assert.equal(Object.hasOwn(decisions[0].body, 'result'), false);
  assert.deepEqual(decisions[1].body.result.content[0], { type: 'text', text: 'inspected: classified marker' });
  assert.deepEqual(decisions[3].body.result.content[0], { type: 'text', text: 'inspected: deny marker' });
});

test('remote inspector accepts only an exact allow decision and fails closed on malformed or redirected replies', async t => {
  const context = sampleContext();
  for (const response of [
    Response.json({ decision: 'allow', extra: true }),
    Response.json({ decision: true }),
    Response.json({ decision: 'ALLOW' }),
    Response.redirect('https://attacker.example/collect')
  ]) {
    const inspector = new RemoteInspector({ url: 'http://127.0.0.1/inspect', token: inspectorToken, tools: ['public-transfer'], allowLocalHttp: true, fetch: async () => response });
    assert.equal(await inspector.beforeCall(context), 'deny');
  }
  const allow = new RemoteInspector({ url: 'http://127.0.0.1/inspect', token: inspectorToken, tools: ['public-transfer'], allowLocalHttp: true, fetch: async () => Response.json({ decision: 'allow' }) });
  assert.equal(await allow.beforeCall(context), 'allow');
});

test('remote inspector denies oversized payloads before network transfer and cancels on deadline', async t => {
  let calls = 0;
  const tooLarge = new RemoteInspector({ url: 'http://127.0.0.1/inspect', token: inspectorToken, tools: ['public-transfer'], dataMode: 'full', allowLocalHttp: true, maxRequestBytes: 1024, fetch: async () => { calls++; return Response.json({ decision: 'allow' }); } });
  assert.equal(await tooLarge.beforeCall(sampleContext({ arguments: { secret: 'x'.repeat(2000) } })), 'deny');
  assert.equal(calls, 0);
  let aborted = false;
  const slow = new RemoteInspector({ url: 'http://127.0.0.1/inspect', token: inspectorToken, tools: ['public-transfer'], allowLocalHttp: true, timeoutMs: 10, fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(init.signal.reason); }, { once: true })) });
  const keepAlive = setInterval(() => {}, 1000);
  try { assert.equal(await slow.beforeCall(sampleContext()), 'deny'); }
  finally { clearInterval(keepAlive); }
  assert.equal(aborted, true);
});

test('remote inspector sends data only for explicitly selected public or physical tool names', async () => {
  let calls = 0;
  const inspector = new RemoteInspector({ url: 'http://127.0.0.1/inspect', token: inspectorToken, tools: ['payments__*'], allowLocalHttp: true, fetch: async () => { calls++; return Response.json({ decision: 'allow' }); } });
  const otherTool = sampleContext({ requestedTool: 'search', upstreamId: 'catalog', upstreamTool: 'search' });
  assert.equal(await inspector.beforeCall(otherTool), 'allow');
  assert.equal(calls, 0);
  const publicAlias = sampleContext({ requestedTool: 'transfer', upstreamId: 'payments', upstreamTool: 'transfer' });
  assert.equal(await inspector.beforeCall(publicAlias), 'allow');
  assert.equal(calls, 1);
});

test('remote inspector identity fields default to data-minimized identifiers and require explicit opt-in', async () => {
  const requests = [];
  const send = inspector => inspector.beforeCall(sampleContext({ principal: { id: 'agent-7', tenantId: 'tenant-a', subject: 'person@example.test', roles: ['finance-admin'], authScheme: 'jwt' } }));
  const defaults = new RemoteInspector({ url: 'http://127.0.0.1/inspect', token: inspectorToken, tools: ['public-transfer'], allowLocalHttp: true, fetch: async (_url, init) => { requests.push(JSON.parse(init.body)); return Response.json({ decision: 'allow' }); } });
  assert.equal(await send(defaults), 'allow');
  assert.deepEqual(requests[0].principal, { id: 'agent-7', tenantId: 'tenant-a' });
  const explicit = new RemoteInspector({ url: 'http://127.0.0.1/inspect', token: inspectorToken, tools: ['public-transfer'], identityFields: ['id', 'subject'], allowLocalHttp: true, fetch: async (_url, init) => { requests.push(JSON.parse(init.body)); return Response.json({ decision: 'allow' }); } });
  assert.equal(await send(explicit), 'allow');
  assert.deepEqual(requests[1].principal, { id: 'agent-7', subject: 'person@example.test' });
  assert.throws(() => new RemoteInspector({ url: 'http://127.0.0.1/inspect', token: inspectorToken, tools: ['public-transfer'], identityFields: ['subject'], allowLocalHttp: true }), /identity fields/i);
  assert.throws(() => new RemoteInspector({ url: 'http://127.0.0.1/inspect', token: inspectorToken, tools: ['public-transfer'], identityFields: ['id', 'subject', 'subject'], allowLocalHttp: true }), /identity fields/i);
});

test('remote inspector endpoint and bearer destination must be exactly bound in strict mode', async t => {
  let observed, observedBody;
  const endpoint = await service(t, (req, res) => { observed = req.headers.authorization; observedBody = req.body; res.json({ decision: 'allow' }); });
  const config = { allowLocalHttp: true, clients: [], upstreams: [{ id: 'alpha', url: 'http://127.0.0.1:3000/mcp' }] };
  const env = { INSPECTOR_DECISION_URL: `${endpoint}/inspect`, INSPECTOR_BEARER_TOKEN: inspectorToken, INSPECTOR_TOOLS: 'payments__*', INSPECTOR_ALLOW_LOCAL_HTTP: 'true', GATEWAY_REQUIRE_CREDENTIAL_BINDINGS: 'true', GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS: '127.0.0.1/32', GATEWAY_CREDENTIAL_BINDINGS: '[]' };
  const unscoped = { ...env }; delete unscoped.INSPECTOR_TOOLS;
  assert.throws(() => environmentPlugins(config, unscoped), /tool allowlist/i);
  assert.throws(() => environmentPlugins(config, env), /destination is not approved/i);
  env.GATEWAY_CREDENTIAL_BINDINGS = JSON.stringify([
    { reference: 'INSPECTOR_DECISION_URL', endpoint: `${endpoint}/inspect`, purpose: 'inspection-service' },
    { reference: 'INSPECTOR_BEARER_TOKEN', endpoint: `${endpoint}/inspect`, purpose: 'inspection-service' }
  ]);
  const plugins = environmentPlugins(config, env);
  assert.equal(plugins.inspectors.length, 1);
  assert.ok(plugins.inspectors[0] instanceof RemoteInspector);
  // The default sends metadata only; full payload transfer needs an explicit
  // deployment-owned setting. The client token is never sent to the service.
  const decision = await plugins.inspectors[0].beforeCall(sampleContext());
  assert.equal(decision, 'allow');
  assert.equal(observed, `Bearer ${inspectorToken}`);
  assert.deepEqual(observedBody.principal, { id: 'agent-7', tenantId: 'tenant-a' });
  assert.equal(Object.hasOwn(observedBody, 'arguments'), false);
  env.INSPECTOR_DATA_MODE = 'full';
  const fullPayload = environmentPlugins(config, env);
  assert.equal(await fullPayload.inspectors[0].beforeCall(sampleContext()), 'allow');
  assert.deepEqual(observedBody.arguments, { recipient: 'customer-1', amount: 12 });
  env.INSPECTOR_DATA_MODE = 'unknown';
  assert.throws(() => environmentPlugins(config, env), /data mode/i);
  delete env.INSPECTOR_DATA_MODE;
  env.INSPECTOR_IDENTITY_FIELDS = 'id,subject';
  const explicitlyScoped = environmentPlugins(config, env);
  assert.equal(await explicitlyScoped.inspectors[0].beforeCall(sampleContext()), 'allow');
  assert.deepEqual(observedBody.principal, { id: 'agent-7', subject: 'user-11' });
  env.INSPECTOR_IDENTITY_FIELDS = 'id,id';
  assert.throws(() => environmentPlugins(config, env), /identity fields/i);
});
