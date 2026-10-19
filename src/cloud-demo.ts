import { SqliteStore } from './store.js';
import { createRuntime } from './runtime.js';
import { createDemoServer } from './demo-server.js';
import { createModernDemoServer } from './demo-modern.js';
import { loadConfig } from './config.js';
import { environmentPlugins } from './runtime.js';
import type { Server } from 'node:http';

const adminKey = process.env.GATEWAY_ADMIN_KEY;
if (!adminKey || adminKey.length < 24) throw new Error('GATEWAY_ADMIN_KEY must be set to a secret of at least 24 characters');
const serviceKey = process.env.DEMO_TOKEN ?? 'relay-public-echo-demo-token';
if (serviceKey.length < 24) throw new Error('DEMO_TOKEN must contain at least 24 characters');
const configuredAllowedHosts = process.env.GATEWAY_ALLOWED_HOSTS?.split(',').map(host => host.trim()).filter(Boolean);
const alphaPort = Number(process.env.DEMO_ALPHA_PORT ?? 4101);
const betaPort = Number(process.env.DEMO_BETA_PORT ?? 4102);
if (![alphaPort, betaPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535) || alphaPort === betaPort) {
  throw new Error('DEMO_ALPHA_PORT and DEMO_BETA_PORT must be different valid TCP ports');
}
const store = new SqliteStore(':memory:', {
  allowLocalHttp: true,
  clients: [{ id: 'public-echo-demo', tokenEnv: 'DEMO_TOKEN', allow: ['echo'] }],
  upstreams: [{ id: 'alpha', url: `http://127.0.0.1:${alphaPort}/mcp` }, { id: 'beta', url: `http://127.0.0.1:${betaPort}/mcp` }],
  routes: [{ name: 'echo', strategy: 'sticky', targets: [{ upstreamId: 'alpha', tool: 'echo' }, { upstreamId: 'beta', tool: 'echo' }] }]
});
const runtimeEnvironment = { DEMO_TOKEN: serviceKey };
const startupSnapshot = await store.read();
const startupConfig = loadConfig(startupSnapshot.document, runtimeEnvironment);
environmentPlugins(startupConfig, runtimeEnvironment);
const servers: Server[] = [];
servers.push(createDemoServer('alpha').listen(alphaPort, '127.0.0.1'));
servers.push(createModernDemoServer('beta').listen(betaPort, '127.0.0.1'));
const app = createRuntime(store, {
  adminKey,
  environment: runtimeEnvironment,
  allowedHosts: configuredAllowedHosts?.length ? configuredAllowedHosts : undefined
});
const port = Number(process.env.PORT ?? 3000);
servers.push(app.listen(port, process.env.HOST ?? '0.0.0.0'));
console.log(`Public echo demo ready on port ${port}; admin console: /admin/; MCP endpoint: /mcp`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  for (const server of servers) server.close();
  void store.close();
});
