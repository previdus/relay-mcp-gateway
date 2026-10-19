import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';

export interface DpopReplayStore {
  /** Atomically claim a proof key until it is no longer inside the accepted time window. */
  consume(key: string, expiresAtSeconds: number): Promise<boolean>;
}

export class DpopReplayStoreUnavailable extends Error {
  constructor() { super('DPoP replay protection is unavailable'); }
}

/** Shared-secret, replica-compatible server nonce. RFC 9449 permits nonce reuse;
 * proof jti replay state remains the one-use control. */
export class DpopNonceManager {
  constructor(private readonly secret: string, private readonly maxAgeSeconds = 300) {
    if (secret.length < 32 || !Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 300) throw new Error('Invalid DPoP nonce configuration');
  }
  issue(nowSeconds = Math.floor(Date.now() / 1000)) {
    const payload = `${nowSeconds}.${randomBytes(32).toString('base64url')}`;
    return `${payload}.${createHmac('sha256', this.secret).update(payload).digest('base64url')}`;
  }
  verify(nonce: string, nowSeconds = Math.floor(Date.now() / 1000)): number | undefined {
    if (nonce.length > 256) return undefined;
    const match = /^(\d{10})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(nonce);
    if (!match) return undefined;
    const issuedAt = Number(match[1]);
    if (issuedAt > nowSeconds + 5 || nowSeconds - issuedAt > this.maxAgeSeconds) return undefined;
    const expected = createHmac('sha256', this.secret).update(`${match[1]}.${match[2]}`).digest();
    const supplied = Buffer.from(match[3]!, 'base64url');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? issuedAt : undefined;
  }
}

export class DpopNonceRequired extends Error {
  constructor(readonly nonce: string) { super('A current DPoP nonce is required'); }
}

/** Explicitly single-process replay protection for local development and tests. */
export class InMemoryDpopReplayStore implements DpopReplayStore {
  private entries = new Map<string, number>();
  constructor(private readonly maxEntries = 100_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000_000) throw new Error('Invalid DPoP replay-store capacity');
  }
  async consume(key: string, expiresAtSeconds: number): Promise<boolean> {
    const now = Date.now() / 1000;
    if (this.entries.has(key) && this.entries.get(key)! > now) return false;
    if (this.entries.size >= this.maxEntries) {
      for (const [candidate, expires] of this.entries) if (expires <= now) this.entries.delete(candidate);
      if (this.entries.size >= this.maxEntries) throw new DpopReplayStoreUnavailable();
    }
    this.entries.set(key, expiresAtSeconds);
    return true;
  }
}

/** Shared, atomic replay protection for horizontally scaled PostgreSQL deployments. */
export class PostgresDpopReplayStore implements DpopReplayStore {
  private operations = 0;
  constructor(private readonly pool: Pool) {}
  async consume(key: string, expiresAtSeconds: number): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `INSERT INTO gateway_dpop_replay (proof_key, expires_at)
         VALUES ($1, to_timestamp($2))
         ON CONFLICT (proof_key) DO UPDATE SET expires_at = EXCLUDED.expires_at
         WHERE gateway_dpop_replay.expires_at <= clock_timestamp()
         RETURNING proof_key`,
        [key, expiresAtSeconds]
      );
      this.operations++;
      if (this.operations % 1024 === 0) await this.pool.query('DELETE FROM gateway_dpop_replay WHERE expires_at <= clock_timestamp()');
      return result.rowCount === 1;
    } catch { throw new DpopReplayStoreUnavailable(); }
  }
}

export interface DpopProofInput {
  proof?: string;
  proofHeaderCount: number;
  authorizationScheme?: string;
  accessToken: string;
  confirmation: unknown;
  method: string;
  requestTarget: string;
  publicOrigin: string;
  maxAgeSeconds: number;
  replayStore: DpopReplayStore;
  nonceManager?: DpopNonceManager;
}

const acceptedAlgorithms = ['ES256', 'PS256', 'RS256', 'EdDSA'] as const;
const privateJwkMembers = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

/** Validate the resource-server half of RFC 9449 before identity mapping or policy evaluation. */
export async function verifyDpopProof(input: DpopProofInput): Promise<boolean> {
  try {
    if (input.authorizationScheme?.toLowerCase() !== 'dpop' || input.proofHeaderCount !== 1 || !input.proof || input.proof.length > 8192 || !input.accessToken || input.accessToken.length > 8192) return false;
    if (!Number.isInteger(input.maxAgeSeconds) || input.maxAgeSeconds < 1 || input.maxAgeSeconds > 300 || !/^[A-Z]{3,16}$/.test(input.method)) return false;

    const header = decodeProtectedHeader(input.proof);
    if (header.typ !== 'dpop+jwt' || !acceptedAlgorithms.includes(header.alg as typeof acceptedAlgorithms[number]) || !header.jwk || typeof header.jwk !== 'object' || Array.isArray(header.jwk)) return false;
    const jwk = header.jwk as JWK;
    if (privateJwkMembers.some(member => Object.hasOwn(jwk, member))) return false;
    const confirmation = input.confirmation;
    if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation) || Object.keys(confirmation).length !== 1 || !('jkt' in confirmation)) return false;
    const jkt = await calculateJwkThumbprint(jwk);
    if (typeof confirmation.jkt !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(confirmation.jkt) || confirmation.jkt !== jkt) return false;

    const publicOrigin = new URL(input.publicOrigin);
    if (publicOrigin.protocol !== 'https:' || publicOrigin.username || publicOrigin.password || publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash) return false;
    if (!input.requestTarget.startsWith('/') || input.requestTarget.startsWith('//') || input.requestTarget.includes('\\')) return false;
    const expectedTarget = new URL(input.requestTarget, publicOrigin);
    expectedTarget.search = ''; expectedTarget.hash = '';

    const key = await importJWK(jwk, header.alg);
    const verified = await jwtVerify(input.proof, key, { algorithms: [...acceptedAlgorithms], typ: 'dpop+jwt' });
    const payload = verified.payload;
    const now = Date.now() / 1000;
    if (typeof payload.jti !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(payload.jti) ||
        payload.htm !== input.method || typeof payload.htu !== 'string' || typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) ||
        (!input.nonceManager && Math.abs(now - payload.iat) > input.maxAgeSeconds)) return false;
    const actualTarget = new URL(payload.htu);
    if (actualTarget.protocol !== 'https:' || actualTarget.username || actualTarget.password || actualTarget.search || actualTarget.hash || actualTarget.href !== expectedTarget.href) return false;
    const expectedAth = createHash('sha256').update(input.accessToken, 'ascii').digest('base64url');
    if (typeof payload.ath !== 'string' || payload.ath !== expectedAth) return false;
    const nonceIssuedAt = input.nonceManager ? typeof payload.nonce === 'string' ? input.nonceManager.verify(payload.nonce) : undefined : undefined;
    if (input.nonceManager && nonceIssuedAt === undefined) throw new DpopNonceRequired(input.nonceManager.issue());

    const replayKey = createHash('sha256').update(JSON.stringify([jkt, payload.jti, payload.htm, actualTarget.href])).digest('hex');
    // Keep a just-expired-at-the-boundary proof claimed briefly as well. Without
    // this floor, a proof with iat == now - maxAge could be accepted while its
    // replay record was already expired, allowing repeated use at the boundary.
    return await input.replayStore.consume(replayKey, Math.max((nonceIssuedAt ?? payload.iat) + input.maxAgeSeconds, now + 1));
  } catch (error) {
    if (error instanceof DpopReplayStoreUnavailable || error instanceof DpopNonceRequired) throw error;
    return false;
  }
}
