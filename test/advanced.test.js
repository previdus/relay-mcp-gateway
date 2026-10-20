import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { Server, createMcpHandler, inputRequired, UriTemplate } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createGateway } from '../dist/gateway.js';
import { SchemaPool } from '../dist/schema-pool.js';
import { createModernDemoServer } from '../dist/demo-modern.js';
import { templateUri } from '../dist/resource-names.js';
import { listen, serviceToken } from './helpers.js';
import { OAuthCredentialProvider } from '../dist/credentials.js';
import { createUpstreamTransport } from '../dist/transports.js';
import { fileURLToPath } from 'node:url';
const stateKey = 'shared-continuation-key-at-least-32-characters';
async function clientFor(url, t, token = serviceToken, capabilities = {}) {
  const client = new Client({ name: 'advanced', version: '1' }, { capabilities, versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close()); return client;
}
function fixture(factory) { const app = express(); app.use(express.json()); const handler = toNodeHandler(createMcpHandler(factory)); app.all('/mcp', (req, res) => void handler(req, res, req.body)); return app; }
test('schema workers terminate a pathological regex and recover without blocking HTTP', async t => {
  const pool = new SchemaPool(1); t.after(() => pool.close());
  assert.equal((await pool.validate({ type: 'string' }, 'warm')).valid, true);
  const started = Date.now();
  const attack = pool.validate({ type: 'string', pattern: '^(a+)+$' }, `${'a'.repeat(100)}!`, 150);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(Date.now() - started < 120);
  assert.equal((await attack).valid, false);
  assert.equal((await pool.validate({ type: 'number' }, 42)).valid, true);
});
test('tenant discovery and calls remain isolated even with broad grants and a custom router', async t => {
  const a = await listen(createModernDemoServer('a'), t), b = await listen(createModernDemoServer('b'), t);
  const config = { allowLocalHttp: true, clients: [{ id: 'tenant-a-user', tenantId: 'a', token: serviceToken, allow: ['a__*', 'b__*'] }], upstreams: [{ id: 'a', tenantId: 'a', url: `${a}/mcp` }, { id: 'b', tenantId: 'b', url: `${b}/mcp` }] };
  const url = await listen(createGateway(config), t), client = await clientFor(url, t);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['a__echo']);
  await assert.rejects(client.callTool({ name: 'b__echo', arguments: { text: 'cross-tenant' } }), /forbidden/);
  const forged = await listen(createGateway(config, { router: { names: () => ['a__echo'], resolve: () => ({ upstream: config.upstreams[1], tool: 'echo' }) } }), t);
  await assert.rejects((await clientFor(forged, t)).callTool({ name: 'a__echo', arguments: { text: 'forged' } }), /Unregistered/);
});
test('custom routers cannot remap an authorized physical tool to another same-tenant upstream', async t => {
  const a = await listen(createModernDemoServer('alpha'), t), b = await listen(createModernDemoServer('beta'), t);
  const config = {
    allowLocalHttp: true,
    clients: [{ id: 'same-tenant-agent', tenantId: 'shared', token: serviceToken, allow: ['alpha__echo'] }],
    upstreams: [{ id: 'alpha', tenantId: 'shared', url: `${a}/mcp` }, { id: 'beta', tenantId: 'shared', url: `${b}/mcp` }],
  };
  const gateway = await listen(createGateway(config, { router: {
    names: (upstreamId, tool) => upstreamId === 'alpha' ? [`${upstreamId}__${tool}`] : [],
    resolve: () => ({ upstream: config.upstreams[1], tool: 'echo' }),
  } }), t);
  const client = await clientFor(gateway, t);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['alpha__echo']);
  await assert.rejects(client.callTool({ name: 'alpha__echo', arguments: { text: 'must not reach beta' } }), /route target is not configured/i);
});
test('custom routers may select any enabled target in the administrator-configured alias pool', async t => {
  const a = await listen(createModernDemoServer('alpha'), t), b = await listen(createModernDemoServer('beta'), t);
  const config = {
    allowLocalHttp: true,
    clients: [{ id: 'route-agent', token: serviceToken, allow: ['echo'] }],
    upstreams: [{ id: 'alpha', url: `${a}/mcp` }, { id: 'beta', url: `${b}/mcp` }],
    routes: [{ name: 'echo', strategy: 'priority', targets: [{ upstreamId: 'alpha', tool: 'echo' }, { upstreamId: 'beta', tool: 'echo' }] }],
  };
  const gateway = await listen(createGateway(config, { router: {
    names: (_upstreamId, tool) => tool === 'echo' ? ['echo'] : [],
    resolve: () => ({ upstream: config.upstreams[1], tool: 'echo' }),
  } }), t);
  const client = await clientFor(gateway, t);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['echo']);
  assert.equal((await client.callTool({ name: 'echo', arguments: { text: 'approved target' } })).content[0].text, 'beta: approved target');
});
test('credential plugin receives the authenticated principal and scopes dynamic upstream TLS to the selected transport', async t => {
  const cert = await readFile(fileURLToPath(new URL('./fixtures/mtls-test-cert.pem', import.meta.url)));
  const key = await readFile(fileURLToPath(new URL('./fixtures/mtls-test-key.pem', import.meta.url)));
  const upstreamServer = https.createServer({ cert, key, ca: cert, requestCert: true, rejectUnauthorized: true }, createModernDemoServer('credential-plugin'));
  upstreamServer.listen(0, '127.0.0.1'); await once(upstreamServer, 'listening');
  t.after(() => new Promise(resolve => upstreamServer.close(resolve)));
  const upstreamUrl = `https://localhost:${upstreamServer.address().port}`;
  const clientIdentity = { id: 'tls-agent', token: serviceToken, allow: ['alpha__echo'] };
  const config = { clients: [clientIdentity], upstreams: [{ id: 'alpha', url: `${upstreamUrl}/mcp` }] };
  const tls = { cert: cert.toString(), key: key.toString(), ca: cert.toString() };
  let tlsIdentity, requestedHeaders;
  const gateway = await listen(createGateway(config, {
    credentials: {
      async tls(upstream, principal) { assert.equal(upstream.id, 'alpha'); assert.equal(principal?.id, 'tls-agent'); return tls; },
      async headers(upstream, principal, subjectToken, tls) { requestedHeaders = { upstream: upstream.id, principal: principal?.id, subjectToken, tls }; return {}; }
    },
    transportFactory(upstream, context) {
      assert.equal(upstream.id, 'alpha');
      assert.equal(context?.principal?.id, 'tls-agent');
      tlsIdentity = context?.tls;
      return createUpstreamTransport(upstream, {}, undefined, undefined, context?.tls);
    }
  }), t);
  const client = await clientFor(gateway, t);
  assert.equal((await client.callTool({ name: 'alpha__echo', arguments: { text: 'delegated identity' } })).content[0].text, 'credential-plugin: delegated identity');
  assert.deepEqual(requestedHeaders, { upstream: 'alpha', principal: 'tls-agent', subjectToken: undefined, tls });
  assert.deepEqual(tlsIdentity, tls);
});
test('routed alias invocation rechecks every live target contract after discovery', async t => {
  const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
  const alpha = { schema: structuredClone(schema), calls: 0, available: true }, beta = { schema: structuredClone(schema), calls: 0, available: true };
  const makeUpstream = (name, state) => fixture(() => {
    const server = new Server({ name, version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => { if (!state.available) throw new Error('temporarily unavailable'); return { tools: [{ name: 'echo', description: 'Echo text', inputSchema: state.schema }] }; });
    server.setRequestHandler('tools/call', async ({ params }) => { state.calls++; return { content: [{ type: 'text', text: `${name}: ${params.arguments.text}` }] }; });
    return server;
  });
  const alphaUrl = await listen(makeUpstream('alpha', alpha), t), betaUrl = await listen(makeUpstream('beta', beta), t);
  const config = { allowLocalHttp: true, clients: [{ id: 'agent', token: serviceToken, allow: ['echo'] }], upstreams: [{ id: 'alpha', url: `${alphaUrl}/mcp` }, { id: 'beta', url: `${betaUrl}/mcp` }], routes: [{ name: 'echo', strategy: 'priority', targets: [{ upstreamId: 'alpha', tool: 'echo' }, { upstreamId: 'beta', tool: 'echo' }] }] };
  const gateway = await listen(createGateway(config), t), client = await clientFor(gateway, t);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['echo']);
  beta.schema = { type: 'object', properties: { text: { type: 'number' } }, required: ['text'] };
  await assert.rejects(client.callTool({ name: 'echo', arguments: { text: 'must not execute' } }), /contract/i);
  assert.equal(alpha.calls + beta.calls, 0, 'no backend executes when any eligible contract has drifted');
  beta.schema = structuredClone(schema);
  beta.available = false;
  await assert.rejects(client.callTool({ name: 'echo', arguments: { text: 'must remain unavailable' } }), /contract/i);
  assert.equal(alpha.calls + beta.calls, 0, 'no backend executes when an eligible target cannot be checked');
});
test('custom routers cannot select disabled alias targets', async t => {
  const a = await listen(createModernDemoServer('alpha'), t), b = await listen(createModernDemoServer('beta'), t);
  const config = {
    allowLocalHttp: true,
    clients: [{ id: 'route-agent', token: serviceToken, allow: ['echo'] }],
    upstreams: [{ id: 'alpha', url: `${a}/mcp` }, { id: 'beta', url: `${b}/mcp` }],
    routes: [{ name: 'echo', strategy: 'priority', targets: [{ upstreamId: 'alpha', tool: 'echo' }, { upstreamId: 'beta', tool: 'echo', enabled: false }] }],
  };
  const gateway = await listen(createGateway(config, { router: {
    names: (_upstreamId, tool) => tool === 'echo' ? ['echo'] : [],
    resolve: () => ({ upstream: config.upstreams[1], tool: 'echo' }),
  } }), t);
  const client = await clientFor(gateway, t);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['echo']);
  await assert.rejects(client.callTool({ name: 'echo', arguments: { text: 'disabled target' } }), /route target is not configured/i);
});
test('custom routers do not expose aliases to principals outside configured route selectors', async t => {
  const upstream = await listen(createModernDemoServer('alpha'), t);
  const config = {
    allowLocalHttp: true,
    clients: [{ id: 'unapproved-agent', token: serviceToken, allow: ['echo'] }],
    upstreams: [{ id: 'alpha', url: `${upstream}/mcp` }],
    routes: [{ name: 'echo', strategy: 'priority', clients: ['approved-agent'], targets: [{ upstreamId: 'alpha', tool: 'echo' }] }],
  };
  const gateway = await listen(createGateway(config, { router: {
    names: (_upstreamId, tool) => tool === 'echo' ? ['echo'] : [],
    resolve: () => ({ upstream: config.upstreams[0], tool: 'echo' }),
  } }), t);
  const client = await clientFor(gateway, t);
  assert.deepEqual((await client.listTools()).tools, []);
  await assert.rejects(client.callTool({ name: 'echo', arguments: { text: 'selector bypass' } }), /route target is not configured/i);
});
test('modern MRTR crosses replicas with sealed route state, reauthorization and tamper rejection', async t => {
  let completions = 0;
  const upstream = await listen(fixture(() => {
    const server = new Server({ name: 'callback-server', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'confirm', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }));
    server.setRequestHandler('tools/call', async ({ params }, ctx) => {
      if (ctx.mcpReq.inputResponses?.confirm?.action === 'accept') {
        completions++;
        assert.equal(ctx.mcpReq.requestState(), 'secret-backend-state');
        return { content: [{ type: 'text', text: `confirmed ${params.arguments.text}` }] };
      }
      return inputRequired({ requestState: 'secret-backend-state', inputRequests: { confirm: inputRequired.elicit({ message: 'Confirm operation', requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] } }) } });
    }); return server;
  }), t);
  const config = { allowLocalHttp: true, features: { callbacks: true }, clients: [{ id: 'user1', token: serviceToken, allow: ['a__*'], callbackMethods: ['elicitation/create'] }, { id: 'user2', token: `${serviceToken}-other`, allow: ['a__*'], callbackMethods: ['elicitation/create'] }], upstreams: [{ id: 'a', url: `${upstream}/mcp` }] };
  const first = await listen(createGateway(config, { stateKey }), t), second = await listen(createGateway(config, { stateKey }), t);
  const capabilities = { elicitation: { form: {} } };
  const one = await clientFor(first, t, serviceToken, capabilities), two = await clientFor(second, t, serviceToken, capabilities);
  const pending = await one.request({ method: 'tools/call', params: { name: 'a__confirm', arguments: { text: 'original' } } }, { allowInputRequired: true });
  assert.equal(pending.resultType, 'input_required'); assert.ok(pending.requestState);
  const retry = { name: 'a__confirm', arguments: { text: 'original' }, requestState: pending.requestState, inputResponses: { confirm: { action: 'accept', content: { confirm: true } } } };
  const done = await two.request({ method: 'tools/call', params: retry });
  assert.equal(done.content[0].text, 'confirmed original');
  const tamperedState = `${pending.requestState[0] === 'x' ? 'y' : 'x'}${pending.requestState.slice(1)}`;
  await assert.rejects(two.request({ method: 'tools/call', params: { ...retry, requestState: tamperedState } }), /continuation/i);
  await assert.rejects(two.request({ method: 'tools/call', params: { ...retry, arguments: { text: 'changed' } } }), /match/);
  const other = await clientFor(second, t, `${serviceToken}-other`, capabilities);
  await assert.rejects(other.request({ method: 'tools/call', params: retry }), /continuation/i);
  const restricted = await listen(createGateway({ ...config, invocationPolicies: { a__confirm: { allow: [] } } }, { stateKey }), t);
  const restrictedClient = await clientFor(restricted, t, serviceToken, capabilities);
  await assert.rejects(restrictedClient.request({ method: 'tools/call', params: retry }), /argument policy/);
  assert.equal(completions, 1, 'changed policy must block an already issued continuation');
  const inspected = await listen(createGateway(config, { stateKey, inspectors: [{ id: 'pending-review', afterCall: ({ result }) => result.resultType === 'input_required' ? 'deny' : 'allow' }] }), t);
  const inspectedClient = await clientFor(inspected, t, serviceToken, capabilities);
  await assert.rejects(inspectedClient.request({ method: 'tools/call', params: { name: 'a__confirm', arguments: { text: 'untrusted prompt must not pass' } } }, { allowInputRequired: true }), /Result withheld/);
  assert.equal(completions, 1);
});
test('modern MRTR continuation cannot cross subjects sharing the same client and tenant', async t => {
  let completions = 0;
  const upstream = await listen(fixture(() => {
    const server = new Server({ name: 'subject-bound-callback', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'confirm', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }));
    server.setRequestHandler('tools/call', async ({ params }, ctx) => {
      if (ctx.mcpReq.inputResponses?.confirm?.action === 'accept') { completions++; return { content: [{ type: 'text', text: `confirmed ${params.arguments.text}` }] }; }
      return inputRequired({ requestState: 'subject-bound-state', inputRequests: { confirm: inputRequired.elicit({ message: 'Confirm operation', requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] } }) } });
    });
    return server;
  }), t);
  const authenticate = async token => token === serviceToken
    ? { id: 'shared-agent', tenantId: 'team-a', subject: 'alice', allow: ['a__*'], callbackMethods: ['elicitation/create'] }
    : token === `${serviceToken}-bob`
      ? { id: 'shared-agent', tenantId: 'team-a', subject: 'bob', allow: ['a__*'], callbackMethods: ['elicitation/create'] }
      : undefined;
  const gateway = await listen(createGateway({ allowLocalHttp: true, features: { callbacks: true }, clients: [{ id: 'placeholder', token: serviceToken, allow: ['a__*'] }], upstreams: [{ id: 'a', tenantId: 'team-a', url: `${upstream}/mcp` }] }, { stateKey, authenticator: { authenticate } }), t);
  const capabilities = { elicitation: { form: {} } };
  const alice = await clientFor(gateway, t, serviceToken, capabilities), bob = await clientFor(gateway, t, `${serviceToken}-bob`, capabilities);
  const pending = await alice.request({ method: 'tools/call', params: { name: 'a__confirm', arguments: { text: 'private operation' } } }, { allowInputRequired: true });
  assert.equal(pending.resultType, 'input_required');
  const retry = { name: 'a__confirm', arguments: { text: 'private operation' }, requestState: pending.requestState, inputResponses: { confirm: { action: 'accept', content: { confirm: true } } } };
  await assert.rejects(bob.request({ method: 'tools/call', params: retry }), /continuation/i);
  assert.equal(completions, 0, 'a different subject with the same client ID and tenant cannot resume the operation');
});
test('resource templates preserve variable expansion and completion enforces permissions', async t => {
  const upstream = await listen(fixture(() => {
    const server = new Server({ name: 'templates', version: '1' }, { capabilities: { resources: {}, prompts: {}, completions: {}, tools: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: [] }));
    server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [{ name: 'Note', uriTemplate: 'notes://{id}{?format}' }] }));
    server.setRequestHandler('resources/read', async ({ params }) => ({ contents: [{ uri: params.uri, text: params.uri }] }));
    server.setRequestHandler('completion/complete', async ({ params }) => { assert.equal(params.ref.uri, 'notes://{id}{?format}'); return { completion: { values: ['one', 'two'], total: 2 } }; });
    return server;
  }), t);
  const config = { allowLocalHttp: true, features: { resources: true }, clients: [{ id: 'user1', token: serviceToken, allow: [], permissions: { resources: ['a__notes://{id}{?format}'] } }], upstreams: [{ id: 'a', url: `${upstream}/mcp` }] };
  const client = await clientFor(await listen(createGateway(config), t), t);
  const template = (await client.listResourceTemplates()).resourceTemplates[0].uriTemplate;
  const uri = new UriTemplate(template).expand({ id: 'hello world', format: 'text' });
  assert.equal((await client.readResource({ uri })).contents[0].text, 'notes://hello%20world?format=text');
  const ref = templateUri('a', 'notes://{id}{?format}');
  assert.equal((await client.complete({ ref: { type: 'ref/resource', uri: ref }, argument: { name: 'id', value: '' } })).completion.total, 2);
});
test('stdio worker forwards only explicitly configured credentials', async t => {
  process.env.NOT_ALLOWED_PARENT_SECRET = 'must-not-be-inherited'; t.after(() => { delete process.env.NOT_ALLOWED_PARENT_SECRET; });
  const upstream = { id: 'local', url: 'stdio://local', transport: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('../dist/demo-stdio.js', import.meta.url))], environment: { EXPLICIT_SECRET: 'configured-secret' } };
  const url = await listen(createGateway({ clients: [{ id: 'user1', token: serviceToken, allow: ['local__*'] }], upstreams: [upstream] }), t);
  const client = await clientFor(url, t);
  assert.equal((await client.listTools()).tools[0].name, 'local__echo');
  const result = JSON.parse((await client.callTool({ name: 'local__echo', arguments: { text: 'stdio' } })).content[0].text);
  assert.deepEqual(result, { text: 'stdio', explicit: 'configured-secret', inherited: false });
});
test('delegated OAuth exchange is isolated by subject and never passes the inbound token to the backend', async t => {
  const grants = [], grantAuthorization = [], authorization = [];
  const identity = express(); identity.use(express.urlencoded({ extended: false }));
  identity.post('/token', (req, res) => { grants.push(req.body); grantAuthorization.push(req.get('authorization')); res.json({ access_token: `exchanged-${req.body.subject_token}`, token_type: 'Bearer', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', expires_in: 300 }); });
  const issuer = await listen(identity, t);
  const backend = express(); backend.use((req, _res, next) => { authorization.push(req.headers.authorization); next(); }); backend.use(createModernDemoServer('delegated'));
  const upstreamUrl = await listen(backend, t);
  const upstream = { id: 'a', url: `${upstreamUrl}/mcp`, oauth: { mode: 'token_exchange', tokenEndpoint: `${issuer}/token`, clientId: 'gateway', clientSecret: 'private-client-secret', audience: 'upstream' } };
  const config = { allowLocalHttp: true, clients: [{ id: 'user1', token: serviceToken, allow: ['a__*'] }], upstreams: [upstream] };
  const auth = { authenticate: async token => token === serviceToken ? { ...config.clients[0], authScheme: 'jwt' } : undefined };
  const provider = new OAuthCredentialProvider(true);
  const url = await listen(createGateway(config, { authenticator: auth, credentials: provider }), t), client = await clientFor(url, t);
  assert.equal((await client.callTool({ name: 'a__echo', arguments: { text: 'delegated' } })).content[0].text, 'delegated: delegated');
  await client.listTools();
  assert.equal(grants.length, 1);
  assert.equal(grantAuthorization[0], `Basic ${Buffer.from('gateway:private-client-secret').toString('base64')}`);
  assert.equal(grants[0].grant_type, 'urn:ietf:params:oauth:grant-type:token-exchange');
  assert.equal(grants[0].subject_token, serviceToken);
  assert.equal(grants[0].client_id, undefined);
  assert.equal(grants[0].client_secret, undefined);
  assert.ok(authorization.every(value => value === `Bearer exchanged-${serviceToken}`));
  await assert.rejects(provider.headers(upstream, { ...config.clients[0], authScheme: 'api-key' }, serviceToken), /verified JWT/);
});
test('subscription streams relay permitted changes and close when the configuration revision is revoked', async t => {
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'changing', version: '1' }, { capabilities: { tools: { listChanged: true }, resources: { listChanged: true, subscribe: true } } });
    server.setRequestHandler('tools/list', async () => ({ tools: [] })); return server;
  });
  t.after(() => handler.close());
  const upstreamApp = express(); upstreamApp.use(express.json()); const node = toNodeHandler(handler); upstreamApp.all('/mcp', (req, res) => void node(req, res, req.body));
  const upstream = await listen(upstreamApp, t); let current = true;
  const config = { allowLocalHttp: true, features: { notifications: true, resources: true }, clients: [{ id: 'user1', token: serviceToken, allow: ['a__*'], permissions: { resources: ['a__notes://public'] } }], upstreams: [{ id: 'a', url: `${upstream}/mcp` }] };
  const url = await listen(createGateway(config, { isRevisionCurrent: async () => current }), t), client = await clientFor(url, t);
  let changes = 0; client.setNotificationHandler('notifications/tools/list_changed', () => { changes++; });
  const subscription = await client.listen({ toolsListChanged: true });
  t.after(() => subscription.close());
  for (let i = 0; i < 30 && !changes; i++) { handler.notify.toolsChanged(); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.ok(changes > 0);
  current = false;
  await Promise.race([subscription.closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Revoked stream stayed open')), 2500))]);
});
