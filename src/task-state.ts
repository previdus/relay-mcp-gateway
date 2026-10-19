import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { principalSealBinding } from './continuations.js';
import type { ServiceClient } from './types.js';

export interface McpTaskState {
  upstreamTaskId: string;
  upstreamId: string;
  upstreamTool: string;
  publicTool: string;
  arguments: Record<string, unknown>;
  contractFingerprint: string;
  pendingInputMethods?: Record<string, string>;
  pendingInputClaims?: Record<string, { response: unknown; method: string; claimId: string; leaseUntilMs: number }>;
  consumedInputKeys?: string[];
  expiresAtMs: number;
}

export function taskStorageKey(publicTaskId: string) {
  return createHash('sha256').update(publicTaskId).digest('hex');
}

/** Encrypts route and caller-specific task state so database contents reveal no task IDs or arguments. */
export class McpTaskCodec {
  private readonly key: Buffer;
  constructor(key: string) {
    if (Buffer.byteLength(key) < 32) throw new Error('GATEWAY_STATE_KEY must contain at least 32 bytes');
    this.key = createHash('sha256').update(key).digest();
  }
  createId() { return randomBytes(32).toString('base64url'); }
  seal(state: McpTaskState, principal: ServiceClient) {
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > 90000) throw new Error('Task state exceeds the configured encrypted state limit');
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(principalSealBinding(principal)));
    const body = Buffer.concat([cipher.update(serialized), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
  }
  open(value: string, principal: ServiceClient): McpTaskState {
    try {
      if (value.length > 131072) throw new Error();
      const bytes = Buffer.from(value, 'base64url');
      if (bytes.length < 29 || bytes.length > 98304) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(principalSealBinding(principal)));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const state = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()) as McpTaskState;
      if (!state || typeof state.upstreamTaskId !== 'string' || typeof state.upstreamId !== 'string' || typeof state.upstreamTool !== 'string' || typeof state.publicTool !== 'string' || typeof state.contractFingerprint !== 'string' || !state.arguments || typeof state.arguments !== 'object' || !Number.isSafeInteger(state.expiresAtMs) || state.expiresAtMs <= Date.now()) throw new Error();
      if (state.pendingInputMethods !== undefined && (!state.pendingInputMethods || typeof state.pendingInputMethods !== 'object' || Array.isArray(state.pendingInputMethods) || Object.entries(state.pendingInputMethods).some(([key, method]) => !key || typeof method !== 'string'))) throw new Error();
      if (state.pendingInputClaims !== undefined && (!state.pendingInputClaims || typeof state.pendingInputClaims !== 'object' || Array.isArray(state.pendingInputClaims) || Object.entries(state.pendingInputClaims).some(([key, claim]) => !key || !claim || typeof claim !== 'object' || typeof claim.method !== 'string' || state.pendingInputMethods?.[key] !== claim.method || typeof claim.claimId !== 'string' || !claim.claimId || !Number.isSafeInteger(claim.leaseUntilMs) || claim.leaseUntilMs <= 0))) throw new Error();
      if (state.consumedInputKeys !== undefined && (!Array.isArray(state.consumedInputKeys) || state.consumedInputKeys.some(key => typeof key !== 'string' || !key) || new Set(state.consumedInputKeys).size !== state.consumedInputKeys.length)) throw new Error();
      return state;
    } catch { throw new Error('Task unavailable'); }
  }
}
