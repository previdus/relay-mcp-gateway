import { boundedJson, securityEndpoint } from './security-http.js';
import type { AccessAction, Authorizer } from './plugins.js';
import type { ServiceClient } from './types.js';
import { withEgressFetch, type EgressPolicy } from './egress.js';

type OpaAction = 'tools/call' | AccessAction;

/** Fail-closed client for one deployment-pinned OPA Data API decision URL. */
export class OpaAuthorizer implements Authorizer {
  private readonly endpoint: URL;
  private readonly timeoutMs: number;

  constructor(private readonly options: { url: string; token?: string; timeoutMs?: number; allowLocalHttp?: boolean; egressPolicy?: EgressPolicy }) {
    this.endpoint = securityEndpoint(options.url, options.allowLocalHttp);
    this.timeoutMs = options.timeoutMs ?? 1000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 10000) throw new Error('Invalid OPA decision timeout');
    if (options.token !== undefined && (!options.token || options.token.length > 8192 || /[\r\n]/.test(options.token))) throw new Error('Invalid OPA bearer token');
  }

  canCall(principal: ServiceClient, tool: string) {
    return this.decide(principal, 'tools/call', tool);
  }

  canAccess(principal: ServiceClient, action: AccessAction, name: string) {
    return this.decide(principal, action, name);
  }

  private async decide(principal: ServiceClient, action: OpaAction, name: string): Promise<boolean> {
    // Construct a positive allowlist. Never serialize the principal object: it
    // can contain a service key when called from management/plugin code.
    const identity = {
      id: principal.id,
      ...(principal.tenantId ? { tenantId: principal.tenantId } : {}),
      ...(principal.subject ? { subject: principal.subject } : {}),
      ...(principal.oauthClientId ? { oauthClientId: principal.oauthClientId } : {}),
      ...(principal.authScheme ? { authScheme: principal.authScheme } : {}),
      ...(principal.roles ? { roles: principal.roles } : {})
    };
    const body = JSON.stringify({ input: { principal: identity, action, resource: { name } } });
    if (Buffer.byteLength(body) > 16384) return false;
    try {
      const document = await withEgressFetch(this.endpoint, 16384, this.options.egressPolicy, async fetcher => {
        const response = await fetcher(this.endpoint, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
          headers: { 'Content-Type': 'application/json', ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}) },
          body
        });
        return boundedJson(response, 16384);
      });
      return Object.hasOwn(document, 'result') && document.result === true;
    } catch {
      // A missing, malformed, unavailable or timed-out policy decision denies.
      return false;
    }
  }
}
