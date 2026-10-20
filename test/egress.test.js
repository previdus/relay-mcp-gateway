import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import express from 'express';
import { listen } from './helpers.js';
import { closeEgressFetch, upstreamFetch, validateEgressCidrs } from '../dist/egress.js';

test('upstream fetch rejects redirects and out-of-origin endpoint events', async t => {
  const app = express(); app.get('/redirect', (_req, res) => res.redirect('https://example.com')); app.get('/ok', (_req, res) => res.send('ok'));
  const url = await listen(app, t);
  const request = upstreamFetch(`${url}/mcp`);
  assert.equal(await (await request(`${url}/ok`)).text(), 'ok');
  await assert.rejects(request(`${url}/redirect`));
  await assert.rejects(request('https://example.com'), /Cross-origin/);
});
test('upstream fetch bounds both declared and streamed response sizes', async t => {
  const app = express();
  app.get('/declared', (_req, res) => res.send('x'.repeat(2048)));
  app.get('/stream', (_req, res) => { res.write('x'.repeat(700)); res.end('x'.repeat(700)); });
  const url = await listen(app, t), request = upstreamFetch(`${url}/mcp`, 1024);
  await assert.rejects(request(`${url}/declared`), /byte limit/);
  const response = await request(`${url}/stream`);
  await assert.rejects(response.text(), /byte limit/);
});

test('upstream fetch presents a dedicated client certificate only on its configured upstream TLS connection', async t => {
  const cert = await readFile(fileURLToPath(new URL('./fixtures/mtls-test-cert.pem', import.meta.url)));
  const key = await readFile(fileURLToPath(new URL('./fixtures/mtls-test-key.pem', import.meta.url)));
  let peerAuthorized = false;
  const server = https.createServer({ cert, key, ca: cert, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    peerAuthorized = req.socket.authorized;
    res.end('mTLS upstream accepted');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `https://localhost:${server.address().port}/mcp`;
  const fetcher = upstreamFetch(url, undefined, ['/mcp'], undefined, { cert: cert.toString(), key: key.toString(), ca: cert.toString() });
  t.after(() => closeEgressFetch(fetcher));
  const response = await fetcher(url);
  assert.equal(await response.text(), 'mTLS upstream accepted');
  assert.equal(peerAuthorized, true);
});

test('strict egress validates all DNS answers and pins the vetted answer into the socket connection', async t => {
  let hits = 0, resolutions = 0;
  const app = express(); app.get('/mcp', (_req, res) => { hits++; res.send('pinned'); });
  const localUrl = await listen(app, t), endpoint = new URL(localUrl);
  endpoint.hostname = 'gateway-egress.test'; endpoint.pathname = '/mcp';
  const fetcher = upstreamFetch(endpoint.href, undefined, ['/mcp'], {
    allowedPrivateCidrs: ['127.0.0.0/8'],
    resolveAddresses: async hostname => { resolutions++; assert.equal(hostname, 'gateway-egress.test'); return [{ address: '127.0.0.1', family: 4 }]; }
  });
  t.after(() => closeEgressFetch(fetcher));
  assert.equal(await (await fetcher(endpoint.href)).text(), 'pinned');
  assert.equal(resolutions, 1);
  assert.equal(hits, 1);
});

test('strict egress denies private, metadata, special-use, and mixed DNS answers before connecting', async t => {
  let hits = 0;
  const app = express(); app.get('/mcp', (_req, res) => { hits++; res.send('unexpected'); });
  const localUrl = await listen(app, t), endpoint = new URL(localUrl); endpoint.hostname = 'blocked-egress.test'; endpoint.pathname = '/mcp';
  const cases = [
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }],
    [{ address: '198.18.0.1', family: 4 }],
    [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]
  ];
  for (const answers of cases) {
    const fetcher = upstreamFetch(endpoint.href, undefined, ['/mcp'], { resolveAddresses: async () => answers });
    t.after(() => closeEgressFetch(fetcher));
    await assert.rejects(fetcher(endpoint.href), error => error.cause?.code === 'EACCES');
  }
  assert.equal(hits, 0);
  const literal = upstreamFetch(localUrl, undefined, undefined, {});
  t.after(() => closeEgressFetch(literal));
  await assert.rejects(literal(localUrl), /address denied/);
});

test('private egress configuration accepts only canonical RFC1918, ULA, and loopback subnets', () => {
  assert.deepEqual(validateEgressCidrs(['10.20.0.0/16', 'fc00::/7', '127.0.0.0/8']), ['10.20.0.0/16', 'fc00::/7', '127.0.0.0/8']);
  for (const cidr of ['0.0.0.0/0', '10.0.0.0/7', '169.254.0.0/16', '100.64.0.0/10', '::/0', 'fe80::/10', '10.20.1.2/16']) {
    assert.throws(() => validateEgressCidrs([cidr]), /Egress CIDRs/);
  }
});

test('strict egress bounds stalled DNS resolution', async t => {
  const fetcher = upstreamFetch('https://slow-egress.test/mcp', undefined, undefined, {
    resolutionTimeoutMs: 50,
    resolveAddresses: () => new Promise(() => {})
  });
  t.after(() => closeEgressFetch(fetcher));
  await assert.rejects(fetcher('https://slow-egress.test/mcp'), error => error.cause?.code === 'ETIMEDOUT');
});
