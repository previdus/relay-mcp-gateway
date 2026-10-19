import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGateway, validateConfig } from '../dist/gateway.js';
import { createDemoServer } from '../dist/demo-server.js';
import { createModernDemoServer } from '../dist/demo-modern.js';
import express from 'express';

const token = 'test-only-key-at-least-24-characters';
async function listen(app, t) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t, allow = ['alpha__*', 'beta__*']) {
  const a = await listen(createDemoServer('alpha'), t);
  const b = await listen(createDemoServer('beta'), t);
  const events = [];
  const config = { allowLocalHttp: true, clients: [{ id: 'tester', token, allow }], upstreams: [{ id: 'alpha', url: `${a}/mcp` }, { id: 'beta', url: `${b}/mcp` }] };
  const url = await listen(createGateway(config, { audit: async e => { events.push(e); } }), t);
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  return { client, url, events };
}
test('discovers colliding tool names and routes to the correct upstream', async t => {
  const { client, events } = await setup(t);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(x => x.name).sort(), ['alpha__echo', 'beta__echo']);
  for (const label of ['alpha', 'beta']) {
    const result = await client.callTool({ name: `${label}__echo`, arguments: { text: 'secret-payload' } });
    assert.equal(result.content[0].text, `${label}: secret-payload`);
  }
  assert.ok(events.some(e => e.method === 'tools/call' && e.outcome === 'ok'));
  assert.ok(!JSON.stringify(events).includes('secret-payload'));
  assert.ok(!JSON.stringify(events).includes(token));
});
test('demo alias routes across legacy and modern upstreams with one stable tool contract', async t => {
  const alpha = await listen(createDemoServer('alpha'), t);
  const beta = await listen(createModernDemoServer('beta'), t);
  const config = {
    allowLocalHttp: true,
    clients: [{ id: 'demo', token, allow: ['echo'] }],
    upstreams: [{ id: 'alpha', url: `${alpha}/mcp` }, { id: 'beta', url: `${beta}/mcp` }],
    routes: [{ name: 'echo', strategy: 'sticky', targets: [{ upstreamId: 'alpha', tool: 'echo' }, { upstreamId: 'beta', tool: 'echo' }] }],
  };
  const url = await listen(createGateway(config), t);
  const client = new Client({ name: 'demo-alias-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['echo']);
  assert.match((await client.callTool({ name: 'echo', arguments: { text: 'deployment verified' } })).content[0].text, /^(alpha|beta): deployment verified$/);
});
test('filters discovery and rejects a direct unauthorized call', async t => {
  const { client, events } = await setup(t, ['alpha__echo']);
  assert.deepEqual((await client.listTools()).tools.map(x => x.name), ['alpha__echo']);
  await assert.rejects(client.callTool({ name: 'beta__echo', arguments: { text: 'blocked' } }), /forbidden/);
  assert.ok(events.some(e => e.outcome === 'denied'));
});
test('rejects missing authentication, browser origins and malformed JSON', async t => {
  const { url } = await setup(t);
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
});
test('validates upstream destinations and credentials', () => {
  const config = { clients: [{ id: 'test', token, allow: [] }], upstreams: [{ id: 'alpha', url: 'http://169.254.169.254/mcp' }] };
  assert.throws(() => validateConfig(config), /HTTPS/);
  assert.throws(() => validateConfig({ ...config, upstreams: [], clients: [{ id: 'test', token: 'weak', allow: [] }] }), /Invalid client/);
});
test('unavailable upstream yields a bounded tool error without retry', async t => {
  const dead = await listen(createGateway({ clients: [{ id: 'test', token, allow: [] }], upstreams: [] }), t);
  const config = { allowLocalHttp: true, timeoutMs: 150, clients: [{ id: 'test', token, allow: ['dead__*'] }], upstreams: [{ id: 'dead', url: `${dead}/missing` }] };
  const url = await listen(createGateway(config), t);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  const result = await client.callTool({ name: 'dead__echo', arguments: {} });
  assert.equal(result.isError, true);
  assert.deepEqual((await client.listTools()).tools, []);
});
test('stalled upstream times out and concurrent requests are limited', async t => {
  const slow = express();
  slow.post('/mcp', () => {});
  const upstream = await listen(slow, t);
  const config = { allowLocalHttp: true, timeoutMs: 200, maxConcurrentPerClient: 1, clients: [{ id: 'test', token, allow: ['slow__*'] }], upstreams: [{ id: 'slow', url: `${upstream}/mcp` }] };
  const url = await listen(createGateway(config), t);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  const started = Date.now();
  const call = client.callTool({ name: 'slow__echo', arguments: {} });
  await new Promise(resolve => setTimeout(resolve, 50));
  const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 123, method: 'tools/list' }) });
  assert.equal(response.status, 429);
  assert.equal((await call).isError, true);
  assert.ok(Date.now() - started < 2000);
});

