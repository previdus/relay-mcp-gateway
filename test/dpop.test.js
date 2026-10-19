import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK, calculateJwkThumbprint } from 'jose';
import { createGateway } from '../dist/gateway.js';
import { IntrospectionAuthenticator } from '../dist/authentication.js';
import { JwtAuthenticator } from '../dist/plugins.js';
import { DpopNonceManager, DpopReplayStoreUnavailable, InMemoryDpopReplayStore } from '../dist/dpop.js';
import { environmentPlugins } from '../dist/runtime.js';
import { listen } from './helpers.js';

const issuer = 'https://issuer.example';
const audience = 'https://gateway.example/mcp';
const principal = { id: 'bound-agent', subject: 'workload', allow: ['alpha__echo'] };
const now = () => Math.floor(Date.now() / 1000);

async function fixture() {
  const issuerKeys = await generateKeyPair('ES256');
  const issuerJwk = { ...await exportJWK(issuerKeys.publicKey), kid: 'issuer-key' };
  const proofKeys = await generateKeyPair('ES256');
  const proofJwk = await exportJWK(proofKeys.publicKey);
  const jkt = await calculateJwkThumbprint(proofJwk);
  const accessToken = await new SignJWT({ cnf: { jkt }, scope: 'mcp:access' }).setProtectedHeader({ alg: 'ES256', kid: 'issuer-key', typ: 'at+jwt' }).setIssuer(issuer).setAudience(audience).setSubject('workload').setIssuedAt().setExpirationTime('5m').sign(issuerKeys.privateKey);
  const signProof = async (token = accessToken, changes = {}, headerChanges = {}) => {
    const iat = now();
    const claims = { jti: randomUUID(), htm: 'GET', htu: 'https://gateway.example/mcp', iat, ath: createHash('sha256').update(token, 'ascii').digest('base64url'), ...changes };
    return new SignJWT(claims).setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: proofJwk, ...headerChanges }).sign(proofKeys.privateKey);
  };
  const makeAuth = (replayStore = new InMemoryDpopReplayStore(), nonceManager) => new JwtAuthenticator({ issuer, audience, jwksUrl: `${issuer}/jwks`, clients: [principal], requiredTyp: 'at+jwt', key: createLocalJWKSet({ keys: [issuerJwk] }), dpop: { publicOrigin: 'https://gateway.example', replayStore, ...(nonceManager ? { nonceManager } : {}) } });
  const context = (proof, changes = {}) => ({ authorizationHeaderCount: 1, authorizationScheme: 'DPoP', dpopProof: proof, dpopProofHeaderCount: 1, method: 'GET', requestTarget: '/mcp', ...changes });
  return { issuerKeys, issuerJwk, proofKeys, proofJwk, jkt, accessToken, signProof, makeAuth, context };
}

