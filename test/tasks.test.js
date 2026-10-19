import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createTaskSessionFromClient } from '@modelcontextprotocol/ext-tasks/client';
import {
  TASKS_EXTENSION_ID_V2, CreateTaskResultV2Schema, GetTaskResultV2Schema,
  UpdateTaskResultV2Schema, CancelTaskResultV2Schema, GetTaskRequestV2Schema,
  UpdateTaskRequestV2Schema, CancelTaskRequestV2Schema, withTaskCapabilityV2,
} from '@modelcontextprotocol/ext-tasks/core/v2';
import { createGateway } from '../dist/gateway.js';
import { TaskAwareServer } from '../dist/task-server.js';
import { RawTaskTransport } from '../dist/raw-task-transport.js';
import { McpTaskCodec, taskStorageKey } from '../dist/task-state.js';
import { SqliteStore } from '../dist/store.js';
import { listen, document, serviceToken } from './helpers.js';

const stateKey = 'mcp-tasks-shared-encryption-key-32-bytes';

test('SQLite persists only encrypted task state across a gateway restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-task-state-'));
  const path = join(directory, 'tasks.sqlite');
  const config = document;
  const first = new SqliteStore(path, config);
  const ciphertext = 'encrypted-task-route-and-arguments';
  await first.putMcpTask('a'.repeat(64), ciphertext, Date.now() + 60000);
  await first.close();
  const restarted = new SqliteStore(path, config);
  t.after(async () => { await restarted.close(); await rm(directory, { recursive: true, force: true }); });
  const restored = await restarted.getMcpTask('a'.repeat(64));
  assert.equal(restored?.ciphertext, ciphertext);
  assert.ok(restored.expiresAtMs > Date.now());
  assert.equal(await restarted.compareAndSetMcpTask('a'.repeat(64), ciphertext, 'updated-ciphertext', restored.expiresAtMs), true);
  assert.equal(await restarted.compareAndSetMcpTask('a'.repeat(64), ciphertext, 'stale-overwrite', restored.expiresAtMs), false, 'stale task state cannot overwrite an acknowledged input');
  assert.equal((await restarted.getMcpTask('a'.repeat(64))).ciphertext, 'updated-ciphertext');
});
function fixture(factory, headersSeen) {
  const app = express(); app.use(express.json());
  const handler = toNodeHandler(createMcpHandler(factory));
  app.all('/mcp', (req, res) => { headersSeen.push(req.headers['mcp-name']); void handler(req, res, req.body); });
  return app;
}
async function clientFor(url, t, token = serviceToken) {
  const client = new Client({ name: 'tasks-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const raw = new RawTaskTransport(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  await client.connect(raw, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  t.after(() => client.close()); return { client, raw };
}
async function rawRequest(connection, method, params, headers = {}, extraCapabilities = {}) {
  const { raw } = connection;
  const existingCapabilities = params._meta?.['io.modelcontextprotocol/clientCapabilities'] ?? {};
  const framed = { ...params, _meta: {
    ...(params._meta ?? {}),
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'tasks-test', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': { ...existingCapabilities, ...extraCapabilities, extensions: { ...(existingCapabilities.extensions ?? {}), ...(extraCapabilities.extensions ?? {}), [TASKS_EXTENSION_ID_V2]: {} } },
  } };
  const response = await raw.dispatch({ method, params: framed }, { signal: AbortSignal.timeout(5000), timeout: 5000, headers });
  if (response.error) throw new Error(response.error.message);
  return response.result;
}

test('official MCP Tasks V2 client interoperates with gateway task routing', async t => {
  const headersSeen = [], upstreamTaskId = 'vendor-owned-task-identifier';
  const upstream = await listen(fixture(() => {
    const server = new TaskAwareServer({ name: 'interop-upstream', version: '1' }, { capabilities: { tools: {}, extensions: { [TASKS_EXTENSION_ID_V2]: {} } } });
    server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'long_job', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, execution: { taskSupport: 'required' } }] }));
    server.setRequestHandler('tools/call', async () => ({ resultType: 'task', taskId: upstreamTaskId, status: 'working', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttlMs: 60000 }));
    server.setRequestHandler('tasks/get', { params: GetTaskRequestV2Schema.shape.params, result: GetTaskResultV2Schema }, async params => {
      assert.equal(params.taskId, upstreamTaskId, 'gateway must translate its opaque task handle to the upstream handle');
      return { taskId: upstreamTaskId, status: 'completed', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttlMs: 30000, result: { resultType: 'complete', content: [{ type: 'text', text: 'completed by upstream' }] } };
    });
    return server;
  }, headersSeen), t);
  const taskStore = {
    records: new Map(),
    async putMcpTask(key, ciphertext, expiresAtMs) { this.records.set(key, { ciphertext, expiresAtMs }); },
    async getMcpTask(key) { const value = this.records.get(key); return value?.expiresAtMs > Date.now() ? value : undefined; },
    async compareAndSetMcpTask(key, expectedCiphertext, ciphertext, expiresAtMs) {
      const current = this.records.get(key);
      if (!current || current.ciphertext !== expectedCiphertext || current.expiresAtMs <= Date.now()) return false;
      this.records.set(key, { ciphertext, expiresAtMs }); return true;
    },
  };
  const gateway = await listen(createGateway({ allowLocalHttp: true, features: { tasks: true }, clients: [{ id: 'task-agent', token: serviceToken, allow: ['async__*'] }], upstreams: [{ id: 'async', url: `${upstream}/mcp` }] }, { stateKey, taskStore }), t);
  const client = new Client({ name: 'official-ext-tasks-client', version: '0.2.2' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const raw = new RawTaskTransport(new StreamableHTTPClientTransport(new URL(`${gateway}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
  await client.connect(raw, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  t.after(() => client.close());
  const clientTaskHeaders = [];
  const session = createTaskSessionFromClient(client, {
    endpointId: 'gateway-interop',
    rawDispatch: async (request, options = {}) => {
      const timeout = options.context?.requestTimeoutMs ?? 5000;
      if (request.method === 'tasks/get') clientTaskHeaders.push(options.context?.headers?.['Mcp-Name']);
      const response = await raw.dispatch(request, { signal: options.signal ?? AbortSignal.timeout(timeout), timeout, headers: options.context?.headers });
      return response.error ? { kind: 'error', error: response.error } : { kind: 'result', result: response.result };
    },
    v2RequestFraming: {
      protocolVersion: '2026-07-28',
      clientInfo: { name: 'official-ext-tasks-client', version: '0.2.2' },
      clientCapabilities: { extensions: { [TASKS_EXTENSION_ID_V2]: {} } },
    },
  });
  t.after(() => session.close());
  assert.equal(session.capabilities.execution, true);
  const execution = await session.callTool('async__long_job', { value: 'interop' }, { task: { preference: 'require' }, requestTimeoutMs: 5000 });
  assert.equal(execution.kind, 'task');
  assert.notEqual(execution.handle.taskId, upstreamTaskId, 'gateway task IDs stay opaque to the client');
  const settled = await execution.settle({ close: true });
  assert.equal(settled.outcome.status, 'completed', `${JSON.stringify(settled.outcome)} ${settled.outcome.error?.message ?? ''} ${settled.outcome.error?.cause?.message ?? ''}`);
  assert.equal(settled.outcome.result.content[0].text, 'completed by upstream');
  assert.ok(clientTaskHeaders.includes(execution.handle.taskId), 'official Tasks V2 client must carry the gateway task ID in Mcp-Name');
  assert.ok(headersSeen.includes(upstreamTaskId), 'gateway must translate Mcp-Name to the upstream task ID');
});

test('MCP Tasks are opaque, encrypted, shared across gateway replicas and routed with Mcp-Name', async t => {
  const headersSeen = [], upstreamId = 'private-upstream-task-id';
  let updated = false, updateCalls = 0, announceUpdate, releaseUpdate;
  const updateStarted = new Promise(resolve => { announceUpdate = resolve; });
  const updateGate = new Promise(resolve => { releaseUpdate = resolve; });
  const upstream = await listen(fixture(() => {
    const server = new TaskAwareServer({ name: 'async-tool', version: '1' }, { capabilities: { tools: {}, extensions: { [TASKS_EXTENSION_ID_V2]: {} } } });
    server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'long_job', inputSchema: { type: 'object', properties: { secret: { type: 'string' } }, required: ['secret'] } }] }));
    server.setRequestHandler('tools/call', async (_request, ctx) => {
      assert.ok(ctx.mcpReq.envelope, 'task request must reach the MCP server');
      return { resultType: 'task', taskId: upstreamId, status: 'working', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttlMs: 60000 };
    });
    server.setRequestHandler('tasks/get', { params: GetTaskRequestV2Schema.shape.params, result: GetTaskResultV2Schema }, async params => updated
      ? ({ taskId: params.taskId, status: 'completed', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttlMs: 30000, result: { content: [{ type: 'text', text: 'finished' }] } })
      : ({ taskId: params.taskId, status: 'input_required', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttlMs: 30000, inputRequests: { confirm: { method: 'elicitation/create', params: { mode: 'form', message: 'Confirm operation', requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] } } } } }));
    server.setRequestHandler('tasks/update', { params: GetTaskRequestV2Schema.shape.params, result: UpdateTaskResultV2Schema }, async (_params, ctx) => {
      assert.equal(ctx.mcpReq.inputResponses?.confirm?.action, 'accept'); updateCalls++; announceUpdate(); await updateGate; updated = true; return { resultType: 'complete' };
    });
    server.setRequestHandler('tasks/cancel', { params: CancelTaskRequestV2Schema.shape.params, result: CancelTaskResultV2Schema }, async () => ({ resultType: 'complete' }));
    return server;
  }, headersSeen), t);
  const records = new Map();
  const taskStore = {
    async putMcpTask(key, ciphertext, expiresAtMs) { records.set(key, { ciphertext, expiresAtMs }); },
    async getMcpTask(key) { const value = records.get(key); return value?.expiresAtMs > Date.now() ? value : undefined; },
    async compareAndSetMcpTask(key, expectedCiphertext, ciphertext, expiresAtMs) {
      const current = records.get(key);
      if (!current || current.ciphertext !== expectedCiphertext || current.expiresAtMs <= Date.now()) return false;
      records.set(key, { ciphertext, expiresAtMs }); return true;
    },
  };
  const config = { allowLocalHttp: true, features: { tasks: true, callbacks: true }, clients: [{ id: 'task-agent', token: serviceToken, allow: ['async__*'], callbackMethods: ['elicitation/create'] }], upstreams: [{ id: 'async', url: `${upstream}/mcp` }] };
  const first = await listen(createGateway(config, { stateKey, taskStore }), t);
  const second = await listen(createGateway(config, { stateKey, taskStore }), t);
  const client = await clientFor(first, t);
  assert.deepEqual(client.client.getServerCapabilities()?.extensions?.[TASKS_EXTENSION_ID_V2], {});
  const result = CreateTaskResultV2Schema.parse(await rawRequest(client, 'tools/call', withTaskCapabilityV2({ name: 'async__long_job', arguments: { secret: 'never expose in task DB' } })));
  assert.equal(result.taskId, result.taskId.trim());
  assert.notEqual(result.taskId, upstreamId);
  assert.match(result.taskId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(records.size, 1);
  const stored = [...records.values()][0];
  assert.ok(!stored.ciphertext.includes(upstreamId));
  assert.ok(!stored.ciphertext.includes('never expose in task DB'));

  const otherReplica = await clientFor(second, t);
  const got = GetTaskResultV2Schema.parse(await rawRequest(otherReplica, 'tasks/get', { taskId: result.taskId }, { 'Mcp-Name': result.taskId }, { elicitation: { form: {} } }));
  assert.equal(got.taskId, result.taskId);
  assert.equal(got.status, 'input_required');
  assert.equal(headersSeen.at(-1), upstreamId, 'gateway must replace public routing hint with upstream task ID');
  const inputResponse = { confirm: { action: 'accept', content: { confirm: true } } };
  const firstUpdate = rawRequest(otherReplica, 'tasks/update', { taskId: result.taskId, inputResponses: inputResponse }, { 'Mcp-Name': result.taskId }, { elicitation: { form: {} } });
  await updateStarted;
  const secondUpdate = rawRequest(client, 'tasks/update', { taskId: result.taskId, inputResponses: inputResponse }, { 'Mcp-Name': result.taskId }, { elicitation: { form: {} } });
  await assert.rejects(rawRequest(client, 'tasks/update', { taskId: result.taskId, inputResponses: { confirm: { action: 'accept', content: { confirm: false } } } }, { 'Mcp-Name': result.taskId }, { elicitation: { form: {} } }), /conflicts with an in-flight response/i);
  await new Promise(resolve => setTimeout(resolve, 100));
  releaseUpdate();
  const concurrentUpdates = await Promise.all([firstUpdate, secondUpdate]);
  concurrentUpdates.forEach(value => UpdateTaskResultV2Schema.parse(value));
  assert.equal(updateCalls, 1, 'a cross-replica callback response is forwarded once');
  UpdateTaskResultV2Schema.parse(await rawRequest(otherReplica, 'tasks/update', { taskId: result.taskId, inputResponses: inputResponse }, { 'Mcp-Name': result.taskId }, { elicitation: { form: {} } }));
  UpdateTaskResultV2Schema.parse(await rawRequest(otherReplica, 'tasks/update', { taskId: result.taskId, inputResponses: { unknown: { action: 'accept' } } }, { 'Mcp-Name': result.taskId }, { elicitation: { form: {} } }));
  assert.equal(updateCalls, 1, 'replayed and unknown input response keys are acknowledged without forwarding');
  const completed = GetTaskResultV2Schema.parse(await rawRequest(otherReplica, 'tasks/get', { taskId: result.taskId }, { 'Mcp-Name': result.taskId }, { elicitation: { form: {} } }));
  assert.equal(completed.status, 'completed');
  CancelTaskResultV2Schema.parse(await rawRequest(otherReplica, 'tasks/cancel', { taskId: result.taskId }, { 'Mcp-Name': result.taskId }));
  assert.equal(headersSeen.at(-1), upstreamId);
});

test('MCP Tasks reject a different caller and mismatched routing hint', async t => {
  const upstream = await listen(fixture(() => {
    const server = new TaskAwareServer({ name: 'async-tool', version: '1' }, { capabilities: { tools: {}, extensions: { [TASKS_EXTENSION_ID_V2]: {} } } });
    server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'long_job', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }));
    server.setRequestHandler('tools/call', async () => ({ resultType: 'task', taskId: 'opaque-backend-id', status: 'working', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttlMs: 60000 }));
    server.setRequestHandler('tasks/get', { params: GetTaskRequestV2Schema.shape.params, result: GetTaskResultV2Schema }, async params => ({ taskId: params.taskId, status: 'working', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttlMs: 30000 }));
    return server;
  }, []), t);
  const records = new Map(), taskStore = {
    async putMcpTask(k, ciphertext, expiresAtMs) { records.set(k, { ciphertext, expiresAtMs }); },
    async getMcpTask(k) { return records.get(k); },
    async compareAndSetMcpTask(k, expectedCiphertext, ciphertext, expiresAtMs) {
      const current = records.get(k);
      if (!current || current.ciphertext !== expectedCiphertext || current.expiresAtMs <= Date.now()) return false;
      records.set(k, { ciphertext, expiresAtMs }); return true;
    },
  };
  let policyAllowed = true;
  const config = { allowLocalHttp: true, features: { tasks: true }, clients: [{ id: 'placeholder', token: serviceToken, tenantId: 'team', allow: ['async__*'] }], upstreams: [{ id: 'async', tenantId: 'team', url: `${upstream}/mcp` }] };
  const url = await listen(createGateway(config, { stateKey, taskStore, authorizer: { canCall: async () => policyAllowed }, authenticator: { authenticate: async token => token === serviceToken ? { id: 'same-agent', tenantId: 'team', subject: 'alice', allow: ['async__*'] } : token === `${serviceToken}-bob` ? { id: 'same-agent', tenantId: 'team', subject: 'bob', allow: ['async__*'] } : undefined } }), t);
  const alice = await clientFor(url, t), bob = await clientFor(url, t, `${serviceToken}-bob`);
  const result = CreateTaskResultV2Schema.parse(await rawRequest(alice, 'tools/call', withTaskCapabilityV2({ name: 'async__long_job', arguments: {} })));
  policyAllowed = false;
  await assert.rejects(rawRequest(alice, 'tasks/get', { taskId: result.taskId }), /task unavailable/i);
  policyAllowed = true;
  const mismatchedHeader = await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tasks/get', 'Mcp-Name': 'different-task-id' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9001, method: 'tasks/get', params: { taskId: result.taskId } }) });
  assert.equal(mismatchedHeader.status, 400, 'conflicting routing header and body must be rejected');
  await assert.rejects(rawRequest(bob, 'tasks/get', { taskId: result.taskId }, { 'Mcp-Name': result.taskId }), /task unavailable/i);
});

test('MCP task input claims recover after an ambiguous upstream failure without changing the response', async t => {
  let failFirstUpdate = true, updateCalls = 0, updated = false;
  const upstream = await listen(fixture(() => {
    const server = new TaskAwareServer({ name: 'async-tool', version: '1' }, { capabilities: { tools: {}, extensions: { [TASKS_EXTENSION_ID_V2]: {} } } });
    server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'long_job', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }));
    server.setRequestHandler('tools/call', async () => ({ resultType: 'task', taskId: 'backend-retry-task', status: 'working', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttlMs: 60000 }));
    server.setRequestHandler('tasks/get', { params: GetTaskRequestV2Schema.shape.params, result: GetTaskResultV2Schema }, async params => updated
      ? ({ taskId: params.taskId, status: 'completed', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttlMs: 30000, result: { content: [{ type: 'text', text: 'done' }] } })
      : ({ taskId: params.taskId, status: 'input_required', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttlMs: 30000, inputRequests: { confirm: { method: 'elicitation/create', params: { mode: 'form', message: 'Confirm', requestedSchema: { type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'] } } } } }));
    server.setRequestHandler('tasks/update', { params: GetTaskRequestV2Schema.shape.params, result: UpdateTaskResultV2Schema }, async () => {
      updateCalls++;
      if (failFirstUpdate) { failFirstUpdate = false; throw new Error('temporary upstream failure'); }
      updated = true; return { resultType: 'complete' };
    });
    return server;
  }, []), t);
  const records = new Map(), taskStore = {
    async putMcpTask(key, ciphertext, expiresAtMs) { records.set(key, { ciphertext, expiresAtMs }); },
    async getMcpTask(key) { const value = records.get(key); return value?.expiresAtMs > Date.now() ? value : undefined; },
    async compareAndSetMcpTask(key, expectedCiphertext, ciphertext, expiresAtMs) {
      const current = records.get(key);
      if (!current || current.ciphertext !== expectedCiphertext || current.expiresAtMs <= Date.now()) return false;
      records.set(key, { ciphertext, expiresAtMs }); return true;
    },
  };
  const config = { allowLocalHttp: true, features: { tasks: true, callbacks: true }, clients: [{ id: 'task-agent', token: serviceToken, allow: ['async__*'], callbackMethods: ['elicitation/create'] }], upstreams: [{ id: 'async', url: `${upstream}/mcp` }] };
  const url = await listen(createGateway(config, { stateKey, taskStore }), t);
  const connection = await clientFor(url, t);
  const result = CreateTaskResultV2Schema.parse(await rawRequest(connection, 'tools/call', withTaskCapabilityV2({ name: 'async__long_job', arguments: {} })));
  await rawRequest(connection, 'tasks/get', { taskId: result.taskId }, { 'Mcp-Name': result.taskId }, { elicitation: { form: {} } });
  const response = { confirm: { action: 'accept', content: { accepted: true } } };
  await assert.rejects(rawRequest(connection, 'tasks/update', { taskId: result.taskId, inputResponses: response }, { 'Mcp-Name': result.taskId }, { elicitation: { form: {} } }));
  assert.equal(updateCalls, 1);

  const principal = { id: 'task-agent', allow: ['async__*'], callbackMethods: ['elicitation/create'], authScheme: 'api-key' };
  const codec = new McpTaskCodec(stateKey), storageKey = taskStorageKey(result.taskId), stored = records.get(storageKey);
  const state = codec.open(stored.ciphertext, principal);
  assert.equal(state.pendingInputClaims.confirm.response.content.accepted, true);
  state.pendingInputClaims.confirm.leaseUntilMs = Date.now() - 1;
  records.set(storageKey, { ...stored, ciphertext: codec.seal(state, principal) });

  UpdateTaskResultV2Schema.parse(await rawRequest(connection, 'tasks/update', { taskId: result.taskId, inputResponses: response }, { 'Mcp-Name': result.taskId }, { elicitation: { form: {} } }));
  assert.equal(updateCalls, 2, 'the identical response is retried after its durable claim expires');
  assert.equal((await GetTaskResultV2Schema.parse(await rawRequest(connection, 'tasks/get', { taskId: result.taskId }, { 'Mcp-Name': result.taskId }, { elicitation: { form: {} } }))).status, 'completed');
});
