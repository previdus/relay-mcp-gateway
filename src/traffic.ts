import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
export interface RatePolicy { capacity: number; refillPerSecond: number }
export interface RateLimiter { consume(key: string, policy: RatePolicy): Promise<boolean> }
export const rateKey = (parts: unknown[], policy: RatePolicy) => createHash('sha256').update(JSON.stringify([...parts, policy.capacity, policy.refillPerSecond])).digest('hex');
export class LocalRateLimiter implements RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number; capacity: number; refillPerSecond: number }>();
  private lastPrunedAt = Number.NEGATIVE_INFINITY;
  constructor(private now = () => performance.now(), private maximumEntries = 100_000) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 1_000_000) throw new Error('Invalid rate bucket capacity');
  }
  async consume(key: string, policy: RatePolicy) {
    const at = this.now();
    if (!Number.isFinite(at)) throw new Error('Invalid rate limiter clock');
    const bucket = this.buckets.get(key) ?? { tokens: policy.capacity, at, capacity: policy.capacity, refillPerSecond: policy.refillPerSecond };
    bucket.tokens = Math.min(policy.capacity, bucket.tokens + Math.max(0, at - bucket.at) * policy.refillPerSecond / 1000);
    bucket.at = at;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens--;
    // A bucket that has fully refilled has no remaining quota history. It is
    // safe to reclaim after policy churn; a partially depleted bucket is not.
    if (!this.buckets.has(key) && this.buckets.size >= this.maximumEntries) this.pruneRefilled(at);
    if (!this.buckets.has(key) && this.buckets.size >= this.maximumEntries) throw new Error('Rate bucket capacity exhausted');
    this.buckets.set(key, bucket);
    return allowed;
  }
  private pruneRefilled(now: number) {
    // Avoid turning a full registry into a linear scan on every rejected
    // insertion. One retry per second is enough while keeping memory bounded.
    if (now - this.lastPrunedAt < 1000) return;
    this.lastPrunedAt = now;
    for (const [key, bucket] of this.buckets) {
      const elapsed = Math.max(0, now - bucket.at);
      if (bucket.tokens >= bucket.capacity || elapsed * bucket.refillPerSecond / 1000 >= bucket.capacity - bucket.tokens) this.buckets.delete(key);
    }
  }
}
export class PostgresRateLimiter implements RateLimiter {
  constructor(private pool: pg.Pool) {}
  async consume(key: string, policy: RatePolicy) {
    const result = await this.pool.query(`INSERT INTO gateway_rate_buckets (key, tokens, updated_at)
      VALUES ($1, $2 - 1, clock_timestamp()) ON CONFLICT (key) DO UPDATE SET
      tokens = LEAST($2, gateway_rate_buckets.tokens + GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - gateway_rate_buckets.updated_at))) * $3) - 1,
      updated_at = clock_timestamp()
      WHERE LEAST($2, gateway_rate_buckets.tokens + GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - gateway_rate_buckets.updated_at))) * $3) >= 1
      RETURNING key`, [key, policy.capacity, policy.refillPerSecond]);
    return Boolean(result.rowCount);
  }
}
export interface CircuitPolicy { failureThreshold: number; resetAfterMs: number }
export class CircuitOpen extends Error { constructor() { super('Upstream circuit is open'); } }
interface Circuit { failures: number; openUntil: number; probing: boolean; generation: number }
export interface CircuitBreaker { run<T>(key: string, policy: CircuitPolicy, operation: () => Promise<T>, shouldCount?: (error: unknown) => boolean): Promise<T> }
export class CircuitBreakers implements CircuitBreaker {
  private states = new Map<string, Circuit>();
  constructor(private now = () => performance.now()) {}
  async run<T>(key: string, policy: CircuitPolicy, operation: () => Promise<T>, shouldCount = (_error: unknown) => true): Promise<T> {
    const state = this.states.get(key) ?? { failures: 0, openUntil: 0, probing: false, generation: 0 };
    if (!this.states.has(key) && this.states.size >= 10000) throw new Error('Circuit registry capacity exhausted');
    this.states.set(key, state);
    const probe = state.openUntil > 0;
    if (probe && (state.openUntil > this.now() || state.probing)) throw new CircuitOpen();
    if (probe) state.probing = true;
    const generation = state.generation;
    try {
      const result = await operation();
      if (state.generation === generation) {
        state.failures = 0;
        if (probe) { state.openUntil = 0; state.generation++; }
      }
      return result;
    } catch (error) {
      if (state.generation === generation && shouldCount(error) && ++state.failures >= policy.failureThreshold) {
        state.openUntil = this.now() + policy.resetAfterMs; state.generation++;
      }
      throw error;
    } finally { if (probe) state.probing = false; }
  }
}

