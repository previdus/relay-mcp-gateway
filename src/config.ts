import { z } from 'zod';
import type { GatewayConfig } from './types.js';
import { validateConfig } from './gateway.js';
import { invocationPoliciesSchema, catalogPolicySchema } from './invocation-policy.js';
import { discoverySchema } from './catalog.js';
import { environmentCredentialBindings, type CredentialBindingPolicy } from './credential-bindings.js';

const environmentKey = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const headerName = z.string().min(1).max(128).regex(/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/);
const reservedHeaders = new Set(['authorization', 'proxy-authorization', 'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'cookie', 'set-cookie', 'origin', 'forwarded', 'accept', 'accept-encoding', 'content-type', 'mcp-method', 'mcp-name', 'mcp-protocol-version', 'mcp-session-id']);
function validateHeaderReferences(headers: Record<string, string>) {
  const seen = new Set<string>();
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (reservedHeaders.has(lower) || lower.startsWith('proxy-') || lower.startsWith('sec-') || lower.startsWith('x-forwarded-') || seen.has(lower)) throw new Error('Invalid upstream header reference');
    seen.add(lower);
  }
}
const ratePolicy = z.object({ capacity: z.number().int().min(1).max(1000000), refillPerSecond: z.number().min(0.001).max(1000000) }).strict();
export const configSchema = z.object({
  discovery: discoverySchema.optional(),
  inspectionTimeoutMs: z.number().int().min(1).max(5000).optional(),
  invocationPolicies: invocationPoliciesSchema.optional(),
  catalogPolicy: catalogPolicySchema.optional(),
  toolContracts: z.record(z.string().regex(/^[a-zA-Z0-9_.-]+$/), z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  approvalRequiredTools: z.array(z.string().max(128).regex(/^(?:[a-zA-Z0-9_.-]+|[a-z][a-z0-9-]{0,31}__\*)$/)).min(1).max(256).refine(names => new Set(names).size === names.length, 'Duplicate approval tool').optional(),
  traffic: z.object({ rateLimit: ratePolicy.optional(), toolRateLimits: z.record(z.string().regex(/^[a-zA-Z0-9_.-]+$/), ratePolicy).optional(), circuitBreaker: z.object({ failureThreshold: z.number().int().min(1).max(1000), resetAfterMs: z.number().int().min(100).max(3600000) }).strict().optional() }).strict().optional(),
  allowLocalHttp: z.boolean().optional(),
  timeoutMs: z.number().int().min(1).max(120000).optional(),
  maxConcurrentPerClient: z.number().int().min(1).max(10000).optional(),
  maxUpstreamResponseBytes: z.number().int().min(1024).max(16 * 1024 * 1024).optional(),
  allowedOrigins: z.array(z.string().url()).optional(),
  allowedHosts: z.array(z.string().min(1)).min(1).optional(),
  roleGrants: z.record(z.array(z.string())).optional(),
  features: z.object({ prompts: z.boolean().optional(), resources: z.boolean().optional(), callbacks: z.boolean().optional(), notifications: z.boolean().optional(), catalogSearch: z.boolean().optional(), tasks: z.boolean().optional() }).strict().optional(),
  routes: z.array(z.object({
    name: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
    strategy: z.enum(['sticky', 'weighted', 'rendezvous', 'priority']),
    clients: z.array(z.string()).optional(),
    tenants: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).min(1).max(100).optional(),
    requiredRoles: z.array(z.string().min(1).max(128)).min(1).max(32).optional(),
    targets: z.array(z.object({ upstreamId: z.string(), tool: z.string().min(1), weight: z.number().int().min(1).max(10000).optional(), priority: z.number().int().min(0).max(1000).optional(), enabled: z.boolean().optional() }).strict()).min(1).max(100)
  }).strict()).max(1000).optional(),
  clients: z.array(z.object({
    id: z.string().min(1).max(128),
    tenantId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
    subject: z.string().min(1).max(256).optional(),
    oauthClientId: z.string().min(1).max(256).optional(),
    oauthIssuer: z.string().url().max(2048).optional(),
    certificateSha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
    callbackMethods: z.array(z.enum(['elicitation/create', 'sampling/createMessage', 'roots/list'])).optional(),
    tokenEnv: environmentKey.optional(),
    rateLimit: ratePolicy.optional(),
    allow: z.array(z.string().regex(/^(?:[a-zA-Z0-9_.-]+|[a-z][a-z0-9-]{0,31}__\*)$/)),
    roles: z.array(z.string()).optional(),
    permissions: z.object({ prompts: z.array(z.string()).optional(), resources: z.array(z.string()).optional() }).strict().optional()
  }).strict()).min(1).max(10000),
  upstreams: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    tenantId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
    url: z.string().url(),
    tokenEnv: environmentKey.optional(),
    headerEnvRefs: z.record(headerName, environmentKey).refine(headers => Object.keys(headers).length <= 32).optional(),
    transport: z.enum(['streamable-http', 'sse', 'stdio']).optional(),
    timeoutMs: z.number().int().min(1).max(120000).optional(),
    connectTimeoutMs: z.number().int().min(1).max(120000).optional(),
    discoveryCacheTtlMs: z.number().int().min(1).max(60000).optional(),
    requestPaths: z.array(z.string().min(1).max(2048)).min(1).max(32).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).max(100).optional(),
    envRefs: z.record(environmentKey).optional(),
    oauth: z.object({ mode: z.enum(['client_credentials', 'token_exchange']), clientAuthMethod: z.enum(['client_secret_basic', 'client_secret_post', 'tls_client_auth', 'self_signed_tls_client_auth']).optional(), tokenEndpoint: z.string().url(), clientIdEnv: environmentKey, clientSecretEnv: environmentKey.optional(), actorTokenEnv: environmentKey.optional(), actorTokenType: z.enum(['urn:ietf:params:oauth:token-type:access_token', 'urn:ietf:params:oauth:token-type:jwt']).optional(), scope: z.string().optional(), audience: z.string().optional(), resource: z.string().url().optional() }).strict().optional(),
    tls: z.object({ clientCertEnv: environmentKey, clientKeyEnv: environmentKey, caEnv: environmentKey.optional() }).strict().optional()
  }).strict()).max(100)
}).strict();

