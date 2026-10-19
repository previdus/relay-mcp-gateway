import { once } from 'node:events';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createGateway } from '../dist/gateway.js';
import { createDemoServer } from '../dist/demo-server.js';
import { ROUTE_CONTRACT_CACHE_MAX_TTL_MS } from '../dist/route-contract-cache.js';

const integer = (name, fallback, min, max) => {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
};
const number = (name, fallback, min, max) => {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a number from ${min} to ${max}`);
  return value;
};

const concurrency = integer('RELAY_PERF_CONCURRENCY', 8, 1, 64);
const durationSeconds = number('RELAY_PERF_DURATION_SECONDS', 10, 1, 180);
const warmupSeconds = number('RELAY_PERF_WARMUP_SECONDS', 2, 0, 60);
const discoveryCacheTtlMs = integer('RELAY_PERF_DISCOVERY_CACHE_TTL_MS', 15000, 0, 60000);
const aliasTargets = integer('RELAY_PERF_ALIAS_TARGETS', 1, 1, 32);
const upstreamToolListTtlMs = integer('RELAY_PERF_UPSTREAM_TTL_MS', 0, 0, 60000);
const contractCacheMaxTtlMs = integer('RELAY_PERF_CONTRACT_CACHE_MAX_TTL_MS', ROUTE_CONTRACT_CACHE_MAX_TTL_MS, 0, 60000);
const maxP95Ms = process.env.RELAY_PERF_MAX_P95_MS === undefined ? undefined : number('RELAY_PERF_MAX_P95_MS', 100, 0.1, 60000);
const minRps = process.env.RELAY_PERF_MIN_RPS === undefined ? undefined : number('RELAY_PERF_MIN_RPS', 1, 0.01, 1_000_000);

// One-millisecond buckets bound memory regardless of request volume.
const histogramSize = 60_001;
function makeHistogram() {
  const buckets = new Uint32Array(histogramSize);
  let count = 0;
  function observe(milliseconds) {
    const bucket = Math.min(histogramSize - 1, Math.max(0, Math.ceil(milliseconds)));
    buckets[bucket]++;
    count++;
  }
  function quantile(q) {
    if (!count) return null;
    const target = Math.ceil(count * q);
    let seen = 0;
    for (let i = 0; i < buckets.length; i++) {
      seen += buckets[i];
      if (seen >= target) return i;
    }
    return null;
  }
  return { observe, get count() { return count; }, quantile };
}

function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => ({
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  }));
}

const upstreamMethodsByTarget = {};
const upstreams = [];
for (let index = 0; index < aliasTargets; index++) {
  const id = `perf${index}`;
  upstreamMethodsByTarget[id] = {};
  // Keep the advertised tool contract identical across route targets while
  // maintaining independent request counters for each endpoint.
  const upstream = await listen(createDemoServer('perf0', method => {
    const name = typeof method === 'string' ? method : 'invalid';
    const counts = upstreamMethodsByTarget[id];
    counts[name] = (counts[name] ?? 0) + 1;
  }, { ...(upstreamToolListTtlMs > 0 ? { toolListTtlMs: upstreamToolListTtlMs } : {}) }));
  upstreams.push({ id, url: `${upstream.url}/mcp`, server: upstream.server });
}
const upstreamMethods = () => Object.values(upstreamMethodsByTarget).reduce((aggregate, methods) => {
  for (const [method, count] of Object.entries(methods)) aggregate[method] = (aggregate[method] ?? 0) + count;
  return aggregate;
}, {});
const token = 'perf-smoke-token-with-more-than-24-characters';
const routedAlias = aliasTargets > 1;
const toolName = routedAlias ? 'echo' : 'perf0__echo';
const gateway = createGateway({
  allowLocalHttp: true,
  allowedHosts: ['127.0.0.1', 'localhost'],
  maxConcurrentPerClient: concurrency + 2,
  timeoutMs: 5000,
  discovery: { routeContractCacheMaxTtlMs: contractCacheMaxTtlMs },
  clients: [{ id: 'perf', token, allow: [toolName] }],
  upstreams: upstreams.map(upstream => ({ id: upstream.id, url: upstream.url, ...(discoveryCacheTtlMs ? { discoveryCacheTtlMs } : {}) })),
  ...(routedAlias ? { routes: [{ name: 'echo', strategy: 'priority', targets: upstreams.map(upstream => ({ upstreamId: upstream.id, tool: 'echo' })) }] } : {}),
});
const gatewayListener = await listen(gateway);
const clients = [];

async function connectClient() {
  const client = new Client({ name: 'relay-perf-smoke', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gatewayListener.url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  clients.push(client);
  return client;
}

async function exercise(workerClients, seconds, record, expectedPayload = false) {
  const deadline = performance.now() + seconds * 1000;
  let successes = 0;
  let failures = 0;
  const workers = workerClients.map(async client => {
    while (performance.now() < deadline) {
      const started = performance.now();
      try {
        const result = await client.callTool({ name: toolName, arguments: { text: 'smoke' } });
        if (result.isError || (expectedPayload && result.content?.[0]?.text !== 'perf0: smoke')) throw new Error('Unexpected tool result');
        successes++;
      } catch {
        failures++;
      } finally {
        if (record) record.observe(performance.now() - started);
      }
    }
  });
  await Promise.all(workers);
  return { successes, failures };
}

let result;
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
try {
  const workerClients = await Promise.all(Array.from({ length: concurrency }, () => connectClient()));
  if (warmupSeconds > 0) await exercise(workerClients, warmupSeconds, null);
  for (const methods of Object.values(upstreamMethodsByTarget)) for (const method of Object.keys(methods)) delete methods[method];
  const memoryBefore = process.memoryUsage();
  loopDelay.enable();
  const histogram = makeHistogram();
  const elapsedStart = performance.now();
  const counts = await exercise(workerClients, durationSeconds, histogram, true);
  const elapsedSeconds = (performance.now() - elapsedStart) / 1000;
  loopDelay.disable();
  const memoryAfter = process.memoryUsage();
  const eventLoopMs = value => Number((value / 1e6).toFixed(2));
  const p95 = histogram.quantile(0.95);
  const rps = counts.successes / elapsedSeconds;
  const measuredMethods = upstreamMethods();
  const measuredDiscovers = measuredMethods['server/discover'] ?? 0;
  const discoveryBoundedAsConfigured = discoveryCacheTtlMs === 0
    ? measuredDiscovers === counts.successes
    : discoveryCacheTtlMs > (durationSeconds + warmupSeconds) * 1000 + 500 ? measuredDiscovers === 0 : true;
  const measuredToolLists = measuredMethods['tools/list'] ?? 0;
  const expectedStrictToolLists = counts.successes * aliasTargets;
  const checks = {
    noCallFailures: counts.failures === 0,
    selectedToolContractCheckedOnEverySuccess: measuredToolLists >= counts.successes,
    toolListRequestsRespectCacheMode: upstreamToolListTtlMs === 0 || contractCacheMaxTtlMs === 0
      ? measuredToolLists === expectedStrictToolLists
      : measuredToolLists >= counts.successes && measuredToolLists <= expectedStrictToolLists,
    everySuccessInvokedExactlyOnce: (measuredMethods['tools/call'] ?? 0) === counts.successes,
    discoveryRequestsMatchCacheMode: discoveryBoundedAsConfigured,
    p95BelowConfiguredLimit: maxP95Ms === undefined || (p95 !== null && p95 <= maxP95Ms),
    throughputAboveConfiguredMinimum: minRps === undefined || rps >= minRps,
  };
  result = {
    benchmark: routedAlias ? 'local-routed-alias-contract-smoke' : 'local-single-process-mcp-gateway-smoke',
    warning: 'A loopback smoke baseline only; not a capacity, multi-replica, cloud, or production SLO claim.',
    protocol: 'MCP 2026-07-28 over Streamable HTTP',
    concurrency,
    aliasTargets,
    aliasContractChecksPerCall: Math.max(0, aliasTargets - 1),
    upstreamToolListTtlMs,
    localContractCacheTtlCapMs: contractCacheMaxTtlMs,
    discoveryCacheTtlMs,
    warmupSeconds,
    requestedDurationSeconds: durationSeconds,
    elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
    calls: { attempted: counts.successes + counts.failures, succeeded: counts.successes, failed: counts.failures, requestsPerSecond: Number(rps.toFixed(2)) },
    upstreamMethods,
    upstreamMethodsByTarget,
    latencyMs: { p50: histogram.quantile(0.5), p95, p99: histogram.quantile(0.99), maxBucketUpperBound: histogram.quantile(1), bucketWidth: '1 ms, rounded up' },
    eventLoopDelayMs: { p95: eventLoopMs(loopDelay.percentile(95)), p99: eventLoopMs(loopDelay.percentile(99)), max: eventLoopMs(loopDelay.max) },
    memoryBytes: {
      rssBefore: memoryBefore.rss, rssAfter: memoryAfter.rss, rssDelta: memoryAfter.rss - memoryBefore.rss,
      heapUsedBefore: memoryBefore.heapUsed, heapUsedAfter: memoryAfter.heapUsed, heapUsedDelta: memoryAfter.heapUsed - memoryBefore.heapUsed,
    },
    checks,
    passed: Object.values(checks).every(Boolean),
  };
} finally {
  await Promise.all(clients.map(client => client.close().catch(() => {})));
  await Promise.all([gatewayListener.server, ...upstreams.map(upstream => upstream.server)].map(server => new Promise(resolve => server.close(() => resolve()))));
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.passed) process.exitCode = 1;
