import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Server, createMcpHandler, inputRequired } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createGateway } from '../dist/gateway.js';
import { SqliteStore } from '../dist/store.js';
import { RemoteRouter } from '../dist/remote-router.js';
import { createRuntime, environmentPlugins } from '../dist/runtime.js';
import { createModernDemoServer } from '../dist/demo-modern.js';
import { adminToken, listen, serviceToken } from './helpers.js';

const routerToken = 'remote-router-service-credential';
const configFor = (alpha, beta, options = {}) => ({
  allowLocalHttp: true,
  clients: [{ id: 'routing-agent', token: serviceToken, allow: ['echo'], ...options.client }],
  upstreams: [{ id: 'alpha', url: `${alpha}/mcp` }, { id: 'beta', url: `${beta}/mcp` }],
  routes: [{ name: 'echo', strategy: 'priority', ...options.route, targets: options.targets ?? [{ upstreamId: 'alpha', tool: 'echo' }, { upstreamId: 'beta', tool: 'echo' }] }]
});

async function mcpClient(url, t) {
  const client = new Client({ name: 'remote-router-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
  t.after(() => client.close());
  return client;
}

async function decisionServer(t, decide) {
  const app = express(); app.use(express.json({ limit: '64kb' }));
  app.post('/decide', (req, res) => decide(req, res));
  return listen(app, t);
}

test('out-of-process router selects only from the identity-filtered target pool and receives no credentials or arguments', async t => {
  const alpha = await listen(createModernDemoServer('alpha'), t), beta = await listen(createModernDemoServer('beta'), t);
  let decision;
  const service = await decisionServer(t, (req, res) => {
    decision = { body: req.body, authorization: req.headers.authorization };
    res.json({ target: { upstreamId: 'beta', tool: 'echo' } });
  });
  const config = {
    allowLocalHttp: true,
    clients: [{ id: 'routing-agent', tokenEnv: 'SERVICE_TOKEN', allow: ['echo'] }],
    upstreams: [{ id: 'alpha', url: `${alpha}/mcp` }, { id: 'beta', url: `${beta}/mcp` }],
    routes: [{ name: 'echo', strategy: 'priority', targets: [{ upstreamId: 'alpha', tool: 'echo' }, { upstreamId: 'beta', tool: 'echo' }] }]
  };
  const store = new SqliteStore(':memory:', config); t.after(() => store.close());
  const gateway = await listen(createRuntime(store, { adminKey: adminToken, environment: {
    SERVICE_TOKEN: serviceToken,
    ROUTER_DECISION_URL: `${service}/decide`,
    ROUTER_BEARER_TOKEN: routerToken,
    ROUTER_ALLOW_LOCAL_HTTP: 'true'
  } }), t);
  const client = await mcpClient(gateway, t);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['echo']);
  const preview = await fetch(`${gateway}/admin/api/resolve`, {
    method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'routing-agent', tool: 'echo' })
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), { revision: 1, authorized: true, routable: true, upstreamId: 'beta', upstreamTool: 'echo', reason: 'Policy granted; configured target selected' });
  const result = await client.callTool({ name: 'echo', arguments: { text: 'private tool input' } });
  assert.equal(result.content[0].text, 'beta: private tool input');
  assert.equal(decision.authorization, `Bearer ${routerToken}`);
  assert.deepEqual(Object.keys(decision.body).sort(), ['candidates', 'principal', 'requestId', 'route']);
  assert.deepEqual(decision.body.candidates.map(({ upstreamId, tool }) => [upstreamId, tool]), [['alpha', 'echo'], ['beta', 'echo']]);
  assert.deepEqual(decision.body.principal, { id: 'routing-agent', authScheme: 'api-key' });
  assert.equal(JSON.stringify(decision.body).includes(serviceToken), false);
  assert.equal(JSON.stringify(decision.body).includes('private tool input'), false);
  assert.equal(JSON.stringify(decision.body).includes('http://'), false);
});

