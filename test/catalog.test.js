import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createGateway } from '../dist/gateway.js';
import { collectCatalog } from '../dist/catalog.js';
import { listen, serviceToken } from './helpers.js';

async function fixture(t, changes = {}, plugins = {}) {
  const state = { tools: Array.from({ length: 7 }, (_, i) => ({ name: `t${i}`, description: `Useful catalog entry ${i}`, inputSchema: { type: 'object' } })), requests: 0 };
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'catalog', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async ({ params }) => { const offset = Number(params?.cursor ?? 0); return { tools: state.tools.slice(offset, offset + 3), ...(offset + 3 < state.tools.length ? { nextCursor: String(offset + 3) } : {}) }; });
    return server;
  }); t.after(() => handler.close());
  const upstream = express(); upstream.use(express.json()); upstream.all('/mcp', (req, res) => { state.requests++; return toNodeHandler(handler)(req, res, req.body); });
  const upstreamUrl = await listen(upstream, t);
  const principal = { id: 'one', token: serviceToken, allow: ['u__*'] };
  const config = { allowLocalHttp: true, clients: [principal, { ...principal, id: 'two', token: `${serviceToken}-two` }, { id: 'limited', token: `${serviceToken}-limited`, allow: ['u__t0'] }], upstreams: [{ id: 'u', url: `${upstreamUrl}/mcp` }], discovery: { pageSize: 2 }, features: { catalogSearch: true }, ...changes };
  const url = await listen(createGateway(config, plugins), t);
  async function clientFor(base = url, token = serviceToken) { const client = new Client({ name: 'catalog-test', version: '1' }); t.after(() => client.close()); await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })); return client; }
  const search = (body, token = serviceToken) => fetch(`${url}/catalog/search`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { url, config, state, clientFor, search };
}

test('standard catalog pagination is stateless across replicas and bound to identity, revision and metadata', async t => {
  const { url, config, state, clientFor } = await fixture(t, {}, { configurationRevision: 1 });
  const second = await listen(createGateway(config, { configurationRevision: 1 }), t);
  const client = await clientFor(url), replica = await clientFor(second);
  const first = await client.request({ method: 'tools/list', params: {} }); assert.equal(first.tools.length, 2); assert.ok(first.nextCursor);
  const names = first.tools.map(t => t.name); let cursor = first.nextCursor;
  while (cursor) { const page = await replica.request({ method: 'tools/list', params: { cursor } }); names.push(...page.tools.map(t => t.name)); cursor = page.nextCursor; }
  assert.deepEqual(names, Array.from({ length: 7 }, (_, i) => `u__t${i}`));
  const other = await clientFor(url, `${serviceToken}-two`);
  await assert.rejects(other.listTools({ cursor: first.nextCursor }), /invalid or stale/);
  const changed = await listen(createGateway(config, { configurationRevision: 2 }), t);
  await assert.rejects((await clientFor(changed)).listTools({ cursor: first.nextCursor }), /invalid or stale/);
  state.tools[0] = { ...state.tools[0], description: 'Changed metadata' };
  await assert.rejects(replica.listTools({ cursor: first.nextCursor }), /invalid or stale/);
  await assert.rejects(client.listTools({ cursor: 'not-json' }), /invalid or stale/);
});

test('authorized search is literal, paginated and cannot disclose another identity catalog', async t => {
  const { search } = await fixture(t);
  assert.equal((await search({ query: 'catalog' }, 'bad')).status, 401);
  const first = await (await search({ query: 'catalog', limit: 2 })).json(); assert.equal(first.tools.length, 2); assert.equal(first.tools[0].inputSchema, undefined);
  const full = await (await search({ query: 'catalog', limit: 2, detail: 'full' })).json(); assert.ok(full.tools[0].inputSchema);
  assert.equal((await search({ query: 'entry', limit: 2, cursor: first.nextCursor })).status, 400);
  assert.equal((await search({ query: 'catalog', limit: 2, cursor: first.nextCursor }, `${serviceToken}-two`)).status, 400);
  const limited = await (await search({ query: 'catalog' }, `${serviceToken}-limited`)).json(); assert.deepEqual(limited.tools.map(t => t.name), ['u__t0']);
  assert.deepEqual((await (await search({ query: 't6' }, `${serviceToken}-limited`)).json()).tools, []);
  assert.deepEqual((await (await search({ query: '.*' })).json()).tools, [], 'query is not an executable regular expression');
  assert.equal((await search({ query: 'x'.repeat(129) })).status, 400);
});

