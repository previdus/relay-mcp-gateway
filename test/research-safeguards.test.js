import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createGateway } from '../dist/gateway.js';
import { loadConfig } from '../dist/config.js';
import { enforceInvocation, invocationPoliciesSchema } from '../dist/invocation-policy.js';
import { contractFingerprint, enforceContract } from '../dist/contracts.js';
import { listen, serviceToken, document } from './helpers.js';

const principal = { id: 'one', token: serviceToken, allow: ['bank__*', 'pay'], tenantId: 'acme', subject: 'user-42' };
const restriction = { allow: [{ clients: ['one'], constraints: [
  { field: ['recipient'], op: 'oneOf', values: ['approved@example.test'] },
  { field: ['amount'], op: 'numberRange', min: 1, max: 100 },
  { field: ['account', 'tenant'], op: 'matchesIdentity', claim: 'tenantId' }
] }] };
const valid = { recipient: 'approved@example.test', amount: 50, account: { tenant: 'acme' } };

async function fixture(t, extra = {}, plugins = {}) {
  const state = { calls: [], requests: 0, tool: { name: 'transfer', description: 'Send a payment', inputSchema: { type: 'object', properties: { recipient: { type: 'string' }, amount: { type: 'number' }, account: { type: 'object' } }, required: ['recipient', 'amount', 'account'] } } };
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'bank', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: [state.tool] }));
    server.setRequestHandler('tools/call', async ({ params }) => { state.calls.push(params.arguments); return { content: [{ type: 'text', text: 'payment recorded' }] }; });
    return server;
  });
  t.after(() => handler.close());
  const app = express(); app.use(express.json()); app.all('/mcp', (req, res) => { state.requests++; return toNodeHandler(handler)(req, res, req.body); });
  const upstream = await listen(app, t), events = [];
  const config = { allowLocalHttp: true, clients: [principal], upstreams: [{ id: 'bank', url: `${upstream}/mcp`, tenantId: 'acme' }], routes: [{ name: 'pay', strategy: 'sticky', targets: [{ upstreamId: 'bank', tool: 'transfer' }] }], ...extra };
  const url = await listen(createGateway(config, { ...plugins, audit: async e => { events.push(e); } }), t);
  const client = new Client({ name: 'security-regression', version: '1' }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
  return { state, client, events, url };
}

test('physical definition pins also constrain unpinned aliases during discovery and execution', async t => {
  const original = { name: 'transfer', description: 'Send a payment', inputSchema: { type: 'object', properties: { recipient: { type: 'string' }, amount: { type: 'number' }, account: { type: 'object' } }, required: ['recipient', 'amount', 'account'] } };
  const { client, state } = await fixture(t, { toolContracts: { bank__transfer: contractFingerprint(original) } });
  assert.equal((await client.listTools()).tools.length, 2);
  state.tool = { ...state.tool, description: 'Changed after review' };
  assert.deepEqual((await client.listTools()).tools, []);
  for (const name of ['pay', 'bank__transfer']) await assert.rejects(client.callTool({ name, arguments: valid }), /definition changed/);
  assert.equal(state.calls.length, 0);
});

test('trusted inspectors receive immutable credential-free snapshots and can only narrow grants', async t => {
  const phases = [];
  const { client, state } = await fixture(t, {}, { inspectors: [{ id: 'recipient-check', beforeCall: context => {
    phases.push('before'); assert.equal(context.principal.token, undefined); assert.equal(Object.isFrozen(context.arguments.account), true);
    assert.equal(context.upstreamTool, 'transfer'); assert.equal(context.requestedTool, 'pay');
    return context.arguments.recipient === 'approved@example.test' ? 'allow' : 'deny';
  }, afterCall: context => { phases.push('after'); assert.equal(Object.isFrozen(context.result), true); return 'allow'; } }] });
  await assert.rejects(client.callTool({ name: 'pay', arguments: { ...valid, recipient: 'attacker@example.test' } }), /inspection/);
  assert.equal(state.requests, 0);
  assert.equal((await client.callTool({ name: 'pay', arguments: valid })).content[0].text, 'payment recorded');
  assert.deepEqual(state.calls, [valid]); assert.deepEqual(phases, ['before', 'before', 'after']);
});

test('inspection timeout and malformed decisions fail closed without upstream effects', async t => {
  let aborted = false;
  const timed = await fixture(t, { inspectionTimeoutMs: 25 }, { inspectors: [{ id: 'stalled', beforeCall: ({ signal }) => { signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); } }] });
  await assert.rejects(timed.client.callTool({ name: 'pay', arguments: valid }), /inspection unavailable/);
  assert.equal(aborted, true); assert.equal(timed.state.requests, 0);
  for (const verdict of [true, undefined, { allow: true }]) {
    const malformed = await fixture(t, {}, { inspectors: [{ id: 'malformed', beforeCall: () => verdict }] });
    await assert.rejects(malformed.client.callTool({ name: 'pay', arguments: valid }), /inspection/);
    assert.equal(malformed.state.calls.length, 0);
  }
});

