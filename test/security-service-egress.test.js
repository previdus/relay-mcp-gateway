import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { IntrospectionAuthenticator } from '../dist/authentication.js';
import { OAuthCredentialProvider } from '../dist/credentials.js';
import { JwtAuthenticator, OpenFgaAuthorizer } from '../dist/plugins.js';
import { OpaAuthorizer } from '../dist/opa-authorizer.js';
import { environmentPlugins } from '../dist/runtime.js';

const principal = { id: 'agent', token: 'never-forward-this', allow: ['alpha__*'], subject: 'workload' };
function deniedEgress() {
  const resolutions = [];
  return {
    resolutions,
    policy: { resolveAddresses: async hostname => { resolutions.push(hostname); return [{ address: '169.254.169.254', family: 4 }]; } }
  };
}

test('OAuth token exchange refuses to send client and subject credentials to a forbidden DNS answer', async () => {
  const egress = deniedEgress();
  const upstream = { id: 'alpha', url: 'https://backend.example/mcp', oauth: { mode: 'token_exchange', tokenEndpoint: 'https://tokens.example/oauth/token', clientId: 'gateway', clientSecret: 'gateway-secret' } };
  const provider = new OAuthCredentialProvider(false, egress.policy);
  await assert.rejects(provider.headers(upstream, { ...principal, authScheme: 'jwt' }, 'agent-access-token'));
  assert.deepEqual(egress.resolutions, ['tokens.example']);
});

test('OAuth introspection refuses to send the inbound agent token or client secret to a forbidden DNS answer', async () => {
  const egress = deniedEgress();
  const auth = new IntrospectionAuthenticator({ endpoint: 'https://identity.example/introspect', issuer: 'https://identity.example', audience: 'gateway', clientId: 'gateway', clientSecret: 'introspection-secret', clients: [principal], egressPolicy: egress.policy });
  assert.equal(await auth.authenticate('agent-access-token'), undefined);
  assert.deepEqual(egress.resolutions, ['identity.example']);
});

test('JWKS refresh refuses a forbidden DNS answer before downloading a signing key set', async () => {
  const { privateKey } = await generateKeyPair('ES256');
  const egress = deniedEgress();
  const options = { issuer: 'https://identity.example', audience: 'gateway', jwksUrl: 'https://keys.example/jwks', clients: [principal], egressPolicy: egress.policy };
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'key-1' }).setIssuer(options.issuer).setAudience(options.audience).setSubject('workload').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  assert.equal(await new JwtAuthenticator(options).authenticate(token), undefined);
  assert.deepEqual(egress.resolutions, ['keys.example']);
});

test('OPA and OpenFGA bearer credentials are not sent when strict DNS validation rejects the endpoint', async () => {
  const egress = deniedEgress();
  const opa = new OpaAuthorizer({ url: 'https://opa.example/v1/data/authz/allow', token: 'opa-secret', egressPolicy: egress.policy });
  const fga = new OpenFgaAuthorizer({ url: 'https://fga.example', storeId: 'store', modelId: 'model', token: 'fga-secret', egressPolicy: egress.policy });
  assert.equal(await opa.canCall(principal, 'alpha__echo'), false);
  assert.equal(await fga.canCall(principal, 'alpha__echo'), false);
  assert.deepEqual(egress.resolutions, ['opa.example', 'fga.example']);
});

test('strict egress mode is wired into the environment-created OAuth and policy services', () => {
  const config = { clients: [principal], upstreams: [] };
  const oauth = environmentPlugins(config, { GATEWAY_REQUIRE_EGRESS_VALIDATION: 'true', OAUTH_INTROSPECTION_URL: 'https://identity.example/introspect', OAUTH_ISSUER: 'https://identity.example', OAUTH_AUDIENCE: 'gateway', OAUTH_INTROSPECTION_CLIENT_ID: 'gateway', OAUTH_INTROSPECTION_CLIENT_SECRET: 'secret' });
  assert.ok(oauth.egressPolicy);
  assert.ok(oauth.authenticator.options.egressPolicy);

  const opa = environmentPlugins(config, { GATEWAY_REQUIRE_EGRESS_VALIDATION: 'true', OPA_DECISION_URL: 'https://opa.example/v1/data/authz/allow', OPA_BEARER_TOKEN: 'opa-secret' });
  assert.ok(opa.egressPolicy);
  assert.ok(opa.authorizer.policies.find(policy => policy instanceof OpaAuthorizer).options.egressPolicy);

  const fga = environmentPlugins(config, { GATEWAY_REQUIRE_EGRESS_VALIDATION: 'true', FGA_URL: 'https://fga.example', FGA_STORE_ID: 'store', FGA_MODEL_ID: 'model', FGA_API_TOKEN: 'fga-secret' });
  assert.ok(fga.authorizer.policies.find(policy => policy.constructor.name === 'OpenFgaAuthorizer').options.egressPolicy);
});
