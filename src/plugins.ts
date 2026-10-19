import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { GatewayConfig, ServiceClient, Upstream } from './types.js';
import { sameTenant } from './tenancy.js';
import { mappedIdentity, validateIdentityOptions, type JwtRevocationStore, type VerifiedIdentityOptions } from './authentication.js';
import { boundedJson, securityEndpoint } from './security-http.js';
import { withEgressFetch, type EgressPolicy } from './egress.js';
import { DpopNonceRequired, DpopReplayStoreUnavailable, verifyDpopProof, type DpopNonceManager, type DpopReplayStore } from './dpop.js';

export interface AuthenticationContext {
  certificateSha256?: string; authorizationHeaderCount: number; authorizationScheme?: string;
  dpopProof?: string; dpopProofHeaderCount: number; method?: string; requestTarget?: string;
}
export interface Authenticator { readonly challengeScheme?: 'Bearer' | 'DPoP'; authenticate(token: string, context?: AuthenticationContext): Promise<ServiceClient | undefined> }
export class InsufficientScopeError extends Error {
  constructor(readonly requiredScopes: string[]) { super('Insufficient scope'); }
}
export type AccessAction = 'prompts/get' | 'resources/read';
export interface Authorizer {
  canCall(principal: ServiceClient, tool: string): Promise<boolean>;
  canAccess?(principal: ServiceClient, action: AccessAction, name: string): Promise<boolean>;
}
export interface RoutingContext { principal: ServiceClient; requestId: string; signal?: AbortSignal }
export interface ResolvedRoute { upstream: Upstream; tool: string }
export interface Router {
  names(upstreamId: string, tool: string, context: RoutingContext): string[];
  resolve(name: string, context: RoutingContext): ResolvedRoute | undefined | Promise<ResolvedRoute | undefined>;
}
const matchesGrant = (grant: string, name: string) => grant === name || (name.includes('__') && grant === `${name.split('__')[0]}__*`);
export const tokenEquals = (a: string, b: string) => {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
};
export class ApiKeyAuthenticator implements Authenticator {
  constructor(private clients: ServiceClient[]) {}
  async authenticate(token: string, context?: AuthenticationContext) { if (context?.authorizationScheme && context.authorizationScheme.toLowerCase() !== 'bearer') return undefined; const client = this.clients.find(client => typeof client.token === 'string' && tokenEquals(client.token, token)); return client ? { ...client, authScheme: 'api-key' as const } : undefined; }
}
/** Authenticates from the TLS socket's already-verified peer certificate; it never trusts forwarded certificate headers. */
export class MtlsAuthenticator implements Authenticator {
  constructor(private clients: ServiceClient[]) {
    const fingerprints = new Set<string>();
    for (const client of clients) {
      if (!client.certificateSha256 || !/^[A-Za-z0-9_-]{43}$/.test(client.certificateSha256) || fingerprints.has(client.certificateSha256)) throw new Error('mTLS clients need unique SHA-256 certificate thumbprints');
      fingerprints.add(client.certificateSha256);
    }
  }
  async authenticate(token: string, context?: AuthenticationContext) {
    if (token || context?.authorizationHeaderCount !== 0 || !context?.certificateSha256) return undefined;
    const client = this.clients.find(candidate => candidate.certificateSha256 === context.certificateSha256);
    return client ? { ...client, authScheme: 'mtls' as const } : undefined;
  }
}
export class JwtAuthenticator implements Authenticator {
  readonly challengeScheme: 'Bearer' | 'DPoP';
  private key: JWTVerifyGetKey;
  constructor(private options: VerifiedIdentityOptions & { issuer: string; audience: string; jwksUrl: string; key?: JWTVerifyGetKey; requiredTyp?: string; revocationStore?: JwtRevocationStore; egressPolicy?: EgressPolicy; dpop?: { publicOrigin: string; maxAgeSeconds?: number; replayStore: DpopReplayStore; nonceManager?: DpopNonceManager } }) {
    this.challengeScheme = options.dpop ? 'DPoP' : 'Bearer';
    securityEndpoint(options.issuer); securityEndpoint(options.jwksUrl);
    if (!options.audience || options.requiredTyp !== undefined && !['at+jwt', 'application/at+jwt'].includes(options.requiredTyp)) throw new Error('Invalid JWT audience or token type profile');
    validateIdentityOptions(options);
    this.key = options.key ?? createRemoteJWKSet(new URL(options.jwksUrl), {
      timeoutDuration: 3000,
      // Preserve jose's cache, refresh coalescing and unknown-kid cooldown. Bound
      // the network body before jose parses it; the original signal covers reads.
      [customFetch]: async (url, init) => withEgressFetch(url, 65536, this.options.egressPolicy, async fetcher => {
        const response = await fetcher(url, { ...init, redirect: 'error' });
        const document = await boundedJson(response, 65536);
        if (response.status !== 200 || !Array.isArray(document.keys) || !document.keys.length || document.keys.length > 64) throw new Error('Invalid JWKS document');
        return Response.json(document);
      })
    });
    if (options.requiredScopes?.some(scope => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope))) throw new Error('Invalid OAuth scope');
  }
  async authenticate(token: string, context?: AuthenticationContext) {
    try {
      if (!token || token.length > 8192 || (context?.authorizationScheme && context.authorizationScheme.toLowerCase() !== (this.options.dpop ? 'dpop' : 'bearer'))) return undefined;
      const { payload } = await jwtVerify(token, this.key, { issuer: this.options.issuer, audience: this.options.audience, algorithms: ['RS256', 'ES256'], requiredClaims: ['exp', 'sub', 'iat'], ...(this.options.requiredTyp ? { typ: this.options.requiredTyp } : {}) });
      if (this.options.revocationStore) {
        if (typeof payload.jti !== 'string' || !/^[\x21-\x7E]{1,256}$/.test(payload.jti) || await this.options.revocationStore.isRevoked(this.options.issuer, payload.jti)) return undefined;
      }
      const identity = mappedIdentity(payload, this.options, 'jwt', Boolean(this.options.dpop), this.options.issuer);
      if (!identity) return undefined;
      if (this.options.dpop && !await verifyDpopProof({ proof: context?.dpopProof, proofHeaderCount: context?.dpopProofHeaderCount ?? 0, authorizationScheme: context?.authorizationScheme, accessToken: token, confirmation: payload.cnf, method: context?.method ?? '', requestTarget: context?.requestTarget ?? '', publicOrigin: this.options.dpop.publicOrigin, maxAgeSeconds: this.options.dpop.maxAgeSeconds ?? 60, replayStore: this.options.dpop.replayStore, nonceManager: this.options.dpop.nonceManager })) return undefined;
      return identity;
    } catch (error) { if (error instanceof InsufficientScopeError || error instanceof DpopReplayStoreUnavailable || error instanceof DpopNonceRequired) throw error; return undefined; }
  }
}
export interface JwtIssuerProfile {
  issuer: string; audience: string; jwksUrl: string; requiredTyp?: string; requiredScopes?: string[]; maxTokenAgeSeconds?: number; key?: JWTVerifyGetKey;
}
/** Dispatches only to a finite, deployment-pinned issuer map. The unverified `iss`
 * claim selects a verifier but never supplies a network destination or trust rule. */
