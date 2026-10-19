import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { MultiIssuerJwtAuthenticator } from '../dist/plugins.js';
import { createRuntime } from '../dist/runtime.js';
import { SqliteStore } from '../dist/store.js';
import { environmentPlugins } from '../dist/runtime.js';
import { validateIdentityOptions } from '../dist/authentication.js';
import { adminToken, listen } from './helpers.js';

const issuerA = 'https://identity-a.example';
const issuerB = 'https://identity-b.example';

test('multi-issuer JWT dispatch keeps issuer keys, audience and subject mappings isolated', async () => {
  const pairA = await generateKeyPair('ES256'), pairB = await generateKeyPair('ES256');
  const jwkA = { ...await exportJWK(pairA.publicKey), kid: 'identity-a' };
  const jwkB = { ...await exportJWK(pairB.publicKey), kid: 'identity-b' };
  const profiles = [
    { issuer: issuerA, audience: 'gateway-a', jwksUrl: `${issuerA}/keys`, requiredTyp: 'at+jwt', key: createLocalJWKSet({ keys: [jwkA] }) },
    { issuer: issuerB, audience: 'gateway-b', jwksUrl: `${issuerB}/keys`, requiredTyp: 'at+jwt', key: createLocalJWKSet({ keys: [jwkB] }) }
  ];
  const clients = [
    { id: 'agent-a', subject: 'shared-subject', oauthIssuer: issuerA, allow: ['alpha__echo'] },
    { id: 'agent-b', subject: 'shared-subject', oauthIssuer: issuerB, allow: ['beta__echo'] }
  ];
  const auth = new MultiIssuerJwtAuthenticator(profiles, clients);
  const sign = (issuer, audience, key, kid, subject = 'shared-subject', clientId) => new SignJWT({ ...(clientId ? { client_id: clientId } : {}), scope: 'mcp:access' }).setProtectedHeader({ alg: 'ES256', kid, typ: 'at+jwt' }).setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(key);
  const context = { authorizationHeaderCount: 1, authorizationScheme: 'Bearer', dpopProofHeaderCount: 0, method: 'POST', requestTarget: '/mcp' };

  const tokenA = await sign(issuerA, 'gateway-a', pairA.privateKey, 'identity-a');
  const tokenB = await sign(issuerB, 'gateway-b', pairB.privateKey, 'identity-b');
  assert.equal((await auth.authenticate(tokenA, context))?.id, 'agent-a');
  assert.equal((await auth.authenticate(tokenB, context))?.id, 'agent-b');
  assert.equal(await auth.authenticate(await sign(issuerA, 'gateway-b', pairA.privateKey, 'identity-a'), context), undefined, 'audience is checked by the selected issuer profile');
  assert.equal(await auth.authenticate(await sign(issuerB, 'gateway-b', pairA.privateKey, 'identity-a'), context), undefined, 'one issuer cannot use another issuer’s signing key');
  assert.equal(await auth.authenticate(await sign('https://untrusted.example', 'gateway-a', pairA.privateKey, 'identity-a'), context), undefined, 'unknown issuers never create a verifier');
  assert.equal(await auth.authenticate(await sign(issuerA, 'gateway-a', pairA.privateKey, 'identity-a', 'shared-subject-b'), context), undefined, 'subject mapping remains issuer-specific');
  assert.throws(() => new MultiIssuerJwtAuthenticator(profiles, [{ id: 'unbound', subject: 'shared-subject', allow: [] }]), /bind to a configured oauthIssuer/i);
  assert.throws(() => new MultiIssuerJwtAuthenticator([profiles[0], profiles[0]], clients), /unique issuer profiles/i);
});

test('multi-issuer deployment publishes all pinned authorization servers in MCP resource metadata', async t => {
  const profiles = [
    { issuer: issuerA, audience: 'gateway-a', jwksUrl: `${issuerA}/keys`, requiredTyp: 'at+jwt', requiredScopes: ['mcp:a'] },
    { issuer: issuerB, audience: 'gateway-b', jwksUrl: `${issuerB}/keys`, requiredTyp: 'at+jwt', requiredScopes: ['mcp:b'] }
  ];
  const config = { clients: [
    { id: 'agent-a', subject: 'same', oauthIssuer: issuerA, allow: [] },
    { id: 'agent-b', subject: 'same', oauthIssuer: issuerB, allow: [] }
  ], upstreams: [] };
  const store = new SqliteStore(':memory:', config); t.after(() => store.close());
  const url = await listen(createRuntime(store, { adminKey: adminToken, environment: { JWT_ISSUER_PROFILES: JSON.stringify(profiles), GATEWAY_RESOURCE_URL: 'https://gateway.example/mcp' } }), t);
  const metadata = await (await fetch(`${url}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.deepEqual(metadata.authorization_servers, [issuerA, issuerB]);
  assert.deepEqual(metadata.scopes_supported, ['mcp:a', 'mcp:b']);
  const ready = await fetch(`${url}/readyz`);
  assert.equal(ready.status, 200);
});

test('multi-issuer environment accepts only explicit bounded profiles and issuer-bound identities', () => {
  const profiles = [
    { issuer: issuerA, audience: 'gateway-a', jwksUrl: `${issuerA}/keys` },
    { issuer: issuerB, audience: 'gateway-b', jwksUrl: `${issuerB}/keys` }
  ];
  const clients = [
    { id: 'agent-a', subject: 'same', oauthIssuer: issuerA, allow: [] },
    { id: 'agent-b', subject: 'same', oauthIssuer: issuerB, allow: [] }
  ];
  const config = { clients, upstreams: [] };
  assert.ok(environmentPlugins(config, { JWT_ISSUER_PROFILES: JSON.stringify(profiles) }).authenticator instanceof MultiIssuerJwtAuthenticator);
  assert.throws(() => environmentPlugins(config, { JWT_ISSUER_PROFILES: JSON.stringify(profiles), JWT_ISSUER: issuerA }), /cannot be mixed/i);
  assert.throws(() => environmentPlugins({ ...config, clients: [{ id: 'unbound', subject: 'same', allow: [] }] }, { JWT_ISSUER_PROFILES: JSON.stringify(profiles) }), /bind to a configured oauthIssuer/i);
  assert.throws(() => environmentPlugins(config, { JWT_ISSUER_PROFILES: JSON.stringify([profiles[0], profiles[0]]) }), /unique issuers/i);
  assert.throws(() => environmentPlugins(config, { JWT_ISSUER_PROFILES: '[{"issuer":"https://attacker.example","audience":"gateway","jwksUrl":"http://127.0.0.1/keys"},{"issuer":"https://other.example","audience":"gateway","jwksUrl":"https://other.example/keys"}]' }), /Security endpoint/i);
});

test('OAuth identity overlap checks allow issuer separation and reject wildcard bindings', () => {
  const identity = (id, oauthIssuer, oauthClientId) => ({ id, subject: 'same-subject', tenantId: 'tenant-a', oauthIssuer, oauthClientId, allow: [] });
  assert.doesNotThrow(() => validateIdentityOptions({ clients: [identity('a', issuerA), identity('b', issuerB)] }));
  assert.doesNotThrow(() => validateIdentityOptions({ clients: [identity('a', issuerA, 'client-a'), identity('b', issuerA, 'client-b')] }));
  assert.throws(() => validateIdentityOptions({ clients: [identity('a', issuerA), identity('b', issuerA, 'client-b')] }), /Ambiguous/);
  assert.throws(() => validateIdentityOptions({ clients: [identity('a', undefined, 'client-a'), identity('b', issuerA)] }), /Ambiguous/);
});
