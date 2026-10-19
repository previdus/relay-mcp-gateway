import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { PostgresStore, RevisionConflict } from '../dist/store.js';
import { PostgresDpopReplayStore } from '../dist/dpop.js';
import { PostgresLimiter } from '../dist/limiter.js';
import { OpenFgaAuthorizer } from '../dist/plugins.js';
import { AllowListAuthorizer, AllOfAuthorizer } from '../dist/plugins.js';
import { OpaAuthorizer } from '../dist/opa-authorizer.js';
import { createGateway } from '../dist/gateway.js';
import express from 'express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { TaskAwareServer } from '../dist/task-server.js';
import { RawTaskTransport } from '../dist/raw-task-transport.js';
import { McpTaskCodec, taskStorageKey } from '../dist/task-state.js';
import { TASKS_EXTENSION_ID_V2, CreateTaskResultV2Schema, GetTaskRequestV2Schema, GetTaskResultV2Schema, UpdateTaskResultV2Schema, withTaskCapabilityV2 } from '@modelcontextprotocol/ext-tasks/core/v2';
import { document, serviceToken } from '../test/helpers.js';
import { adminToken, listen } from '../test/helpers.js';
import { createRuntime } from '../dist/runtime.js';
import { createModernDemoServer } from '../dist/demo-modern.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createPostgresPool } from '../dist/postgres-pool.js';

if (!process.env.TEST_DATABASE_URL || !process.env.TEST_FGA_URL || !process.env.TEST_OPA_URL) throw new Error('Service tests require TEST_DATABASE_URL, TEST_FGA_URL, and TEST_OPA_URL; use the dedicated disposable test stack');
function taskFixture(factory, onRequest = () => {}) {
  const app = express(); app.use(express.json());
  const handler = toNodeHandler(createMcpHandler(factory));
  app.all('/mcp', (req, res) => { onRequest(req.body); void handler(req, res, req.body); });
  return app;
}
async function rawTaskRequest(connection, method, params, headers = {}, extraCapabilities = {}) {
  const existing = params._meta?.['io.modelcontextprotocol/clientCapabilities'] ?? {};
  const framed = { ...params, _meta: {
    ...(params._meta ?? {}),
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'postgres-task-recovery', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': { ...existing, ...extraCapabilities, extensions: { ...(existing.extensions ?? {}), ...(extraCapabilities.extensions ?? {}), [TASKS_EXTENSION_ID_V2]: {} } }
  } };
  const response = await connection.raw.dispatch({ method, params: framed }, { signal: AbortSignal.timeout(8000), timeout: 8000, headers });
  if (response.error) throw new Error(response.error.message);
  return response.result;
}
test('strict-bound PostgreSQL pool verifies the database certificate and DNS-pins its TLS socket', async t => {
  const endpoint = new URL(process.env.TEST_DATABASE_URL);
  endpoint.hostname = 'database-service-egress.test';
  endpoint.searchParams.set('sslmode', 'verify-full');
  endpoint.searchParams.set('sslrootcert', fileURLToPath(new URL('../test/fixtures/postgres-test.crt', import.meta.url)));
  const boundEndpoint = `postgresql://database-service-egress.test:${endpoint.port || '5432'}${endpoint.pathname}`;
  let resolutions = 0;
  const pool = createPostgresPool({
    DATABASE_URL: endpoint.href,
    GATEWAY_REQUIRE_CREDENTIAL_BINDINGS: 'true',
    GATEWAY_CREDENTIAL_BINDINGS: JSON.stringify([{ reference: 'DATABASE_URL', endpoint: boundEndpoint, purpose: 'database' }]),
    GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS: '127.0.0.0/8'
  }, async hostname => {
    resolutions++;
    assert.equal(hostname, 'database-service-egress.test');
    return [{ address: '127.0.0.1', family: 4 }];
  });
  assert.ok(pool);
  t.after(() => pool.end());
  const result = await pool.query('SELECT 1 AS value');
  assert.equal(result.rows[0].value, 1);
  assert.equal(resolutions, 1, 'DNS was vetted and pinned for the TLS connection');
});