test('aggregate tool, scan and byte overflows fail explicitly rather than publishing a truncated catalog', async t => {
  for (const discovery of [{ maxTools: 2 }, { maxScannedTools: 2 }, { maxBytes: 1024 }]) {
    const f = await fixture(t, { discovery });
    if (discovery.maxBytes) f.state.tools[0].description = 'x'.repeat(2000);
    await assert.rejects((await f.clientFor()).listTools(), /discovery limits/);
    const response = await f.search({ query: 't0' }); assert.equal(response.status, 503); assert.equal((await response.json()).tools, undefined);
  }
});

test('catalog collection bounds parallel upstream work and cancels collection on budget exhaustion', async () => {
  const principal = { id: 'one', token: serviceToken, allow: [] };
  const config = { clients: [principal], upstreams: Array.from({ length: 8 }, (_, i) => ({ id: `u${i}`, url: `https://u${i}.example/mcp` })), discovery: { concurrency: 2 } };
  let active = 0, maximum = 0, started = 0;
  const collect = config => collectCatalog({ config, principal, context: { principal, requestId: 'bounded' }, router: { names: id => [`${id}__t`], resolve: () => undefined }, signal: new AbortController().signal, canCall: async () => true, onRejected: async () => {}, onFailure: async () => {}, execute: async (_u, operation, signal) => {
    active++; started++; maximum = Math.max(maximum, active);
    try { await new Promise(r => setTimeout(r, 10)); signal.throwIfAborted(); return await operation({ request: async () => ({ tools: [{ name: 't', inputSchema: { type: 'object' } }] }) }, { signal, timeout: 100 }); }
    finally { active--; }
  } });
  assert.equal((await collect(config)).length, 8); assert.equal(maximum, 2);
  started = 0; await assert.rejects(collect({ ...config, discovery: { concurrency: 2, maxTools: 2 } }), /discovery limits/);
  assert.ok(started <= 4); assert.equal(active, 0);
});

test('routed aliases publish only when every eligible target has the same full contract', async () => {
  const principal = { id: 'agent', allow: ['*'] };
  const config = { clients: [principal], upstreams: [{ id: 'a', url: 'https://a.example/mcp' }, { id: 'b', url: 'https://b.example/mcp' }], routes: [{ name: 'echo', strategy: 'priority', targets: [{ upstreamId: 'a', tool: 'echo' }, { upstreamId: 'b', tool: 'echo' }] }] };
  const collect = async schemas => {
    const rejected = [];
    const tools = await collectCatalog({ config, principal, context: { principal, requestId: 'contracts' }, router: { names: id => [`${id}__echo`, 'echo'], resolve: () => undefined }, signal: new AbortController().signal, canCall: async () => true, onRejected: async (_upstream, name, error) => rejected.push([name, error.message]), onFailure: async () => {}, execute: async (upstream, operation, signal) => operation({ request: async () => ({ tools: schemas[upstream.id] === undefined ? [] : [{ name: 'echo', description: 'Echo text', inputSchema: schemas[upstream.id] }] }) }, { signal, timeout: 100 }) });
    return { names: tools.map(tool => tool.name).sort(), rejected };
  };
  const first = { type: 'object', properties: { text: { type: 'string' }, count: { type: 'integer' } }, required: ['text'] };
  const reordered = { required: ['text'], properties: { count: { type: 'integer' }, text: { type: 'string' } }, type: 'object' };
  assert.deepEqual((await collect({ a: first, b: reordered })).names, ['a__echo', 'b__echo', 'echo']);
  const incompatible = await collect({ a: first, b: { type: 'object', properties: { text: { type: 'number' } }, required: ['text'] } });
  assert.deepEqual(incompatible.names, ['a__echo', 'b__echo']);
  assert.match(incompatible.rejected[0][1], /contracts differ/);
  const unavailable = await collect({ a: first });
  assert.deepEqual(unavailable.names, ['a__echo']);
  assert.match(unavailable.rejected[0][1], /unavailable/);
});

test('catalog search requires durable admission before touching upstreams and remains opt-in', async t => {
  const f = await fixture(t, {}, { requireAudit: true, audit: async () => { throw new Error('audit offline'); } });
  assert.equal((await f.search({ query: 'catalog' })).status, 503); assert.equal(f.state.requests, 0);
  const disabled = await fixture(t, { features: {} }); assert.equal((await disabled.search({ query: 'catalog' })).status, 404); assert.equal(disabled.state.requests, 0);
});
