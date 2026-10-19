import { readFile, mkdir } from 'node:fs/promises';
import { loadConfig, configSchema } from './config.js';
import { SqliteStore, PostgresStore, type ConfigStore } from './store.js';
import { PostgresLimiter, type ConcurrencyLimiter } from './limiter.js';
import { createRuntime, environmentPlugins } from './runtime.js';
import { configureTracing } from './telemetry.js';
import { createGatewayListener } from './listener.js';
import { InMemoryDpopReplayStore, PostgresDpopReplayStore } from './dpop.js';
import { closeHttpServer } from './server-shutdown.js';
import { createPostgresPool } from './postgres-pool.js';
const tracing = configureTracing(process.env);

await mkdir('data', { recursive: true });
const initial = configSchema.parse(JSON.parse(await readFile(process.env.GATEWAY_CONFIG ?? 'gateway.config.json', 'utf8')));
let store: ConfigStore;
let limiter: ConcurrencyLimiter | undefined;
if (process.env.DATABASE_URL) {
  const pool = createPostgresPool(process.env)!;
  pool.on('error', () => console.error('Idle database connection failed'));
  const postgres = new PostgresStore(pool);
  await postgres.initialize(initial);
  store = postgres;
  limiter = new PostgresLimiter(pool);
} else store = new SqliteStore(process.env.SQLITE_PATH ?? 'data/gateway.sqlite', initial);
const snapshot = await store.read();
const resolved = loadConfig(snapshot.document);
const dpopReplayStore = store instanceof PostgresStore ? new PostgresDpopReplayStore(store.pool) : new InMemoryDpopReplayStore();
const jwtRevocationStore = process.env.JWT_REVOCATION_ENABLED === 'true' && store.isJwtRevoked ? { isRevoked: (issuer: string, tokenId: string) => store.isJwtRevoked!(issuer, tokenId) } : undefined;
environmentPlugins(resolved, process.env, dpopReplayStore, jwtRevocationStore);
const adminKey = process.env.GATEWAY_ADMIN_KEY ?? '';
if (resolved.clients.some(client => client.token === adminKey)) throw new Error('Admin key must be separate from service credentials');
const hosts = process.env.GATEWAY_ALLOWED_HOSTS?.split(',').map(host => host.trim());
const app = createRuntime(store, { adminKey, allowedHosts: hosts, limiter, dpopReplayStore });
const tlsEnabled = Boolean(process.env.GATEWAY_MTLS_CLIENT_CA_FILE);
const ready = () => console.log(`${tlsEnabled ? 'HTTPS/mTLS' : 'HTTP'} gateway ready: /mcp | Console: /admin/ | Readiness: /readyz`);
const http = await createGatewayListener(app, process.env);
http.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1', ready);
const shutdownTimeoutMs = Number(process.env.GATEWAY_SHUTDOWN_TIMEOUT_MS ?? 120_000);
if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 120_000) throw new Error('Invalid GATEWAY_SHUTDOWN_TIMEOUT_MS');
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (shuttingDown) { http.closeAllConnections(); return; }
  shuttingDown = true;
  const hardStop = setTimeout(() => process.exit(1), shutdownTimeoutMs + 10_000);
  void closeHttpServer(http, shutdownTimeoutMs).then(async () => {
    await store.close();
    await tracing?.shutdown();
    clearTimeout(hardStop);
    process.exit(0);
  }).catch(() => {
    clearTimeout(hardStop);
    process.exit(1);
  });
});