test('strict PostgreSQL TLS rejects an untrusted CA and a certificate with the wrong hostname', async () => {
  const certificate = fileURLToPath(new URL('../test/fixtures/postgres-test.crt', import.meta.url));
  for (const failure of [
    { host: 'database-service-egress.test', trustFixture: false },
    { host: 'database-wrong-host.test', trustFixture: true }
  ]) {
    const endpoint = new URL(process.env.TEST_DATABASE_URL);
    endpoint.hostname = failure.host;
    endpoint.searchParams.set('sslmode', 'verify-full');
    if (failure.trustFixture) endpoint.searchParams.set('sslrootcert', certificate);
    else endpoint.searchParams.delete('sslrootcert');
    const destination = `postgresql://${failure.host}:${endpoint.port || '5432'}${endpoint.pathname}`;
    const pool = createPostgresPool({
      DATABASE_URL: endpoint.href,
      GATEWAY_REQUIRE_CREDENTIAL_BINDINGS: 'true',
      GATEWAY_CREDENTIAL_BINDINGS: JSON.stringify([{ reference: 'DATABASE_URL', endpoint: destination, purpose: 'database' }]),
      GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS: '127.0.0.0/8'
    }, async hostname => {
      assert.equal(hostname, failure.host);
      return [{ address: '127.0.0.1', family: 4 }];
    });
    assert.ok(pool);
    await assert.rejects(pool.connect(), /certificate|issuer|self-signed|hostname|altname/i);
    await pool.end();
  }
});

test('PostgreSQL DPoP replay claims are atomic across gateway replicas and expire safely', async t => {
  const poolA = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const poolB = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const store = new PostgresStore(poolA);
  t.after(async () => { await store.close(); await poolB.end(); });
  await store.initialize(document);
  const replayA = new PostgresDpopReplayStore(poolA), replayB = new PostgresDpopReplayStore(poolB);
  const key = `integration-${crypto.randomUUID()}`;
  const claims = await Promise.all([replayA.consume(key, Date.now() / 1000 + 60), replayB.consume(key, Date.now() / 1000 + 60)]);
  assert.deepEqual(claims.sort(), [false, true], 'only one replica can claim a proof');
  await poolA.query('UPDATE gateway_dpop_replay SET expires_at = clock_timestamp() - interval \'1 second\' WHERE proof_key = $1', [key]);
  assert.equal(await replayB.consume(key, Date.now() / 1000 + 60), true, 'expired replay state can be reclaimed');
});

test('PostgreSQL JWT revocations are visible across independent gateway pools and expire', async t => {
  const poolA = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const poolB = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const storeA = new PostgresStore(poolA), storeB = new PostgresStore(poolB);
  t.after(async () => { await storeA.close(); await storeB.close(); });
  await storeA.initialize(document);
  const issuer = 'https://issuer.example', tokenId = `revocation-${crypto.randomUUID()}`;
  await storeA.revokeJwt(issuer, tokenId, Math.floor(Date.now() / 1000) + 60);
  assert.equal(await storeB.isJwtRevoked(issuer, tokenId), true, 'revocation is shared immediately');
  assert.equal(await storeB.isJwtRevoked('https://other-issuer.example', tokenId), false, 'issuer is part of the lookup key');
  const key = createHash('sha256').update(issuer).update('\0').update(tokenId).digest('hex');
  await poolA.query('UPDATE gateway_jwt_revocations SET expires_at = clock_timestamp() - interval \'1 second\' WHERE token_key = $1', [key]);
  assert.equal(await storeB.isJwtRevoked(issuer, tokenId), false, 'expired revocations no longer deny and are eligible for cleanup');
  await storeA.setJwtIssuerDisabled(issuer, true);
  assert.equal(await storeB.isJwtIssuerDisabled(issuer), true, 'issuer emergency stop is visible across pools');
  assert.equal(await storeB.isJwtRevoked(issuer, 'token-without-jti'), true, 'issuer stop denies tokens regardless of token ID');
  await storeB.setJwtIssuerDisabled(issuer, false);
  assert.equal(await storeA.isJwtRevoked(issuer, 'token-without-jti'), false, 'explicit re-enable is shared across pools');
});

