import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../dist/config.js';
import { ExactCredentialBindings } from '../dist/credential-bindings.js';
import { ApiKeyAuthenticator } from '../dist/plugins.js';
import { mappedIdentity } from '../dist/authentication.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const config = {
  clients: [{ id: 'developer', tokenEnv: 'GATEWAY_KEY', allow: ['alpha__echo'] }],
  upstreams: [{ id: 'alpha', url: 'https://example.com/mcp', tokenEnv: 'UPSTREAM_KEY' }]
};
const environment = { GATEWAY_KEY: 'long-development-key-123456789', UPSTREAM_KEY: 'separate-upstream-key' };
const fixtureCertificate = readFileSync(fileURLToPath(new URL('./fixtures/mtls-test-cert.pem', import.meta.url)), 'utf8');
const fixturePrivateKey = readFileSync(fileURLToPath(new URL('./fixtures/mtls-test-key.pem', import.meta.url)), 'utf8');
test('resolves separate gateway and upstream credentials', () => {
  const resolved = loadConfig(config, environment);
  assert.equal(resolved.clients[0].token, environment.GATEWAY_KEY);
  assert.equal(resolved.upstreams[0].token, environment.UPSTREAM_KEY);
  assert.equal(config.clients[0].token, undefined);
});
test('resolves delegated exchange and outbound mTLS secret references only at their approved destinations', () => {
  const endpoint = 'https://jira.example/mcp', tokenEndpoint = 'https://identity.example/token';
  const document = { ...config, upstreams: [{ id: 'alpha', url: endpoint, tls: { clientCertEnv: 'JIRA_CERT', clientKeyEnv: 'JIRA_KEY', caEnv: 'JIRA_CA' }, oauth: { mode: 'token_exchange', tokenEndpoint, clientIdEnv: 'GATEWAY_CLIENT_ID', clientSecretEnv: 'GATEWAY_CLIENT_SECRET', actorTokenEnv: 'GATEWAY_ACTOR_TOKEN', resource: endpoint, scope: 'issues:read' } }] };
  const env = { ...environment, JIRA_CERT: fixtureCertificate, JIRA_KEY: fixturePrivateKey, JIRA_CA: fixtureCertificate, GATEWAY_CLIENT_ID: 'gateway-client', GATEWAY_CLIENT_SECRET: 'gateway-secret', GATEWAY_ACTOR_TOKEN: 'gateway-actor' };
  const refs = [
    ['MCP_UPSTREAM_ALPHA', 'upstream-endpoint', endpoint],
    ['GATEWAY_CLIENT_SECRET', 'oauth-token', tokenEndpoint],
    ['GATEWAY_CLIENT_SECRET', 'oauth-recipient', endpoint],
    ['GATEWAY_ACTOR_TOKEN', 'oauth-token', tokenEndpoint],
    ...['JIRA_CERT', 'JIRA_KEY', 'JIRA_CA'].map(reference => [reference, 'upstream-tls', endpoint]),
    ...['JIRA_CERT', 'JIRA_KEY', 'JIRA_CA'].map(reference => [reference, 'oauth-token-tls', tokenEndpoint])
  ].map(([reference, purpose, destination]) => ({ reference, purpose, endpoint: destination }));
  const resolved = loadConfig(document, env, new ExactCredentialBindings(refs));
  assert.deepEqual(resolved.upstreams[0].tls, { clientCert: env.JIRA_CERT, clientKey: env.JIRA_KEY, ca: env.JIRA_CA });
  assert.equal(resolved.upstreams[0].oauth.actorToken, env.GATEWAY_ACTOR_TOKEN);
  assert.equal(resolved.upstreams[0].oauth.resource, endpoint);
  const mtlsOAuth = loadConfig({ ...document, upstreams: [{ ...document.upstreams[0], oauth: { ...document.upstreams[0].oauth, clientAuthMethod: 'tls_client_auth', clientSecretEnv: undefined } }] }, env);
  assert.equal(mtlsOAuth.upstreams[0].oauth.clientSecret, undefined);
  assert.throws(() => loadConfig(document, env, new ExactCredentialBindings(refs.filter(binding => binding.reference !== 'JIRA_KEY'))), /not approved/);
  const systemCa = loadConfig({ ...document, upstreams: [{ ...document.upstreams[0], tls: { clientCertEnv: 'JIRA_CERT', clientKeyEnv: 'JIRA_KEY' } }] }, env);
  assert.deepEqual(systemCa.upstreams[0].tls, { clientCert: env.JIRA_CERT, clientKey: env.JIRA_KEY, ca: undefined });
  assert.throws(() => loadConfig({ ...document, upstreams: [{ ...document.upstreams[0], oauth: { ...document.upstreams[0].oauth, mode: 'client_credentials' } }] }, env), /Actor tokens are valid only/);
});
test('resolves vendor-specific outbound headers only when their exact secret destinations are approved', () => {
  const endpoint = 'https://jira.example/mcp';
  const policy = new ExactCredentialBindings([
    { reference: 'MCP_UPSTREAM_ALPHA', purpose: 'upstream-endpoint', endpoint },
    { reference: 'JIRA_API_KEY', purpose: 'upstream', endpoint },
    { reference: 'JIRA_WORKSPACE', purpose: 'upstream', endpoint }
  ]);
  const input = { ...config, upstreams: [{ id: 'alpha', url: endpoint, headerEnvRefs: { 'X-API-Key': 'JIRA_API_KEY', 'X-Workspace': 'JIRA_WORKSPACE' } }] };
  const testEnvironment = { ...environment, JIRA_API_KEY: 'scoped-api-key', JIRA_WORKSPACE: 'team-42' };
  const resolved = loadConfig(input, testEnvironment, policy);
  assert.deepEqual(resolved.upstreams[0].headers, { 'X-API-Key': 'scoped-api-key', 'X-Workspace': 'team-42' });
  assert.throws(() => loadConfig(input, testEnvironment, new ExactCredentialBindings([{ reference: 'MCP_UPSTREAM_ALPHA', purpose: 'upstream-endpoint', endpoint: 'https://other.example/mcp' }, { reference: 'JIRA_API_KEY', purpose: 'upstream', endpoint: 'https://other.example/mcp' }, { reference: 'JIRA_WORKSPACE', purpose: 'upstream', endpoint }])), /not approved/);
  assert.throws(() => loadConfig({ ...config, upstreams: [{ id: 'alpha', url: endpoint, headerEnvRefs: { Authorization: 'JIRA_API_KEY' } }] }, { ...environment, JIRA_API_KEY: 'scoped-api-key' }), /Invalid upstream header reference/);
});
test('fails closed on absent credentials and malformed policies', () => {
  assert.throws(() => loadConfig(config, {}), /Missing credential environment variable/);
  assert.throws(() => loadConfig({ ...config, timeoutMs: -1 }, environment), /timeoutMs/);
  assert.throws(() => loadConfig({ ...config, clients: [{ ...config.clients[0], allow: ['*'] }] }, environment), /allow/);
  assert.throws(() => loadConfig({ ...config, unknownSetting: true }, environment), /Invalid gateway configuration/);
});