test('withholding a result does not retry or claim to undo the upstream action', async t => {
  const { client, state, events } = await fixture(t, {}, { inspectors: [{ id: 'output-boundary', afterCall: () => 'deny' }] });
  await assert.rejects(client.callTool({ name: 'pay', arguments: valid }), /Result withheld.*may already have completed/);
  assert.deepEqual(state.calls, [valid]);
  assert.ok(events.some(e => e.method === 'tools/call' && e.outcome === 'denied'));
  assert.equal(JSON.stringify(events).includes('approved@example.test'), false);
});

test('inspection composes in order, isolates concurrent calls and cannot bypass core policy', async t => {
  let checked = 0, last = 0;
  const { client, state } = await fixture(t, { invocationPolicies: { bank__transfer: restriction } }, { inspectors: [
    { id: 'first', beforeCall: async ({ arguments: args }) => { checked++; await new Promise(r => setTimeout(r, 5)); return args.amount <= 75 ? 'allow' : 'deny'; } },
    { id: 'second', beforeCall: () => { last++; return 'allow'; } }
  ] });
  await assert.rejects(client.callTool({ name: 'pay', arguments: { ...valid, recipient: 'attacker@example.test' } }), /argument policy/);
  assert.equal(checked, 0);
  const calls = await Promise.allSettled([50, 80, 70].map(amount => client.callTool({ name: 'pay', arguments: { ...valid, amount } })));
  assert.equal(calls.filter(c => c.status === 'fulfilled').length, 2);
  assert.deepEqual(state.calls.map(c => c.amount).sort(), [50, 70]);
  assert.equal(checked, 3); assert.equal(last, 2);
});

test('inspector exceptions and attempted mutations fail closed before execution', async t => {
  for (const beforeCall of [() => { throw new Error('private classifier detail'); }, context => { context.arguments.account.tenant = 'victim'; return 'allow'; }]) {
    const { client, state } = await fixture(t, {}, { inspectors: [{ id: 'failure', beforeCall }] });
    await assert.rejects(client.callTool({ name: 'pay', arguments: valid }), error => /inspection unavailable/.test(error.message) && !error.message.includes('private classifier detail'));
    assert.equal(state.requests, 0);
  }
});

test('policy configuration rejects unsafe ambiguity through raw and programmatic ingestion', () => {
  const invalid = [
    { allow: [{ constraints: [] }] }, { allow: [{ constraints: [{ field: ['x'], op: 'numberRange' }] }] },
    { allow: [{ constraints: [{ field: ['x'], op: 'numberRange', min: 2, max: 1 }] }] },
    { allow: [{ constraints: [{ field: [], op: 'equals', value: 'x' }] }] },
    { allow: [{ constraints: [{ field: ['x'], op: 'execute', code: 'anything' }] }] },
    { allow: [{ clients: [], constraints: [{ field: ['x'], op: 'equals', value: 'x' }] }] },
    { allow: [], unknown: true }
  ];
  for (const policy of invalid) {
    assert.equal(invocationPoliciesSchema.safeParse({ pay: policy }).success, false);
    assert.throws(() => loadConfig({ ...document, invocationPolicies: { pay: policy } }, { SERVICE_TOKEN: serviceToken }), /Invalid/);
    assert.throws(() => createGateway({ clients: [principal], upstreams: [], invocationPolicies: { pay: policy } }), /Invalid invocation/);
  }
  assert.throws(() => createGateway({ clients: [principal], upstreams: [], catalogPolicy: { requirePinned: 'yes' } }), /Invalid catalog/);
  assert.equal(invocationPoliciesSchema.safeParse({ pay: { allow: [] } }).success, true);
  assert.equal(invocationPoliciesSchema.safeParse({ pay: { allow: [{ constraints: [{ field: ['x'], op: 'equals', value: 'x'.repeat(2049) }] }] } }).success, false);
});

test('literal argument checks fail closed without coercion, inherited fields or absent identity', () => {
  const p = { pay: restriction };
  enforceInvocation(p, ['pay'], principal, valid);
  for (const args of [{ ...valid, amount: '50' }, { ...valid, amount: NaN }, { ...valid, amount: Infinity }, { ...valid, amount: 101 }, { ...valid, account: {} }, { ...valid, account: Object.create({ tenant: 'acme' }) }, { ...valid, recipient: 'approved@example.test.evil' }]) assert.throws(() => enforceInvocation(p, ['pay'], principal, args), /forbidden/);
  for (const claim of ['id', 'tenantId', 'subject']) {
    const policy = { pay: { allow: [{ constraints: [{ field: ['owner'], op: 'matchesIdentity', claim }] }] } };
    enforceInvocation(policy, ['pay'], principal, { owner: principal[claim] });
    assert.throws(() => enforceInvocation(policy, ['pay'], { ...principal, [claim]: undefined }, {}), /forbidden/);
  }
  assert.throws(() => enforceInvocation(p, ['pay'], { ...principal, id: 'other' }, valid), /forbidden/);
  const anyRule = { pay: { allow: [{ constraints: [{ field: ['ok'], op: 'equals', value: true }] }, { constraints: [{ field: ['ok'], op: 'equals', value: null }] }] } };
  enforceInvocation(anyRule, ['pay'], principal, { ok: null });
  assert.throws(() => enforceInvocation(anyRule, ['pay'], principal, {}), /forbidden/);
  assert.throws(() => enforceInvocation({ pay: { allow: [] } }, ['pay'], principal, valid), /forbidden/);
  assert.deepEqual(valid, { recipient: 'approved@example.test', amount: 50, account: { tenant: 'acme' } });
});

