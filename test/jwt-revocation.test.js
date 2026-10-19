import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { JwtAuthenticator, MultiIssuerJwtAuthenticator } from '../dist/plugins.js';
import { SqliteStore } from '../dist/store.js';
import { createRuntime, environmentPlugins } from '../dist/runtime.js';
import { adminToken, listen } from './helpers.js';

const issuer = 'https://identity.example';
const audience = 'https://gateway.example/mcp';
const principal = { id: 'agent', subject: 'workload', oauthIssuer: issuer, allow: ['alpha__echo'] };
const context = { authorizationHeaderCount: 1, authorizationScheme: 'Bearer', dpopProofHeaderCount: 0, method: 'POST', requestTarget: '/mcp' };

test('JWT jti revocation is issuer-bound, immediate, and fails closed on store errors', async () => {
  const pair = await generateKeyPair('ES256'), jwk = { ...await exportJWK(pair.publicKey), kid: 'key-1' }, revoked = new Set();
  const store = { async isRevoked(profileIssuer, tokenId) { if (tokenId === 'db-error') throw new Error('private database detail'); return revoked.has(`${profileIssuer}\0${tokenId}`); } };
  const auth = new JwtAuthenticator({ issuer, audience, jwksUrl: `${issuer}/keys`, key: createLocalJWKSet({ keys: [jwk] }), clients: [principal], revocationStore: store });
  const sign = (tokenId, tokenIssuer = issuer) => new SignJWT({ jti: tokenId }).setProtectedHeader({ alg: 'ES256', kid: 'key-1', typ: 'at+jwt' }).setIssuer(tokenIssuer).setAudience(audience).setSubject('workload').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  const valid = await sign('token-1234567890');
  assert.equal((await auth.authenticate(valid, context))?.id, 'agent');
  revoked.add(`${issuer}\0token-1234567890`);
  assert.equal(await auth.authenticate(valid, context), undefined, 'revocation applies on the next authentication');
  assert.equal(await auth.authenticate(await sign('db-error'), context), undefined, 'a revocation-store outage never allows the token');
  assert.equal(await auth.authenticate(await sign('other-issuer', 'https://other.example'), context), undefined, 'issuer validation happens before lookup');
  const withoutId = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'key-1', typ: 'at+jwt' }).setIssuer(issuer).setAudience(audience).setSubject('workload').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  assert.equal(await auth.authenticate(withoutId, context), undefined, 'revocation mode requires a bounded jti');
});

test('SQLite revocations persist only a hash, are issuer-scoped and expire', async t => {
  const config = { clients: [principal], upstreams: [] }, store = new SqliteStore(':memory:', config); t.after(() => store.close());
  const until = Math.floor(Date.now() / 1000) + 60;
  await store.revokeJwt(issuer, 'secret-token-id', until);
  assert.equal(await store.isJwtRevoked(issuer, 'secret-token-id'), true);
  assert.equal(await store.isJwtRevoked('https://other.example', 'secret-token-id'), false);
  const db = store.db;
  const stored = db.prepare('SELECT token_key FROM gateway_jwt_revocations').get().token_key;
  assert.equal(stored.includes('secret-token-id'), false);
  db.prepare('UPDATE gateway_jwt_revocations SET expires_at=?').run(Math.floor(Date.now() / 1000) - 1);
  assert.equal(await store.isJwtRevoked(issuer, 'secret-token-id'), false);
});

test('issuer emergency stops deny every JWT jti and can only be reversed by an explicit audited re-enable', async t => {
  const store = new SqliteStore(':memory:', { clients: [principal], upstreams: [] }); t.after(() => store.close());
  assert.equal(await store.isJwtIssuerDisabled(issuer), false);
  await store.setJwtIssuerDisabled(issuer, true, { requestId: 'disable', at: new Date().toISOString(), clientId: 'administrator', outcome: 'jwt_issuer_disabled', method: 'admin/jwt.issuer.disable' });
  assert.equal(await store.isJwtIssuerDisabled(issuer), true);
  assert.equal(await store.isJwtRevoked(issuer, 'token-without-a-jti'), true, 'issuer stop covers every token identifier');
  assert.equal(await store.isJwtRevoked('https://other.example', 'token-without-a-jti'), false);
  await store.setJwtIssuerDisabled(issuer, false, { requestId: 'enable', at: new Date().toISOString(), clientId: 'administrator', outcome: 'jwt_issuer_enabled', method: 'admin/jwt.issuer.enable' });
  assert.equal(await store.isJwtIssuerDisabled(issuer), false);
  assert.equal(await store.isJwtRevoked(issuer, 'token-without-a-jti'), false);
  assert.deepEqual((await store.recentAudit()).map(event => event.outcome), ['jwt_issuer_enabled', 'jwt_issuer_disabled']);
});

