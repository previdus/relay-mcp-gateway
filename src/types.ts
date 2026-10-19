export interface ServiceClient {
  id: string;
  token?: string;
  allow: string[];
  roles?: string[];
  permissions?: { prompts?: string[]; resources?: string[] };
  tenantId?: string;
  subject?: string;
  oauthClientId?: string;
  /** Exact trusted OAuth issuer for this identity; required by multi-issuer JWT mode. */
  oauthIssuer?: string;
  /** Base64url SHA-256 thumbprint of the DER client certificate (RFC 8705). */
  certificateSha256?: string;
  callbackMethods?: string[];
  authScheme?: 'api-key' | 'jwt' | 'introspection' | 'mtls';
  rateLimit?: import('./traffic.js').RatePolicy;
}

export interface Upstream {
  id: string;
  url: string;
  token?: string;
  transport?: 'streamable-http' | 'sse' | 'stdio';
  tenantId?: string;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  /** Opt-in cache for MCP v2 protocol discovery; use only for homogeneous upstream deployments. */
  discoveryCacheTtlMs?: number;
  requestPaths?: string[];
  command?: string;
  args?: string[];
  environment?: Record<string, string>;
  oauth?: { mode: 'client_credentials' | 'token_exchange'; clientAuthMethod?: 'client_secret_basic' | 'client_secret_post'; tokenEndpoint: string; clientId: string; clientSecret: string; scope?: string; audience?: string };
}

export interface GatewayConfig {
  clients: ServiceClient[];
  upstreams: Upstream[];
  allowLocalHttp?: boolean;
  timeoutMs?: number;
  maxConcurrentPerClient?: number;
  allowedOrigins?: string[];
  allowedHosts?: string[];
  routes?: RouteRule[];
  roleGrants?: Record<string, string[]>;
  features?: { prompts?: boolean; resources?: boolean; callbacks?: boolean; notifications?: boolean; catalogSearch?: boolean; tasks?: boolean };
  maxUpstreamResponseBytes?: number;
  toolContracts?: Record<string, string>;
  approvalRequiredTools?: string[];
  invocationPolicies?: import('./invocation-policy.js').InvocationPolicies;
  catalogPolicy?: import('./invocation-policy.js').CatalogPolicy;
  inspectionTimeoutMs?: number;
  discovery?: import('./catalog.js').DiscoveryOptions;
  traffic?: { rateLimit?: import('./traffic.js').RatePolicy; toolRateLimits?: Record<string, import('./traffic.js').RatePolicy>; circuitBreaker?: import('./traffic.js').CircuitPolicy };
}

export interface RouteTarget { upstreamId: string; tool: string; weight?: number; priority?: number; enabled?: boolean }
export interface RouteRule { name: string; targets: RouteTarget[]; strategy: 'weighted' | 'sticky' | 'rendezvous' | 'priority'; clients?: string[]; tenants?: string[]; requiredRoles?: string[] }

export type AuditOutcome = 'started' | 'ok' | 'partial' | 'denied' | 'approval_pending' | 'approval_consumed' | 'token_revoked' | 'jwt_issuer_disabled' | 'jwt_issuer_enabled' | 'tool_error' | 'upstream_error' | 'error' | 'discovery_failed';
export interface AuditEvent {
  requestId: string;
  at: string;
  clientId: string;
  outcome: AuditOutcome;
  upstream?: string;
  method?: string;
  tool?: string;
  durationMs?: number;
  configurationRevision?: number;
  sourceRevision?: number;
}
export type AuditSink = (event: AuditEvent) => Promise<void>;

declare global {
  namespace Express {
    interface Request { principal?: ServiceClient }
  }
}
