import { randomBytes } from 'node:crypto';
import { SqliteStore } from './store.js';
import { createRuntime } from './runtime.js';
import { createDemoServer } from './demo-server.js';
import { createModernDemoServer } from './demo-modern.js';
import type { Server } from 'node:http';
const token = randomBytes(24).toString('hex');
const adminKey = randomBytes(24).toString('hex');
const store = new SqliteStore(':memory:', {
  allowLocalHttp: true,
  clients: [{ id: 'demo', tokenEnv: 'DEMO_TOKEN', allow: ['alpha__*', 'beta__*', 'echo'] }],
  upstreams: [{ id: 'alpha', url: 'http://127.0.0.1:4101/mcp' }, { id: 'beta', url: 'http://127.0.0.1:4102/mcp' }],
  routes: [{ name: 'echo', strategy: 'sticky', targets: [{ upstreamId: 'alpha', tool: 'echo' }, { upstreamId: 'beta', tool: 'echo' }] }]
});
const servers: Server[] = [];
servers.push(createDemoServer('alpha').listen(4101, '127.0.0.1'));
servers.push(createModernDemoServer('beta').listen(4102, '127.0.0.1'));
servers.push(createRuntime(store, { adminKey, environment: { DEMO_TOKEN: token } }).listen(3000, '127.0.0.1'));
console.log(`Demo: http://127.0.0.1:3000/admin/\nAdmin key: ${adminKey}\nMCP endpoint: http://127.0.0.1:3000/mcp\nService key: ${token}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { for (const server of servers) server.close(); void store.close(); });
