import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalRateLimiter, CircuitBreakers, CircuitOpen } from '../dist/traffic.js';
import { createGateway } from '../dist/gateway.js';
import { createDemoServer } from '../dist/demo-server.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { listen, serviceToken } from './helpers.js';

test('token bucket bounds bursts, refills, isolates keys and tolerates clock reversal', async () => {
  let now = 1000; const limiter = new LocalRateLimiter(() => now), policy = { capacity: 2, refillPerSecond: 1 };
  assert.equal(await limiter.consume('a', policy), true);
  assert.equal(await limiter.consume('a', policy), true);
  assert.equal(await limiter.consume('a', policy), false);
  assert.equal(await limiter.consume('b', policy), true);
  now += 500; assert.equal(await limiter.consume('a', policy), false);
  now += 500; assert.equal(await limiter.consume('a', policy), true);
  now -= 2000; assert.equal(await limiter.consume('a', policy), false);
});

test('local rate limiter reclaims only fully refilled buckets after policy churn', async () => {
  let now = 1000;
  const limiter = new LocalRateLimiter(() => now, 2);
  const fast = { capacity: 1, refillPerSecond: 1 };
  assert.equal(await limiter.consume('old-a', fast), true);
  assert.equal(await limiter.consume('old-b', fast), true);
  now += 1000;
  assert.equal(await limiter.consume('new-policy', fast), true);
  // The previous buckets are eligible because their quota is fully restored.
  assert.equal(await limiter.consume('new-policy-2', fast), true);

  const constrained = new LocalRateLimiter(() => now, 1);
  const slow = { capacity: 1, refillPerSecond: 0.001 };
  assert.equal(await constrained.consume('active', slow), true);
  now += 1000;
  await assert.rejects(constrained.consume('another-policy', slow), /capacity exhausted/);
  // A short idle interval has not restored this bucket's token, so it remains protected.
  await assert.rejects(constrained.consume('third-policy', slow), /capacity exhausted/);
});

test('circuit opens, admits one recovery probe and ignores stale completions', async () => {
  let now = 1000; const breaker = new CircuitBreakers(() => now), policy = { failureThreshold: 1, resetAfterMs: 100 };
  let complete; const slow = breaker.run('backend', policy, () => new Promise(resolve => { complete = resolve; }));
  await assert.rejects(breaker.run('backend', policy, async () => { throw new Error('offline'); }), /offline/);
  complete('old success'); await slow;
  await assert.rejects(breaker.run('backend', policy, async () => 'must not run'), CircuitOpen);
  now += 101;
  let recover; const probe = breaker.run('backend', policy, () => new Promise(resolve => { recover = resolve; }));
  await assert.rejects(breaker.run('backend', policy, async () => 'second probe'), CircuitOpen);
  recover('healthy'); assert.equal(await probe, 'healthy');
  assert.equal(await breaker.run('backend', policy, async () => 'recovered'), 'recovered');
  await assert.rejects(breaker.run('backend', policy, async () => { throw new Error('user input'); }, () => false), /user input/);
  assert.equal(await breaker.run('backend', policy, async () => 'still closed'), 'still closed');
});

test('per-tool quotas reject repeated real MCP calls and fail closed on store errors', async t => {
  const upstream = await listen(createDemoServer('alpha'), t);
  const config = { allowLocalHttp: true, clients: [{ id: 'one', token: serviceToken, allow: ['alpha__*'] }], upstreams: [{ id: 'alpha', url: `${upstream}/mcp` }], traffic: { toolRateLimits: { alpha__echo: { capacity: 1, refillPerSecond: 0.001 } } } };
  const url = await listen(createGateway(config), t);
  const client = new Client({ name: 'quota-test', version: '1' }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
  assert.equal((await client.callTool({ name: 'alpha__echo', arguments: { text: 'once' } })).content[0].text, 'alpha: once');
  await assert.rejects(client.callTool({ name: 'alpha__echo', arguments: { text: 'twice' } }), /429|Rate limit/);
  assert.equal((await client.listTools()).tools[0].name, 'alpha__echo');
  const failed = await listen(createGateway({ ...config, traffic: { rateLimit: { capacity: 1, refillPerSecond: 1 } } }, { rateLimiter: { consume: async () => { throw new Error('offline'); } } }), t);
  const response = await fetch(`${failed}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'tools/list' }) });
  assert.equal(response.status, 503);
});

test('gateway circuit stops failed connection attempts and recovers without retrying tool calls', async t => {
  const { createUpstreamTransport } = await import('../dist/transports.js');
  const upstream = await listen(createDemoServer('alpha'), t);
  let attempts = 0, unavailable = true;
  const url = await listen(createGateway({ allowLocalHttp: true, clients: [{ id: 'one', token: serviceToken, allow: ['alpha__*'] }], upstreams: [{ id: 'alpha', url: `${upstream}/mcp` }], traffic: { circuitBreaker: { failureThreshold: 1, resetAfterMs: 100 } } }, { transportFactory: upstream => { attempts++; if (unavailable) throw new Error('connection failed'); return createUpstreamTransport(upstream, {}); } }), t);
  const client = new Client({ name: 'breaker-test', version: '1' }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
  assert.deepEqual((await client.listTools()).tools, []);
  assert.deepEqual((await client.listTools()).tools, []);
  assert.equal(attempts, 1);
  unavailable = false;
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal((await client.listTools()).tools[0].name, 'alpha__echo');
  await assert.rejects(client.callTool({ name: 'alpha__echo', arguments: { text: 42 } }), /input schema/);
  assert.equal((await client.callTool({ name: 'alpha__echo', arguments: { text: 'healthy' } })).content[0].text, 'alpha: healthy');
});
