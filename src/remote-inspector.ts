import type { EgressPolicy } from './egress.js';
import { closeEgressFetch, upstreamFetch } from './egress.js';
import { boundedJson, securityEndpoint } from './security-http.js';
import type { InspectionContext, InspectionDecision, ResultInspectionContext, ToolInspector } from './inspection.js';

type Phase = 'beforeCall' | 'afterCall';
export type InspectorDataMode = 'metadata' | 'full';
export type InspectorIdentityField = 'id' | 'tenantId' | 'subject' | 'roles' | 'authScheme';

/** Optional remote veto service for enterprise DLP and domain inspection. */
export class RemoteInspector implements ToolInspector {
  readonly id = 'remote-inspector';
  private readonly endpoint: URL;

  constructor(private readonly options: {
    url: string;
    token: string;
    tools: readonly string[];
    timeoutMs?: number;
    maxRequestBytes?: number;
    dataMode?: InspectorDataMode;
    identityFields?: readonly InspectorIdentityField[];
    allowLocalHttp?: boolean;
    fetch?: typeof fetch;
    egressPolicy?: EgressPolicy;
  }) {
    this.endpoint = securityEndpoint(options.url, options.allowLocalHttp);
    if (!options.token || options.token.length > 8192 || /[\r\n]/.test(options.token)) throw new Error('Invalid remote inspector credential');
    if (!Array.isArray(options.tools) || options.tools.length < 1 || options.tools.length > 256 || new Set(options.tools).size !== options.tools.length || options.tools.some(name => typeof name !== 'string' || name.length < 1 || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name) || name.includes('*') && !/^[A-Za-z0-9_.-]{1,64}__\*$/.test(name))) throw new Error('Invalid remote inspector tool allowlist');
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 5000)) throw new Error('Invalid remote inspector timeout');
    if (options.maxRequestBytes !== undefined && (!Number.isSafeInteger(options.maxRequestBytes) || options.maxRequestBytes < 1024 || options.maxRequestBytes > 1024 * 1024)) throw new Error('Invalid remote inspector request limit');
    if (options.dataMode !== undefined && !['metadata', 'full'].includes(options.dataMode)) throw new Error('Invalid remote inspector data mode');
    if (options.identityFields !== undefined && (!Array.isArray(options.identityFields) || !options.identityFields.includes('id') || new Set(options.identityFields).size !== options.identityFields.length || options.identityFields.some(field => !['id', 'tenantId', 'subject', 'roles', 'authScheme'].includes(field)))) throw new Error('Invalid remote inspector identity fields');
  }

  beforeCall(context: InspectionContext) { return this.inspect('beforeCall', context); }
  afterCall(context: ResultInspectionContext) { return this.inspect('afterCall', context); }

  private async inspect(phase: Phase, context: InspectionContext | ResultInspectionContext): Promise<InspectionDecision> {
    const physicalName = `${context.upstreamId}__${context.upstreamTool}`;
    const applies = (name: string) => this.options.tools.some(pattern => pattern.endsWith('__*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name);
    if (!applies(context.requestedTool) && !applies(physicalName)) return 'allow';
    // Tool arguments and results can contain secrets. Only send them when the
    // deployment explicitly opts into full-payload transfer.
    const principal = context.principal;
    const identityFields = this.options.identityFields ?? ['id', 'tenantId'];
    const identity = Object.fromEntries(identityFields.flatMap(field => {
      const value = principal[field];
      return value === undefined ? [] : [[field, value]];
    }));
    const body = JSON.stringify({
      requestId: context.requestId,
      phase,
      principal: identity,
      requestedTool: context.requestedTool,
      upstreamId: context.upstreamId,
      upstreamTool: context.upstreamTool,
      ...(this.options.dataMode === 'full' ? {
        arguments: context.arguments,
        ...(phase === 'afterCall' ? { result: (context as ResultInspectionContext).result } : {})
      } : {})
    });
    if (Buffer.byteLength(body) > (this.options.maxRequestBytes ?? 256 * 1024)) return 'deny';

    let managedFetch: typeof fetch | undefined;
    try {
      const fetcher = this.options.fetch ?? (this.options.egressPolicy
        ? (managedFetch = upstreamFetch(this.endpoint.href, 2048, [this.endpoint.pathname], this.options.egressPolicy))
        : fetch);
      const response = await fetcher(this.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([
          AbortSignal.timeout(this.options.timeoutMs ?? 1000), context.signal
        ]),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.token}` },
        body
      });
      const document = await boundedJson(response, 2048);
      return Object.keys(document).length === 1 && Object.hasOwn(document, 'decision') && document.decision === 'allow' ? 'allow' : 'deny';
    } catch {
      return 'deny';
    } finally {
      if (managedFetch) await closeEgressFetch(managedFetch).catch(() => {});
    }
  }
}