test('PostgreSQL MCP task state is shared across independent gateway pools and expires', async t => {
  const poolA = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const poolB = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const storeA = new PostgresStore(poolA), storeB = new PostgresStore(poolB);
  t.after(async () => { await storeA.close(); await storeB.close(); });
  await storeA.initialize(document);
  const key = `task-${crypto.randomUUID()}`;
  const ciphertext = 'opaque-aes-gcm-ciphertext';
  const expiresAtMs = Date.now() + 60_000;
  await storeA.putMcpTask(key, ciphertext, expiresAtMs);
  assert.deepEqual(await storeB.getMcpTask(key), { ciphertext, expiresAtMs }, 'another replica can resolve durable encrypted task state');
  assert.equal(await storeB.compareAndSetMcpTask(key, ciphertext, 'claimed-task-state', expiresAtMs), true, 'one replica can atomically claim task input state');
  assert.equal(await storeA.compareAndSetMcpTask(key, ciphertext, 'stale-task-state', expiresAtMs), false, 'a stale replica cannot replay or overwrite the claimed input');
  assert.equal((await storeA.getMcpTask(key)).ciphertext, 'claimed-task-state');
  await poolA.query('UPDATE gateway_mcp_tasks SET expires_at_ms=$2 WHERE task_key=$1', [key, Date.now() - 1]);
  assert.equal(await storeB.getMcpTask(key), undefined, 'expired task state is not returned across replicas');
  await poolA.query('DELETE FROM gateway_mcp_tasks WHERE task_key=$1', [key]);
});

