import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../dist/config.js';
import { ApiKeyAuthenticator } from '../dist/plugins.js';
import { mappedIdentity } from '../dist/authentication.js';

const config = {
  clients: [{ id: 'developer', tokenEnv: 'GATEWAY_KEY', allow: ['alpha__echo'] }],
  upstreams: [{ id: 'alpha', url: 'https://example.com/mcp', tokenEnv: 'UPSTREAM_KEY' }]
};
const environment = { GATEWAY_KEY: 'long-development-key-123456789', UPSTREAM_KEY: 'separate-upstream-key' };
test('resolves separate gateway and upstream credentials', () => {
  const resolved = loadConfig(config, environment);
  assert.equal(resolved.clients[0].token, environment.GATEWAY_KEY);
  assert.equal(resolved.upstreams[0].token, environment.UPSTREAM_KEY);
  assert.equal(config.clients[0].token, undefined);
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
