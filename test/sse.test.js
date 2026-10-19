import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createGateway } from '../dist/gateway.js';
import { listen, serviceToken } from './helpers.js';

test('modern ingress routes to a legacy HTTP+SSE upstream with independent credentials', async t => {
  const app = express(); app.use(express.json());
  const sessions = new Map(); const seenTokens = [];
  app.get('/sse', async (req, res) => {
    seenTokens.push(req.headers.authorization);
    if (req.headers.authorization !== 'Bearer upstream-only-key') return res.status(401).end();
    const server = new McpServer({ name: 'legacy-sse', version: '1' });
    server.registerTool('echo', {}, async () => ({ content: [{ type: 'text', text: 'from legacy SSE' }] }));
    const transport = new SSEServerTransport('/messages', res);
    sessions.set(transport.sessionId, transport);
    res.on('close', () => { sessions.delete(transport.sessionId); void server.close(); });
    await server.connect(transport);
  });
  app.post('/messages', async (req, res) => {
    if (req.headers.authorization !== 'Bearer upstream-only-key') return res.status(401).end();
    const transport = sessions.get(req.query.sessionId);
    if (!transport) return res.status(404).end();
    await transport.handlePostMessage(req, res, req.body);
  });
  const upstream = await listen(app, t);
  const url = await listen(createGateway({ allowLocalHttp: true, clients: [{ id: 'user1', token: serviceToken, allow: ['legacy__*'] }], upstreams: [{ id: 'legacy', url: `${upstream}/sse`, transport: 'sse', token: 'upstream-only-key' }] }), t);
  const client = new Client({ name: 'modern-client', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools[0].name, 'legacy__echo');
  assert.equal((await client.callTool({ name: 'legacy__echo' })).content[0].text, 'from legacy SSE');
  assert.ok(seenTokens.length >= 2);
  assert.ok(seenTokens.every(token => token === 'Bearer upstream-only-key'));
});