test('PostgreSQL task input recovery survives an ambiguous upstream failure across gateway replicas', async t => {
  const sharedStateKey = 'postgres-task-recovery-state-key-over-32-bytes';
  const upstreamTaskId = 'private-postgres-retry-task';
  let inputAccepted = false, updateCalls = 0, observedInputResponses = [];
  const upstream = await listen(taskFixture(() => {
    const server = new TaskAwareServer({ name: 'postgres-task-recovery', version: '1' }, { capabilities: { tools: {}, extensions: { [TASKS_EXTENSION_ID_V2]: {} } } });
    server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'long_job', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }));
    server.setRequestHandler('tools/call', async () => ({ resultType: 'task', taskId: upstreamTaskId, status: 'working', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttlMs: 60000 }));
    server.setRequestHandler('tasks/get', { params: GetTaskRequestV2Schema.shape.params, result: GetTaskResultV2Schema }, async params => inputAccepted
      ? ({ taskId: params.taskId, status: 'completed', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttlMs: 30000, result: { content: [{ type: 'text', text: 'completed once' }] } })
      : ({ taskId: params.taskId, status: 'input_required', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttlMs: 30000, inputRequests: { confirm: { method: 'elicitation/create', params: { mode: 'form', message: 'Confirm', requestedSchema: { type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'] } } } } }));
    server.setRequestHandler('tasks/update', { params: GetTaskRequestV2Schema.shape.params, result: UpdateTaskResultV2Schema }, async () => {
      updateCalls++;
      if (!inputAccepted) { inputAccepted = true; throw new Error('upstream accepted the input but its acknowledgement was lost'); }
      return { resultType: 'complete' };
    });
    return server;
  }, body => { if (body?.method === 'tasks/update') observedInputResponses.push(body.params?.inputResponses); }), t);

  const poolA = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }), poolB = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const storeA = new PostgresStore(poolA), storeB = new PostgresStore(poolB);
  t.after(async () => { await storeA.close(); await storeB.close(); });
  const config = {
    allowLocalHttp: true, features: { tasks: true, callbacks: true },
    clients: [{ id: 'task-agent', tokenEnv: 'SERVICE_TOKEN', allow: ['async__*'], callbackMethods: ['elicitation/create'] }],
    upstreams: [{ id: 'async', url: `${upstream}/mcp` }]
  };
  await poolA.query('TRUNCATE gateway_config_history, gateway_config, gateway_audit, gateway_leases, gateway_mcp_tasks');
  await storeA.initialize(config); await storeB.initialize(config);
  const options = { adminKey: adminToken, environment: { SERVICE_TOKEN: serviceToken, GATEWAY_STATE_KEY: sharedStateKey } };
  const urls = [await listen(createRuntime(storeA, options), t), await listen(createRuntime(storeB, options), t)];
  const clients = [];
  for (const url of urls) {
    const client = new Client({ name: 'postgres-task-recovery', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const raw = new RawTaskTransport(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
    await client.connect(raw, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    clients.push({ client, raw }); t.after(() => client.close());
  }

  const created = CreateTaskResultV2Schema.parse(await rawTaskRequest(clients[0], 'tools/call', withTaskCapabilityV2({ name: 'async__long_job', arguments: {} })));
  await rawTaskRequest(clients[0], 'tasks/get', { taskId: created.taskId }, { 'Mcp-Name': created.taskId }, { elicitation: { form: {} } });
  const response = { confirm: { action: 'accept', content: { accepted: true } } };
  const requestHeaders = { 'Mcp-Name': created.taskId }, capabilities = { elicitation: { form: {} } };
  await assert.rejects(rawTaskRequest(clients[0], 'tasks/update', { taskId: created.taskId, inputResponses: response }, requestHeaders, capabilities), /acknowledgement was lost/);
  assert.equal(updateCalls, 1);
  assert.deepEqual(observedInputResponses[0], response, 'the gateway forwards the exact authorized response to the upstream');

  const storageKey = taskStorageKey(created.taskId), stored = await storeA.getMcpTask(storageKey);
  assert.ok(stored, 'replica B can read the encrypted task record created by replica A');
  const principal = { id: 'task-agent', authScheme: 'api-key', callbackMethods: ['elicitation/create'] };
  const codec = new McpTaskCodec(sharedStateKey), state = codec.open(stored.ciphertext, principal);
  assert.equal(state.pendingInputClaims.confirm.response.content.accepted, true);
  state.pendingInputClaims.confirm.leaseUntilMs = Date.now() - 1;
  assert.equal(await storeB.compareAndSetMcpTask(storageKey, stored.ciphertext, codec.seal(state, principal), stored.expiresAtMs), true, 'replica B atomically reclaims the expired durable input lease');

  UpdateTaskResultV2Schema.parse(await rawTaskRequest(clients[1], 'tasks/update', { taskId: created.taskId, inputResponses: response }, requestHeaders, capabilities));
  assert.equal(updateCalls, 2, 'replica B retries the identical response after the simulated lost acknowledgement');
  assert.deepEqual(observedInputResponses[1], response);
  const finalState = codec.open((await storeA.getMcpTask(storageKey)).ciphertext, principal);
  assert.ok(finalState.consumedInputKeys.includes('confirm'));
  assert.deepEqual(finalState.pendingInputClaims, {});
  const completed = GetTaskResultV2Schema.parse(await rawTaskRequest(clients[0], 'tasks/get', { taskId: created.taskId }, requestHeaders, capabilities));
  assert.equal(completed.status, 'completed', 'the first replica observes the recovered completion from the shared task backend');
});

test('PostgreSQL atomic revisions, shared auditing and distributed leases', async t => {
  const poolA = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const poolB = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const a = new PostgresStore(poolA), b = new PostgresStore(poolB);
  t.after(async () => { await a.close(); await b.close(); });
  await a.initialize(document);
  await poolA.query('TRUNCATE gateway_config_history, gateway_config, gateway_audit, gateway_leases');
  await a.initialize(document);
  const writes = await Promise.allSettled([a.write({ ...document, timeoutMs: 100 }, 1), b.write({ ...document, timeoutMs: 200 }, 1)]);
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(writes.filter(result => result.status === 'rejected' && result.reason instanceof RevisionConflict).length, 1);
  assert.equal((await a.read()).revision, 2);
  assert.equal((await b.read()).revision, 2);
  await a.audit({ requestId: 'test', at: new Date().toISOString(), clientId: 'test', outcome: 'ok' });
  assert.equal((await b.recentAudit()).length, 1);
  for (let i = 1; i <= 4; i++) await a.audit({ requestId: `page-${i}`, at: new Date().toISOString(), clientId: 'test', outcome: 'ok' });
  const paged = [];
  let cursor;
  do { const page = await b.auditPage(cursor, 2); paged.push(...page.events.map(event => event.requestId)); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual(paged, ['test', 'page-1', 'page-2', 'page-3', 'page-4'], 'separate PostgreSQL pools traverse the same audit log');
  await poolA.query("CREATE OR REPLACE FUNCTION reject_gateway_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER audit_failure BEFORE INSERT ON gateway_audit FOR EACH ROW EXECUTE FUNCTION reject_gateway_audit()");
  try {
    await assert.rejects(a.write({ ...document, timeoutMs: 999 }, 2, { requestId: 'blocked', at: new Date().toISOString(), clientId: 'admin', outcome: 'ok' }), /audit unavailable/);
    assert.equal((await b.read()).revision, 2);
    assert.deepEqual((await b.history()).map(item => item.revision), [2, 1]);
  } finally { await poolA.query('DROP TRIGGER audit_failure ON gateway_audit; DROP FUNCTION reject_gateway_audit()'); }
  await a.write(document, 2, { requestId: 'committed', at: new Date().toISOString(), clientId: 'admin', outcome: 'ok' });
  assert.equal((await b.read()).revision, 3);
  assert.deepEqual((await b.history()).map(item => item.revision), [3, 2, 1]);
  assert.deepEqual((await b.revision(1)).document, document);
  assert.ok((await b.recentAudit()).some(event => event.requestId === 'committed'));
  const limiterA = new PostgresLimiter(poolA), limiterB = new PostgresLimiter(poolB);
  const attempts = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? limiterA : limiterB).acquire('shared-principal', 3)));
  const acquired = attempts.filter(Boolean);
  assert.equal(acquired.length, 3);
  await Promise.all(acquired.map(release => release()));
  const release = await limiterB.acquire('shared-principal', 3);
  assert.ok(release); await release();
});

test('real OpenFGA model checks direct grants, group inheritance, denial and revocation', async () => {
  const base = process.env.TEST_FGA_URL;
  async function post(path, body) {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`OpenFGA ${path}: ${response.status} ${await response.text()}`);
    return response.status === 204 ? {} : response.json();
  }
  const store = await post('/stores', { name: `gateway-integration-${Date.now()}` });
  try {
    const model = await post(`/stores/${store.id}/authorization-models`, {
      schema_version: '1.1', type_definitions: [
        { type: 'user' },
        { type: 'group', relations: { member: { this: {} } }, metadata: { relations: { member: { directly_related_user_types: [{ type: 'user' }] } } } },
        { type: 'tool', relations: { can_call: { this: {} } }, metadata: { relations: { can_call: { directly_related_user_types: [{ type: 'user' }, { type: 'group', relation: 'member' }] } } } }
      ]
    });
    const grant = { user: 'group:engineering#member', relation: 'can_call', object: 'tool:alpha__echo' };
    const member = { user: 'user:user1', relation: 'member', object: 'group:engineering' };
    await post(`/stores/${store.id}/write`, { authorization_model_id: model.authorization_model_id, writes: { tuple_keys: [grant, member] } });
    const policy = new OpenFgaAuthorizer({ url: base, storeId: store.id, modelId: model.authorization_model_id, allowLocalHttp: true });
    const principal = { id: 'user1', token: serviceToken, allow: ['alpha__*'] };
    assert.equal(await policy.canCall(principal, 'alpha__echo'), true);
    assert.equal(await policy.canCall(principal, 'beta__echo'), false);
    await post(`/stores/${store.id}/write`, { authorization_model_id: model.authorization_model_id, deletes: { tuple_keys: [member] } });
    assert.equal(await policy.canCall(principal, 'alpha__echo'), false);
    const namespace=value=>encodeURIComponent(JSON.stringify(['acme',value]));
    const v2Grant={user:`user:${namespace('user1')}`,relation:'can_call',object:`tool:${namespace('alpha__echo')}`};
    await post(`/stores/${store.id}/write`,{authorization_model_id:model.authorization_model_id,writes:{tuple_keys:[v2Grant]}});
    const v2=new OpenFgaAuthorizer({url:base,storeId:store.id,modelId:model.authorization_model_id,allowLocalHttp:true,namespaceFormat:'tuple-v2'});
    assert.equal(await v2.canCall({...principal,tenantId:'acme'},'alpha__echo'),true);
    assert.equal(await v2.canCall({...principal,id:'acme/user1'},'alpha__echo'),false);
    await post(`/stores/${store.id}/write`,{authorization_model_id:model.authorization_model_id,deletes:{tuple_keys:[v2Grant]}});
    assert.equal(await v2.canCall({...principal,tenantId:'acme'},'alpha__echo'),false);
  } finally { await fetch(`${base}/stores/${store.id}`, { method: 'DELETE' }); }
});
test('real OPA Rego decisions gate MCP tool discovery, direct calls and resource access', async t => {
  const opa = new OpaAuthorizer({ url: process.env.TEST_OPA_URL, allowLocalHttp: true });
  assert.equal(await opa.canCall({ id: 'agent', roles: ['reader'], allow: ['alpha__*'] }, 'alpha__echo'), true);
  assert.equal(await opa.canCall({ id: 'agent', roles: ['reader'], allow: ['alpha__*'] }, 'alpha__multiply'), false);
  assert.equal(await opa.canCall({ id: 'agent', roles: ['guest'], allow: ['alpha__*'] }, 'alpha__echo'), false);
  assert.equal(await opa.canAccess({ id: 'report-agent', allow: [] }, 'resources/read', 'resource://monthly-report'), true);
  assert.equal(await opa.canAccess({ id: 'other-agent', allow: [] }, 'resources/read', 'resource://monthly-report'), false);

  const upstream = await listen(createModernDemoServer('opa-live'), t);
  const config = { allowLocalHttp: true, clients: [{ id: 'agent', token: serviceToken, roles: ['reader'], allow: ['alpha__echo', 'alpha__multiply'] }], upstreams: [{ id: 'alpha', url: `${upstream}/mcp` }] };
  const gateway = await listen(createGateway(config, { authorizer: new AllOfAuthorizer([new AllowListAuthorizer(), opa]) }), t);
  const client = new Client({ name: 'real-opa-mcp', version: '1' }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['alpha__echo']);
  assert.ok(!(await client.callTool({ name: 'alpha__echo', arguments: { text: 'authorized by Rego' } })).isError);
  await assert.rejects(client.callTool({ name: 'alpha__multiply', arguments: { left: 2, right: 3 } }), /forbidden|not found/i);
});
test('real PostgreSQL gateway replicas route concurrent HTTP calls and share policy updates', async t => {
  const upstream = await listen(createModernDemoServer('shared'), t);
  const poolA = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }), poolB = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const firstStore = new PostgresStore(poolA), secondStore = new PostgresStore(poolB);
  t.after(async () => { await firstStore.close(); await secondStore.close(); });
  await firstStore.initialize(document);
  await poolA.query('TRUNCATE gateway_config_history, gateway_config, gateway_audit, gateway_leases');
  const initial = { ...document, maxConcurrentPerClient: 32, features: { catalogSearch: true }, discovery: { pageSize: 1 }, routes: [{ name: 'echo', strategy: 'rendezvous', targets: [{ upstreamId: 'alpha', tool: 'echo' }] }], upstreams: [{ id: 'alpha', url: `${upstream}/mcp` }] };
  await firstStore.initialize(initial);
  const options = { adminKey: adminToken, environment: { SERVICE_TOKEN: serviceToken } };
  const urls = [await listen(createRuntime(firstStore, { ...options, limiter: new PostgresLimiter(poolA) }), t), await listen(createRuntime(secondStore, { ...options, limiter: new PostgresLimiter(poolB) }), t)];
  const clients = [];
  for (const url of urls) {
    const client = new Client({ name: 'replica-load-test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
    clients.push(client); t.after(() => client.close());
  }
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => clients[i % 2].callTool({ name: 'alpha__echo', arguments: { text: String(i) } })));
  assert.equal(results.length, 20);
  assert.ok(results.every((result, i) => result.content[0].text === `shared: ${i}`));
  const firstPage = await clients[0].request({ method: 'tools/list', params: {} }); assert.ok(firstPage.nextCursor);
  const nextPage = await clients[1].request({ method: 'tools/list', params: { cursor: firstPage.nextCursor } }); assert.deepEqual(nextPage.tools.map(tool => tool.name), ['echo']);
  const restricted = { ...initial, invocationPolicies: { alpha__echo: { allow: [{ constraints: [{ field: ['text'], op: 'equals', value: 'approved' }] }] } } };
  await firstStore.write(restricted, 1);
  await assert.rejects(clients[1].request({ method: 'tools/list', params: { cursor: firstPage.nextCursor } }), /invalid or stale/);
  assert.deepEqual((await secondStore.read()).document.invocationPolicies, restricted.invocationPolicies);
  for (const client of clients) {
    await assert.rejects(client.callTool({ name: 'alpha__echo', arguments: { text: 'unapproved' } }), /argument policy/);
    assert.equal((await client.callTool({ name: 'alpha__echo', arguments: { text: 'approved' } })).content[0].text, 'shared: approved');
  }
  const search = await fetch(`${urls[1]}/catalog/search`, { method: 'POST', headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'echo', limit: 10 }) });
  assert.equal(search.status, 200); assert.equal((await search.json()).tools.length, 2);
  const changed = { ...initial, clients: [{ ...initial.clients[0], allow: [] }] };
  const response = await fetch(`${urls[0]}/admin/api/config`, { method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'If-Match': '"2"' }, body: JSON.stringify(changed) });
  assert.equal(response.status, 200);
  assert.deepEqual((await clients[1].listTools()).tools, []);
  await assert.rejects(clients[1].callTool({ name: 'alpha__echo', arguments: { text: 'denied' } }), /forbidden/);
});