test('DPoP JWT authentication binds proof key, token hash, method, URL, and one-time replay state', async () => {
  const f = await fixture();
  const replay = new InMemoryDpopReplayStore();
  const auth = f.makeAuth(replay);
  const proof = await f.signProof();
  assert.equal((await auth.authenticate(f.accessToken, f.context(proof)))?.id, principal.id);
  assert.equal(await auth.authenticate(f.accessToken, f.context(proof)), undefined, 'a proof cannot be replayed');
  const boundaryAuth = f.makeAuth(new InMemoryDpopReplayStore());
  const boundaryNow = now(), originalNow = Date.now;
  Date.now = () => boundaryNow * 1000;
  try {
    const boundaryProof = await f.signProof(f.accessToken, { iat: boundaryNow - 60 });
    assert.equal((await boundaryAuth.authenticate(f.accessToken, f.context(boundaryProof)))?.id, principal.id, 'proof at the age boundary is still valid');
    assert.equal(await boundaryAuth.authenticate(f.accessToken, f.context(boundaryProof)), undefined, 'age-boundary proof remains replay-protected');
  } finally { Date.now = originalNow; }
  assert.equal((await f.makeAuth().authenticate(f.accessToken, f.context(await f.signProof(), { requestTarget: '/mcp?cursor=ignored' })))?.id, principal.id, 'the DPoP target omits the query by specification');

  const cases = [
    [await f.signProof(f.accessToken, { htm: 'POST' }), {}],
    [await f.signProof(f.accessToken, { htu: 'https://gateway.example/other' }), {}],
    [await f.signProof(f.accessToken, { ath: 'wrong' }), {}],
    [await f.signProof(f.accessToken, { iat: now() - 61 }), {}],
    [await f.signProof(f.accessToken, {}, { typ: 'JWT' }), {}],
    [await f.signProof(f.accessToken, {}, { jwk: { ...f.proofJwk, d: 'private-material' } }), {}],
    [await f.signProof(), { authorizationScheme: 'Bearer' }],
    [await f.signProof(), { dpopProofHeaderCount: 2 }]
  ];
  for (const [invalidProof, changes] of cases) assert.equal(await auth.authenticate(f.accessToken, f.context(invalidProof, changes)), undefined);
  const wrongConfirmation = await new SignJWT({ cnf: { jkt: 'A'.repeat(43) }, scope: 'mcp:access' }).setProtectedHeader({ alg: 'ES256', kid: 'issuer-key', typ: 'at+jwt' }).setIssuer(issuer).setAudience(audience).setSubject('workload').setIssuedAt().setExpirationTime('5m').sign(f.issuerKeys.privateKey);
  assert.equal(await auth.authenticate(wrongConfirmation, f.context(await f.signProof(wrongConfirmation))), undefined);

  const unavailable = f.makeAuth({ consume: async () => { throw new DpopReplayStoreUnavailable(); } });
  await assert.rejects(unavailable.authenticate(f.accessToken, f.context(await f.signProof())), DpopReplayStoreUnavailable);
});

test('DPoP MCP HTTP mode uses DPoP challenges, rejects bearer downgrade, and rejects replay', async t => {
  const f = await fixture();
  const store = new InMemoryDpopReplayStore();
  const auth = f.makeAuth(store);
  const gateway = await listen(createGateway({ allowLocalHttp: true, clients: [principal], upstreams: [] }, { authenticator: auth }), t);
  const denied = await fetch(`${gateway}/mcp`);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate'), /^DPoP /i);
  const proof = await f.signProof();
  const headers = { Authorization: `DPoP ${f.accessToken}`, DPoP: proof };
  const accepted = await fetch(`${gateway}/mcp`, { headers });
  assert.notEqual(accepted.status, 401, 'a valid proof authenticates before MCP method handling');
  const replay = await fetch(`${gateway}/mcp`, { headers });
  assert.equal(replay.status, 401);
  const bearer = await fetch(`${gateway}/mcp`, { headers: { Authorization: `Bearer ${f.accessToken}`, DPoP: await f.signProof() } });
  assert.equal(bearer.status, 401, 'a DPoP-bound token cannot be downgraded to bearer authentication');
});

test('opaque introspection accepts DPoP-bound tokens only with the matching proof key', async t => {
  const f = await fixture();
  const app = express(); app.use(express.urlencoded({ extended: false }));
  app.post('/introspect', (req, res) => {
    assert.equal(req.body.token, 'opaque-access-token');
    res.json({ active: true, iss: issuer, aud: audience, sub: 'workload', exp: now() + 60, iat: now(), token_type: 'DPoP', cnf: { jkt: f.jkt }, scope: 'mcp:access' });
  });
  const url = await listen(app, t);
  const auth = new IntrospectionAuthenticator({ endpoint: `${url}/introspect`, issuer, audience, clientId: 'gateway', clientSecret: 'private', clients: [principal], allowLocalHttp: true, dpop: { publicOrigin: 'https://gateway.example', replayStore: new InMemoryDpopReplayStore() } });
  const proof = await f.signProof('opaque-access-token');
  const context = f.context(proof);
  assert.equal((await auth.authenticate('opaque-access-token', context))?.id, principal.id);
  assert.equal(await auth.authenticate('opaque-access-token', context), undefined, 'proof replay is denied');
  assert.equal(await auth.authenticate('opaque-access-token', { ...context, authorizationScheme: 'Bearer' }), undefined);
});

