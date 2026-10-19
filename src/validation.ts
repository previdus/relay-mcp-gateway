import type { GatewayConfig } from './types.js';
import { invocationPoliciesSchema, catalogPolicySchema } from './invocation-policy.js';
import { discoverySchema } from './catalog.js';
import { securityEndpoint } from './security-http.js';
export function validateConfig(config: GatewayConfig): GatewayConfig {
  if (config.discovery !== undefined && !discoverySchema.safeParse(config.discovery).success) throw new Error('Invalid discovery limits');
  if (config.inspectionTimeoutMs !== undefined && (!Number.isInteger(config.inspectionTimeoutMs) || config.inspectionTimeoutMs < 1 || config.inspectionTimeoutMs > 5000)) throw new Error('Invalid inspection timeout');
  if (config.invocationPolicies !== undefined && !invocationPoliciesSchema.safeParse(config.invocationPolicies).success) throw new Error('Invalid invocation policy');
  if (config.catalogPolicy !== undefined && !catalogPolicySchema.safeParse(config.catalogPolicy).success) throw new Error('Invalid catalog policy');
  for (const [name, fingerprint] of Object.entries(config.toolContracts ?? {})) if (!/^[a-zA-Z0-9_.-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid tool contract pin');
  const rates = [config.traffic?.rateLimit, ...Object.values(config.traffic?.toolRateLimits ?? {}), ...(config.clients ?? []).map(client => client.rateLimit)];
  for (const rate of rates) if (rate && (!Number.isInteger(rate.capacity) || rate.capacity < 1 || rate.capacity > 1000000 || !Number.isFinite(rate.refillPerSecond) || rate.refillPerSecond < 0.001 || rate.refillPerSecond > 1000000)) throw new Error('Invalid rate policy');
  const circuit = config.traffic?.circuitBreaker;
  if (circuit && (!Number.isInteger(circuit.failureThreshold) || circuit.failureThreshold < 1 || circuit.failureThreshold > 1000 || !Number.isInteger(circuit.resetAfterMs) || circuit.resetAfterMs < 100 || circuit.resetAfterMs > 3600000)) throw new Error('Invalid circuit breaker policy');
  if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 120000)) throw new Error('timeoutMs must be between 1 and 120000');
  if (config.maxConcurrentPerClient !== undefined && (!Number.isInteger(config.maxConcurrentPerClient) || config.maxConcurrentPerClient < 1)) throw new Error('maxConcurrentPerClient must be a positive integer');
  if (!config.clients?.length || !Array.isArray(config.upstreams)) throw new Error('Clients and upstreams are required');
  const ids = new Set();
  for (const upstream of config.upstreams) {
    for (const budget of [upstream.timeoutMs, upstream.connectTimeoutMs]) if (budget !== undefined && (!Number.isInteger(budget) || budget < 1 || budget > 120000)) throw new Error('Invalid upstream timeout');
    if (upstream.discoveryCacheTtlMs !== undefined && (!Number.isInteger(upstream.discoveryCacheTtlMs) || upstream.discoveryCacheTtlMs < 1 || upstream.discoveryCacheTtlMs > 60000)) throw new Error('Invalid protocol discovery cache TTL');
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(upstream.id) || ids.has(upstream.id)) throw new Error('Invalid or duplicate upstream id');
    ids.add(upstream.id);
    if (upstream.oauth) {
      securityEndpoint(upstream.oauth.tokenEndpoint, config.allowLocalHttp);
      if (!['client_credentials', 'token_exchange'].includes(upstream.oauth.mode) || upstream.oauth.clientAuthMethod !== undefined && !['client_secret_basic', 'client_secret_post'].includes(upstream.oauth.clientAuthMethod) || typeof upstream.oauth.clientId !== 'string' || !upstream.oauth.clientId || typeof upstream.oauth.clientSecret !== 'string') throw new Error('Invalid upstream OAuth client authentication configuration');
      if (upstream.token) throw new Error('Select either static or OAuth upstream credentials');
    }
    const url = new URL(upstream.url);
    if (upstream.requestPaths !== undefined && (!Array.isArray(upstream.requestPaths) || !upstream.requestPaths.length || upstream.requestPaths.length > 32 || upstream.requestPaths.some(path => typeof path !== 'string' || path.length > 2048 || !path.startsWith('/') || path.startsWith('//') || /[\\?#%\s]/.test(path) || new URL(path, 'https://validation.example').pathname !== path) || !upstream.requestPaths.includes(url.pathname))) throw new Error('Invalid upstream request paths');
    if (url.username || url.password || url.hash) throw new Error('Credentials and fragments are forbidden in upstream URLs');
    if (upstream.transport === 'stdio') {
      if (!upstream.command || url.protocol !== 'stdio:') throw new Error('Stdio requires an approved command and stdio URI');
      if (upstream.oauth || upstream.token) throw new Error('Stdio credentials must use explicit environment references');
      continue;
    }
    if (url.protocol !== 'https:' && !(config.allowLocalHttp && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Upstreams require HTTPS (or explicitly enabled loopback HTTP)');
  }
  const tokens = new Set();
  const certificateThumbprints = new Set();
  const names = new Set<string>();
  for (const route of config.routes ?? []) {
    if (route.targets.some(target => target.enabled !== undefined && typeof target.enabled !== 'boolean')) throw new Error('Invalid route target availability');
    if (route.name.includes('__') || names.has(route.name) || !['weighted', 'sticky', 'rendezvous', 'priority'].includes(route.strategy) || !route.targets.length || new Set(route.targets.map(t => JSON.stringify([t.upstreamId, t.tool]))).size !== route.targets.length || route.targets.some(target => !ids.has(target.upstreamId) || !Number.isInteger(target.weight ?? 1) || (target.weight ?? 1) < 1 || (target.weight ?? 1) > 10000 || !Number.isInteger(target.priority ?? 0) || (target.priority ?? 0) < 0 || (target.priority ?? 0) > 1000)) throw new Error('Invalid routing rule');
    if (route.tenants !== undefined && (!Array.isArray(route.tenants) || !route.tenants.length || route.tenants.length > 100 || route.tenants.some(x => !/^[a-zA-Z0-9_-]{1,64}$/.test(x)))) throw new Error('Invalid route tenant selector');
    if (route.requiredRoles !== undefined && (!Array.isArray(route.requiredRoles) || !route.requiredRoles.length || route.requiredRoles.length > 32 || route.requiredRoles.some(x => typeof x !== 'string' || !x.length || x.length > 128))) throw new Error('Invalid route role selector');
    names.add(route.name);
  }
  const clientIds = new Set();
  for (const client of config.clients) {
    if (client.oauthIssuer !== undefined) {
      try { securityEndpoint(client.oauthIssuer, config.allowLocalHttp); }
      catch { throw new Error('Invalid OAuth issuer identity binding'); }
    }
    if (client.certificateSha256 !== undefined && (!/^[A-Za-z0-9_-]{43}$/.test(client.certificateSha256) || certificateThumbprints.has(client.certificateSha256))) throw new Error('Invalid or duplicate client certificate thumbprint');
    if (client.oauthClientId !== undefined && (typeof client.oauthClientId !== 'string' || !client.oauthClientId.length || client.oauthClientId.length > 256)) throw new Error('Invalid OAuth client identity binding');
    if (client.subject !== undefined && (typeof client.subject !== 'string' || !client.subject.length || client.subject.length > 256)) throw new Error('Invalid verified subject');
    if (!client.id || clientIds.has(client.id) || client.token === undefined && !client.subject && !client.certificateSha256 || client.token !== undefined && (typeof client.token !== 'string' || client.token.length < 24 || tokens.has(client.token)) || !Array.isArray(client.allow) || client.allow.some(x => typeof x !== 'string')) throw new Error('Invalid client identity, token, or allow list');
    if (client.token !== undefined) tokens.add(client.token);
    if (client.certificateSha256 !== undefined) certificateThumbprints.add(client.certificateSha256);
    clientIds.add(client.id);
  }
  return config;
}