test('PostgreSQL token buckets enforce one budget across independent gateway replicas', async t => {
  const { PostgresRateLimiter } = await import('../dist/traffic.js');
  const poolA = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }), poolB = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const storeA = new PostgresStore(poolA), storeB = new PostgresStore(poolB);
  t.after(async () => { await storeA.close(); await storeB.close(); });
  await storeA.initialize(document);
  await poolA.query('TRUNCATE gateway_config_history, gateway_config, gateway_audit, gateway_leases, gateway_rate_buckets');
  await storeA.initialize(document);
  const policy = { capacity: 4, refillPerSecond: 0.001 };
  const limiters = [new PostgresRateLimiter(poolA), new PostgresRateLimiter(poolB)];
  const reservations = await Promise.all(Array.from({ length: 20 }, (_, i) => limiters[i % 2].consume('shared-test', policy)));
  assert.equal(reservations.filter(Boolean).length, 4);
  assert.equal(await limiters[1].consume('shared-test', policy), false);
  assert.equal(await limiters[1].consume('another-tenant', policy), true);
  const upstream = await listen(createModernDemoServer('quota'), t);
  const initial = { ...document, maxConcurrentPerClient: 32, upstreams: [{ id: 'alpha', url: `${upstream}/mcp` }], traffic: { toolRateLimits: { alpha__echo: { capacity: 3, refillPerSecond: 0.001 } } } };
  await storeA.write(initial, 1);
  const options = { adminKey: adminToken, environment: { SERVICE_TOKEN: serviceToken } };
  const urls = [await listen(createRuntime(storeA, options), t), await listen(createRuntime(storeB, options), t)];
  const clients = [];
  for (const url of urls) {
    const client = new Client({ name: 'shared-quota', version: '1' });
    t.after(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
    clients.push(client);
  }
  const calls = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => clients[i % 2].callTool({ name: 'alpha__echo', arguments: { text: String(i) } })));
  assert.equal(calls.filter(result => result.status === 'fulfilled').length, 3);
  assert.equal(calls.filter(result => result.status === 'rejected' && /429|Rate limit/.test(result.reason.message)).length, 9);
  await storeA.write({ ...initial, timeoutMs: 4000 }, 2);
  await assert.rejects(clients[1].callTool({ name: 'alpha__echo', arguments: { text: 'no reset on revision' } }), /429|Rate limit/);
});

