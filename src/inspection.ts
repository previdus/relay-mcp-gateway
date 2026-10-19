import type { ServiceClient } from './types.js';

export type InspectionDecision = 'allow' | 'deny';
export interface InspectionContext {
  readonly requestId: string;
  readonly principal: Readonly<Pick<ServiceClient, 'id' | 'tenantId' | 'subject' | 'roles' | 'authScheme'>>;
  readonly requestedTool: string;
  readonly upstreamId: string;
  readonly upstreamTool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly taskInputResponses?: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}
export interface ResultInspectionContext extends InspectionContext { readonly result: unknown }
/** Trusted, in-process extensions. They may only veto; no transforms, grants or retries. */
export interface ToolInspector {
  readonly id: string;
  beforeCall?(context: InspectionContext): InspectionDecision | Promise<InspectionDecision>;
  afterCall?(context: ResultInspectionContext): InspectionDecision | Promise<InspectionDecision>;
}
export class InspectionDenied extends Error {
  constructor(result = false) { super(result ? 'Result withheld by inspection; the upstream operation may already have completed. Do not retry automatically.' : 'Tool invocation denied or inspection unavailable'); }
}
type Input = { requestId: string; principal: ServiceClient; requestedTool: string; upstreamId: string; upstreamTool: string; arguments: Record<string, unknown>; taskInputResponses?: Record<string, unknown>; signal: AbortSignal };

function snapshot(input: Input, result?: { value: unknown }) {
  const { id, tenantId, subject, roles, authScheme } = input.principal;
  // Never provide bearer credentials to inspectors; payloads remain transient.
  const copy = JSON.parse(JSON.stringify({ requestId: input.requestId, principal: { id, tenantId, subject, roles, authScheme }, requestedTool: input.requestedTool, upstreamId: input.upstreamId, upstreamTool: input.upstreamTool, arguments: input.arguments, ...(input.taskInputResponses ? { taskInputResponses: input.taskInputResponses } : {}), ...(result ? { result: result.value } : {}) }));
  const pending: unknown[] = [copy]; let count = 0;
  while (pending.length) {
    if (++count > 50000) throw new InspectionDenied(Boolean(result));
    const value = pending.pop();
    if (value && typeof value === 'object') { Object.freeze(value); pending.push(...Object.values(value)); }
  }
  return copy;
}

export class InspectionPipeline {
  constructor(private inspectors: readonly ToolInspector[] = [], private timeoutMs = 1000) {
    if (inspectors.length > 16 || new Set(inspectors.map(i => i.id)).size !== inspectors.length || inspectors.some(i => !/^[a-zA-Z0-9_.-]{1,64}$/.test(i.id) || !i.beforeCall && !i.afterCall)) throw new Error('Invalid inspector registration');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('Invalid inspection timeout');
  }
  async inspect(phase: 'beforeCall' | 'afterCall', input: Input, result?: unknown) {
    const active = this.inspectors.filter(i => i[phase]); if (!active.length) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let onAbort: () => void = () => {};
    try {
      const context = Object.freeze({ ...snapshot(input, phase === 'afterCall' ? { value: result } : undefined), signal });
      const aborted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(new InspectionDenied(phase === 'afterCall')); signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); });
      const execute = async () => {
        for (const inspector of active) {
          signal.throwIfAborted();
          if (await inspector[phase]!(context) !== 'allow') throw new InspectionDenied(phase === 'afterCall');
        }
      };
      await Promise.race([execute(), aborted]);
    } catch { throw new InspectionDenied(phase === 'afterCall'); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); controller.abort(); }
  }
}
