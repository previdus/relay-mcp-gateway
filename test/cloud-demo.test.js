import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

test('public cloud demo exposes only synthetic product fixtures and safe preview actions', async t => {
  const ports = await Promise.all(Array.from({ length: 13 }, () => freePort()));
  const [port, alphaPort, betaPort, ...integrationPorts] = ports;
  assert.equal(new Set(ports).size, ports.length);
  const child = spawn(process.execPath, ['dist/cloud-demo.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DEMO_ALPHA_PORT: String(alphaPort), DEMO_BETA_PORT: String(betaPort), ...Object.fromEntries(integrationPorts.map((value, index) => [`DEMO_INTEGRATION_${index + 1}_PORT`, String(value)])), GATEWAY_ADMIN_KEY: 'test-admin-key-that-is-long-enough-123', DEMO_TOKEN: 'test-public-echo-token-123456', DEMO_READER_TOKEN: 'test-public-reader-token-123456' },
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
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ['echo', 'enterprise_search', 'jira__search', 'aws__cloudwatch_logs', 'gmail__create_draft', 'slack__post_message', 'drive__read_file', 'logs__query', 'github__list_pull_requests', 'calendar__list_events', 'database__get_record', 'observability__get_trace']) assert.ok(tools.includes(name), `missing public-safe demo tool ${name}`);
  assert.ok(!tools.some(name => name === 'alpha__echo' || name === 'beta__echo'));
  const echo = await client.callTool({ name: 'echo', arguments: { text: 'safe public sample' } });
  assert.equal(echo.isError, undefined);
  assert.match(JSON.stringify(echo), /safe public sample/);
  assert.equal((await client.callTool({ name: 'gmail__create_draft', arguments: { to: 'demo@example.test', subject: 'Test', body: 'Synthetic only' } })).structuredContent.preview, true);
  assert.equal((await client.callTool({ name: 'slack__post_message', arguments: { channel: 'demo', text: 'Synthetic only' } })).structuredContent.preview, true);
  assert.equal((await client.callTool({ name: 'github__preview_review_comment', arguments: { pullRequest: 'PR-204', body: 'Looks good in the demo' } })).structuredContent.posted, false);
  assert.equal((await client.callTool({ name: 'calendar__preview_event', arguments: { title: 'Demo review', start: '2026-10-21T12:00:00Z' } })).structuredContent.invitationSent, false);
  assert.equal((await client.callTool({ name: 'database__get_record', arguments: { recordId: 'order-demo-17' } })).structuredContent.record.status, 'awaiting_review');
  assert.equal((await client.callTool({ name: 'observability__get_trace', arguments: { traceId: 'trace-204' } })).structuredContent.trace.status, 'error');
  assert.equal((await client.callTool({ name: 'enterprise_search', arguments: { query: 'access review' } })).structuredContent.source, 'jira-demo');
  await assert.rejects(client.callTool({ name: 'alpha__echo', arguments: { text: 'must not escape demo scope' } }));

  const reader = new Client({ name: 'cloud-demo-reader', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  t.after(() => reader.close());
  await reader.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: 'Bearer test-public-reader-token-123456' } } }));
  const readerTools = (await reader.listTools()).tools.map(tool => tool.name);
  assert.ok(readerTools.includes('jira__search'));
  assert.ok(readerTools.includes('drive__read_file'));
  assert.ok(readerTools.includes('database__get_record'));
  assert.ok(readerTools.includes('observability__get_trace'));
  assert.ok(!readerTools.includes('jira__create_issue'), 'read-only identity must not discover preview write tools');
  await assert.rejects(reader.callTool({ name: 'jira__create_issue', arguments: { project: 'OPS', summary: 'should be denied' } }), /forbidden|not authorized|denied/i);

  const unauthorized = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer invalid-demo-key', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' }, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }) });
  assert.equal(unauthorized.status, 401, 'invalid credentials fail at the gateway before any demo upstream call');

  const directList = spawnSync(process.execPath, ['scripts/demo-call.js', '--url', `${base}/mcp`, '--token', 'test-public-reader-token-123456', '--list'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(directList.status, 0, directList.stderr);
  assert.match(directList.stdout, /observability__get_trace/);
  const directCall = spawnSync(process.execPath, ['scripts/demo-call.js', '--url', `${base}/mcp`, '--token', 'test-public-reader-token-123456', '--tool', 'jira__search', '--args', '{"query":"checkout"}'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(directCall.status, 0, directCall.stderr);
  assert.match(directCall.stdout, /OPS-204/);
  const directDeny = spawnSync(process.execPath, ['scripts/demo-call.js', '--url', `${base}/mcp`, '--token', 'test-public-reader-token-123456', '--tool', 'github__preview_review_comment', '--args', '{"pullRequest":"PR-204","body":"attempt"}'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(directDeny.status, 2, `the CLI surfaces a gateway authorization denial: ${directDeny.stderr} ${directDeny.stdout}`);
  assert.match(`${directDeny.stdout}${directDeny.stderr}`, /forbidden|not authorized|denied/i);
});
