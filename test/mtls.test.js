import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { createGateway } from '../dist/gateway.js';
import { createGatewayListener } from '../dist/listener.js';
import { MtlsAuthenticator } from '../dist/plugins.js';
import { environmentPlugins } from '../dist/runtime.js';

const certPath = fileURLToPath(new URL('./fixtures/mtls-test-cert.pem', import.meta.url));
const keyPath = fileURLToPath(new URL('./fixtures/mtls-test-key.pem', import.meta.url));
const certificate = await readFile(certPath);
const privateKey = await readFile(keyPath);
const thumbprint = createHash('sha256').update(new X509Certificate(certificate).raw).digest('base64url');
const identity = { id: 'mtls-agent', certificateSha256: thumbprint, allow: [] };

function request(port, { certificate: useCertificate = false, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'GET', ca: certificate,
      ...(useCertificate ? { cert: certificate, key: privateKey } : {}), headers }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    req.once('error', reject); req.end();
  });
}

test('mTLS identity requires an authorized TLS peer certificate and forbids bearer fallback', async t => {
  const authenticator = new MtlsAuthenticator([identity]);
  assert.equal((await authenticator.authenticate('', { authorizationHeaderCount: 0, certificateSha256: thumbprint }))?.id, identity.id);
  assert.equal(await authenticator.authenticate('', { authorizationHeaderCount: 0 }), undefined);
  assert.equal(await authenticator.authenticate('', { authorizationHeaderCount: 1, certificateSha256: thumbprint }), undefined);
  assert.equal(await authenticator.authenticate('bearer-token', { authorizationHeaderCount: 1, certificateSha256: thumbprint }), undefined);
  assert.throws(() => new MtlsAuthenticator([{ ...identity, certificateSha256: 'short' }]), /thumbprints/i);
  assert.throws(() => new MtlsAuthenticator([identity, { ...identity, id: 'duplicate' }]), /unique/i);

  const app = createGateway({ clients: [identity], upstreams: [] }, { authenticator });
  const server = await createGatewayListener(app, { GATEWAY_TLS_CERT_FILE: certPath, GATEWAY_TLS_KEY_FILE: keyPath, GATEWAY_MTLS_CLIENT_CA_FILE: certPath });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  assert.equal(await request(port), 401, 'a TLS connection without a client certificate is not an identity');
  assert.equal(await request(port, { headers: { 'X-Forwarded-Client-Cert': 'sha256=' + thumbprint } }), 401, 'forwarded certificate headers are ignored');
  assert.equal(await request(port, { certificate: true, headers: { Authorization: 'Bearer ignored' } }), 401, 'mTLS mode rejects mixed bearer credentials');
  assert.notEqual(await request(port, { certificate: true }), 401, 'the mapped, CA-verified TLS peer is authenticated');
});

test('deployment mTLS mode requires a complete TLS trust setup and certificate mappings', async () => {
  const config = { clients: [identity], upstreams: [] };
  assert.throws(() => environmentPlugins(config, { GATEWAY_TLS_CERT_FILE: certPath }), /requires gateway TLS/i);
  await assert.rejects(createGatewayListener(createGateway(config), { GATEWAY_TLS_CERT_FILE: certPath }), /requires gateway TLS/i);
  assert.throws(() => environmentPlugins({ clients: [{ id: 'unmapped', subject: 'agent', allow: [] }], upstreams: [] }, {
    GATEWAY_TLS_CERT_FILE: certPath, GATEWAY_TLS_KEY_FILE: keyPath, GATEWAY_MTLS_CLIENT_CA_FILE: certPath
  }), /certificate thumbprint/i);
  assert.throws(() => environmentPlugins({ clients: [{ ...identity, token: 'legacy-service-key-that-must-not-remain' }], upstreams: [] }, {
    GATEWAY_TLS_CERT_FILE: certPath, GATEWAY_TLS_KEY_FILE: keyPath, GATEWAY_MTLS_CLIENT_CA_FILE: certPath
  }), /must not retain a service-key/i);
  assert.throws(() => environmentPlugins(config, {
    GATEWAY_TLS_CERT_FILE: certPath, GATEWAY_TLS_KEY_FILE: keyPath, GATEWAY_MTLS_CLIENT_CA_FILE: certPath, JWT_ISSUER: 'https://issuer.example'
  }), /Select mTLS or OAuth/i);
  assert.ok(environmentPlugins(config, {
    GATEWAY_TLS_CERT_FILE: certPath, GATEWAY_TLS_KEY_FILE: keyPath, GATEWAY_MTLS_CLIENT_CA_FILE: certPath
  }).authenticator instanceof MtlsAuthenticator);
});
