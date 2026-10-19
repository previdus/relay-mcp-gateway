import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../dist/store.js';
import { createRuntime } from '../dist/runtime.js';
import { listen, document, serviceToken, adminToken } from './helpers.js';

test('configuration and audit roll back together when the audit insert fails', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-atomic-'));
  const path = join(directory, 'test.sqlite');
  const store = new SqliteStore(path, document);
  const sabotage = new DatabaseSync(path);
  t.after(async () => { sabotage.close(); await store.close(); await rm(directory, { recursive: true }); });
  sabotage.exec("CREATE TRIGGER audit_failure BEFORE INSERT ON gateway_audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  const event = { requestId: 'atomic', at: new Date().toISOString(), clientId: 'admin', outcome: 'ok' };
  await assert.rejects(store.write({ ...document, timeoutMs: 1000 }, 1, event), /audit unavailable/);
  assert.equal((await store.read()).revision, 1);
  assert.deepEqual((await store.history()).map(item => item.revision), [1]);
  sabotage.exec('DROP TRIGGER audit_failure');
  await store.write({ ...document, timeoutMs: 1000 }, 1, event);
  assert.equal((await store.read()).revision, 2);
  assert.equal((await store.recentAudit())[0].requestId, 'atomic');
});

test('runtime fails closed on audit admission failure and protects bounded metrics', async t => {
  const store = new SqliteStore(':memory:', document);
  t.after(() => store.close());
  const original = store.audit.bind(store);
  store.audit = async () => { throw new Error('offline'); };
  const url = await listen(createRuntime(store, { adminKey: adminToken, environment: { SERVICE_TOKEN: serviceToken } }), t);
  const headers = { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' };
  const request = () => fetch(`${url}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal((await request()).status, 503);
  assert.equal((await fetch(`${url}/admin/api/metrics`)).status, 401);
  store.audit = original;
  await request();
  const metrics = await (await fetch(`${url}/admin/api/metrics`, { headers: { Authorization: `Bearer ${adminToken}` } })).text();
  assert.match(metrics, /gateway_events_total\{outcome="started"\} 2/);
  assert.equal(metrics.includes('user1'), false);
  assert.ok((await store.recentAudit()).some(event => event.outcome === 'started'));
});

test('runtime composes the durable database audit with an injected audit plugin', async t => {
  const store = new SqliteStore(':memory:', document);
  t.after(() => store.close());
  const external = [];
  const url = await listen(createRuntime(store, { adminKey: adminToken, environment: { SERVICE_TOKEN: serviceToken }, plugins: () => ({ audit: async event => external.push(event) }) }), t);
  const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
  assert.equal(response.status, 200);
  assert.ok(external.some(event => event.outcome === 'started'));
  assert.ok(external.some(event => event.outcome === 'ok'));
  assert.ok((await store.recentAudit()).some(event => event.outcome === 'started'), 'the plugin does not replace local durable audit');
});

test('runtime denies audit admission when the injected sink rejects the start event', async t => {
  const store = new SqliteStore(':memory:', document);
  t.after(() => store.close());
  const url = await listen(createRuntime(store, { adminKey: adminToken, environment: { SERVICE_TOKEN: serviceToken }, plugins: () => ({ audit: async event => { if (event.outcome === 'started') throw new Error('sink unavailable'); } }) }), t);
  const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'alpha__echo', arguments: { text: 'must not run' } } }) });
  assert.equal(response.status, 503);
  assert.ok((await store.recentAudit()).some(event => event.outcome === 'started'), 'local audit is retained even if the extension sink rejects');
});

test('readiness and publishing reject callback configuration without the shared state key', async t => {
  const store = new SqliteStore(':memory:', document);
  t.after(() => store.close());
  const url = await listen(createRuntime(store, { adminKey: adminToken, environment: { SERVICE_TOKEN: serviceToken } }), t);
  const response = await fetch(`${url}/admin/api/config`, { method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'If-Match': '"1"' }, body: JSON.stringify({ ...document, features: { callbacks: true } }) });
  assert.equal(response.status, 400);
  assert.equal((await store.read()).revision, 1);
  await store.write({ ...document, features: { callbacks: true } }, 1);
  assert.equal((await fetch(`${url}/readyz`)).status, 503);
});