export class MultiIssuerJwtAuthenticator implements Authenticator {
  readonly challengeScheme: 'Bearer' | 'DPoP';
  private readonly authenticators: Map<string, JwtAuthenticator>;
  constructor(profiles: JwtIssuerProfile[], clients: ServiceClient[], dpop?: { publicOrigin: string; maxAgeSeconds?: number; replayStore: DpopReplayStore; nonceManager?: DpopNonceManager }, revocationStore?: JwtRevocationStore, egressPolicy?: EgressPolicy) {
    if (!Array.isArray(profiles) || profiles.length < 2 || profiles.length > 16 || new Set(profiles.map(profile => profile.issuer)).size !== profiles.length) throw new Error('Multi-issuer JWT mode requires 2 to 16 unique issuer profiles');
    const issuers = new Set(profiles.map(profile => profile.issuer));
    if (clients.some(client => !client.oauthIssuer || !issuers.has(client.oauthIssuer))) throw new Error('Every multi-issuer JWT identity must bind to a configured oauthIssuer');
    this.challengeScheme = dpop ? 'DPoP' : 'Bearer';
    this.authenticators = new Map(profiles.map(profile => [profile.issuer, new JwtAuthenticator({ ...profile, clients, ...(dpop ? { dpop } : {}), ...(revocationStore ? { revocationStore } : {}), ...(egressPolicy ? { egressPolicy } : {}) })]));
  }
  async authenticate(token: string, context?: AuthenticationContext) {
    if (!token || token.length > 8192) return undefined;
    let issuer: unknown;
    try { issuer = decodeJwt(token).iss; } catch { return undefined; }
    if (typeof issuer !== 'string') return undefined;
    return this.authenticators.get(issuer)?.authenticate(token, context);
  }
}
export class AllowListAuthorizer implements Authorizer {
  async canCall(client: ServiceClient, name: string) { return client.allow.some(grant => matchesGrant(grant, name)); }
  async canAccess(client: ServiceClient, action: AccessAction, name: string) {
    const grants = client.permissions?.[action === 'prompts/get' ? 'prompts' : 'resources'] ?? [];
    return grants.some(grant => matchesGrant(grant, name));
  }
}
export class RoleAuthorizer implements Authorizer {
  constructor(private grants: Record<string, string[]>) {}
  async canCall(client: ServiceClient, tool: string) {
    return (client.roles ?? []).some(role => (Object.hasOwn(this.grants, role) ? this.grants[role]! : []).some(grant => matchesGrant(grant, tool)));
  }
  async canAccess(client: ServiceClient, action: AccessAction, name: string) {
    return (client.roles ?? []).some(role => (Object.hasOwn(this.grants, role) ? this.grants[role]! : []).filter(grant => grant.startsWith(`${action}:`)).some(grant => matchesGrant(grant.slice(action.length + 1), name)));
  }
}
export class AllOfAuthorizer implements Authorizer {
  constructor(private policies: Authorizer[]) { if (!policies.length) throw new Error('At least one policy is required'); }
  async canCall(client: ServiceClient, tool: string) {
    for (const policy of this.policies) if (!await policy.canCall(client, tool)) return false;
    return true;
  }
  async canAccess(client: ServiceClient, action: AccessAction, name: string) {
    for (const policy of this.policies) if (!policy.canAccess || !await policy.canAccess(client, action, name)) return false;
    return true;
  }
}
export class OpenFgaAuthorizer implements Authorizer {
  constructor(private options: { url: string; storeId: string; modelId: string; token?: string; allowLocalHttp?: boolean; namespaceFormat?: 'legacy' | 'tuple-v2'; egressPolicy?: EgressPolicy }) {
    securityEndpoint(options.url, options.allowLocalHttp);
    if (!options.storeId || !options.modelId) throw new Error('Pin an OpenFGA store and model');
    if (options.namespaceFormat !== undefined && !['legacy','tuple-v2'].includes(options.namespaceFormat)) throw new Error('Invalid OpenFGA namespace format');
  }
  async canCall(principal: ServiceClient, tool: string) { return this.check(principal, 'tool', 'can_call', tool); }
  async canAccess(principal: ServiceClient, action: AccessAction, name: string) { return this.check(principal, action === 'prompts/get' ? 'prompt' : 'resource', action === 'prompts/get' ? 'can_get' : 'can_read', name); }
  private async check(principal: ServiceClient, type: string, relation: string, name: string) {
    try {
      if (this.options.namespaceFormat !== 'tuple-v2' && !principal.tenantId && principal.id.includes('/')) return false;
      const namespace = (value: string) => encodeURIComponent(this.options.namespaceFormat === 'tuple-v2' ? JSON.stringify([principal.tenantId ?? 'default', value]) : principal.tenantId ? `${principal.tenantId}/${value}` : value);
      const endpoint = `${this.options.url.replace(/\/$/, '')}/stores/${encodeURIComponent(this.options.storeId)}/check`;
      const result: unknown = await withEgressFetch(endpoint, 16384, this.options.egressPolicy, async fetcher => {
        const response = await fetcher(endpoint, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000),
          headers: { 'Content-Type': 'application/json', ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}) },
          body: JSON.stringify({ authorization_model_id: this.options.modelId, tuple_key: { user: `user:${namespace(principal.id)}`, relation, object: `${type}:${namespace(name)}` }, consistency: 'HIGHER_CONSISTENCY' })
        });
        return boundedJson(response);
      });
      return typeof result === 'object' && result !== null && 'allowed' in result && result.allowed === true;
    } catch { return false; }
  }
}
export class ConfigRouter implements Router {
  constructor(private config: GatewayConfig) {}
  private eligible(rule: NonNullable<GatewayConfig['routes']>[number], context: RoutingContext) {
    return (!rule.clients || rule.clients.includes(context.principal.id)) && (!rule.tenants || rule.tenants.includes(context.principal.tenantId ?? 'default')) && (!rule.requiredRoles || rule.requiredRoles.every(role => context.principal.roles?.includes(role)));
  }
  names(upstreamId: string, tool: string, context: RoutingContext) {
    if (!this.config.upstreams.some(upstream => upstream.id === upstreamId && sameTenant(context.principal, upstream))) return [];
    const aliases = (this.config.routes ?? []).filter(route => this.eligible(route, context) && route.targets.some(target => target.enabled !== false && target.upstreamId === upstreamId && target.tool === tool));
    return [`${upstreamId}__${tool}`, ...aliases.map(route => route.name)];
  }
  resolve(name: string, context: RoutingContext) {
    const rule = this.config.routes?.find(route => route.name === name);
    if (rule) {
      if (!this.eligible(rule, context)) return undefined;
      const targets = rule.targets.filter(target => target.enabled !== false && this.config.upstreams.some(upstream => upstream.id === target.upstreamId && sameTenant(context.principal, upstream)));
      if (!targets.length) return undefined;
      if (rule.strategy === 'priority') {
        const selected = [...targets].sort((a,b) => {
          const priority=(a.priority ?? 0)-(b.priority ?? 0), left=JSON.stringify([a.upstreamId,a.tool]), right=JSON.stringify([b.upstreamId,b.tool]);
          return priority || (left < right ? -1 : left > right ? 1 : 0);
        })[0]!;
        return { upstream: this.config.upstreams.find(u => u.id === selected.upstreamId)!, tool: selected.tool };
      }
      if (rule.strategy === 'rendezvous') {
        let selected: typeof targets[number] | undefined, best = Infinity, bestKey = '';
        for (const target of targets) {
          const key = JSON.stringify([target.upstreamId, target.tool]);
          const hash = createHash('sha256').update(JSON.stringify([context.principal.tenantId ?? 'default', context.principal.id, name, key])).digest().readUInt32BE();
          const score = -Math.log((hash + 1) / (0x100000000 + 1)) / (target.weight ?? 1);
          if (score < best || score === best && key < bestKey) { selected = target; best = score; bestKey = key; }
        }
        return { upstream: this.config.upstreams.find(u => u.id === selected!.upstreamId)!, tool: selected!.tool };
      }
      const total = targets.reduce((sum, target) => sum + (target.weight ?? 1), 0);
      let bucket = rule.strategy === 'sticky' ? createHash('sha256').update(`${context.principal.id}:${name}`).digest().readUInt32BE() % total : randomInt(total);
      for (const target of targets) {
        bucket -= target.weight ?? 1;
        if (bucket < 0) {
          const upstream = this.config.upstreams.find(upstream => upstream.id === target.upstreamId);
          return upstream && sameTenant(context.principal, upstream) ? { upstream, tool: target.tool } : undefined;
        }
      }
      return undefined;
    }
    const upstream = this.config.upstreams.find(upstream => name.startsWith(`${upstream.id}__`));
    return upstream && sameTenant(context.principal, upstream) ? { upstream, tool: name.slice(upstream.id.length + 2) } : undefined;
  }
}
