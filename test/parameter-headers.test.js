import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import express from 'express';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createGateway } from '../dist/gateway.js';
import { parameterDeclarations, parameterHeaders, validateParameterHeaders } from '../dist/parameter-headers.js';
import { listen, serviceToken } from './helpers.js';

const schema = { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' }, nested: { type: 'object', properties: { count: { type: 'integer', 'x-mcp-header': 'Count' }, enabled: { type: 'boolean', 'x-mcp-header': 'Enabled' } } } } };
test('parameter headers encode exact nested primitives and reject malformed declarations and unsafe values', () => {
  const args = { region: 'Hello, 世界\n', nested: { count: 42, enabled: false } };
  const headers = parameterHeaders(schema, args); assert.equal(headers['Mcp-Param-Count'], '42'); assert.equal(headers['Mcp-Param-Enabled'], 'false'); assert.ok(headers['Mcp-Param-Region'].startsWith('=?base64?'));
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  validateParameterHeaders(schema, args, { ...lower, 'mcp-param-count': '42.0' });
  for (const incoming of [{}, { ...lower, 'mcp-param-count': '43' }, { ...lower, 'mcp-param-region': '=?base64?%%%?=' }, { ...lower, 'mcp-param-region': '=?base64?/w==?=' }]) assert.throws(() => validateParameterHeaders(schema, args, incoming), /does not match/);
  assert.deepEqual(parameterHeaders(schema, {}), {});
  assert.throws(() => parameterHeaders(schema, { nested: { count: Number.MAX_SAFE_INTEGER + 1 } }), /invalid/);
  const invalid = [
    { type: 'object', properties: { x: { type: 'number', 'x-mcp-header': 'X' } } },
    { type: 'object', properties: { x: { type: 'string', 'x-mcp-header': 'X' }, y: { type: 'integer', 'x-mcp-header': 'x' } } },
    { type: 'object', allOf: [{ properties: { x: { type: 'string', 'x-mcp-header': 'X' } } }] },
    { type: 'object', properties: { x: { type: 'string', 'x-mcp-header': 'Bad\r\nName' } } }
  ];
  for (const value of invalid) assert.throws(() => parameterDeclarations(value), /invalid/);
});

test('gateway mirrors parameter headers upstream and rejects mismatched modern ingress before execution', async t => {
  const received = []; let invoked = 0;
  const tool = { name: 'regional', inputSchema: schema };
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'headers', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: [tool, { name: 'invalid', inputSchema: { type: 'object', properties: { x: { type: 'number', 'x-mcp-header': 'X' } } } }] }));
    server.setRequestHandler('tools/call', async () => { invoked++; return { content: [{ type: 'text', text: 'ok' }] }; }); return server;
  }); t.after(() => handler.close());
  const app = express(); app.use(express.json()); app.all('/mcp', (req, res) => { if (req.body?.method === 'tools/call') received.push(req.headers); return toNodeHandler(handler)(req, res, req.body); });
  const upstream = await listen(app, t), url = await listen(createGateway({ allowLocalHttp: true, clients: [{ id: 'one', token: serviceToken, allow: ['u__*'] }], upstreams: [{ id: 'u', url: `${upstream}/mcp` }] }), t);
  const client = new Client({ name: 'headers', version: '1' }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['u__regional']);
  const args = { region: 'Hello, 世界', nested: { count: 0, enabled: false } };
  assert.equal((await client.callTool({ name: 'u__regional', arguments: args })).content[0].text, 'ok');
  assert.equal(received[0]['mcp-param-count'], '0'); assert.equal(received[0]['mcp-param-enabled'], 'false');
  assert.equal(received[0]['mcp-param-region'], parameterHeaders(schema, args)['Mcp-Param-Region']);
  const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'u__regional', 'Mcp-Param-Region': 'wrong', 'Mcp-Param-Count': '0', 'Mcp-Param-Enabled': 'false' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'u__regional', arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, -32020); assert.equal(invoked, 1);
  const duplicateBody = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'u__regional', arguments: { region: 'a, b' }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } });
  const duplicate = await new Promise((resolve, reject) => {
    const call = httpRequest(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(duplicateBody), Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'u__regional', 'Mcp-Param-Region': ['a', 'b'] } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    }); call.on('error', reject); call.end(duplicateBody);
  });
  assert.equal(duplicate.status, 400); assert.equal(duplicate.body.error.code, -32020); assert.equal(invoked, 1);
});