test('actual MCP actions preserve legitimate utility and stop recipient, amount, identity and alias attacks', async t => {
  const { client, state, events } = await fixture(t, { invocationPolicies: { bank__transfer: restriction, pay: { allow: [{ constraints: [{ field: ['amount'], op: 'numberRange', max: 75 }] }] } } });
  assert.equal((await client.callTool({ name: 'pay', arguments: valid })).content[0].text, 'payment recorded');
  assert.equal((await client.callTool({ name: 'bank__transfer', arguments: { ...valid, amount: 100 } })).content[0].text, 'payment recorded');
  const before = state.requests;
  for (const [name, arguments_] of [
    ['pay', { ...valid, recipient: 'attacker@example.test' }],
    ['bank__transfer', { ...valid, recipient: 'attacker@example.test' }],
    ['pay', { ...valid, amount: 76 }],
    ['bank__transfer', { ...valid, amount: 101 }],
    ['pay', { ...valid, amount: '50' }],
    ['pay', { ...valid, account: { tenant: 'victim', subject: 'user-42' } }]
  ]) await assert.rejects(client.callTool({ name, arguments: arguments_ }), /argument policy/);
  assert.equal(state.requests, before, 'denials must not open any upstream request');
  assert.deepEqual(state.calls, [valid, { ...valid, amount: 100 }]);
  assert.equal(events.filter(e => e.method === 'tools/call' && e.outcome === 'denied').length, 6);
  assert.equal(JSON.stringify(events).includes('approved@example.test'), false);
});

test('argument rules cannot grant access outside tool permissions', async t => {
  const { client, state } = await fixture(t, { clients: [{ ...principal, allow: [] }], invocationPolicies: { pay: restriction } });
  await assert.rejects(client.callTool({ name: 'pay', arguments: valid }), /forbidden/);
  assert.equal(state.calls.length, 0);
});

test('legacy MCP ingress obeys the same physical tool argument policies', async t => {
  const { Client: LegacyClient } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport: LegacyTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { url, state } = await fixture(t, { invocationPolicies: { bank__transfer: restriction } });
  const legacy = new LegacyClient({ name: 'legacy-policy', version: '1' }); t.after(() => legacy.close());
  await legacy.connect(new LegacyTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
  await assert.rejects(legacy.callTool({ name: 'pay', arguments: { ...valid, amount: 101 } }), /argument policy/);
  assert.equal(state.calls.length, 0);
  assert.equal((await legacy.callTool({ name: 'pay', arguments: valid })).content[0].text, 'payment recorded');
  assert.deepEqual(state.calls, [valid]);
});

test('reviewed-only catalog rejects unpinned definitions in discovery and direct calls', async t => {
  const { client, state, events } = await fixture(t, { catalogPolicy: { requirePinned: true } });
  assert.deepEqual((await client.listTools()).tools, []);
  await assert.rejects(client.callTool({ name: 'bank__transfer', arguments: valid }), /review and pinning/);
  assert.equal(state.calls.length, 0);
  assert.ok(events.some(e => e.method === 'gateway/catalog_rejected'));
});

test('metadata review blocks hidden controls even when pinned and permits ordinary multilingual text', async t => {
  const { client, state } = await fixture(t, { catalogPolicy: { rejectControlCharacters: true } });
  const normal = state.tool;
  state.tool = { ...normal, description: '支付 — café\nReviewed\ttext' };
  assert.equal((await client.listTools()).tools.length, 2);
  for (const description of ['safe\x1b[2Jhidden', 'safe\u202eevil', 'safe\u009b31m']) {
    state.tool = { ...normal, description };
    assert.deepEqual((await client.listTools()).tools, []);
    await assert.rejects(client.callTool({ name: 'pay', arguments: valid }), /display controls/);
    assert.throws(() => enforceContract(state.tool, contractFingerprint(state.tool), { requirePinned: true, rejectControlCharacters: true }), /display controls/);
  }
  assert.equal(state.calls.length, 0);
  state.tool = normal;
  assert.equal((await client.callTool({ name: 'pay', arguments: valid })).content[0].text, 'payment recorded');
});
