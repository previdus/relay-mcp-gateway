import type { PriorDiscovery } from '@modelcontextprotocol/client';

type Entry = { value: PriorDiscovery; expiresAt: number };

/** Bounded, short-lived protocol-era hints. Keys must already be auth-context scoped. */
export class DiscoveryCache {
  private entries = new Map<string, Entry>();
  constructor(private ttlMs = 15_000, private maxEntries = 1024, private now = () => Date.now()) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || !Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('Invalid discovery cache bounds');
  }
  get(key: string): PriorDiscovery | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) { this.entries.delete(key); return undefined; }
    // Refresh LRU order without extending freshness: this is a hint, not a lease.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: PriorDiscovery, ttlMs = this.ttlMs): void {
    if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new Error('Invalid discovery cache TTL');
    const now = this.now();
    for (const [candidate, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(candidate);
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value, expiresAt: now + ttlMs });
  }
  delete(key: string): void { this.entries.delete(key); }
}
