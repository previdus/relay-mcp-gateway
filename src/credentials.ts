import { createHash } from 'node:crypto';
import type { ServiceClient, Upstream } from './types.js';
import { boundedJson, securityEndpoint } from './security-http.js';
import { withEgressFetch, type ClientTlsCredentials, type EgressPolicy } from './egress.js';
export interface CredentialProvider {
  headers(upstream: Upstream, principal?: ServiceClient, subjectToken?: string, tls?: ClientTlsCredentials): Promise<Record<string, string>>;
  /** Optional trusted secret-manager hook for per-principal mTLS identities. */
  tls?(upstream: Upstream, principal?: ServiceClient): Promise<ClientTlsCredentials | undefined>;
}
interface CachedToken { token: string; expires: number }
export class OAuthCredentialProvider implements CredentialProvider {
  private cache = new Map<string, Promise<CachedToken>>();
  constructor(private allowLocalHttp = false, private egressPolicy?: EgressPolicy) {}
  async tls(upstream: Upstream): Promise<ClientTlsCredentials | undefined> {
    return upstream.tls ? { cert: upstream.tls.clientCert, key: upstream.tls.clientKey, ...(upstream.tls.ca ? { ca: upstream.tls.ca } : {}) } : undefined;
  }
  async headers(upstream: Upstream, principal?: ServiceClient, subjectToken?: string, tls?: ClientTlsCredentials): Promise<Record<string, string>> {
    if (!upstream.oauth) return { ...(upstream.headers ?? {}), ...(upstream.token ? { Authorization: `Bearer ${upstream.token}` } : {}) };
    const oauth = upstream.oauth;
    securityEndpoint(oauth.tokenEndpoint, this.allowLocalHttp);
    if (oauth.mode === 'token_exchange' && (principal?.authScheme !== 'jwt' || !subjectToken)) throw new Error('Token exchange requires a verified JWT principal');
    const key = createHash('sha256').update(JSON.stringify([upstream.id, principal?.tenantId, principal?.id, oauth, tls, oauth.mode === 'token_exchange' ? subjectToken : 'service'])).digest('hex');
    let pending = this.cache.get(key);
    if (pending) {
      const cached = await pending;
      if (cached.expires > Date.now()) return { ...(upstream.headers ?? {}), Authorization: `Bearer ${cached.token}` };
      // Another caller may already have replaced the expired promise while this
      // caller was awaiting it. Never delete or duplicate that new exchange.
      if (this.cache.get(key) === pending) this.cache.delete(key);
      pending = this.cache.get(key);
    }
    if (!pending) {
      if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!);
      pending = this.exchange(upstream, subjectToken, tls); this.cache.set(key, pending);
      const exchange = pending;
      void exchange.catch(() => { if (this.cache.get(key) === exchange) this.cache.delete(key); });
    }
    return { ...(upstream.headers ?? {}), Authorization: `Bearer ${(await pending).token}` };
  }
  private async exchange(upstream: Upstream, subjectToken?: string, tls?: ClientTlsCredentials): Promise<CachedToken> {
    const oauth = upstream.oauth!;
    const authMethod = oauth.clientAuthMethod ?? 'client_secret_basic';
    if (!['client_secret_basic', 'client_secret_post', 'tls_client_auth', 'self_signed_tls_client_auth'].includes(authMethod)) throw new Error('Unsupported OAuth client authentication method');
    const body = new URLSearchParams({ grant_type: oauth.mode === 'client_credentials' ? 'client_credentials' : 'urn:ietf:params:oauth:grant-type:token-exchange' });
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (authMethod === 'client_secret_basic') {
      if (!oauth.clientSecret) throw new Error('OAuth client secret is required for client_secret_basic');
      const encode = (value: string) => new URLSearchParams({ value }).toString().slice('value='.length);
      headers.Authorization = `Basic ${Buffer.from(`${encode(oauth.clientId)}:${encode(oauth.clientSecret)}`, 'utf8').toString('base64')}`;
    } else if (authMethod === 'client_secret_post') {
      if (!oauth.clientSecret) throw new Error('OAuth client secret is required for client_secret_post');
      body.set('client_id', oauth.clientId);
      body.set('client_secret', oauth.clientSecret);
    } else {
      if (!tls) throw new Error('OAuth mTLS client authentication requires an upstream client certificate');
      if (new URL(oauth.tokenEndpoint).protocol !== 'https:') throw new Error('OAuth mTLS client authentication requires HTTPS');
      body.set('client_id', oauth.clientId);
    }
    if (oauth.scope) body.set('scope', oauth.scope);
    if (oauth.audience) body.set('audience', oauth.audience);
    if (oauth.resource) body.set('resource', oauth.resource);
    if (oauth.mode === 'token_exchange') {
      body.set('subject_token', subjectToken!);
      body.set('subject_token_type', 'urn:ietf:params:oauth:token-type:access_token');
      body.set('requested_token_type', 'urn:ietf:params:oauth:token-type:access_token');
      if (oauth.actorToken) {
        body.set('actor_token', oauth.actorToken);
        body.set('actor_token_type', oauth.actorTokenType ?? 'urn:ietf:params:oauth:token-type:access_token');
      }
    }
    const value = await withEgressFetch(oauth.tokenEndpoint, 16384, this.egressPolicy, async fetcher => {
      const response = await fetcher(oauth.tokenEndpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000), headers, body });
      return boundedJson(response);
    }, tls);
    if (typeof value.access_token !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/.test(value.access_token) || value.access_token.length > 8192 || typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer' || typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0) throw new Error('Invalid token response');
    if (value.scope !== undefined && (typeof value.scope !== 'string' || (oauth.scope?.split(' ').filter(Boolean) ?? []).some(scope => !(value.scope as string).split(' ').includes(scope)))) throw new Error('Token exchange returned insufficient scope');
    if ((oauth.mode === 'token_exchange' || value.issued_token_type !== undefined) && value.issued_token_type !== 'urn:ietf:params:oauth:token-type:access_token') throw new Error('Unsupported issued token type');
    return { token: value.access_token, expires: Date.now() + Math.max(0, Math.min(value.expires_in, 86400) * 1000 - 1000) };
  }
}
