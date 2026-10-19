import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { closeHttpServer } from '../dist/server-shutdown.js';

test('HTTP shutdown stops admission, drains briefly, and closes a long-lived response at the deadline', async t => {
  const server = createServer((_request, response) => { response.writeHead(200); response.write('streaming'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const responseReady = new Promise((resolve, reject) => {
    const request = fetch(base);
    request.then(resolve, reject);
  });
  const response = await responseReady;
  assert.equal(response.status, 200);

  assert.ok(response.body);
  const reader = response.body.getReader();
  const closed = (async () => {
    try { while (!(await reader.read()).done) {} } catch { /* Force-close rejects a pending stream read. */ }
  })();
  const draining = closeHttpServer(server, 25);
  await assert.rejects(fetch(base));
  await Promise.all([closed, draining]);
  assert.throws(() => closeHttpServer(server, 0), /Invalid HTTP drain timeout/);
});
