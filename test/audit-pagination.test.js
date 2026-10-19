import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../dist/store.js';
import { createRuntime } from '../dist/runtime.js';
import { adminToken, document, listen } from './helpers.js';

test('audit pages use stable ascending cursors and never repeat or skip records', async t => {
  const store = new SqliteStore(':memory:', document);
  t.after(() => store.close());
  for (let i = 1; i <= 7; i++) await store.audit({ requestId: `request-${i}`, at: new Date().toISOString(), clientId: 'agent', outcome: 'ok' });
  const seen = [];
  let cursor;
  do {
    const page = await store.auditPage(cursor, 3);
    seen.push(...page.events.map(event => event.requestId));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, ['request-1', 'request-2', 'request-3', 'request-4', 'request-5', 'request-6', 'request-7']);
  assert.deepEqual(await store.auditPage(Buffer.from('7').toString('base64url'), 3), { events: [] });
});

test('admin audit pagination is authenticated, bounded, append-safe and rejects malformed cursors', async t => {
  const store = new SqliteStore(':memory:', document);
  t.after(() => store.close());
  const url = await listen(createRuntime(store, { adminKey: adminToken, environment: {} }), t);
  const endpoint = `${url}/admin/api/audit/pages`;
  assert.equal((await fetch(endpoint)).status, 401);
  const headers = { Authorization: `Bearer ${adminToken}` };
  for (let i = 1; i <= 4; i++) await store.audit({ requestId: `entry-${i}`, at: new Date().toISOString(), clientId: 'agent', outcome: 'ok' });
  const firstResponse = await fetch(`${endpoint}?limit=2`, { headers });
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.deepEqual(first.events.map(event => event.requestId), ['entry-1', 'entry-2']);
  assert.ok(first.nextCursor);
  await store.audit({ requestId: 'entry-5', at: new Date().toISOString(), clientId: 'agent', outcome: 'ok' });
  const second = await (await fetch(`${endpoint}?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, { headers })).json();
  assert.deepEqual(second.events.map(event => event.requestId), ['entry-3', 'entry-4']);
  assert.ok(second.nextCursor);
  const third = await (await fetch(`${endpoint}?limit=2&cursor=${encodeURIComponent(second.nextCursor)}`, { headers })).json();
  assert.deepEqual(third.events.map(event => event.requestId), ['entry-5']);
  assert.equal(third.nextCursor, undefined);
  assert.equal((await fetch(`${endpoint}?limit=501`, { headers })).status, 400);
  assert.equal((await fetch(`${endpoint}?cursor=%%%`, { headers })).status, 400);
});
