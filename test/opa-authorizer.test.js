import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { OpaAuthorizer } from '../dist/opa-authorizer.js';
import { environmentPlugins } from '../dist/runtime.js';
import { createGateway } from '../dist/gateway.js';
import { AllowListAuthorizer, AllOfAuthorizer } from '../dist/plugins.js';
import { createModernDemoServer } from '../dist/demo-modern.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { listen, serviceToken } from './helpers.js';

const principal = { id: 'agent-1', token: 'must-never-reach-opa', tenantId: 'tenant-a', subject: 'subject-1', oauthClientId: 'oauth-agent', authScheme: 'jwt', roles: ['reader'] };

test('OPA receives a bounded identity projection and grants only a literal true decision', async t => {
  let seen;
  const app = express(); app.use(express.json());
  app.post('/v1/data/mcp/authz/allow', (req, res) => { seen = { input: req.body, authorization: req.get('authorization') }; res.type('application/json').send('{"result":true}'); });
  const base = await listen(app, t);
  const authorizer = new OpaAuthorizer({ url: `${base}/v1/data/mcp/authz/allow`, token: 'opa-service-key', allowLocalHttp: true });
  assert.equal(await authorizer.canCall(principal, 'alpha__search'), true);
  assert.deepEqual(seen.input, { input: { principal: { id: 'agent-1', tenantId: 'tenant-a', subject: 'subject-1', oauthClientId: 'oauth-agent', authScheme: 'jwt', roles: ['reader'] }, action: 'tools/call', resource: { name: 'alpha__search' } } });
  assert.equal(seen.authorization, 'Bearer opa-service-key');
  assert.ok(!JSON.stringify(seen.input).includes(principal.token));
  assert.equal(await authorizer.canAccess(principal, 'resources/read', 'resource://report'), true);
  assert.equal(seen.input.input.action, 'resources/read');
});

test('OPA denies false, absent, non-boolean, malformed, oversized, and unsuccessful decisions', async t => {
  const app = express();
  app.post('/false', (_req, res) => res.json({ result: false }));
  app.post('/absent', (_req, res) => res.json({ decision_id: 'only' }));
  app.post('/truthy', (_req, res) => res.json({ result: 'true' }));
  app.post('/malformed', (_req, res) => res.type('application/json').send('{'));
  app.post('/error', (_req, res) => res.status(500).json({ result: true }));
  app.post('/large', (_req, res) => res.type('application/json').send(JSON.stringify({ result: true, extra: 'x'.repeat(20000) })));
  const base = await listen(app, t);
  for (const path of ['/false', '/absent', '/truthy', '/malformed', '/error', '/large']) {
    assert.equal(await new OpaAuthorizer({ url: `${base}${path}`, allowLocalHttp: true }).canCall(principal, 'alpha__search'), false, path);
  }
});

test('OPA redirects, endpoint confusion and timeouts deny without sending credentials onward', async t => {
  let redirected = 0;
  const app = express();
  app.post('/redirect', (_req, res) => res.redirect(307, '/sink'));
  app.post('/sink', (_req, res) => { redirected++; res.json({ result: true }); });
  app.post('/slow', async (_req, res) => { await new Promise(resolve => setTimeout(resolve, 100)); res.json({ result: true }); });
  const base = await listen(app, t);
  assert.equal(await new OpaAuthorizer({ url: `${base}/redirect`, token: 'secret', allowLocalHttp: true }).canCall(principal, 'tool'), false);
  assert.equal(redirected, 0);
  assert.equal(await new OpaAuthorizer({ url: `${base}/slow`, timeoutMs: 10, allowLocalHttp: true }).canCall(principal, 'tool'), false);
  assert.throws(() => new OpaAuthorizer({ url: `${base}/decision?path=other`, allowLocalHttp: true }), /query or fragment/);
  assert.throws(() => new OpaAuthorizer({ url: 'http://opa.internal/v1/data/mcp/authz/allow' }), /HTTPS/);
  assert.throws(() => new OpaAuthorizer({ url: `${base}/decision`, timeoutMs: 10001, allowLocalHttp: true }), /timeout/);
});

test('OPA composes as a required policy and strict mode pins endpoint and bearer reference', async t => {
  let calls = 0;
  const app = express(); app.post('/v1/data/mcp/authz/allow', (_req, res) => { calls++; res.json({ result: true }); });
  const base = await listen(app, t), endpoint = `${base}/v1/data/mcp/authz/allow`;
  const config = { clients: [{ id: 'agent', token: serviceToken, allow: ['alpha__*'] }], upstreams: [] };
  const policy = [
    { reference: 'OPA_DECISION_URL', endpoint, purpose: 'authorization-service' },
    { reference: 'OPA_BEARER_TOKEN', endpoint, purpose: 'authorization-service' }
  ];
  const env = { OPA_DECISION_URL: endpoint, OPA_BEARER_TOKEN: 'opa-secret', OPA_ALLOW_LOCAL_HTTP: 'true', GATEWAY_REQUIRE_CREDENTIAL_BINDINGS: 'true', GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS: '127.0.0.0/8', GATEWAY_CREDENTIAL_BINDINGS: JSON.stringify(policy) };
  const authorizer = environmentPlugins(config, env).authorizer;
  assert.equal(await authorizer.canCall({ id: 'agent', allow: ['alpha__*'] }, 'alpha__search'), true);
  assert.equal(calls, 1);
  assert.equal(await authorizer.canCall({ id: 'agent', allow: [] }, 'alpha__search'), false);
  assert.equal(calls, 1, 'local allowlist denial prevents remote evaluation');
  assert.throws(() => environmentPlugins(config, { ...env, OPA_DECISION_URL: `${base}/different` }), /not approved/);
  assert.throws(() => environmentPlugins(config, { ...env, GATEWAY_CREDENTIAL_BINDINGS: JSON.stringify([policy[0]]) }), /not approved/);
  assert.throws(() => environmentPlugins(config, { ...env, OPA_TIMEOUT_MS: '0' }), /timeout/);
});

test('actual MCP discovery and calls obey the OPA decision in addition to local grants', async t => {
  const backend = await listen(createModernDemoServer('opa'), t);
  const app = express(); app.use(express.json());
  app.post('/decision', (req, res) => res.json({ result: req.body.input.resource.name === 'alpha__echo' }));
  const opa = await listen(app, t);
  const config = { allowLocalHttp: true, clients: [{ id: 'agent', token: serviceToken, allow: ['alpha__echo', 'alpha__multiply'] }], upstreams: [{ id: 'alpha', url: `${backend}/mcp` }] };
  const authorizer = new AllOfAuthorizer([new AllowListAuthorizer(), new OpaAuthorizer({ url: `${opa}/decision`, allowLocalHttp: true })]);
  const gateway = await listen(createGateway(config, { authorizer }), t);
  const client = new Client({ name: 'opa-policy-integration', version: '1' }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['alpha__echo']);
  assert.ok(!(await client.callTool({ name: 'alpha__echo', arguments: { text: 'policy approved' } })).isError);
  await assert.rejects(client.callTool({ name: 'alpha__multiply', arguments: { left: 2, right: 3 } }), /forbidden|not found/i);
});
