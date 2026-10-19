import type { IncomingMessage } from 'node:http';
import type { ServiceClient } from './types.js';
import type { Authenticator } from './plugins.js';
import { InsufficientScopeError } from './plugins.js';
import { boundedJson, securityEndpoint } from './security-http.js';
import { withEgressFetch, type EgressPolicy } from './egress.js';
import { DpopNonceRequired, DpopReplayStoreUnavailable, verifyDpopProof, type DpopNonceManager, type DpopReplayStore } from './dpop.js';
import type { AuthenticationContext } from './plugins.js';

export function bearerToken(req: Pick<IncomingMessage, 'headersDistinct'>): string {
  const values = req.headersDistinct.authorization;
  if (values?.length !== 1 || values[0]!.length > 8199) return '';
  return /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(values[0]!)?.[1] ?? '';
}

export function accessTokenCredential(req: Pick<IncomingMessage, 'headersDistinct'>): { token: string; scheme?: string } {
  const values = req.headersDistinct.authorization;
  if (values?.length !== 1 || values[0]!.length > 8199) return { token: '' };
  const match = /^(Bearer|DPoP) ([A-Za-z0-9\-._~+/]+=*)$/i.exec(values[0]!);
  return match ? { token: match[2]!, scheme: match[1] } : { token: '' };
}

export interface VerifiedIdentityOptions { clients: ServiceClient[]; requiredScopes?: string[]; maxTokenAgeSeconds?: number }
export interface JwtRevocationStore { isRevoked(issuer: string, tokenId: string): Promise<boolean> }
export function validateIdentityOptions(options: VerifiedIdentityOptions) {
  if (options.requiredScopes?.some(s => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(s))) throw new Error('Invalid OAuth scope');
  if (options.maxTokenAgeSeconds !== undefined && (!Number.isInteger(options.maxTokenAgeSeconds) || options.maxTokenAgeSeconds < 1 || options.maxTokenAgeSeconds > 86400)) throw new Error('Invalid token age limit');
  const bindings = new Map<string, { count: number; bothWildcard: boolean; issuerWildcardClients: Set<string>; clientWildcardIssuers: Set<string>; exact: Set<string>; exactByClient: Map<string, number>; exactByIssuer: Map<string, number> }>();
  for (const client of options.clients) {
    const key = JSON.stringify([client.subject ?? client.id, client.tenantId ?? 'default']);
    const index = bindings.get(key) ?? { count: 0, bothWildcard: false, issuerWildcardClients: new Set<string>(), clientWildcardIssuers: new Set<string>(), exact: new Set<string>(), exactByClient: new Map<string, number>(), exactByIssuer: new Map<string, number>() };
    const issuer = client.oauthIssuer, clientId = client.oauthClientId;
    const exactPair = issuer !== undefined && clientId !== undefined ? JSON.stringify([issuer, clientId]) : undefined;
    const overlaps = issuer === undefined && clientId === undefined ? index.count > 0
      : issuer === undefined ? index.bothWildcard || index.issuerWildcardClients.has(clientId!) || index.clientWildcardIssuers.size > 0 || (index.exactByClient.get(clientId!) ?? 0) > 0
      : clientId === undefined ? index.bothWildcard || index.issuerWildcardClients.size > 0 || index.clientWildcardIssuers.has(issuer) || (index.exactByIssuer.get(issuer) ?? 0) > 0
      : index.bothWildcard || index.issuerWildcardClients.has(clientId) || index.clientWildcardIssuers.has(issuer) || index.exact.has(exactPair!);
    if (overlaps) throw new Error('Ambiguous verified identity binding');
    index.count++;
    if (issuer === undefined && clientId === undefined) index.bothWildcard = true;
    else if (issuer === undefined) index.issuerWildcardClients.add(clientId!);
    else if (clientId === undefined) index.clientWildcardIssuers.add(issuer);
    else {
      index.exact.add(exactPair!);
      index.exactByClient.set(clientId, (index.exactByClient.get(clientId) ?? 0) + 1);
      index.exactByIssuer.set(issuer, (index.exactByIssuer.get(issuer) ?? 0) + 1);
    }
    bindings.set(key, index);
  }
}