/** Shared circuit state for horizontally scaled gateways. A probe lease is
 * longer than the maximum configured upstream operation deadline (120s), so
 * only one replica probes a recovering destination at a time. */
export class PostgresCircuitBreakers implements CircuitBreaker {
  constructor(private pool: pg.Pool, private probeLeaseMs = 125_000) {
    if (!Number.isSafeInteger(probeLeaseMs) || probeLeaseMs < 120_000 || probeLeaseMs > 300_000) throw new Error('Invalid distributed circuit probe lease');
  }

  async run<T>(key: string, policy: CircuitPolicy, operation: () => Promise<T>, shouldCount = (_error: unknown) => true): Promise<T> {
    if (!Number.isSafeInteger(policy.failureThreshold) || policy.failureThreshold < 1 || !Number.isSafeInteger(policy.resetAfterMs) || policy.resetAfterMs < 1) throw new Error('Invalid circuit policy');
    const probeToken = randomUUID();
    const connection = await this.pool.connect();
    let generation: string;
    let probe: boolean;
    try {
      await connection.query('BEGIN');
      await connection.query('INSERT INTO gateway_circuits (key, failures, generation) VALUES ($1, 0, 0) ON CONFLICT (key) DO NOTHING', [key]);
      const selected = await connection.query('SELECT failures, open_until, generation, probe_token, probe_until, clock_timestamp() AS now FROM gateway_circuits WHERE key=$1 FOR UPDATE', [key]);
      const row = selected.rows[0];
      generation = String(row.generation);
      probe = row.open_until !== null;
      if (probe) {
        if (new Date(row.open_until).getTime() > new Date(row.now).getTime() || row.probe_token !== null && new Date(row.probe_until).getTime() > new Date(row.now).getTime()) {
          await connection.query('ROLLBACK');
          throw new CircuitOpen();
        }
        await connection.query('UPDATE gateway_circuits SET probe_token=$2, probe_until=clock_timestamp() + ($3 * interval \'1 millisecond\') WHERE key=$1', [key, probeToken, this.probeLeaseMs]);
      }
      await connection.query('COMMIT');
    } catch (error) {
      try { await connection.query('ROLLBACK'); } catch {}
      throw error;
    } finally { connection.release(); }

    let value: T;
    try { value = await operation(); }
    catch (error) {
      let counted = false;
      try { counted = shouldCount(error); } catch {}
      try {
        if (probe) {
          if (counted) await this.pool.query(`UPDATE gateway_circuits SET failures=GREATEST(failures, $4), open_until=clock_timestamp() + ($5 * interval '1 millisecond'), generation=generation+1, probe_token=NULL, probe_until=NULL WHERE key=$1 AND generation=$2 AND probe_token=$3`, [key, generation!, probeToken, policy.failureThreshold, policy.resetAfterMs]);
          else await this.pool.query('UPDATE gateway_circuits SET probe_token=NULL, probe_until=NULL WHERE key=$1 AND generation=$2 AND probe_token=$3', [key, generation!, probeToken]);
        } else if (counted) {
          await this.pool.query(`UPDATE gateway_circuits SET
            failures=failures+1,
            open_until=CASE WHEN failures+1 >= $3 THEN clock_timestamp() + ($4 * interval '1 millisecond') ELSE open_until END,
            generation=CASE WHEN failures+1 >= $3 THEN generation+1 ELSE generation END,
            probe_token=CASE WHEN failures+1 >= $3 THEN NULL ELSE probe_token END,
            probe_until=CASE WHEN failures+1 >= $3 THEN NULL ELSE probe_until END
            WHERE key=$1 AND generation=$2 AND open_until IS NULL`, [key, generation!, policy.failureThreshold, policy.resetAfterMs]);
        }
      } catch { console.error('Distributed circuit state update failed'); }
      throw error;
    }
    try {
      if (probe) await this.pool.query('UPDATE gateway_circuits SET failures=0, open_until=NULL, generation=generation+1, probe_token=NULL, probe_until=NULL WHERE key=$1 AND generation=$2 AND probe_token=$3', [key, generation!, probeToken]);
      else await this.pool.query('UPDATE gateway_circuits SET failures=0 WHERE key=$1 AND generation=$2 AND open_until IS NULL', [key, generation!]);
    } catch { console.error('Distributed circuit state update failed'); }
    return value;
  }
}