test('protocol discovery cache is a bounded explicit opt-in for an upstream', () => {
  const enabled = loadConfig({ ...config, upstreams: [{ ...config.upstreams[0], discoveryCacheTtlMs: 15000 }] }, environment);
  assert.equal(enabled.upstreams[0].discoveryCacheTtlMs, 15000);
  assert.throws(() => loadConfig({ ...config, upstreams: [{ ...config.upstreams[0], discoveryCacheTtlMs: 60001 }] }, environment), /Invalid gateway configuration/);
});

test('OAuth-only identities require explicit subjects and never become API-key identities', async () => {
  const input = { clients: [{ id:'agent',subject:'workload',allow:['alpha__echo'] }, {id:'second',subject:'second-workload',allow:[]}],upstreams:[] };
  const resolved = loadConfig(input,{});
  assert.equal(Object.hasOwn(resolved.clients[0],'token'),false);
  const keys = new ApiKeyAuthenticator(resolved.clients);
  for (const candidate of ['', 'undefined', 'workload', 'agent', 'second-workload']) assert.equal(await keys.authenticate(candidate),undefined);
  const claims = {sub:'workload',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+60};
  assert.equal(mappedIdentity(claims,{clients:resolved.clients},'jwt')?.id,'agent');
  assert.equal(mappedIdentity({...claims,sub:'unknown'},{clients:resolved.clients},'jwt'),undefined);
  assert.throws(()=>loadConfig({...input,clients:[{id:'agent',allow:[]}]},{}),/Invalid client/);
  assert.throws(()=>loadConfig({...input,clients:[{...input.clients[0],tokenEnv:'MISSING'}]},{}),/Missing credential/);
});
