import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import type { AuditEvent } from './types.js';
import { configSchema } from './config.js';
import type { z } from 'zod';
import { createHash } from 'node:crypto';

function jwtRevocationKey(issuer: string, tokenId: string) { return createHash('sha256').update(issuer).update('\0').update(tokenId).digest('hex'); }
function jwtIssuerKey(issuer: string) { return createHash('sha256').update(issuer).digest('hex'); }

export type ConfigDocument = z.infer<typeof configSchema>;
export interface ConfigSnapshot { revision: number; document: ConfigDocument }
export interface ConfigRevision { revision: number; at: string }
export interface AuditPage { events: AuditEvent[]; nextCursor?: string }
export interface StoredMcpTask { ciphertext: string; expiresAtMs: number }
export class RevisionConflict extends Error {}
export class InvalidAuditCursor extends Error {}
export interface ConfigStore {
  read(): Promise<ConfigSnapshot>;
  write(document: ConfigDocument, expectedRevision: number, event?: AuditEvent): Promise<ConfigSnapshot>;
  audit(event: AuditEvent): Promise<void>;
  recentAudit(): Promise<AuditEvent[]>;
  auditPage?(after: string | undefined, limit: number): Promise<AuditPage>;
  isJwtRevoked?(issuer: string, tokenId: string): Promise<boolean>;
  revokeJwt?(issuer: string, tokenId: string, expiresAtSeconds: number, event?: AuditEvent): Promise<void>;
  isJwtIssuerDisabled?(issuer: string): Promise<boolean>;
  setJwtIssuerDisabled?(issuer: string, disabled: boolean, event?: AuditEvent): Promise<void>;
  history?(): Promise<ConfigRevision[]>;
  revision?(revision: number): Promise<ConfigSnapshot | undefined>;
  putMcpTask?(key: string, ciphertext: string, expiresAtMs: number): Promise<void>;
  getMcpTask?(key: string): Promise<StoredMcpTask | undefined>;
  compareAndSetMcpTask?(key: string, expectedCiphertext: string, ciphertext: string, expiresAtMs: number): Promise<boolean>;
  close(): Promise<void>;
}
export class SqliteStore implements ConfigStore {
  private db: DatabaseSync;
  private jwtRevocationLookups = 0;
  constructor(path: string, initial: ConfigDocument) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS gateway_config (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS gateway_audit (id INTEGER PRIMARY KEY, event TEXT NOT NULL); CREATE TABLE IF NOT EXISTS gateway_jwt_revocations (token_key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS gateway_jwt_issuers (issuer_key TEXT PRIMARY KEY, disabled INTEGER NOT NULL CHECK(disabled IN (0,1))); CREATE TABLE IF NOT EXISTS gateway_mcp_tasks (task_key TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, expires_at_ms INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS gateway_mcp_tasks_expiry ON gateway_mcp_tasks(expires_at_ms);');
    this.db.prepare('INSERT OR IGNORE INTO gateway_config VALUES (1, 1, ?)').run(JSON.stringify(configSchema.parse(initial)));
    this.db.exec("CREATE TABLE IF NOT EXISTS gateway_config_history (revision INTEGER PRIMARY KEY, document TEXT NOT NULL, at TEXT NOT NULL); INSERT OR IGNORE INTO gateway_config_history SELECT revision, document, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM gateway_config WHERE id=1;");
  }
  async read(): Promise<ConfigSnapshot> {
    const row = this.db.prepare('SELECT revision, document FROM gateway_config WHERE id=1').get()!;
    return { revision: Number(row.revision), document: configSchema.parse(JSON.parse(String(row.document))) };
  }
  async write(document: ConfigDocument, expectedRevision: number, event?: AuditEvent) {
    const parsed = configSchema.parse(document);
    this.db.exec('BEGIN IMMEDIATE');
    try {
    const result = this.db.prepare('UPDATE gateway_config SET document=?, revision=revision+1 WHERE id=1 AND revision=?').run(JSON.stringify(parsed), expectedRevision);
    if (!result.changes) throw new RevisionConflict('Configuration changed; reload before saving');
    this.db.prepare('INSERT INTO gateway_config_history VALUES (?, ?, ?)').run(expectedRevision + 1, JSON.stringify(parsed), new Date().toISOString());
    if (event) this.db.prepare('INSERT INTO gateway_audit (event) VALUES (?)').run(JSON.stringify(event));
    this.db.exec('COMMIT');
    return { revision: expectedRevision + 1, document: parsed };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async audit(event: AuditEvent) { this.db.prepare('INSERT INTO gateway_audit (event) VALUES (?)').run(JSON.stringify(event)); }
  async history(): Promise<ConfigRevision[]> { return this.db.prepare('SELECT revision, at FROM gateway_config_history ORDER BY revision DESC LIMIT 50').all().map(row => ({ revision: Number(row.revision), at: String(row.at) })); }
  async revision(revision: number): Promise<ConfigSnapshot | undefined> {
    const row = this.db.prepare('SELECT document FROM gateway_config_history WHERE revision=?').get(revision);
    return row ? { revision, document: configSchema.parse(JSON.parse(String(row.document))) } : undefined;
  }
  async recentAudit() { return this.db.prepare('SELECT event FROM gateway_audit ORDER BY id DESC LIMIT 100').all().map(row => JSON.parse(String(row.event)) as AuditEvent); }
  async auditPage(after: string | undefined, limit: number): Promise<AuditPage> {
    const afterId = decodeAuditCursor(after);
    const rows = this.db.prepare('SELECT id,event FROM gateway_audit WHERE id>? ORDER BY id ASC LIMIT ?').all(afterId, limit + 1);
    const hasMore = rows.length > limit, page = rows.slice(0, limit);
    return { events: page.map(row => JSON.parse(String(row.event)) as AuditEvent), ...(hasMore && page.length ? { nextCursor: encodeAuditCursor(String(page[page.length - 1].id)) } : {}) };
  }
  async isJwtRevoked(issuer: string, tokenId: string) {
    const key = jwtRevocationKey(issuer, tokenId), now = Math.floor(Date.now() / 1000);
    if (++this.jwtRevocationLookups % 1024 === 0) this.db.prepare('DELETE FROM gateway_jwt_revocations WHERE expires_at <= ?').run(now);
    return Boolean(this.db.prepare('SELECT 1 FROM gateway_jwt_revocations WHERE token_key=? AND expires_at>? UNION ALL SELECT 1 FROM gateway_jwt_issuers WHERE issuer_key=? AND disabled=1 LIMIT 1').get(key, now, jwtIssuerKey(issuer)));
  }
  async revokeJwt(issuer: string, tokenId: string, expiresAtSeconds: number, event?: AuditEvent) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO gateway_jwt_revocations(token_key,expires_at) VALUES(?,?) ON CONFLICT(token_key) DO UPDATE SET expires_at=MAX(expires_at,excluded.expires_at)').run(jwtRevocationKey(issuer, tokenId), expiresAtSeconds);
      if (event) this.db.prepare('INSERT INTO gateway_audit(event) VALUES(?)').run(JSON.stringify(event));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async isJwtIssuerDisabled(issuer: string) { return Boolean(this.db.prepare('SELECT 1 FROM gateway_jwt_issuers WHERE issuer_key=? AND disabled=1').get(jwtIssuerKey(issuer))); }
  async setJwtIssuerDisabled(issuer: string, disabled: boolean, event?: AuditEvent) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO gateway_jwt_issuers(issuer_key,disabled) VALUES(?,?) ON CONFLICT(issuer_key) DO UPDATE SET disabled=excluded.disabled').run(jwtIssuerKey(issuer), disabled ? 1 : 0);
      if (event) this.db.prepare('INSERT INTO gateway_audit(event) VALUES(?)').run(JSON.stringify(event));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async putMcpTask(key: string, ciphertext: string, expiresAtMs: number) {
    this.db.prepare('DELETE FROM gateway_mcp_tasks WHERE expires_at_ms<=?').run(Date.now());
    this.db.prepare('INSERT INTO gateway_mcp_tasks(task_key,ciphertext,expires_at_ms) VALUES(?,?,?) ON CONFLICT(task_key) DO UPDATE SET ciphertext=excluded.ciphertext,expires_at_ms=excluded.expires_at_ms').run(key, ciphertext, expiresAtMs);
  }
  async getMcpTask(key: string): Promise<StoredMcpTask | undefined> {
    const row = this.db.prepare('SELECT ciphertext,expires_at_ms FROM gateway_mcp_tasks WHERE task_key=? AND expires_at_ms>?').get(key, Date.now());
    return row ? { ciphertext: String(row.ciphertext), expiresAtMs: Number(row.expires_at_ms) } : undefined;
  }
  async compareAndSetMcpTask(key: string, expectedCiphertext: string, ciphertext: string, expiresAtMs: number) {
    const result = this.db.prepare('UPDATE gateway_mcp_tasks SET ciphertext=?, expires_at_ms=? WHERE task_key=? AND ciphertext=? AND expires_at_ms>?').run(ciphertext, expiresAtMs, key, expectedCiphertext, Date.now());
    return result.changes === 1;
  }
  async close() { this.db.close(); }
}
export class PostgresStore implements ConfigStore {
  private jwtRevocationLookups = 0;
  constructor(readonly pool: pg.Pool) {}
  async initialize(initial: ConfigDocument) {
    const parsed = configSchema.parse(initial), connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("SELECT pg_advisory_xact_lock(hashtextextended('relay-schema-initialization', 0))");
      await connection.query('CREATE TABLE IF NOT EXISTS gateway_rate_buckets (key TEXT PRIMARY KEY, tokens DOUBLE PRECISION NOT NULL, updated_at TIMESTAMPTZ NOT NULL); CREATE TABLE IF NOT EXISTS gateway_circuits (key TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, open_until TIMESTAMPTZ, generation BIGINT NOT NULL DEFAULT 0, probe_token UUID, probe_until TIMESTAMPTZ); CREATE TABLE IF NOT EXISTS gateway_dpop_replay (proof_key TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL); CREATE INDEX IF NOT EXISTS gateway_dpop_replay_expiry ON gateway_dpop_replay(expires_at); CREATE TABLE IF NOT EXISTS gateway_jwt_revocations (token_key TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL); CREATE INDEX IF NOT EXISTS gateway_jwt_revocations_expiry ON gateway_jwt_revocations(expires_at); CREATE TABLE IF NOT EXISTS gateway_jwt_issuers (issuer_key TEXT PRIMARY KEY, disabled BOOLEAN NOT NULL); CREATE TABLE IF NOT EXISTS gateway_mcp_tasks (task_key TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, expires_at_ms BIGINT NOT NULL); CREATE INDEX IF NOT EXISTS gateway_mcp_tasks_expiry ON gateway_mcp_tasks(expires_at_ms)');
      await connection.query('CREATE TABLE IF NOT EXISTS gateway_config (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, document JSONB NOT NULL); CREATE TABLE IF NOT EXISTS gateway_audit (id BIGSERIAL PRIMARY KEY, event JSONB NOT NULL); CREATE TABLE IF NOT EXISTS gateway_leases (id UUID PRIMARY KEY, principal TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL); CREATE INDEX IF NOT EXISTS gateway_leases_principal ON gateway_leases(principal);');
      await connection.query('INSERT INTO gateway_config VALUES (1, 1, $1) ON CONFLICT DO NOTHING', [parsed]);
      await connection.query('CREATE TABLE IF NOT EXISTS gateway_config_history (revision INTEGER PRIMARY KEY, document JSONB NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now()); INSERT INTO gateway_config_history (revision, document) SELECT revision, document FROM gateway_config WHERE id=1 ON CONFLICT DO NOTHING');
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  }
  async read(): Promise<ConfigSnapshot> {
    const { rows } = await this.pool.query('SELECT revision, document FROM gateway_config WHERE id=1');
    if (!rows.length) throw new Error('Configuration is not initialized');
    return { revision: rows[0].revision, document: configSchema.parse(rows[0].document) };
  }
  async write(document: ConfigDocument, expectedRevision: number, event?: AuditEvent) {
    const parsed = configSchema.parse(document);
    const connection = await this.pool.connect();
    try {
    await connection.query('BEGIN');
    const result = await connection.query('UPDATE gateway_config SET document=$1, revision=revision+1 WHERE id=1 AND revision=$2 RETURNING revision', [parsed, expectedRevision]);
    if (!result.rowCount) throw new RevisionConflict('Configuration changed; reload before saving');
    await connection.query('INSERT INTO gateway_config_history (revision, document) VALUES ($1, $2)', [Number(result.rows[0].revision), parsed]);
    if (event) await connection.query('INSERT INTO gateway_audit (event) VALUES ($1)', [event]);
    await connection.query('COMMIT');
    return { revision: Number(result.rows[0].revision), document: parsed };
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  }
  async audit(event: AuditEvent) { await this.pool.query('INSERT INTO gateway_audit (event) VALUES ($1)', [event]); }
  async history(): Promise<ConfigRevision[]> { return (await this.pool.query('SELECT revision, at FROM gateway_config_history ORDER BY revision DESC LIMIT 50')).rows.map(row => ({ revision: Number(row.revision), at: new Date(row.at).toISOString() })); }
  async revision(revision: number): Promise<ConfigSnapshot | undefined> {
    const { rows } = await this.pool.query('SELECT document FROM gateway_config_history WHERE revision=$1', [revision]);
    return rows.length ? { revision, document: configSchema.parse(rows[0].document) } : undefined;
  }
  async recentAudit(): Promise<AuditEvent[]> { return (await this.pool.query('SELECT event FROM gateway_audit ORDER BY id DESC LIMIT 100')).rows.map(row => row.event); }
  async auditPage(after: string | undefined, limit: number): Promise<AuditPage> {
    const afterId = decodeAuditCursor(after);
    const result = await this.pool.query('SELECT id,event FROM gateway_audit WHERE id>$1 ORDER BY id ASC LIMIT $2', [afterId, limit + 1]);
    const hasMore = result.rows.length > limit, page = result.rows.slice(0, limit);
    return { events: page.map(row => row.event), ...(hasMore && page.length ? { nextCursor: encodeAuditCursor(String(page[page.length - 1].id)) } : {}) };
  }
  async isJwtRevoked(issuer: string, tokenId: string) {
    const key = jwtRevocationKey(issuer, tokenId);
    const result = await this.pool.query('SELECT 1 FROM gateway_jwt_revocations WHERE token_key=$1 AND expires_at>clock_timestamp() UNION ALL SELECT 1 FROM gateway_jwt_issuers WHERE issuer_key=$2 AND disabled=true LIMIT 1', [key, jwtIssuerKey(issuer)]);
    if (++this.jwtRevocationLookups % 1024 === 0) await this.pool.query('DELETE FROM gateway_jwt_revocations WHERE expires_at <= clock_timestamp()');
    return result.rowCount === 1;
  }
  async revokeJwt(issuer: string, tokenId: string, expiresAtSeconds: number, event?: AuditEvent) {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('INSERT INTO gateway_jwt_revocations(token_key,expires_at) VALUES($1,to_timestamp($2)) ON CONFLICT(token_key) DO UPDATE SET expires_at=GREATEST(gateway_jwt_revocations.expires_at,EXCLUDED.expires_at)', [jwtRevocationKey(issuer, tokenId), expiresAtSeconds]);
      if (event) await connection.query('INSERT INTO gateway_audit(event) VALUES($1)', [event]);
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  }
  async isJwtIssuerDisabled(issuer: string) {
    const result = await this.pool.query('SELECT 1 FROM gateway_jwt_issuers WHERE issuer_key=$1 AND disabled=true', [jwtIssuerKey(issuer)]);
    return result.rowCount === 1;
  }
  async setJwtIssuerDisabled(issuer: string, disabled: boolean, event?: AuditEvent) {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('INSERT INTO gateway_jwt_issuers(issuer_key,disabled) VALUES($1,$2) ON CONFLICT(issuer_key) DO UPDATE SET disabled=EXCLUDED.disabled', [jwtIssuerKey(issuer), disabled]);
      if (event) await connection.query('INSERT INTO gateway_audit(event) VALUES($1)', [event]);
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  }
  async putMcpTask(key: string, ciphertext: string, expiresAtMs: number) {
    await this.pool.query('DELETE FROM gateway_mcp_tasks WHERE expires_at_ms<=$1', [Date.now()]);
    await this.pool.query('INSERT INTO gateway_mcp_tasks(task_key,ciphertext,expires_at_ms) VALUES($1,$2,$3) ON CONFLICT(task_key) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,expires_at_ms=EXCLUDED.expires_at_ms', [key, ciphertext, expiresAtMs]);
  }
  async getMcpTask(key: string): Promise<StoredMcpTask | undefined> {
    const result = await this.pool.query('SELECT ciphertext,expires_at_ms FROM gateway_mcp_tasks WHERE task_key=$1 AND expires_at_ms>$2', [key, Date.now()]);
    return result.rows[0] ? { ciphertext: String(result.rows[0].ciphertext), expiresAtMs: Number(result.rows[0].expires_at_ms) } : undefined;
  }
  async compareAndSetMcpTask(key: string, expectedCiphertext: string, ciphertext: string, expiresAtMs: number) {
    const result = await this.pool.query('UPDATE gateway_mcp_tasks SET ciphertext=$1, expires_at_ms=$2 WHERE task_key=$3 AND ciphertext=$4 AND expires_at_ms>$5', [ciphertext, expiresAtMs, key, expectedCiphertext, Date.now()]);
    return result.rowCount === 1;
  }
  async close() { await this.pool.end(); }
}

function encodeAuditCursor(id: string) { return Buffer.from(id, 'utf8').toString('base64url'); }
function decodeAuditCursor(cursor: string | undefined) {
  if (cursor === undefined) return '0';
  if (cursor.length > 28 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidAuditCursor('Invalid audit cursor');
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor || !/^[1-9][0-9]{0,18}$/.test(decoded)) throw new InvalidAuditCursor('Invalid audit cursor');
  return decoded;
}
