import express, { type Express } from 'express';
import { bearerToken, IntrospectionAuthenticator } from './authentication.js';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hostHeaderValidation } from '@modelcontextprotocol/express';
import { createGateway, type GatewayPlugins } from './modern-gateway.js';
import { loadConfig } from './config.js';
import { InvalidAuditCursor, RevisionConflict, PostgresStore, type ConfigStore } from './store.js';
import { LocalLimiter, PostgresLimiter, type ConcurrencyLimiter } from './limiter.js';
import { tokenEquals, AllowListAuthorizer, RoleAuthorizer, AllOfAuthorizer, OpenFgaAuthorizer, JwtAuthenticator, MultiIssuerJwtAuthenticator, MtlsAuthenticator, ConfigRouter, type JwtIssuerProfile } from './plugins.js';
import type { GatewayConfig } from './types.js';
import { isAbsolute } from 'node:path';
import { GatewayMetrics } from './metrics.js';
import { environmentCredentialBindings } from './credential-bindings.js';
import { OpaAuthorizer } from './opa-authorizer.js';
import { RemoteRouter } from './remote-router.js';
import { RemoteInspector, type InspectorIdentityField } from './remote-inspector.js';
import { RemoteApprovalGate } from './approval-gate.js';
import { LocalRateLimiter, PostgresRateLimiter, CircuitBreakers, PostgresCircuitBreakers, type RateLimiter, type CircuitBreaker } from './traffic.js';
import { validateEgressCidrs } from './egress.js';
import { securityEndpoint } from './security-http.js';
import { sameTenant } from './tenancy.js';
import { DpopNonceManager, InMemoryDpopReplayStore, PostgresDpopReplayStore, type DpopReplayStore } from './dpop.js';

function parseJwtIssuerProfiles(env: NodeJS.ProcessEnv): JwtIssuerProfile[] | undefined {
  if (env.JWT_ISSUER_PROFILES === undefined) return undefined;
  if (env.JWT_ISSUER_PROFILES.length > 65536) throw new Error('JWT issuer profiles exceed the configuration limit');
  let parsed: unknown;
  try { parsed = JSON.parse(env.JWT_ISSUER_PROFILES); } catch { throw new Error('JWT issuer profiles must be valid JSON'); }
  if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 16) throw new Error('JWT issuer profiles must contain 2 to 16 profiles');
  const allowedKeys = new Set(['issuer', 'audience', 'jwksUrl', 'requiredTyp', 'requiredScopes', 'maxTokenAgeSeconds']);
  const profiles = parsed.map((item): JwtIssuerProfile => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !allowedKeys.has(key))) throw new Error('Invalid JWT issuer profile fields');
    const profile = item as Record<string, unknown>;
    if (typeof profile.issuer !== 'string' || profile.issuer.length > 2048 || typeof profile.audience !== 'string' || !profile.audience || profile.audience.length > 2048 || typeof profile.jwksUrl !== 'string' || profile.jwksUrl.length > 2048) throw new Error('JWT issuer profiles require issuer, audience and JWKS URL');
    securityEndpoint(profile.issuer); securityEndpoint(profile.jwksUrl);
    if (profile.requiredTyp !== undefined && typeof profile.requiredTyp !== 'string' || profile.requiredScopes !== undefined && (!Array.isArray(profile.requiredScopes) || profile.requiredScopes.length > 32 || profile.requiredScopes.some(scope => typeof scope !== 'string')) || profile.maxTokenAgeSeconds !== undefined && (!Number.isInteger(profile.maxTokenAgeSeconds) || Number(profile.maxTokenAgeSeconds) < 1 || Number(profile.maxTokenAgeSeconds) > 86400)) throw new Error('Invalid JWT issuer profile validation settings');
    return profile as unknown as JwtIssuerProfile;
  });
  if (new Set(profiles.map(profile => profile.issuer)).size !== profiles.length) throw new Error('JWT issuer profiles must use unique issuers');
  return profiles;
}