test('remote router filters disabled and foreign-tenant targets before calling its service', async t => {
  const alpha = await listen(createModernDemoServer('alpha'), t), beta = await listen(createModernDemoServer('beta'), t);
  let calls = 0, candidatePool;
  const service = await decisionServer(t, (req, res) => {
    calls++; candidatePool = req.body.candidates;
    res.json({ target: { upstreamId: 'beta', tool: 'echo' } });
  });
  const config = configFor(alpha, beta, { client: { tenantId: 'tenant-a' }, targets: [
    { upstreamId: 'alpha', tool: 'echo' },
    { upstreamId: 'beta', tool: 'echo', enabled: false },
  ] });
  // Even a malicious remote decision cannot select beta: it was disabled in
  // the admin pool and is also rejected by the local route-target guard.
  config.upstreams[0].tenantId = 'tenant-a';
  config.upstreams[1].tenantId = 'tenant-b';
  const router = new RemoteRouter(config, { url: `${service}/decide`, token: routerToken, allowLocalHttp: true });
  const principal = { id: 'routing-agent', tenantId: 'tenant-a', allow: ['echo'] };
  assert.equal(await router.resolve('echo', { principal, requestId: 'test-request' }), undefined);
  assert.equal(calls, 1);
  assert.deepEqual(candidatePool.map(({ upstreamId }) => upstreamId), ['alpha']);
});

test('remote router uses the strict DNS-pinned transport for an explicitly approved private endpoint', async t => {
  const alpha = await listen(createModernDemoServer('alpha'), t), beta = await listen(createModernDemoServer('beta'), t);
  const config = configFor(alpha, beta);
  const service = await decisionServer(t, (_req, res) => res.json({ target: { upstreamId: 'alpha', tool: 'echo' } }));
  const router = new RemoteRouter(config, {
    url: `${service}/decide`, token: routerToken, allowLocalHttp: true,
    egressPolicy: { allowedPrivateCidrs: ['127.0.0.1/32'], resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }] }
  });
  const route = await router.resolve('echo', { principal: { id: 'routing-agent' }, requestId: 'strict-egress' });
  assert.equal(route.upstream.id, 'alpha');
});

test('sealed tool continuations reuse their authorized route without a second remote decision', async t => {
  const upstreamApp = express(); upstreamApp.use(express.json());
  const upstreamHandler = toNodeHandler(createMcpHandler(() => {
    const server = new Server({ name: 'continuation-upstream', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'confirm', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }));
    server.setRequestHandler('tools/call', async (_request, context) => context.mcpReq.inputResponses?.confirm?.action === 'accept'
      ? { content: [{ type: 'text', text: 'completed' }] }
      : inputRequired({ requestState: 'private-state', inputRequests: { confirm: inputRequired.elicit({ message: 'Confirm action', requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] } }) } }));
    return server;
  }));
  upstreamApp.all('/mcp', (req, res) => void upstreamHandler(req, res, req.body));
  const upstream = await listen(upstreamApp, t);
  let decisions = 0;
  const service = await decisionServer(t, (_req, res) => { decisions++; res.json({ target: { upstreamId: 'alpha', tool: 'confirm' } }); });
  const stateKey = 'remote-router-continuation-state-key-32-bytes-minimum';
  const config = {
    allowLocalHttp: true, features: { callbacks: true },
    clients: [{ id: 'callback-agent', token: serviceToken, allow: ['confirm'], callbackMethods: ['elicitation/create'] }],
    upstreams: [{ id: 'alpha', url: `${upstream}/mcp` }],
    routes: [{ name: 'confirm', strategy: 'priority', targets: [{ upstreamId: 'alpha', tool: 'confirm' }] }]
  };
  const router = new RemoteRouter(config, { url: `${service}/decide`, token: routerToken, allowLocalHttp: true });
  const first = await listen(createGateway(config, { router, stateKey }), t), second = await listen(createGateway(config, { router, stateKey }), t);
  const capabilities = { elicitation: { form: {} } };
  const connect = async url => {
    const client = new Client({ name: 'continuation-client', version: '1' }, { capabilities, versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
    t.after(() => client.close()); return client;
  };
  const one = await connect(first), two = await connect(second);
  const pending = await one.request({ method: 'tools/call', params: { name: 'confirm', arguments: { text: 'approved' } } }, { allowInputRequired: true });
  assert.equal(pending.resultType, 'input_required');
  assert.equal(decisions, 1);
  const complete = await two.request({ method: 'tools/call', params: { name: 'confirm', arguments: { text: 'approved' }, requestState: pending.requestState, inputResponses: { confirm: { action: 'accept', content: { confirm: true } } } } });
  assert.equal(complete.content[0].text, 'completed');
  assert.equal(decisions, 1);
});