test('PostgreSQL circuit breakers share outage state, serialize half-open probes and ignore stale successes', async t => {
  const { PostgresCircuitBreakers, CircuitOpen } = await import('../dist/traffic.js');
  const poolA = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }), poolB = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const store = new PostgresStore(poolA); t.after(async () => { await store.close(); await poolB.end(); });
  await store.initialize(document);
  await poolA.query('TRUNCATE gateway_circuits');
  const a = new PostgresCircuitBreakers(poolA), b = new PostgresCircuitBreakers(poolB), policy = { failureThreshold: 1, resetAfterMs: 50 };
  await assert.rejects(a.run('shared-outage', policy, async () => { throw new Error('upstream unavailable'); }));
  let attempts = 0;
  await assert.rejects(b.run('shared-outage', policy, async () => { attempts++; }), CircuitOpen);
  assert.equal(attempts, 0);
  await new Promise(resolve => setTimeout(resolve, 65));
  let startProbe;
  const probeStarted = new Promise(resolve => { startProbe = resolve; });
  let finishProbe;
  const probeResult = new Promise(resolve => { finishProbe = resolve; });
  const probing = a.run('shared-outage', policy, async () => { startProbe(); await probeResult; return 'healthy'; });
  await probeStarted;
  await assert.rejects(b.run('shared-outage', policy, async () => { attempts++; }), CircuitOpen);
  assert.equal(attempts, 0);
  finishProbe(); assert.equal(await probing, 'healthy');
  assert.equal(await b.run('shared-outage', policy, async () => 'recovered'), 'recovered');

  let releaseStale;
  const staleResult = new Promise(resolve => { releaseStale = resolve; });
  let staleStarted;
  const staleHasStarted = new Promise(resolve => { staleStarted = resolve; });
  const oldSuccess = a.run('stale-completion', policy, async () => { staleStarted(); await staleResult; return 'stale'; });
  await staleHasStarted;
  await assert.rejects(b.run('stale-completion', policy, async () => { throw new Error('opens circuit'); }));
  releaseStale(); assert.equal(await oldSuccess, 'stale');
  await assert.rejects(a.run('stale-completion', policy, async () => { attempts++; }), CircuitOpen);
  assert.equal(attempts, 0);
});

