import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const { port } = address;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('public cloud demo exposes and authorizes only its echo tool', async t => {
  const [port, alphaPort, betaPort] = await Promise.all([freePort(), freePort(), freePort()]);
  assert.equal(new Set([port, alphaPort, betaPort]).size, 3);
  const child = spawn(process.execPath, ['dist/cloud-demo.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DEMO_ALPHA_PORT: String(alphaPort), DEMO_BETA_PORT: String(betaPort), GATEWAY_ADMIN_KEY: 'test-admin-key-that-is-long-enough-123', DEMO_TOKEN: 'test-public-echo-token-123456' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const base = `http://localhost:${port}`;
  let client;
  t.after(async () => {
    if (client) await client.close().catch(() => {});
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  });

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) assert.fail(`cloud demo exited during startup: ${stderr}`);
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, `cloud demo did not become healthy: ${stderr}`);
  const readiness = await fetch(`${base}/readyz`);
  assert.equal(readiness.status, 200, `cloud demo is not ready: ${readiness.status} ${await readiness.text()}`);

  const probe = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-public-echo-token-123456',
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'server/discover'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'cloud-demo-smoke', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {}
    } } })
  });
  assert.equal(probe.status, 200, `discovery probe failed: ${probe.status} ${await probe.text()}`);

  client = new Client({ name: 'cloud-demo-smoke', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: 'Bearer test-public-echo-token-123456' } } }));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['echo']);
  const echo = await client.callTool({ name: 'echo', arguments: { text: 'safe public sample' } });
  assert.equal(echo.isError, undefined);
  assert.match(JSON.stringify(echo), /safe public sample/);
  await assert.rejects(client.callTool({ name: 'alpha__echo', arguments: { text: 'must not escape demo scope' } }));
});
