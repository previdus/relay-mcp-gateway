type Entry = { fingerprint: string; expiresAt: number };
export const ROUTE_CONTRACT_CACHE_MAX_TTL_MS = 5000;

/** Auth-context scoped cache for upstream contracts with an explicit positive MCP freshness hint. */
export class RouteContractCache {
  private entries = new Map<string, Entry>();
  constructor(private maxEntries = 4096, private maxTtlMs = ROUTE_CONTRACT_CACHE_MAX_TTL_MS, private now = () => Date.now()) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isInteger(maxTtlMs) || maxTtlMs < 0) throw new Error('Invalid route contract cache bounds');
  }
  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) { this.entries.delete(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.fingerprint;
  }
  set(key: string, fingerprint: string, ttlMs: number): void {
    if (this.maxTtlMs === 0 || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) return;
    const now = this.now();
    for (const [candidate, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(candidate);
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { fingerprint, expiresAt: now + Math.min(ttlMs, this.maxTtlMs) });
  }
  delete(key: string): void { this.entries.delete(key); }
  get size() { return this.entries.size; }
}