test('PostgreSQL runtime defaults wire the shared circuit breaker across gateway replicas', async t => {
  const poolA = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }), poolB = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const storeA = new PostgresStore(poolA), storeB = new PostgresStore(poolB);
  t.after(async () => { await storeA.close(); await storeB.close(); });
  const initial = { ...document, upstreams: [{ id: 'alpha', url: 'http://127.0.0.1:1/mcp' }], traffic: { circuitBreaker: { failureThreshold: 1, resetAfterMs: 60000 } } };
  await poolA.query('TRUNCATE gateway_config_history, gateway_config, gateway_audit, gateway_leases, gateway_rate_buckets, gateway_circuits');
  await storeA.initialize(initial); await storeB.initialize(initial);
  let transportAttempts = 0;
  const options = { adminKey: adminToken, environment: { SERVICE_TOKEN: serviceToken }, plugins: () => ({ transportFactory: () => { transportAttempts++; throw new Error('upstream is offline'); } }) };
  const urls = [await listen(createRuntime(storeA, options), t), await listen(createRuntime(storeB, options), t)];
  const clients = [];
  for (const url of urls) {
    const client = new Client({ name: 'shared-circuit-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
    clients.push(client); t.after(() => client.close());
  }
  assert.equal((await clients[0].callTool({ name: 'alpha__echo', arguments: { text: 'fail once' } })).isError, true);
  assert.equal(transportAttempts, 1);
  assert.equal((await clients[1].callTool({ name: 'alpha__echo', arguments: { text: 'must be short-circuited' } })).isError, true);
  assert.equal(transportAttempts, 1);
});