export function mappedIdentity(payload: Record<string, unknown>, options: VerifiedIdentityOptions, authScheme: 'jwt' | 'introspection', allowDpop = false, verifiedIssuer?: string): ServiceClient | undefined {
  const now = Date.now() / 1000;
  const confirmation = payload.cnf;
  const validDpopConfirmation = allowDpop && confirmation !== null && typeof confirmation === 'object' && !Array.isArray(confirmation) && Object.keys(confirmation).length === 1 && 'jkt' in confirmation && typeof confirmation.jkt === 'string' && /^[A-Za-z0-9_-]{43}$/.test(confirmation.jkt);
  if (Object.hasOwn(payload, 'cnf') && !validDpopConfirmation || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 256 || payload.tenant_id !== undefined && (typeof payload.tenant_id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(payload.tenant_id))) return undefined;
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= now || typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > now + 30 || payload.iat > payload.exp) return undefined;
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || payload.nbf > now)) return undefined;
  if (options.maxTokenAgeSeconds !== undefined && now - payload.iat > options.maxTokenAgeSeconds) return undefined;
  const client = options.clients.find(c => (c.subject ?? c.id) === payload.sub && (c.tenantId ?? 'default') === (payload.tenant_id ?? 'default') && (c.oauthIssuer === undefined || c.oauthIssuer === verifiedIssuer) && (c.oauthClientId === undefined || c.oauthClientId === payload.client_id));
  if (!client) return undefined;
  const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
  if (options.requiredScopes?.some(s => !scopes.includes(s))) throw new InsufficientScopeError(options.requiredScopes);
  return { ...client, authScheme };
}

export interface IntrospectionOptions extends VerifiedIdentityOptions {
  endpoint: string; issuer: string; audience: string; clientId: string; clientSecret: string;
  allowLocalHttp?: boolean; timeoutMs?: number; egressPolicy?: EgressPolicy;
  dpop?: { publicOrigin: string; maxAgeSeconds?: number; replayStore: DpopReplayStore; nonceManager?: DpopNonceManager };
}
/** RFC 7662 with a deliberately strict issuer/audience/expiry/subject response profile; no positive cache. */
export class IntrospectionAuthenticator implements Authenticator {
  readonly challengeScheme: 'Bearer' | 'DPoP';
  constructor(private options: IntrospectionOptions) {
    this.challengeScheme = options.dpop ? 'DPoP' : 'Bearer';
    securityEndpoint(options.endpoint, options.allowLocalHttp); securityEndpoint(options.issuer, options.allowLocalHttp);
    validateIdentityOptions(options);
    if (!options.audience || !options.clientId || !options.clientSecret || options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 10000)) throw new Error('Invalid introspection configuration');
  }
  async authenticate(token: string, context?: AuthenticationContext): Promise<ServiceClient | undefined> {
    if (!token || token.length > 8192 || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) return undefined;
    if (context?.authorizationScheme && context.authorizationScheme.toLowerCase() !== (this.options.dpop ? 'dpop' : 'bearer')) return undefined;
    try {
      const encode = (v: string) => new URLSearchParams({ x: v }).toString().slice(2);
      const credentials = Buffer.from(`${encode(this.options.clientId)}:${encode(this.options.clientSecret)}`).toString('base64');
      const p = await withEgressFetch(this.options.endpoint, 16384, this.options.egressPolicy, async fetcher => {
        const response = await fetcher(this.options.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs ?? 2000), headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ token, token_type_hint: 'access_token' }) });
        return boundedJson(response);
      });
      if (p.active !== true || p.iss !== this.options.issuer || (this.options.dpop ? typeof p.token_type !== 'string' || p.token_type.toLowerCase() !== 'dpop' : p.token_type !== undefined && (typeof p.token_type !== 'string' || p.token_type.toLowerCase() !== 'bearer'))) return undefined;
      if (!(typeof p.aud === 'string' ? p.aud === this.options.audience : Array.isArray(p.aud) && p.aud.every(a => typeof a === 'string') && p.aud.includes(this.options.audience))) return undefined;
      const identity = mappedIdentity(p, this.options, 'introspection', Boolean(this.options.dpop), this.options.issuer);
      if (!identity) return undefined;
      if (this.options.dpop && !await verifyDpopProof({ proof: context?.dpopProof, proofHeaderCount: context?.dpopProofHeaderCount ?? 0, authorizationScheme: context?.authorizationScheme, accessToken: token, confirmation: p.cnf, method: context?.method ?? '', requestTarget: context?.requestTarget ?? '', publicOrigin: this.options.dpop.publicOrigin, maxAgeSeconds: this.options.dpop.maxAgeSeconds ?? 60, replayStore: this.options.dpop.replayStore, nonceManager: this.options.dpop.nonceManager })) return undefined;
      return identity;
    } catch (error) { if (error instanceof InsufficientScopeError || error instanceof DpopReplayStoreUnavailable || error instanceof DpopNonceRequired) throw error; return undefined; }
  }
}
