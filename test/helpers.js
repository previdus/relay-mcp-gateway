import { once } from 'node:events';
export async function listen(app, t) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
export const serviceToken = 'service-test-credential-1234567890';
export const adminToken = 'administrator-test-key-1234567890';
export const document = { allowLocalHttp: true, clients: [{ id: 'user1', tokenEnv: 'SERVICE_TOKEN', allow: ['alpha__*', 'echo'] }], upstreams: [] };
