import { Server, type ServerContext, type JSONRPCRequest, type Result } from '@modelcontextprotocol/server';
import { CreateTaskResultV2Schema, hasTaskClientCapabilityV2 } from '@modelcontextprotocol/ext-tasks/core/v2';

/**
 * Extends the SDK's tools/call result seam for the standardized Tasks V2 result.
 * The SDK still validates requests and every non-task result through its normal
 * wrapper; the extension result is validated with the official extension schema.
 */
export class TaskAwareServer extends Server {
  protected override _wrapHandler(method: string, handler: (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result>): (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result> {
    const standard = super._wrapHandler(method, handler);
    if (method !== 'tools/call') return standard;
    return async (request, ctx) => {
      const result = await handler(request, ctx);
      if (result && typeof result === 'object' && (result as { resultType?: unknown }).resultType === 'task' && hasTaskClientCapabilityV2(request.params)) {
        return CreateTaskResultV2Schema.parse(result) as unknown as Result;
      }
      // Reuse the SDK's request/result era checks and input-required behavior
      // without invoking a side-effecting handler a second time.
      return super._wrapHandler(method, async () => result)(request, ctx);
    };
  }
}
