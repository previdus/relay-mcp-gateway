import type { GatewayConfig, Upstream } from './types.js';
import { sameTenant } from './tenancy.js';
import { ConfigRouter, type ResolvedRoute, type Router, type RoutingContext } from './plugins.js';
import { boundedJson, securityEndpoint } from './security-http.js';
import { closeEgressFetch, upstreamFetch, type EgressPolicy } from './egress.js';

type RouteCandidate = { upstreamId: string; tool: string; weight?: number; priority?: number };

/**
 * Delegates alias selection to a separate, deployment-owned service.
 * The external service receives identity and the already-approved candidate
 * pool only. Core authorization and target validation remain authoritative.
 */
export class RemoteRouter implements Router {
  private readonly endpoint: URL;
  private readonly defaults: ConfigRouter;
  private readonly timeoutMs: number;

  constructor(private readonly config: GatewayConfig, private readonly options: {
    url: string;
    token: string;
    timeoutMs?: number;
    allowLocalHttp?: boolean;
    fetch?: typeof fetch;
    egressPolicy?: EgressPolicy;
  }) {
    this.endpoint = securityEndpoint(options.url, options.allowLocalHttp);
    this.defaults = new ConfigRouter(config);
    this.timeoutMs = options.timeoutMs ?? 500;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 10 || this.timeoutMs > 5000) throw new Error('Invalid remote routing timeout');
    if (!options.token || options.token.length > 8192 || /[\r\n]/.test(options.token)) throw new Error('Invalid remote routing credential');
  }

  names(upstreamId: string, tool: string, context: RoutingContext) {
    return this.defaults.names(upstreamId, tool, context);
  }

  async resolve(name: string, context: RoutingContext): Promise<ResolvedRoute | undefined> {
    const rule = this.config.routes?.find(candidate => candidate.name === name);
    // Keep physical tools on the local, deterministic path. Only aliases use
    // the external decision service.
    if (!rule) return this.defaults.resolve(name, context);
    if ((rule.clients && !rule.clients.includes(context.principal.id)) ||
        (rule.tenants && !rule.tenants.includes(context.principal.tenantId ?? 'default')) ||
        (rule.requiredRoles && !rule.requiredRoles.every(role => context.principal.roles?.includes(role)))) return undefined;

    const candidates: RouteCandidate[] = rule.targets
      .filter(target => target.enabled !== false)
      .filter(target => this.config.upstreams.some(upstream => upstream.id === target.upstreamId && sameTenant(context.principal, upstream)))
      .map(({ upstreamId, tool, weight, priority }) => ({ upstreamId, tool, ...(weight === undefined ? {} : { weight }), ...(priority === undefined ? {} : { priority }) }));
    if (!candidates.length || candidates.length > 256) return undefined;

    // A positive identity allowlist avoids accidentally forwarding the API key
    // retained by some authenticator implementations. Arguments and credentials
    // are intentionally outside this routing protocol.
    const { principal } = context;
    const identity = {
      id: principal.id,
      ...(principal.tenantId ? { tenantId: principal.tenantId } : {}),
      ...(principal.subject ? { subject: principal.subject } : {}),
      ...(principal.oauthClientId ? { oauthClientId: principal.oauthClientId } : {}),
      ...(principal.authScheme ? { authScheme: principal.authScheme } : {}),
      ...(principal.roles ? { roles: principal.roles } : {})
    };
    const body = JSON.stringify({ requestId: context.requestId, principal: identity, route: { name }, candidates });
    if (Buffer.byteLength(body) > 32768) return undefined;
    let managedFetch: typeof fetch | undefined;
    try {
      const fetcher = this.options.fetch ?? (this.options.egressPolicy
        ? (managedFetch = upstreamFetch(this.endpoint.href, 4096, [this.endpoint.pathname], this.options.egressPolicy))
        : fetch);
      const response = await fetcher(this.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([
          AbortSignal.timeout(this.timeoutMs),
          ...(context.signal ? [context.signal] : [])
        ]),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.token}` },
        body
      });
      const document = await boundedJson(response, 4096);
      if (Object.keys(document).length !== 1 || !Object.hasOwn(document, 'target') || !document.target || typeof document.target !== 'object' || Array.isArray(document.target)) return undefined;
      const target = document.target as Record<string, unknown>;
      if (Object.keys(target).length !== 2 || typeof target.upstreamId !== 'string' || typeof target.tool !== 'string') return undefined;
      if (!candidates.some(candidate => candidate.upstreamId === target.upstreamId && candidate.tool === target.tool)) return undefined;
      const upstream: Upstream | undefined = this.config.upstreams.find(candidate => candidate.id === target.upstreamId && sameTenant(context.principal, candidate));
      return upstream ? { upstream, tool: target.tool } : undefined;
    } catch {
      // Routing is fail closed: unavailable, malformed, oversized, redirected,
      // or timed-out responses cannot fall back to another target.
      return undefined;
    } finally {
      if (managedFetch) await closeEgressFetch(managedFetch).catch(() => {});
    }
  }
}