test('optional resource nonce challenges and accepts a fresh proof on retry', async t => {
  const f = await fixture();
  const nonceManager = new DpopNonceManager('shared-test-secret-with-more-than-32-characters', 60);
  const gateway = await listen(createGateway({ allowLocalHttp: true, clients: [principal], upstreams: [] }, { authenticator: f.makeAuth(new InMemoryDpopReplayStore(), nonceManager) }), t);
  const send = proof => fetch(`${gateway}/mcp`, { headers: { Authorization: `DPoP ${f.accessToken}`, DPoP: proof } });
  const challenge = await send(await f.signProof());
  assert.equal(challenge.status, 401);
  assert.equal(challenge.headers.get('www-authenticate'), 'DPoP error="use_dpop_nonce"');
  const nonce = challenge.headers.get('dpop-nonce');
  assert.ok(nonceManager.verify(nonce));
  assert.equal(new DpopNonceManager('shared-test-secret-with-more-than-32-characters', 60).verify(nonce), nonceManager.verify(nonce), 'any replica with the shared secret validates the nonce');
  assert.equal(new DpopNonceManager('different-shared-secret-of-more-than-32-characters', 60).verify(nonce), undefined, 'a different deployment secret cannot validate it');
  const retriedProof = await f.signProof(f.accessToken, { nonce, iat: now() + 3600 });
  const accepted = await send(retriedProof);
  assert.notEqual(accepted.status, 401);
  assert.equal((await send(retriedProof)).status, 401, 'nonce reuse does not weaken jti replay protection');
  assert.equal(nonceManager.verify(`${nonce}x`), undefined);
  assert.equal(new DpopNonceManager('shared-test-secret-with-more-than-32-characters', 1).verify(nonce, now() + 2), undefined);
});

test('DPoP deployment mode requires an HTTPS origin and shared replay protection', () => {
  const config = { clients: [principal], upstreams: [] };
  const base = { JWT_ISSUER: issuer, JWT_AUDIENCE: audience, JWT_JWKS_URL: `${issuer}/jwks`, JWT_DPOP_REQUIRED: 'true', GATEWAY_DPOP_PUBLIC_ORIGIN: 'https://gateway.example' };
  assert.throws(() => environmentPlugins(config, base), /public HTTPS origin and replay store/i);
  assert.throws(() => environmentPlugins(config, { ...base, GATEWAY_DPOP_PUBLIC_ORIGIN: 'http://gateway.example' }, new InMemoryDpopReplayStore()), /HTTPS origin/i);
  assert.throws(() => environmentPlugins(config, { ...base, JWT_DPOP_REQUIRED: 'yes' }, new InMemoryDpopReplayStore()), /enforcement mode/i);
  assert.throws(() => environmentPlugins(config, { ...base, OAUTH_DPOP_REQUIRED: 'true' }, new InMemoryDpopReplayStore()), /Select one OAuth proof mode/i);
  assert.throws(() => environmentPlugins(config, { ...base, GATEWAY_DPOP_NONCE_REQUIRED: 'true' }, new InMemoryDpopReplayStore()), /nonce mode requires a shared secret/i);
  assert.throws(() => environmentPlugins(config, { ...base, GATEWAY_DPOP_NONCE_REQUIRED: 'true', GATEWAY_DPOP_NONCE_SECRET: 'short' }, new InMemoryDpopReplayStore()), /at least 32 characters/i);
  assert.ok(environmentPlugins(config, { ...base, GATEWAY_DPOP_NONCE_REQUIRED: 'true', GATEWAY_DPOP_NONCE_SECRET: 'shared-test-secret-with-more-than-32-characters' }, new InMemoryDpopReplayStore()).authenticator.challengeScheme === 'DPoP');
  assert.ok(environmentPlugins(config, base, new InMemoryDpopReplayStore()).authenticator.challengeScheme === 'DPoP');
});
