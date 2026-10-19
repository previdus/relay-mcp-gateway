import { createHash } from 'node:crypto';
import type { EgressPolicy } from './egress.js';
import { closeEgressFetch, upstreamFetch } from './egress.js';
import { boundedJson, securityEndpoint } from './security-http.js';
import type { ServiceClient } from './types.js';

export interface ApprovalContext {
  readonly requestId: string;
  readonly principal: Readonly<Pick<ServiceClient, 'id' | 'tenantId' | 'subject' | 'oauthClientId'>>;
  readonly requestedTool: string;
  readonly upstreamId: string;
  readonly upstreamTool: string;
  readonly configurationRevision: number;
  readonly toolContractFingerprint: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}
export type ApprovalResult = { decision: 'allow' } | { decision: 'pending'; approvalId: string } | { decision: 'deny' };
export interface ToolApprovalGate {
  requestOrConsume(context: ApprovalContext, approvalId?: string): Promise<ApprovalResult>;
}
export class ApprovalDenied extends Error {
  constructor(readonly approvalId?: string) { super(approvalId ? `Human approval is pending (${approvalId})` : 'Tool approval is unavailable or denied'); }
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, ordered(item)]));
  return value;
}
function matches(patterns: readonly string[], name: string) {
  return patterns.some(pattern => pattern.endsWith('__*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name);
}

/** External approval workflow adapter. Its service owns reviewer identity,
 * durable state and atomic permit consumption; this adapter only accepts a
 * pending ID on request and an exact one-use allow on consumption. */
export class RemoteApprovalGate implements ToolApprovalGate {
  private readonly endpoint: URL;
  constructor(private readonly options: {
    url: string;
    token: string;
    tools: readonly string[];
    timeoutMs?: number;
    maxRequestBytes?: number;
    allowLocalHttp?: boolean;
    fetch?: typeof fetch;
    egressPolicy?: EgressPolicy;
  }) {
    this.endpoint = securityEndpoint(options.url, options.allowLocalHttp);
    if (!options.token || options.token.length > 8192 || /[\r\n]/.test(options.token)) throw new Error('Invalid approval service credential');
    if (!Array.isArray(options.tools) || options.tools.length > 256 || new Set(options.tools).size !== options.tools.length || options.tools.some(name => typeof name !== 'string' || name.length < 1 || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name) || name.includes('*') && !/^[A-Za-z0-9_.-]{1,64}__\*$/.test(name))) throw new Error('Invalid approval tool allowlist');
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 5000)) throw new Error('Invalid approval service timeout');
    if (options.maxRequestBytes !== undefined && (!Number.isSafeInteger(options.maxRequestBytes) || options.maxRequestBytes < 1024 || options.maxRequestBytes > 1024 * 1024)) throw new Error('Invalid approval request limit');
  }

  async requestOrConsume(context: ApprovalContext, approvalId?: string): Promise<ApprovalResult> {
    const physicalName = `${context.upstreamId}__${context.upstreamTool}`;
    if (!matches(this.options.tools, context.requestedTool) && !matches(this.options.tools, physicalName)) return { decision: 'deny' };
    if (approvalId !== undefined && (typeof approvalId !== 'string' || approvalId.length < 16 || approvalId.length > 256 || /[^a-zA-Z0-9_.-]/.test(approvalId))) return { decision: 'deny' };
    const identity = {
      id: context.principal.id,
      ...(context.principal.tenantId ? { tenantId: context.principal.tenantId } : {}),
      ...(context.principal.subject ? { subject: context.principal.subject } : {}),
      ...(context.principal.oauthClientId ? { oauthClientId: context.principal.oauthClientId } : {})
    };
    const body = JSON.stringify({
      phase: approvalId ? 'consume' : 'request',
      requestId: context.requestId,
      principal: identity,
      requestedTool: context.requestedTool,
      upstreamId: context.upstreamId,
      upstreamTool: context.upstreamTool,
      configurationRevision: context.configurationRevision,
      toolContractFingerprint: context.toolContractFingerprint,
      argumentDigest: createHash('sha256').update(JSON.stringify(ordered(context.arguments))).digest('hex'),
      arguments: context.arguments,
      ...(approvalId ? { approvalId } : {})
    });
    if (Buffer.byteLength(body) > (this.options.maxRequestBytes ?? 256 * 1024)) return { decision: 'deny' };
    let managedFetch: typeof fetch | undefined;
    try {
      const fetcher = this.options.fetch ?? (this.options.egressPolicy
        ? (managedFetch = upstreamFetch(this.endpoint.href, 2048, [this.endpoint.pathname], this.options.egressPolicy))
        : fetch);
      const response = await fetcher(this.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs ?? 1000), context.signal]),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.token}` }, body
      });
      const document = await boundedJson(response, 2048);
      if (!approvalId && Object.keys(document).length === 2 && document.decision === 'pending' && typeof document.approvalId === 'string' && /^[a-zA-Z0-9_.-]{16,256}$/.test(document.approvalId)) return { decision: 'pending', approvalId: document.approvalId };
      if (approvalId && Object.keys(document).length === 1 && document.decision === 'allow') return { decision: 'allow' };
      return { decision: 'deny' };
    } catch { return { decision: 'deny' }; }
    finally { if (managedFetch) await closeEgressFetch(managedFetch).catch(() => {}); }
  }
}
