import { randomUUID } from 'node:crypto';
import type pg from 'pg';
export interface ConcurrencyLimiter { acquire(principal: string, limit: number): Promise<(() => Promise<void>) | undefined> }
export class LocalLimiter implements ConcurrencyLimiter {
  private counts = new Map<string, number>();
  async acquire(principal: string, limit: number) {
    const count = this.counts.get(principal) ?? 0;
    if (count >= limit) return undefined;
    this.counts.set(principal, count + 1);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const count = (this.counts.get(principal) ?? 1) - 1;
      if (count <= 0) this.counts.delete(principal); else this.counts.set(principal, count);
    };
  }
}
export class PostgresLimiter implements ConcurrencyLimiter {
  constructor(private pool: pg.Pool) {}
  async acquire(principal: string, limit: number) {
    const connection = await this.pool.connect();
    const id = randomUUID();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [principal]);
      await connection.query('DELETE FROM gateway_leases WHERE principal=$1 AND expires_at < now()', [principal]);
      const { rows } = await connection.query('SELECT count(*)::integer AS count FROM gateway_leases WHERE principal=$1', [principal]);
      if (rows[0].count >= limit) { await connection.query('ROLLBACK'); return undefined; }
      // Requests are capped at 125 seconds; leases outlive that cap and recover after a crashed replica.
      await connection.query("INSERT INTO gateway_leases VALUES ($1, $2, now() + interval '135 seconds')", [id, principal]);
      await connection.query('COMMIT');
      return async () => { await this.pool.query('DELETE FROM gateway_leases WHERE id=$1', [id]); };
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  }
}