export function environmentPlugins(config: GatewayConfig, env: NodeJS.ProcessEnv, dpopReplayStore?: DpopReplayStore, jwtRevocationStore?: import('./authentication.js').JwtRevocationStore): GatewayPlugins {
  const jwtIssuerProfiles = parseJwtIssuerProfiles(env);
  if (env.JWT_REVOCATION_ENABLED !== undefined && !['true', 'false'].includes(env.JWT_REVOCATION_ENABLED)) throw new Error('Invalid JWT revocation mode');
  const jwtRevocationEnabled = env.JWT_REVOCATION_ENABLED === 'true';
  if (jwtRevocationEnabled && !jwtRevocationStore) throw new Error('JWT revocation requires a shared revocation store');
  const tlsSettings = [env.GATEWAY_TLS_CERT_FILE, env.GATEWAY_TLS_KEY_FILE, env.GATEWAY_MTLS_CLIENT_CA_FILE];
  const mtlsEnabled = tlsSettings.some(Boolean);
  if (mtlsEnabled && tlsSettings.some(value => !value)) throw new Error('mTLS requires gateway TLS certificate, key, and client CA files');
  if (mtlsEnabled && (jwtIssuerProfiles || env.JWT_ISSUER || env.JWT_JWKS_URL || env.JWT_AUDIENCE || Object.keys(env).some(key => key.startsWith('OAUTH_') && env[key]))) throw new Error('Select mTLS or OAuth authentication; mixed inbound authentication modes are not supported');
  if (mtlsEnabled && config.clients.some(client => !client.certificateSha256 || client.token !== undefined)) throw new Error('Every mTLS client needs a pinned certificate thumbprint and must not retain a service-key credential');
  const credentialBindings = environmentCredentialBindings(env);
  if (env.GATEWAY_REQUIRE_CREDENTIAL_BINDINGS !== undefined && !['true', 'false'].includes(env.GATEWAY_REQUIRE_CREDENTIAL_BINDINGS)) throw new Error('Invalid credential binding enforcement mode');
  const requireBindings = env.GATEWAY_REQUIRE_CREDENTIAL_BINDINGS === 'true';
  if (env.GATEWAY_REQUIRE_EGRESS_VALIDATION !== undefined && !['true', 'false'].includes(env.GATEWAY_REQUIRE_EGRESS_VALIDATION)) throw new Error('Invalid egress validation mode');
  const requireEgressValidation = requireBindings || env.GATEWAY_REQUIRE_EGRESS_VALIDATION === 'true';
  if (env.GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS !== undefined && !requireEgressValidation) throw new Error('Private egress CIDRs require egress validation to be enabled');
  const egressCidrs = env.GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS === undefined ? [] : validateEgressCidrs(env.GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS.split(',').map(cidr => cidr.trim()));
  const egressPolicy = requireEgressValidation ? { allowedPrivateCidrs: egressCidrs } : undefined;
  if (requireBindings && config.upstreams.some(upstream => upstream.transport !== 'stdio' || Object.keys(upstream.environment ?? {}).length > 0) && !credentialBindings) throw new Error('Production upstreams require deployment credential bindings');
  const assertCredentialBinding = (reference: string, endpoint: string, purpose: import('./credential-bindings.js').CredentialPurpose) => {
    if (requireBindings && !credentialBindings) throw new Error('Production credentials require deployment credential bindings');
    credentialBindings?.assertAllowed(reference, endpoint, purpose);
  };
  if ((config.features?.callbacks || config.features?.tasks) && (!env.GATEWAY_STATE_KEY || Buffer.byteLength(env.GATEWAY_STATE_KEY) < 32)) throw new Error('Callbacks and MCP Tasks require a shared state key of at least 32 bytes');
  const policies = [new AllowListAuthorizer()];
  if (config.roleGrants) policies.push(new RoleAuthorizer(config.roleGrants));
  const authorizers = [...policies];
  if (env.OPA_DECISION_URL) {
    const timeoutMs = env.OPA_TIMEOUT_MS === undefined ? 1000 : Number(env.OPA_TIMEOUT_MS);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('Invalid OPA decision timeout');
    if (requireBindings) assertCredentialBinding('OPA_DECISION_URL', env.OPA_DECISION_URL, 'authorization-service');
    if (env.OPA_BEARER_TOKEN) assertCredentialBinding('OPA_BEARER_TOKEN', env.OPA_DECISION_URL, 'authorization-service');
    authorizers.push(new OpaAuthorizer({ url: env.OPA_DECISION_URL, token: env.OPA_BEARER_TOKEN, timeoutMs, allowLocalHttp: env.OPA_ALLOW_LOCAL_HTTP === 'true', ...(egressPolicy ? { egressPolicy } : {}) }));
  } else if (env.OPA_BEARER_TOKEN || env.OPA_TIMEOUT_MS || env.OPA_ALLOW_LOCAL_HTTP) throw new Error('Incomplete OPA authorization configuration');
  if (env.FGA_URL) {
    if (env.FGA_API_TOKEN) assertCredentialBinding('FGA_API_TOKEN', `${env.FGA_URL.replace(/\/$/, '')}/stores/${encodeURIComponent(env.FGA_STORE_ID ?? '')}/check`, 'authorization-service');
    authorizers.push(new OpenFgaAuthorizer({ url: env.FGA_URL, storeId: env.FGA_STORE_ID ?? '', modelId: env.FGA_MODEL_ID ?? '', token: env.FGA_API_TOKEN, allowLocalHttp: env.FGA_ALLOW_HTTP === 'true', namespaceFormat: env.FGA_NAMESPACE_FORMAT as 'legacy' | 'tuple-v2' | undefined, ...(egressPolicy ? { egressPolicy } : {}) }));
  }
  const plugins: GatewayPlugins = { authorizer: new AllOfAuthorizer(authorizers), stateKey: env.GATEWAY_STATE_KEY };
  if (mtlsEnabled) plugins.authenticator = new MtlsAuthenticator(config.clients);
  if (egressPolicy) plugins.egressPolicy = egressPolicy;
  const routerSettings = [env.ROUTER_BEARER_TOKEN, env.ROUTER_TIMEOUT_MS, env.ROUTER_ALLOW_LOCAL_HTTP];
  if (env.ROUTER_DECISION_URL) {
    if (!env.ROUTER_BEARER_TOKEN) throw new Error('Remote routing requires a separate bearer token');
    if (env.ROUTER_ALLOW_LOCAL_HTTP !== undefined && !['true', 'false'].includes(env.ROUTER_ALLOW_LOCAL_HTTP)) throw new Error('Invalid remote routing HTTP mode');
    const timeoutMs = env.ROUTER_TIMEOUT_MS === undefined ? 500 : Number(env.ROUTER_TIMEOUT_MS);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 5000) throw new Error('Invalid remote routing timeout');
    if (requireBindings) assertCredentialBinding('ROUTER_DECISION_URL', env.ROUTER_DECISION_URL, 'routing-service');
    assertCredentialBinding('ROUTER_BEARER_TOKEN', env.ROUTER_DECISION_URL, 'routing-service');
    const endpoint = new URL(env.ROUTER_DECISION_URL);
    plugins.router = new RemoteRouter(config, {
      url: endpoint.href,
      token: env.ROUTER_BEARER_TOKEN,
      timeoutMs,
      allowLocalHttp: env.ROUTER_ALLOW_LOCAL_HTTP === 'true',
      ...(requireEgressValidation ? { egressPolicy: plugins.egressPolicy } : {})
    });
  } else if (routerSettings.some(value => value !== undefined)) throw new Error('Incomplete remote routing configuration');
  const inspectorSettings = [env.INSPECTOR_BEARER_TOKEN, env.INSPECTOR_TOOLS, env.INSPECTOR_TIMEOUT_MS, env.INSPECTOR_MAX_BYTES, env.INSPECTOR_ALLOW_LOCAL_HTTP, env.INSPECTOR_IDENTITY_FIELDS, env.INSPECTOR_DATA_MODE];
  if (env.INSPECTOR_DECISION_URL) {
    if (!env.INSPECTOR_BEARER_TOKEN) throw new Error('Remote inspection requires a separate bearer token');
    if (!env.INSPECTOR_TOOLS || env.INSPECTOR_TOOLS.length > 32768) throw new Error('Remote inspection requires a bounded tool allowlist');
    const tools = env.INSPECTOR_TOOLS.split(',').map(name => name.trim());
    if (tools.some(name => !name) || tools.length > 256) throw new Error('Invalid remote inspection tool allowlist');
    if (env.INSPECTOR_ALLOW_LOCAL_HTTP !== undefined && !['true', 'false'].includes(env.INSPECTOR_ALLOW_LOCAL_HTTP)) throw new Error('Invalid remote inspection HTTP mode');
    const timeoutMs = env.INSPECTOR_TIMEOUT_MS === undefined ? config.inspectionTimeoutMs ?? 1000 : Number(env.INSPECTOR_TIMEOUT_MS);
    const maxRequestBytes = env.INSPECTOR_MAX_BYTES === undefined ? 256 * 1024 : Number(env.INSPECTOR_MAX_BYTES);
    const identityFields = env.INSPECTOR_IDENTITY_FIELDS === undefined ? ['id', 'tenantId'] as InspectorIdentityField[] : env.INSPECTOR_IDENTITY_FIELDS.split(',').map(field => field.trim()) as InspectorIdentityField[];
    const dataMode = env.INSPECTOR_DATA_MODE ?? 'metadata';
    if (!['metadata', 'full'].includes(dataMode)) throw new Error('Invalid remote inspection data mode');
    if (identityFields.some(field => !field) || new Set(identityFields).size !== identityFields.length || !identityFields.includes('id') || identityFields.some(field => !['id', 'tenantId', 'subject', 'roles', 'authScheme'].includes(field))) throw new Error('Invalid remote inspector identity fields');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('Invalid remote inspection timeout');
    if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1024 || maxRequestBytes > 1024 * 1024) throw new Error('Invalid remote inspection request limit');
    if (requireBindings) assertCredentialBinding('INSPECTOR_DECISION_URL', env.INSPECTOR_DECISION_URL, 'inspection-service');
    assertCredentialBinding('INSPECTOR_BEARER_TOKEN', env.INSPECTOR_DECISION_URL, 'inspection-service');
    const endpoint = new URL(env.INSPECTOR_DECISION_URL);
    plugins.inspectors = [new RemoteInspector({
      url: endpoint.href,
      token: env.INSPECTOR_BEARER_TOKEN,
      tools,
      timeoutMs,
      maxRequestBytes,
      identityFields,
      dataMode: dataMode as 'metadata' | 'full',
      allowLocalHttp: env.INSPECTOR_ALLOW_LOCAL_HTTP === 'true',
      ...(requireEgressValidation ? { egressPolicy: plugins.egressPolicy } : {})
    })];
  } else if (inspectorSettings.some(value => value !== undefined)) throw new Error('Incomplete remote inspection configuration');
  const approvalSettings = [env.APPROVAL_BEARER_TOKEN, env.APPROVAL_TIMEOUT_MS, env.APPROVAL_MAX_BYTES, env.APPROVAL_ALLOW_LOCAL_HTTP];
  if (env.APPROVAL_DECISION_URL) {
    if (!env.APPROVAL_BEARER_TOKEN) throw new Error('Remote approval requires a separate bearer token');
    if (env.APPROVAL_ALLOW_LOCAL_HTTP !== undefined && !['true', 'false'].includes(env.APPROVAL_ALLOW_LOCAL_HTTP)) throw new Error('Invalid remote approval HTTP mode');
    const timeoutMs = env.APPROVAL_TIMEOUT_MS === undefined ? 1000 : Number(env.APPROVAL_TIMEOUT_MS);
    const maxRequestBytes = env.APPROVAL_MAX_BYTES === undefined ? 256 * 1024 : Number(env.APPROVAL_MAX_BYTES);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('Invalid remote approval timeout');
    if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1024 || maxRequestBytes > 1024 * 1024) throw new Error('Invalid remote approval request limit');
    if (requireBindings) assertCredentialBinding('APPROVAL_DECISION_URL', env.APPROVAL_DECISION_URL, 'approval-service');
    assertCredentialBinding('APPROVAL_BEARER_TOKEN', env.APPROVAL_DECISION_URL, 'approval-service');
    const endpoint = new URL(env.APPROVAL_DECISION_URL);
    plugins.approvalGate = new RemoteApprovalGate({
      url: endpoint.href, token: env.APPROVAL_BEARER_TOKEN, tools: config.approvalRequiredTools ?? [],
      timeoutMs, maxRequestBytes, allowLocalHttp: env.APPROVAL_ALLOW_LOCAL_HTTP === 'true',
      ...(requireEgressValidation ? { egressPolicy: plugins.egressPolicy } : {})
    });
  } else if (approvalSettings.some(value => value !== undefined)) throw new Error('Incomplete remote approval configuration');
  for (const required of [env.JWT_DPOP_REQUIRED, env.OAUTH_DPOP_REQUIRED]) if (required !== undefined && !['true', 'false'].includes(required)) throw new Error('Invalid DPoP enforcement mode');
  if (env.GATEWAY_DPOP_NONCE_REQUIRED !== undefined && !['true', 'false'].includes(env.GATEWAY_DPOP_NONCE_REQUIRED)) throw new Error('Invalid DPoP nonce mode');
  const dpopSettings = (required: boolean): { publicOrigin: string; maxAgeSeconds: number; replayStore: DpopReplayStore; nonceManager?: DpopNonceManager } | undefined => {
    if (!required) return undefined;
    if (!env.GATEWAY_DPOP_PUBLIC_ORIGIN || !dpopReplayStore) throw new Error('DPoP requires a public HTTPS origin and replay store');
    const maxAgeSeconds = env.GATEWAY_DPOP_MAX_AGE_SECONDS === undefined ? 60 : Number(env.GATEWAY_DPOP_MAX_AGE_SECONDS);
    if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 300) throw new Error('Invalid DPoP proof age');
    const origin = new URL(env.GATEWAY_DPOP_PUBLIC_ORIGIN);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('DPoP public origin must be an HTTPS origin without a path');
    const nonceRequired = env.GATEWAY_DPOP_NONCE_REQUIRED === 'true';
    if (nonceRequired && (!env.GATEWAY_DPOP_NONCE_SECRET || env.GATEWAY_DPOP_NONCE_SECRET.length < 32)) throw new Error('DPoP nonce mode requires a shared secret of at least 32 characters');
    if (!nonceRequired && env.GATEWAY_DPOP_NONCE_SECRET !== undefined) throw new Error('DPoP nonce secret requires nonce enforcement');
    return { publicOrigin: origin.origin, maxAgeSeconds, replayStore: dpopReplayStore, ...(nonceRequired ? { nonceManager: new DpopNonceManager(env.GATEWAY_DPOP_NONCE_SECRET!, maxAgeSeconds) } : {}) };
  };
  const jwtDpop = dpopSettings(env.JWT_DPOP_REQUIRED === 'true');
  const oauthDpop = dpopSettings(env.OAUTH_DPOP_REQUIRED === 'true');
  if (!jwtDpop && !oauthDpop && (env.GATEWAY_DPOP_PUBLIC_ORIGIN !== undefined || env.GATEWAY_DPOP_MAX_AGE_SECONDS !== undefined || env.GATEWAY_DPOP_NONCE_REQUIRED !== undefined || env.GATEWAY_DPOP_NONCE_SECRET !== undefined)) throw new Error('DPoP settings require an enabled OAuth proof mode');
  if (jwtDpop && oauthDpop) throw new Error('Select one OAuth proof mode');
  if (mtlsEnabled && (jwtDpop || oauthDpop)) throw new Error('Select mTLS or DPoP OAuth authentication');
  if (env.OAUTH_INTROSPECTION_URL) {
    if (jwtRevocationEnabled) throw new Error('JWT revocation is only available in locally verified JWT mode; introspection already checks revocation per request');
    if (jwtIssuerProfiles || env.JWT_ISSUER || env.JWT_JWKS_URL || env.JWT_AUDIENCE || env.JWT_DPOP_REQUIRED === 'true') throw new Error('Select JWT verification or introspection, without authentication fallback');
    if (!env.OAUTH_ISSUER || !env.OAUTH_AUDIENCE || !env.OAUTH_INTROSPECTION_CLIENT_ID || !env.OAUTH_INTROSPECTION_CLIENT_SECRET) throw new Error('Introspection requires issuer, audience and separate client credentials');
    if (config.clients.some(client => client.oauthIssuer && client.oauthIssuer !== env.OAUTH_ISSUER)) throw new Error('OAuth identity oauthIssuer does not match the configured introspection issuer');
    if (env.OAUTH_DPOP_REQUIRED === 'true' && !oauthDpop) throw new Error('Invalid introspection DPoP configuration');
    assertCredentialBinding('OAUTH_INTROSPECTION_CLIENT_SECRET', env.OAUTH_INTROSPECTION_URL, 'oauth-token');
    plugins.authenticator = new IntrospectionAuthenticator({ endpoint: env.OAUTH_INTROSPECTION_URL, issuer: env.OAUTH_ISSUER, audience: env.OAUTH_AUDIENCE, clientId: env.OAUTH_INTROSPECTION_CLIENT_ID, clientSecret: env.OAUTH_INTROSPECTION_CLIENT_SECRET, clients: config.clients, requiredScopes: env.OAUTH_REQUIRED_SCOPES?.split(' ').filter(Boolean), maxTokenAgeSeconds: env.OAUTH_MAX_TOKEN_AGE_SECONDS ? Number(env.OAUTH_MAX_TOKEN_AGE_SECONDS) : undefined, ...(oauthDpop ? { dpop: oauthDpop } : {}), ...(egressPolicy ? { egressPolicy } : {}) });
  } else if (Object.entries(env).some(([key,value]) => value && key.startsWith('OAUTH_'))) throw new Error('Incomplete introspection configuration');
  if (jwtIssuerProfiles) {
    if (env.JWT_ISSUER || env.JWT_JWKS_URL || env.JWT_AUDIENCE || env.JWT_REQUIRED_TYP || env.JWT_MAX_TOKEN_AGE_SECONDS || env.JWT_REQUIRED_SCOPES) throw new Error('JWT issuer profiles cannot be mixed with single-issuer JWT settings');
    if (env.JWT_DPOP_REQUIRED === 'true' && !jwtDpop) throw new Error('Invalid multi-issuer DPoP configuration');
    plugins.authenticator = new MultiIssuerJwtAuthenticator(jwtIssuerProfiles, config.clients, jwtDpop, jwtRevocationEnabled ? jwtRevocationStore : undefined, egressPolicy);
  } else if (env.JWT_ISSUER || env.JWT_JWKS_URL || env.JWT_AUDIENCE || env.JWT_REQUIRED_TYP || env.JWT_MAX_TOKEN_AGE_SECONDS || env.JWT_REQUIRED_SCOPES || env.JWT_DPOP_REQUIRED === 'true') {
    if (!env.JWT_ISSUER || !env.JWT_AUDIENCE || !env.JWT_JWKS_URL) throw new Error('JWT issuer, audience and JWKS URL are all required');
    if (config.clients.some(client => client.oauthIssuer && client.oauthIssuer !== env.JWT_ISSUER)) throw new Error('JWT identity oauthIssuer does not match the configured issuer');
    if (env.JWT_DPOP_REQUIRED === 'true' && !jwtDpop) throw new Error('Invalid JWT DPoP configuration');
    plugins.authenticator = new JwtAuthenticator({ issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE, jwksUrl: env.JWT_JWKS_URL, clients: config.clients, requiredScopes: env.JWT_REQUIRED_SCOPES?.split(' ').filter(Boolean), requiredTyp: env.JWT_REQUIRED_TYP, maxTokenAgeSeconds: env.JWT_MAX_TOKEN_AGE_SECONDS ? Number(env.JWT_MAX_TOKEN_AGE_SECONDS) : undefined, ...(jwtDpop ? { dpop: jwtDpop } : {}), ...(jwtRevocationEnabled ? { revocationStore: jwtRevocationStore } : {}), ...(egressPolicy ? { egressPolicy } : {}) });
  }
  if (jwtRevocationEnabled && !plugins.authenticator) throw new Error('JWT revocation requires locally verified JWT authentication');
  if (env.UPSTREAM_ALLOWED_HOSTS) {
    const allowed = env.UPSTREAM_ALLOWED_HOSTS.split(',').map(host => host.trim());
    if (config.upstreams.some(upstream => upstream.transport !== 'stdio' && !allowed.includes(new URL(upstream.url).hostname))) throw new Error('Upstream hostname is outside deployment allowlist');
  }
  for (const upstream of config.upstreams.filter(upstream => upstream.transport === 'stdio')) {
    if (!upstream.command || !isAbsolute(upstream.command) || !(env.STDIO_ALLOWED_COMMANDS ?? '').split(';').includes(upstream.command)) throw new Error('Stdio executable is not approved by this deployment');
  }
  return plugins;
}
export function createRuntime(store: ConfigStore, options: {
  adminKey: string; environment?: NodeJS.ProcessEnv; allowedHosts?: string[]; limiter?: ConcurrencyLimiter;
  rateLimiter?: RateLimiter;
  dpopReplayStore?: DpopReplayStore;
  plugins?: (config: GatewayConfig) => GatewayPlugins;
}) {
  if (options.adminKey.length < 24) throw new Error('Admin key must have at least 24 characters');
  const environment = options.environment ?? process.env;
  const jwtIssuerProfiles = parseJwtIssuerProfiles(environment);
  const authorizationServers = jwtIssuerProfiles?.map(profile => profile.issuer) ?? [environment.JWT_ISSUER ?? environment.OAUTH_ISSUER].filter((issuer): issuer is string => Boolean(issuer));
  const metadataScopes = jwtIssuerProfiles ? [...new Set(jwtIssuerProfiles.flatMap(profile => profile.requiredScopes ?? []))] : (environment.JWT_REQUIRED_SCOPES ?? environment.OAUTH_REQUIRED_SCOPES)?.split(' ').filter(Boolean) ?? [];
  let resource: URL | undefined;
  if (jwtIssuerProfiles || environment.JWT_ISSUER || environment.OAUTH_INTROSPECTION_URL) {
    if (!environment.GATEWAY_RESOURCE_URL) throw new Error('OAuth mode requires GATEWAY_RESOURCE_URL for resource discovery');
    resource = new URL(environment.GATEWAY_RESOURCE_URL);
    if (resource.protocol !== 'https:' || resource.username || resource.password || resource.search || resource.hash) throw new Error('OAuth resource URL must be a public HTTPS URL');
  }
  const app = express();
  app.disable('x-powered-by');
  app.use(hostHeaderValidation(options.allowedHosts ?? ['127.0.0.1', 'localhost', '[::1]']));
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'Cache-Control': 'no-store' });
    next();
  });
  const limiter = options.limiter ?? (store instanceof PostgresStore ? new PostgresLimiter(store.pool) : new LocalLimiter());
  const metrics = new GatewayMetrics();
  const rateLimiter = options.rateLimiter ?? (store instanceof PostgresStore ? new PostgresRateLimiter(store.pool) : new LocalRateLimiter());
  const sharedCircuitBreakers: CircuitBreaker = store instanceof PostgresStore ? new PostgresCircuitBreakers(store.pool) : new CircuitBreakers();
  const dpopReplayStore = options.dpopReplayStore ?? (store instanceof PostgresStore ? new PostgresDpopReplayStore(store.pool) : new InMemoryDpopReplayStore());
  let cached: { revision: number; app: Express } | undefined;
  const metadataPath = resource ? `/.well-known/oauth-protected-resource${resource.pathname === '/' ? '' : resource.pathname}` : undefined;
  const pluginsFor = (config: GatewayConfig) => {
    const deployment = environmentPlugins(config, environment, dpopReplayStore, environment.JWT_REVOCATION_ENABLED === 'true' && store.isJwtRevoked ? { isRevoked: (issuer, tokenId) => store.isJwtRevoked!(issuer, tokenId) } : undefined), application = options.plugins?.(config);
    if (deployment.authenticator && application?.authenticator) throw new Error('Application authenticator cannot replace the deployment authenticator');
    if (deployment.approvalGate && application?.approvalGate) throw new Error('Application approval gate cannot replace the deployment approval gate');
    const plugins: GatewayPlugins = {
      ...deployment, ...application,
      ...(deployment.authorizer && application?.authorizer ? { authorizer: new AllOfAuthorizer([deployment.authorizer, application.authorizer]) } : {}),
      ...(deployment.egressPolicy ? { egressPolicy: deployment.egressPolicy } : {}),
      ...(deployment.stateKey ? { stateKey: deployment.stateKey } : {}),
      ...(deployment.inspectors?.length || application?.inspectors?.length ? { inspectors: [...(application?.inspectors ?? []), ...(deployment.inspectors ?? [])] } : {}),
      limiter, rateLimiter, circuitBreakers: application?.circuitBreakers ?? sharedCircuitBreakers,
      ...(store.putMcpTask && store.getMcpTask ? { taskStore: store } : {}),
      audit: async (event: import('./types.js').AuditEvent) => { metrics.record(event); await store.audit(event); await application?.audit?.(event); }, requireAudit: true,
      ...(resource ? { resourceMetadataUrl: `${resource.origin}${metadataPath}` } : {})
    };
    if (config.approvalRequiredTools?.length && !plugins.approvalGate) throw new Error('Approval-required tools need an approval gate');
    return plugins;
  };
  if (resource && metadataPath) app.get(metadataPath, (_req, res) => res.json({ resource: resource.href, authorization_servers: authorizationServers, bearer_methods_supported: ['header'], scopes_supported: metadataScopes }));
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (_req, res) => {
    try { const snapshot = await store.read(); pluginsFor(loadConfig(snapshot.document, environment)); res.json({ status: 'ready', revision: snapshot.revision }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.use('/admin/api', (req, res, next) => {
    const token = bearerToken(req);
    if (!tokenEquals(token, options.adminKey)) return res.status(401).json({ error: 'Unauthorized' });
    // Management is same-origin only. Requests without Origin support CLI administration.
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: 'Origin denied' }); }
      catch { return res.status(403).json({ error: 'Origin denied' }); }
    }
    next();
  }, express.json({ limit: '256kb' }));
  app.get('/admin/api/config', async (_req, res) => {
    try { const snapshot = await store.read(); res.set('ETag', `"${snapshot.revision}"`).json(snapshot); }
    catch { res.status(503).json({ error: 'Configuration store unavailable' }); }
  });
  app.get('/admin/api/security', async (_req, res) => {
    if (environment.JWT_REVOCATION_ENABLED !== 'true') return res.json({ jwtRevocationEnabled: false, authorizationServers: [] });
    if (!store.isJwtIssuerDisabled) return res.status(503).json({ error: 'JWT issuer status store unavailable' });
    try { return res.json({ jwtRevocationEnabled: true, authorizationServers: await Promise.all(authorizationServers.map(async issuer => ({ issuer, disabled: await store.isJwtIssuerDisabled!(issuer) }))) }); }
    catch { return res.status(503).json({ error: 'JWT issuer status store unavailable' }); }
  });
  if (environment.JWT_REVOCATION_ENABLED === 'true') app.post('/admin/api/token-revocations', async (req, res) => {
    if (!store.revokeJwt) return res.status(503).json({ error: 'JWT revocation store unavailable' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'expiresAt,issuer,tokenId' || typeof body.issuer !== 'string' || typeof body.tokenId !== 'string' || !/^[\x21-\x7E]{1,256}$/.test(body.tokenId) || !Number.isSafeInteger(body.expiresAt)) return res.status(400).json({ error: 'Provide an issuer, JWT ID, and integer expiry time' });
    if (!authorizationServers.includes(body.issuer)) return res.status(400).json({ error: 'Issuer is not configured for JWT authentication' });
    const now = Math.floor(Date.now() / 1000);
    if (body.expiresAt <= now || body.expiresAt > now + 30 * 24 * 60 * 60) return res.status(400).json({ error: 'Expiry must be within the next 30 days' });
    try {
      await store.revokeJwt(body.issuer, body.tokenId, body.expiresAt, { requestId: randomUUID(), at: new Date().toISOString(), clientId: 'administrator', outcome: 'token_revoked', method: 'admin/jwt.revoke' });
      return res.status(201).json({ revoked: true });
    } catch { return res.status(503).json({ error: 'JWT revocation and audit could not be committed' }); }
  });
  if (environment.JWT_REVOCATION_ENABLED === 'true') app.post('/admin/api/jwt-issuers', async (req, res) => {
    if (!store.setJwtIssuerDisabled) return res.status(503).json({ error: 'JWT issuer status store unavailable' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'disabled,issuer' || typeof body.issuer !== 'string' || typeof body.disabled !== 'boolean') return res.status(400).json({ error: 'Provide a configured issuer and disabled state' });
    if (!authorizationServers.includes(body.issuer)) return res.status(400).json({ error: 'Issuer is not configured for JWT authentication' });
    try {
      await store.setJwtIssuerDisabled(body.issuer, body.disabled, { requestId: randomUUID(), at: new Date().toISOString(), clientId: 'administrator', outcome: body.disabled ? 'jwt_issuer_disabled' : 'jwt_issuer_enabled', method: body.disabled ? 'admin/jwt.issuer.disable' : 'admin/jwt.issuer.enable' });
      return res.status(200).json({ issuer: body.issuer, disabled: body.disabled });
    } catch { return res.status(503).json({ error: 'JWT issuer state and audit could not be committed' }); }
  });
  const validateDocument = (input: unknown) => {
    const resolved = loadConfig(input, environment);
    if (resolved.clients.some(client => client.token !== undefined && tokenEquals(client.token, options.adminKey))) throw new Error('Admin key must be separate from service credentials');
    pluginsFor(resolved);
  };
  app.post('/admin/api/validate', (req, res) => {
    try { validateDocument(req.body); res.json({ valid: true }); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid configuration' }); }
  });
  app.put('/admin/api/config', async (req, res) => {
    const match = req.headers['if-match']?.match(/^"(\d+)"$/);
    if (!match) return res.status(428).json({ error: 'A configuration revision is required; reload first' });
    try {
      validateDocument(req.body);
    } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid configuration' }); }
    try {
      const saved = await store.write(req.body, Number(match[1]), { requestId: randomUUID(), at: new Date().toISOString(), clientId: 'administrator', outcome: 'ok', method: 'admin/config.update', configurationRevision: Number(match[1]) + 1 });
      res.set('ETag', `"${saved.revision}"`).json(saved);
    } catch (error) { res.status(error instanceof RevisionConflict ? 409 : 503).json({ error: error instanceof RevisionConflict ? error.message : 'Configuration store unavailable' }); }
  });
  app.get('/admin/api/audit', async (_req, res) => {
    try { res.json(await store.recentAudit()); } catch { res.status(503).json({ error: 'Audit store unavailable' }); }
  });
  app.get('/admin/api/audit/pages', async (req, res) => {
    if (!store.auditPage) return res.status(501).json({ error: 'Audit pagination is not supported by this store' });
    if ((req.query.limit !== undefined && typeof req.query.limit !== 'string') || (req.query.cursor !== undefined && typeof req.query.cursor !== 'string')) return res.status(400).json({ error: 'Invalid audit page request' });
    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || (req.query.cursor !== undefined && req.query.cursor.length > 28)) return res.status(400).json({ error: 'Invalid audit page request' });
    try { return res.json(await store.auditPage(req.query.cursor as string | undefined, limit)); }
    catch (error) { return res.status(error instanceof InvalidAuditCursor ? 400 : 503).json({ error: error instanceof InvalidAuditCursor ? 'Invalid audit cursor' : 'Audit store unavailable' }); }
  });
  app.get('/admin/api/history', async (_req, res) => {
    if (!store.history) return res.status(501).json({ error: 'History is not supported by this store' });
    try { res.json(await store.history()); } catch { res.status(503).json({ error: 'History store unavailable' }); }
  });
  app.get('/admin/api/history/:revision', async (req, res) => {
    if (!store.revision) return res.status(501).json({ error: 'History is not supported by this store' });
    const revision = Number(req.params.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) return res.status(400).json({ error: 'Invalid revision' });
    try { const snapshot = await store.revision(revision); if (!snapshot) return res.status(404).json({ error: 'Revision not found' }); res.json(snapshot); }
    catch { res.status(503).json({ error: 'History store unavailable' }); }
  });
  app.post('/admin/api/rollback', async (req, res) => {
    if (!store.revision) return res.status(501).json({ error: 'History is not supported by this store' });
    const match = req.headers['if-match']?.match(/^"(\d+)"$/);
    if (!match) return res.status(428).json({ error: 'A current configuration revision is required' });
    const revision = req.body?.revision;
    if (!Number.isSafeInteger(revision) || revision < 1) return res.status(400).json({ error: 'Invalid revision' });
    try {
      const snapshot = await store.revision(revision);
      if (!snapshot) return res.status(404).json({ error: 'Revision not found' });
      try { validateDocument(snapshot.document); } catch { return res.status(400).json({ error: 'Historical configuration is invalid under current deployment settings' }); }
      const saved = await store.write(snapshot.document, Number(match[1]), { requestId: randomUUID(), at: new Date().toISOString(), clientId: 'administrator', outcome: 'ok', method: 'admin/config.rollback', sourceRevision: revision, configurationRevision: Number(match[1]) + 1 });
      res.set('ETag', `"${saved.revision}"`).json(saved);
    } catch (error) { res.status(error instanceof RevisionConflict ? 409 : 503).json({ error: error instanceof RevisionConflict ? error.message : 'Configuration store unavailable' }); }
  });
  app.get('/admin/api/metrics', (_req, res) => res.type('text/plain; version=0.0.4').send(metrics.render()));
  app.post('/admin/api/resolve', async (req, res) => {
    if (typeof req.body?.clientId !== 'string' || typeof req.body?.tool !== 'string' || req.body.tool.length > 128) return res.status(400).json({ error: 'clientId and tool are required' });
    try {
      const snapshot = await store.read();
      const config = loadConfig(snapshot.document, environment);
      const principal = config.clients.find(client => client.id === req.body.clientId);
      if (!principal) return res.status(404).json({ error: 'Unknown service identity' });
      const plugins = pluginsFor(config);
      const authorizer = plugins.authorizer ?? new AllowListAuthorizer();
      let authorized = false;
      try { authorized = await authorizer.canCall(principal, req.body.tool); } catch {}
      const router = plugins.router ?? new ConfigRouter(config);
      const route = authorized ? await router.resolve(req.body.tool, { principal, requestId: randomUUID() }) : undefined;
      const rule = config.routes?.find(candidate => candidate.name === req.body.tool);
      const selectorsMatch = !rule || (!rule.clients || rule.clients.includes(principal.id)) && (!rule.tenants || rule.tenants.includes(principal.tenantId ?? 'default')) && (!rule.requiredRoles || rule.requiredRoles.every(role => principal.roles?.includes(role)));
      const configuredTarget = route && (rule
        ? selectorsMatch && rule.targets.some(target => target.enabled !== false && target.upstreamId === route.upstream.id && target.tool === route.tool)
        : req.body.tool === `${route.upstream.id}__${route.tool}`);
      const registered = route && configuredTarget && config.upstreams.some(upstream => upstream.id === route.upstream.id && sameTenant(principal, upstream));
      return res.json({ revision: snapshot.revision, authorized, routable: Boolean(registered), ...(registered ? { upstreamId: route.upstream.id, upstreamTool: route.tool } : {}), reason: !authorized ? 'Permission denied or policy unavailable' : registered ? 'Policy granted; configured target selected' : 'No eligible registered target' });
    } catch { return res.status(503).json({ error: 'Configuration or policy service unavailable' }); }
  });
  app.use('/admin', express.static(fileURLToPath(new URL('../public/', import.meta.url)), { index: 'index.html', etag: false }));
  app.use(async (req, res, next) => {
    if (req.path !== '/mcp' && req.path !== '/catalog/search') return next();
    try {
      const snapshot = await store.read();
      if (!cached || cached.revision !== snapshot.revision) {
        const config = loadConfig(snapshot.document, environment);
        cached = { revision: snapshot.revision, app: createGateway(config, { ...pluginsFor(config), configurationRevision: snapshot.revision, isRevisionCurrent: async () => (await store.read()).revision === snapshot.revision }) };
      }
      cached.app(req, res, next);
    } catch { res.status(503).json({ error: 'Gateway configuration unavailable' }); }
  });
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(400).json({ error: 'Invalid request' }); });
  return app;
}