test('remote router fails closed on unconfigured targets, redirects, malformed data and timeouts', async t => {
  const alpha = await listen(createModernDemoServer('alpha'), t), beta = await listen(createModernDemoServer('beta'), t);
  const config = configFor(alpha, beta, { targets: [{ upstreamId: 'alpha', tool: 'echo' }] });
  const context = { principal: { id: 'routing-agent', allow: ['echo'] }, requestId: 'test-request' };
  const outsider = new RemoteRouter(config, { url: 'http://127.0.0.1/decide', token: routerToken, allowLocalHttp: true, fetch: async () => Response.json({ target: { upstreamId: 'beta', tool: 'echo' } }) });
  assert.equal(await outsider.resolve('echo', context), undefined);
  const malformed = new RemoteRouter(config, { url: 'http://127.0.0.1/decide', token: routerToken, allowLocalHttp: true, fetch: async () => Response.json({ target: { upstreamId: 'alpha', tool: 'echo' }, allow: true }) });
  assert.equal(await malformed.resolve('echo', context), undefined);
  const redirect = new RemoteRouter(config, { url: 'http://127.0.0.1/decide', token: routerToken, allowLocalHttp: true, fetch: async () => Response.redirect('http://attacker.example/collect') });
  assert.equal(await redirect.resolve('echo', context), undefined);
  const timeout = new RemoteRouter(config, { url: 'http://127.0.0.1/decide', token: routerToken, timeoutMs: 20, allowLocalHttp: true, fetch: (_url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })) });
  assert.equal(await timeout.resolve('echo', context), undefined);
});

test('remote router does not call external services for selector-ineligible principals or physical names', async t => {
  const alpha = await listen(createModernDemoServer('alpha'), t), beta = await listen(createModernDemoServer('beta'), t);
  let calls = 0;
  const service = await decisionServer(t, (_req, res) => { calls++; res.json({ target: { upstreamId: 'alpha', tool: 'echo' } }); });
  const config = configFor(alpha, beta, { route: { clients: ['approved-agent'] } });
  const router = new RemoteRouter(config, { url: `${service}/decide`, token: routerToken, allowLocalHttp: true });
  assert.equal(await router.resolve('echo', { principal: { id: 'other-agent' }, requestId: 'route' }), undefined);
  assert.equal((await router.resolve('alpha__echo', { principal: { id: 'other-agent' }, requestId: 'physical' })).upstream.id, 'alpha');
  assert.equal(calls, 0);
});

test('environment configuration pins the remote router credential to its exact decision endpoint', () => {
  const config = { allowLocalHttp: true, clients: [], upstreams: [{ id: 'alpha', url: 'http://127.0.0.1:34567/mcp' }] };
  const url = 'http://127.0.0.1:34568/decide';
  const env = { ROUTER_DECISION_URL: url, ROUTER_BEARER_TOKEN: routerToken, ROUTER_ALLOW_LOCAL_HTTP: 'true', GATEWAY_REQUIRE_CREDENTIAL_BINDINGS: 'true', GATEWAY_CREDENTIAL_BINDINGS: '[]' };
  assert.throws(() => environmentPlugins(config, env), /destination is not approved/i);
  env.GATEWAY_CREDENTIAL_BINDINGS = JSON.stringify([
    { reference: 'ROUTER_DECISION_URL', endpoint: url, purpose: 'routing-service' },
    { reference: 'ROUTER_BEARER_TOKEN', endpoint: url, purpose: 'routing-service' }
  ]);
  assert.ok(environmentPlugins(config, env).router instanceof RemoteRouter);
});