/** Resolve credentials without including their values in validation errors. */
export function loadConfig(input: unknown, environment: NodeJS.ProcessEnv = process.env, bindings: CredentialBindingPolicy | undefined = environmentCredentialBindings(environment)): GatewayConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid gateway configuration at: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  }
  const raw = parsed.data;
  for (const upstream of raw.upstreams) {
    if (bindings && upstream.transport !== 'stdio') {
      const destination = `MCP_UPSTREAM_${upstream.id.replace(/-/g, '_').toUpperCase()}`;
      bindings.assertAllowed(destination, upstream.url, 'upstream-endpoint');
      for (const path of upstream.requestPaths ?? []) bindings.assertAllowed(destination, new URL(path, upstream.url).href, 'upstream-endpoint');
    }
    if (upstream.tokenEnv) bindings?.assertAllowed(upstream.tokenEnv, upstream.url, 'upstream');
    if (upstream.headerEnvRefs) {
      validateHeaderReferences(upstream.headerEnvRefs);
      for (const reference of Object.values(upstream.headerEnvRefs)) bindings?.assertAllowed(reference, upstream.url, 'upstream');
    }
    if (upstream.oauth) {
      if (upstream.oauth.clientSecretEnv) {
        bindings?.assertAllowed(upstream.oauth.clientSecretEnv, upstream.oauth.tokenEndpoint, 'oauth-token');
        bindings?.assertAllowed(upstream.oauth.clientSecretEnv, upstream.url, 'oauth-recipient');
      }
      if (upstream.oauth.actorTokenEnv) bindings?.assertAllowed(upstream.oauth.actorTokenEnv, upstream.oauth.tokenEndpoint, 'oauth-token');
      if (upstream.tls) for (const reference of [upstream.tls.clientCertEnv, upstream.tls.clientKeyEnv, ...(upstream.tls.caEnv ? [upstream.tls.caEnv] : [])]) bindings?.assertAllowed(reference, upstream.oauth.tokenEndpoint, 'oauth-token-tls');
    }
    if (upstream.tls) for (const reference of [upstream.tls.clientCertEnv, upstream.tls.clientKeyEnv, ...(upstream.tls.caEnv ? [upstream.tls.caEnv] : [])]) bindings?.assertAllowed(reference, upstream.url, 'upstream-tls');
    for (const reference of Object.values(upstream.envRefs ?? {})) {
      const target = upstream.transport === 'stdio' && upstream.command ? new URL(`stdio://${upstream.id}/${encodeURIComponent(upstream.command)}`).href : upstream.url;
      bindings?.assertAllowed(reference, target, 'stdio-environment');
    }
    if (bindings && upstream.transport === 'sse' && !upstream.requestPaths) throw new Error('Deployment-bound SSE requires explicit request paths');
    for (const path of upstream.requestPaths ?? []) {
      if (upstream.tokenEnv) bindings?.assertAllowed(upstream.tokenEnv, new URL(path, upstream.url).href, 'upstream');
      if (upstream.headerEnvRefs) for (const reference of Object.values(upstream.headerEnvRefs)) bindings?.assertAllowed(reference, new URL(path, upstream.url).href, 'upstream');
      if (upstream.oauth?.clientSecretEnv) bindings?.assertAllowed(upstream.oauth.clientSecretEnv, new URL(path, upstream.url).href, 'oauth-recipient');
      if (upstream.tls) for (const reference of [upstream.tls.clientCertEnv, upstream.tls.clientKeyEnv, ...(upstream.tls.caEnv ? [upstream.tls.caEnv] : [])]) bindings?.assertAllowed(reference, new URL(path, upstream.url).href, 'upstream-tls');
    }
  }
  function credential(key: string): string {
    const value = environment[key];
    if (!value) throw new Error(`Missing credential environment variable: ${key}`);
    return value;
  }
  return validateConfig({
    ...raw,
    clients: raw.clients.map(({ tokenEnv, ...client }) => ({ ...client, ...(tokenEnv ? { token: credential(tokenEnv) } : {}) })),
    upstreams: raw.upstreams.map(({ tokenEnv, headerEnvRefs, envRefs, oauth, tls, ...upstream }) => ({ ...upstream, ...(tokenEnv ? { token: credential(tokenEnv) } : {}), ...(headerEnvRefs ? { headers: Object.fromEntries(Object.entries(headerEnvRefs).map(([name, ref]) => { const value = credential(ref); if (/[\r\n\0]/.test(value) || Buffer.byteLength(value) > 8192) throw new Error('Invalid upstream header credential'); return [name, value]; })) } : {}), ...(envRefs ? { environment: Object.fromEntries(Object.entries(envRefs).map(([name, ref]) => [name, credential(ref)])) } : {}), ...(oauth ? { oauth: { mode: oauth.mode, clientAuthMethod: oauth.clientAuthMethod ?? 'client_secret_basic', tokenEndpoint: oauth.tokenEndpoint, scope: oauth.scope, audience: oauth.audience, resource: oauth.resource, actorTokenType: oauth.actorTokenType, actorToken: oauth.actorTokenEnv ? credential(oauth.actorTokenEnv) : undefined, clientId: credential(oauth.clientIdEnv), clientSecret: oauth.clientSecretEnv ? credential(oauth.clientSecretEnv) : undefined } } : {}), ...(tls ? { tls: { clientCert: credential(tls.clientCertEnv), clientKey: credential(tls.clientKeyEnv), ca: tls.caEnv ? credential(tls.caEnv) : undefined } } : {}) }))
  });
}
