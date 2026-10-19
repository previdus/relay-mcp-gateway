import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigRouter } from '../dist/plugins.js';
import { createGateway, PLUGIN_API_VERSION } from '../dist/gateway.js';
import { serviceToken } from './helpers.js';
const principal = { id: 'one', token: serviceToken, allow: ['echo'], tenantId: 'acme' };
const upstreams = ['a', 'b', 'c', 'd'].map(id => ({ id, url: `https://${id}.example/mcp`, tenantId: 'acme' }));
const config = ids => ({ clients: [principal], upstreams, routes: [{ name: 'echo', strategy: 'rendezvous', targets: ids.map(id => ({ upstreamId: id, tool: 'echo' })) }] });
const target = (router, id) => router.resolve('echo', { principal: { ...principal, id }, requestId: id }).upstream.id;

test('rendezvous routing is order-independent and stable under target addition/removal', () => {
  const a = new ConfigRouter(config(['a', 'b', 'c'])), reordered = new ConfigRouter(config(['c', 'a', 'b'])), added = new ConfigRouter(config(['a', 'b', 'c', 'd'])), removed = new ConfigRouter(config(['a', 'c']));
  let moves = 0;
  for (let i = 0; i < 500; i++) {
    const id = `client-${i}`, before = target(a, id), after = target(added, id);
    assert.equal(target(reordered, id), before);
    if (after !== before) { moves++; assert.equal(after, 'd'); }
    if (before !== 'b') assert.equal(target(removed, id), before);
  }
  assert.ok(moves > 0 && moves < 250);
});

test('rendezvous weights bias assignments and all strategies exclude foreign tenants before choosing', () => {
  const weighted = config(['a', 'b']); weighted.routes[0].targets[0].weight = 3;
  const router = new ConfigRouter(weighted); let a = 0;
  for (let i = 0; i < 3000; i++) if (target(router, `client-${i}`) === 'a') a++;
  assert.ok(a > 2000 && a < 2500, `3:1 weighted assignment unexpectedly produced ${a}/3000`);
  for (const strategy of ['weighted', 'sticky', 'rendezvous']) {
    const mixed = config(['a', 'b']); mixed.routes[0].strategy = strategy; mixed.upstreams = [{ ...upstreams[0], tenantId: 'foreign' }, upstreams[1]];
    for (let i = 0; i < 20; i++) assert.equal(target(new ConfigRouter(mixed), String(i)), 'b');
  }
});

test('unsupported plugin versions and ambiguous route definitions are rejected at construction', () => {
  assert.equal(PLUGIN_API_VERSION, 1);
  assert.throws(() => createGateway(config(['a']), { pluginApiVersion: 2 }), /Unsupported/);
  assert.throws(() => createGateway(config(['a', 'a'])), /Invalid routing/);
  const invalid = config(['a']); invalid.routes[0].strategy = 'unknown'; assert.throws(() => createGateway(invalid), /Invalid routing/);
});
