import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ProtocolError, ProtocolErrorCode, isInputRequiredResult, type ServerContext, type InputRequiredResult, type ClientCapabilities } from '@modelcontextprotocol/server';
import type { ServiceClient } from './types.js';

interface Continuation { upstreamId: string; upstreamTool: string; binding: string; state?: string; rounds: number; expires: number }
export const callBinding = (method: string, name: string, args: unknown) => createHash('sha256').update(JSON.stringify([method, name, args])).digest('hex');
/** Stable security identity for encrypted continuation state; never includes bearer credentials. */
export function principalSealBinding(principal: ServiceClient) {
  return JSON.stringify([
    principal.id, principal.tenantId ?? 'default', principal.subject ?? null,
    principal.oauthIssuer ?? null, principal.oauthClientId ?? null,
    principal.certificateSha256 ?? null, principal.authScheme ?? null,
    [...(principal.roles ?? [])].sort(), [...(principal.callbackMethods ?? [])].sort(),
  ]);
}
/** Encrypted and authenticated state is portable across replicas sharing the deployment key. */
export class ContinuationCodec {
  private key: Buffer;
  constructor(key: string) { if (Buffer.byteLength(key) < 32) throw new Error('GATEWAY_STATE_KEY must contain at least 32 bytes'); this.key = createHash('sha256').update(key).digest(); }
  seal(value: Omit<Continuation, 'expires'>, principal: ServiceClient) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(principalSealBinding(principal)));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ ...value, expires: Date.now() + 600000 })), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }
  open(token: string, principal: ServiceClient): Continuation {
    try {
      if (token.length > 32768) throw new Error();
      const bytes = Buffer.from(token, 'base64url'); const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(principalSealBinding(principal))); decipher.setAuthTag(bytes.subarray(12, 28));
      const value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()) as Continuation;
      if (value.expires < Date.now() || value.rounds >= 16 || typeof value.binding !== 'string') throw new Error();
      return value;
    } catch { throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid or expired continuation'); }
  }
}
export function callbackCapabilities(principal: ServiceClient, ctx?: ServerContext): ClientCapabilities {
  const envelope = ctx?.mcpReq.envelope as Record<string, unknown> | undefined;
  const declared = envelope?.['io.modelcontextprotocol/clientCapabilities'] as ClientCapabilities | undefined;
  const allowed = principal.callbackMethods ?? [];
  return {
    ...(declared?.elicitation && allowed.includes('elicitation/create') ? { elicitation: declared.elicitation } : {}),
    ...(declared?.sampling && allowed.includes('sampling/createMessage') ? { sampling: declared.sampling } : {}),
    ...(declared?.roots && allowed.includes('roots/list') ? { roots: declared.roots } : {})
  };
}
export function stateFor(ctx: ServerContext, codec: ContinuationCodec | undefined, principal: ServiceClient, binding: string) {
  const raw = ctx.mcpReq.requestState<unknown>();
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !codec) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Continuation support is disabled');
  const state = codec.open(raw, principal);
  if (state.binding !== binding) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Continuation does not match this request');
  return state;
}
export function wrapInput(result: unknown, options: { codec?: ContinuationCodec; principal: ServiceClient; ctx: ServerContext; binding: string; upstreamId: string; upstreamTool: string; rounds?: number }): InputRequiredResult | undefined {
  if (!isInputRequiredResult(result)) return undefined;
  if (!options.codec) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Client callbacks are disabled');
  const caps = callbackCapabilities(options.principal, options.ctx);
  for (const request of Object.values(result.inputRequests ?? {})) {
    const method = request.method;
    if (!(options.principal.callbackMethods ?? []).includes(method) || (method === 'elicitation/create' && !caps.elicitation) || (method === 'sampling/createMessage' && !caps.sampling) || (method === 'roots/list' && !caps.roots)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Callback permission or capability missing');
  }
  return { ...result, requestState: options.codec.seal({ upstreamId: options.upstreamId, upstreamTool: options.upstreamTool, binding: options.binding, state: result.requestState, rounds: (options.rounds ?? 0) + 1 }, options.principal) };
}