test('administrator revocation API is authenticated, issuer-pinned, expiry-bounded and audited without jti', async t => {
  const config = { clients: [principal], upstreams: [] }, store = new SqliteStore(':memory:', config); t.after(() => store.close());
  const env = { JWT_ISSUER: issuer, JWT_AUDIENCE: audience, JWT_JWKS_URL: `${issuer}/keys`, JWT_REVOCATION_ENABLED: 'true', GATEWAY_RESOURCE_URL: audience };
  const url = await listen(createRuntime(store, { adminKey: adminToken, environment: env }), t);
  assert.equal((await fetch(`${url}/readyz`)).status, 200, 'runtime wires its persistent store into JWT authentication');
  const payload = { issuer, tokenId: 'token-id-1234567890', expiresAt: Math.floor(Date.now() / 1000) + 600 };
  assert.equal((await fetch(`${url}/admin/api/token-revocations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).status, 401);
  const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
  const security = await (await fetch(`${url}/admin/api/security`, { headers })).json();
  assert.deepEqual(security.authorizationServers, [{ issuer, disabled: false }]);
  const unauthenticatedStop = await fetch(`${url}/admin/api/jwt-issuers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issuer, disabled: true }) });
  assert.equal(unauthenticatedStop.status, 401);
  const unknownStop = await fetch(`${url}/admin/api/jwt-issuers`, { method: 'POST', headers, body: JSON.stringify({ issuer: 'https://attacker.example', disabled: true }) });
  assert.equal(unknownStop.status, 400);
  const disabled = await fetch(`${url}/admin/api/jwt-issuers`, { method: 'POST', headers, body: JSON.stringify({ issuer, disabled: true }) });
  assert.equal(disabled.status, 200);
  assert.equal(await store.isJwtRevoked(issuer, 'some-token-jti'), true);
  assert.equal((await (await fetch(`${url}/admin/api/security`, { headers })).json()).authorizationServers[0].disabled, true);
  const enabled = await fetch(`${url}/admin/api/jwt-issuers`, { method: 'POST', headers, body: JSON.stringify({ issuer, disabled: false }) });
  assert.equal(enabled.status, 200);
  assert.equal(await store.isJwtRevoked(issuer, 'some-token-jti'), false);
  const wrongIssuer = await fetch(`${url}/admin/api/token-revocations`, { method: 'POST', headers, body: JSON.stringify({ ...payload, issuer: 'https://attacker.example' }) });
  assert.equal(wrongIssuer.status, 400);
  const tooLong = await fetch(`${url}/admin/api/token-revocations`, { method: 'POST', headers, body: JSON.stringify({ ...payload, expiresAt: Math.floor(Date.now() / 1000) + 31 * 86400 }) });
  assert.equal(tooLong.status, 400);
  const accepted = await fetch(`${url}/admin/api/token-revocations`, { method: 'POST', headers, body: JSON.stringify(payload) });
  assert.equal(accepted.status, 201);
  assert.equal(await store.isJwtRevoked(issuer, payload.tokenId), true);
  const audit = await store.recentAudit();
  assert.equal(audit[0].outcome, 'token_revoked');
  assert.equal(JSON.stringify(audit).includes(payload.tokenId), false);
  store.db.exec("CREATE TRIGGER reject_revocation_audit BEFORE INSERT ON gateway_audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  const blockedId = 'audit-rollback-1234567890';
  const blocked = await fetch(`${url}/admin/api/token-revocations`, { method: 'POST', headers, body: JSON.stringify({ ...payload, tokenId: blockedId }) });
  assert.equal(blocked.status, 503);
  assert.equal(await store.isJwtRevoked(issuer, blockedId), false, 'revocation rolls back if its required audit cannot commit');
  const issuerStop = await fetch(`${url}/admin/api/jwt-issuers`, { method: 'POST', headers, body: JSON.stringify({ issuer, disabled: true }) });
  assert.equal(issuerStop.status, 503);
  assert.equal(await store.isJwtIssuerDisabled(issuer), false, 'issuer stop rolls back if its required audit cannot commit');
  store.db.exec('DROP TRIGGER reject_revocation_audit');
});

test('JWT revocation cannot be enabled without a shared store or alongside introspection', () => {
  const base = { clients: [principal], upstreams: [] };
  assert.throws(() => environmentPlugins(base, { JWT_REVOCATION_ENABLED: 'true', JWT_ISSUER: issuer, JWT_AUDIENCE: audience, JWT_JWKS_URL: `${issuer}/keys` }), /shared revocation store/i);
  assert.throws(() => environmentPlugins(base, { JWT_REVOCATION_ENABLED: 'true', OAUTH_INTROSPECTION_URL: `${issuer}/introspect`, OAUTH_ISSUER: issuer, OAUTH_AUDIENCE: audience, OAUTH_INTROSPECTION_CLIENT_ID: 'gateway', OAUTH_INTROSPECTION_CLIENT_SECRET: 'secret' }, undefined, { isRevoked: async () => false }), /only available in locally verified JWT mode/i);
  const revocations = { isRevoked: async () => false };
  assert.ok(environmentPlugins(base, { JWT_REVOCATION_ENABLED: 'true', JWT_ISSUER: issuer, JWT_AUDIENCE: audience, JWT_JWKS_URL: `${issuer}/keys` }, undefined, revocations).authenticator instanceof JwtAuthenticator);
  const issuerB = 'https://identity-b.example';
  const multi = { clients: [principal, { id: 'agent-b', subject: 'workload-b', oauthIssuer: issuerB, allow: [] }], upstreams: [] };
  const profiles = [{ issuer, audience, jwksUrl: `${issuer}/keys` }, { issuer: issuerB, audience, jwksUrl: `${issuerB}/keys` }];
  assert.ok(environmentPlugins(multi, { JWT_REVOCATION_ENABLED: 'true', JWT_ISSUER_PROFILES: JSON.stringify(profiles) }, undefined, revocations).authenticator instanceof MultiIssuerJwtAuthenticator);
});
