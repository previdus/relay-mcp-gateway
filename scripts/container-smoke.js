import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const directory = await mkdtemp(join(tmpdir(), 'relay-container-'));
const name = `relay-smoke-${randomBytes(6).toString('hex')}`;
const image = process.env.RELAY_CONTAINER_IMAGE ?? 'relay-gateway:0.12.0';
const env = { ...process.env, GATEWAY_API_KEY: randomBytes(32).toString('hex'), GATEWAY_ADMIN_KEY: randomBytes(32).toString('hex') };
const docker = args => execFileSync('docker', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let started = false;
const client = new Client({ name: 'container-smoke', version: '1' });
// Node 22 may otherwise exit while fetch's unreferenced connection/timeout waits.
const keepAlive = setInterval(() => {}, 1000);
try {
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ clients: [{ id: 'smoke', tokenEnv: 'GATEWAY_API_KEY', allow: ['local__echo'] }], upstreams: [{ id: 'local', url: 'stdio://local', transport: 'stdio', command: '/usr/local/bin/node', args: ['/app/dist/demo-stdio.js'] }], invocationPolicies: { local__echo: { allow: [{ constraints: [{ field: ['text'], op: 'equals', value: 'container verified' }] }] } }, catalogPolicy: { rejectControlCharacters: true }, features: { catalogSearch: true }, discovery: { pageSize: 1 } }));
  docker(['run', '-d', '--name', name, '--read-only', '--tmpfs', '/app/data:uid=1000,gid=1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-p', '127.0.0.1::3000', '--mount', `type=bind,source=${config},target=/app/smoke.json,readonly`, '-e', 'GATEWAY_CONFIG=/app/smoke.json', '-e', 'GATEWAY_API_KEY', '-e', 'GATEWAY_ADMIN_KEY', '-e', 'STDIO_ALLOWED_COMMANDS=/usr/local/bin/node', image]);
  started = true;
  const address = docker(['port', name, '3000/tcp']).split('\n')[0];
  const base = `http://${address}`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'Container did not become ready');
  assert.equal((await fetch(`${base}/admin/`)).status, 200);
  assert.equal((await fetch(`${base}/admin/api/config`)).status, 401);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${env.GATEWAY_API_KEY}` } } }));
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['local__echo']);
  const result = await client.callTool({ name: 'local__echo', arguments: { text: 'container verified' } });
  assert.equal(JSON.parse(result.content[0].text).text, 'container verified');
  const catalog = await fetch(`${base}/catalog/search`, { method: 'POST', headers: { Authorization: `Bearer ${env.GATEWAY_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'echo' }) });
  assert.equal(catalog.status, 200); assert.equal((await catalog.json()).tools[0].name, 'local__echo');
  await assert.rejects(client.callTool({ name: 'local__echo', arguments: { text: 'unreviewed action' } }), /argument policy/);
  const response = await fetch(`${base}/admin/api/config`, { headers: { Authorization: `Bearer ${env.GATEWAY_ADMIN_KEY}` } });
  const snapshot = await response.json();
  snapshot.document.clients[0].allow = [];
  const saved = await fetch(`${base}/admin/api/config`, { method: 'PUT', headers: { Authorization: `Bearer ${env.GATEWAY_ADMIN_KEY}`, 'Content-Type': 'application/json', 'If-Match': `"${snapshot.revision}"` }, body: JSON.stringify(snapshot.document) });
  assert.equal(saved.status, 200);
  await assert.rejects(client.callTool({ name: 'local__echo', arguments: { text: 'denied' } }), /forbidden/);
  const events = await (await fetch(`${base}/admin/api/audit`, { headers: { Authorization: `Bearer ${env.GATEWAY_ADMIN_KEY}` } })).json();
  assert.ok(events.some(e => e.method === 'admin/config.update'));
  assert.ok(events.some(e => e.outcome === 'denied'));
  assert.equal(docker(['exec', name, 'id', '-u']), '1000');
  console.log('Container smoke passed: readiness, console, authentication, stdio discovery/call, policy publish/revocation, audit, non-root/read-only execution.');
} finally {
  clearInterval(keepAlive);
  await client.close().catch(() => {});
  if (started) docker(['rm', '-f', name]);
  await rm(directory, { recursive: true, force: true });
}
