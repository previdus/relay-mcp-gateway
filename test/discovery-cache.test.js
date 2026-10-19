import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import express from 'express';
import { createGateway } from '../dist/gateway.js';
import { createDemoServer } from '../dist/demo-server.js';
import { DiscoveryCache } from '../dist/discovery-cache.js';
import { createUpstreamTransport } from '../dist/transports.js';
import { RouteContractCache } from '../dist/route-contract-cache.js';

const firstToken = 'first-client-token-that-is-long-enough';
const secondToken = 'second-client-token-that-is-long-enough';

async function listen(app, t) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('modern upstream discovery is reused only inside the same principal and credential context', async t => {
  let probes = 0;
  const upstream = await listen(createDemoServer('alpha', method => { if (method === 'server/discover') probes++; }), t);
  const config = {
    allowLocalHttp: true,
    clients: [
      { id: 'first', token: firstToken, allow: ['alpha__echo'] },
      { id: 'second', token: secondToken, allow: ['alpha__echo'] },
    ],
    upstreams: [{ id: 'alpha', url: `${upstream}/mcp`, discoveryCacheTtlMs: 5000 }],
  };
  const gateway = await listen(createGateway(config), t);
  async function clientFor(token) {
    const client = new Client({ name: 'discovery-cache-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    t.after(() => client.close());
    return client;
  }
  const first = await clientFor(firstToken);
  const second = await clientFor(secondToken);
  assert.equal((await first.callTool({ name: 'alpha__echo', arguments: { text: 'one' } })).content[0].text, 'alpha: one');
  assert.equal((await first.callTool({ name: 'alpha__echo', arguments: { text: 'two' } })).content[0].text, 'alpha: two');
  assert.equal(probes, 1, 'the second operation should adopt the cached discovery result');
  assert.equal((await second.callTool({ name: 'alpha__echo', arguments: { text: 'three' } })).content[0].text, 'alpha: three');
  assert.equal(probes, 2, 'a different authenticated principal must not share discovery state');
});

test('custom transport plugins bypass protocol discovery caching', async t => {
  let probes = 0;
  const upstream = await listen(createDemoServer('custom', method => { if (method === 'server/discover') probes++; }), t);
  const token = 'custom-transport-test-token-is-long-enough';
  const gateway = await listen(createGateway({
    allowLocalHttp: true,
    clients: [{ id: 'custom-client', token, allow: ['custom__echo'] }],
    upstreams: [{ id: 'custom', url: `${upstream}/mcp`, discoveryCacheTtlMs: 15000 }],
  }, { transportFactory: config => createUpstreamTransport(config, {}) }), t);
  const client = new Client({ name: 'custom-transport-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  await client.callTool({ name: 'custom__echo', arguments: { text: 'one' } });
  await client.callTool({ name: 'custom__echo', arguments: { text: 'two' } });
  assert.equal(probes, 2);
});

test('discovery cache expires entries and enforces its size bound', () => {
  let now = 100;
  const cache = new DiscoveryCache(10, 2, () => now);
  cache.set('a', { kind: 'legacy' });
  cache.set('b', { kind: 'legacy' });
  assert.deepEqual(cache.get('a'), { kind: 'legacy' });
  cache.set('c', { kind: 'legacy' });
  assert.equal(cache.get('b'), undefined, 'least recently used entry should be evicted');
  assert.deepEqual(cache.get('a'), { kind: 'legacy' });
  now = 111;
  assert.equal(cache.get('a'), undefined, 'expired hints must not be reused');
});

test('route contract cache honors the upstream TTL, applies a local freshness cap and evicts by LRU', () => {
  let now = 100;
  const cache = new RouteContractCache(2, 5, () => now);
  cache.set('a', 'contract-a', 1000);
  cache.set('b', 'contract-b', 2);
  assert.equal(cache.get('a'), 'contract-a');
  cache.set('c', 'contract-c', 10);
  assert.equal(cache.get('b'), undefined, 'least-recently-used item is evicted');
  assert.equal(cache.get('a'), 'contract-a');
  now = 106;
  assert.equal(cache.get('a'), undefined, 'local cache lifetime never exceeds the five millisecond cap');
  assert.equal(cache.get('c'), undefined, 'upstream TTL shorter than the cap is still honored');
  cache.set('zero', 'contract-zero', 0);
  assert.equal(cache.size, 0, 'zero-TTL source definitions are never cached');
  const disabled = new RouteContractCache(2, 0, () => now);
  disabled.set('disabled', 'contract', 10);
  assert.equal(disabled.get('disabled'), undefined, 'a zero local cap disables the cache');
});

test('route contract cache configuration accepts disable and rejects unsafe bounds', () => {
  const base = { clients: [{ id: 'config-validation', token: firstToken, allow: [] }], upstreams: [{ id: 'upstream', url: 'https://upstream.example/mcp' }] };
  assert.doesNotThrow(() => createGateway({ ...base, discovery: { routeContractCacheMaxTtlMs: 0 } }));
  assert.throws(() => createGateway({ ...base, discovery: { routeContractCacheMaxTtlMs: -1 } }), /Invalid discovery limits/);
  assert.throws(() => createGateway({ ...base, discovery: { routeContractCacheMaxTtlMs: 60001 } }), /Invalid discovery limits/);
});

async function routedCacheFixture(t, ttlMs, discovery = {}) {
  const states = {};
  const upstreams = [];
  for (const id of ['alpha', 'beta']) {
    const state = states[id] = { listCalls: 0, calls: 0, description: 'Shared echo contract' };
    const handler = createMcpHandler(() => {
      const server = new Server({ name: id, version: '1' }, { capabilities: { tools: {} }, cacheHints: { 'tools/list': { ttlMs, cacheScope: 'private' } } });
      server.setRequestHandler('tools/list', async () => {
        state.listCalls++;
        return { tools: [{ name: 'echo', description: state.description, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
      });
      server.setRequestHandler('tools/call', async ({ params }) => { state.calls++; return { content: [{ type: 'text', text: `${id}: ${params.arguments.text}` }] }; });
      return server;
    });
    t.after(() => handler.close());
    const app = express(); app.use(express.json());
    const node = toNodeHandler(handler);
    app.all('/mcp', (req, res) => void node(req, res, req.body));
    const url = await listen(app, t);
    upstreams.push({ id, url: `${url}/mcp` });
  }
  const config = {
    allowLocalHttp: true,
    clients: [
      { id: 'first', token: firstToken, allow: ['echo'] },
      { id: 'second', token: secondToken, allow: ['echo'] },
    ],
    upstreams,
    discovery,
    routes: [{ name: 'echo', strategy: 'priority', targets: upstreams.map(upstream => ({ upstreamId: upstream.id, tool: 'echo' })) }],
  };
  const gateway = await listen(createGateway(config), t);
  async function clientFor(token) {
    const client = new Client({ name: 'route-contract-cache-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    t.after(() => client.close());
    return client;
  }
  return { clientFor, states };
}

test('positive private MCP TTL caches only eligible target contracts per identity for a bounded period', async t => {
  const { clientFor, states } = await routedCacheFixture(t, 30000);
  const first = await clientFor(firstToken), second = await clientFor(secondToken);
  await first.listTools();
  assert.equal(states.beta.listCalls, 1, 'catalog discovery is independent from invocation contract checks');
  await first.callTool({ name: 'echo', arguments: { text: 'one' } });
  assert.equal(states.beta.listCalls, 2, 'first call reads the secondary target and stores its private positive-TTL contract');
  await first.callTool({ name: 'echo', arguments: { text: 'two' } });
  assert.equal(states.beta.listCalls, 2, 'fresh secondary contract avoids another metadata round trip');
  await second.callTool({ name: 'echo', arguments: { text: 'separate identity' } });
  assert.equal(states.beta.listCalls, 3, 'private contract entries are never shared between callers');
  assert.equal(states.alpha.calls + states.beta.calls, 3, 'each request still invokes exactly one backend');
});

test('zero-TTL MCP contracts remain live-checked on every routed call', async t => {
  const { clientFor, states } = await routedCacheFixture(t, 0);
  const client = await clientFor(firstToken);
  await client.listTools();
  assert.equal(states.beta.listCalls, 1);
  await client.callTool({ name: 'echo', arguments: { text: 'one' } });
  await client.callTool({ name: 'echo', arguments: { text: 'two' } });
  assert.equal(states.beta.listCalls, 3, 'zero-TTL contract is re-fetched on both calls');
});

test('gateway discovery configuration can disable positive-TTL route contract caching', async t => {
  const { clientFor, states } = await routedCacheFixture(t, 30000, { routeContractCacheMaxTtlMs: 0 });
  const client = await clientFor(firstToken);
  await client.listTools();
  await client.callTool({ name: 'echo', arguments: { text: 'one' } });
  await client.callTool({ name: 'echo', arguments: { text: 'two' } });
  assert.equal(states.beta.listCalls, 3, 'operator-selected zero cap keeps every secondary target live-checked');
});

test('a cached secondary contract cannot make a changed selected target execute', async t => {
  const { clientFor, states } = await routedCacheFixture(t, 30000);
  const client = await clientFor(firstToken);
  await client.callTool({ name: 'echo', arguments: { text: 'seed' } });
  assert.equal(states.beta.listCalls, 1, 'secondary contract is cached using its explicit freshness hint');
  states.alpha.description = 'Changed after discovery';
  await assert.rejects(client.callTool({ name: 'echo', arguments: { text: 'must be stopped' } }), /contract/i);
  assert.equal(states.alpha.calls, 1, 'changed selected definition is rejected before tool execution');
});
