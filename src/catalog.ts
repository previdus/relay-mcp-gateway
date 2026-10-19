import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/client';
import type { GatewayConfig, ServiceClient } from './types.js';
import type { Router, RoutingContext } from './plugins.js';
import type { UpstreamExecutor } from './features.js';
import { enforceRoutedContract } from './contracts.js';
import { sameTenant } from './tenancy.js';
import { parameterDeclarations } from './parameter-headers.js';

export const discoverySchema = z.object({
  concurrency: z.number().int().min(1).max(16).optional(),
  pageSize: z.number().int().min(1).max(200).optional(),
  maxTools: z.number().int().min(1).max(10000).optional(),
  maxScannedTools: z.number().int().min(1).max(100000).optional(),
  maxBytes: z.number().int().min(1024).max(4 * 1024 * 1024).optional(),
  routeContractCacheMaxTtlMs: z.number().int().min(0).max(60000).optional()
}).strict();
export type DiscoveryOptions = z.infer<typeof discoverySchema>;
export class CatalogLimitExceeded extends Error { constructor() { super('Catalog exceeds configured discovery limits; narrow the configured catalog or increase its bounded budget'); } }
export class InvalidCatalogCursor extends Error { constructor() { super('Catalog cursor is invalid or stale; restart discovery'); } }

/** Bounded collector shared by MCP discovery and authorized HTTP search. No cache of permission. */
export async function collectCatalog(input: {
  config: GatewayConfig; principal: ServiceClient; router: Router; context: RoutingContext; signal: AbortSignal;
  canCall(name: string): Promise<boolean>; execute: UpstreamExecutor;
  onRejected(upstream: string, name: string, error: unknown): Promise<void>;
  onFailure(upstream: string): Promise<void>;
}) {
  const { config, principal } = input, policy = config.discovery;
  const maxTools = policy?.maxTools ?? 1000, maxScanned = policy?.maxScannedTools ?? 10000, maxBytes = policy?.maxBytes ?? 1024 * 1024;
  let scanned = 0, scannedBytes = 0, visible = 0, visibleBytes = 0, next = 0;
  let overflow: CatalogLimitExceeded | undefined;
  const controller = new AbortController(), signal = AbortSignal.any([input.signal, controller.signal, AbortSignal.timeout(config.timeoutMs ?? 5000)]);
  const upstreams = config.upstreams.filter(u => sameTenant(principal, u));
  const results: Tool[][] = Array.from({ length: upstreams.length }, () => []);
  const check = () => {
    if (scanned > maxScanned || scannedBytes > maxBytes || visible > maxTools || visibleBytes > maxBytes) { overflow ??= new CatalogLimitExceeded(); controller.abort(); throw overflow; }
    signal.throwIfAborted();
  };
  async function worker() {
    while (next < upstreams.length && !signal.aborted) {
      const index = next++, upstream = upstreams[index]!;
      try {
        results[index] = await input.execute(upstream, async (client, options) => {
          const tools: Tool[] = [], seen = new Set<string>(); let cursor: string | undefined;
          do {
            const page = await client.request({ method: 'tools/list', params: cursor ? { cursor } : {} }, options);
            for (const tool of page.tools) {
              scanned++; scannedBytes += Buffer.byteLength(JSON.stringify(tool)); check();
              for (const name of input.router.names(upstream.id, tool.name, input.context)) {
                check();
                if (!await input.canCall(name)) continue;
                let fingerprint: string;
                try {
                  parameterDeclarations(tool.inputSchema);
                  fingerprint = enforceRoutedContract(tool, name, upstream.id, config);
                }
                catch (error) { await input.onRejected(upstream.id, name, error); continue; }
                const published = { ...tool, name, _meta: { ...tool._meta, 'com.example.relay/contractFingerprint': fingerprint } };
                visible++; visibleBytes += Buffer.byteLength(JSON.stringify(published)); check(); tools.push(published);
              }
            }
            cursor = page.nextCursor;
            if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new Error('Invalid upstream catalog pagination');
            if (cursor) seen.add(cursor);
          } while (cursor);
          return tools;
        }, signal);
      } catch (error) {
        if (error instanceof CatalogLimitExceeded) overflow ??= error;
        if (!signal.aborted && !overflow) await input.onFailure(upstream.id);
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(upstreams.length, policy?.concurrency ?? 4) }, worker));
    if (overflow) throw overflow;
    signal.throwIfAborted();
    const hiddenAliases = new Set<string>();
    for (const route of config.routes ?? []) {
      const eligible = (!route.clients || route.clients.includes(principal.id)) &&
        (!route.tenants || route.tenants.includes(principal.tenantId ?? 'default')) &&
        (!route.requiredRoles || route.requiredRoles.every(role => principal.roles?.includes(role)));
      if (!eligible) { hiddenAliases.add(route.name); continue; }
      const targets = route.targets.filter(target => target.enabled !== false && upstreams.some(upstream => upstream.id === target.upstreamId));
      if (!targets.length) { hiddenAliases.add(route.name); continue; }
      let expected: string | undefined;
      for (const target of targets) {
        const index = upstreams.findIndex(upstream => upstream.id === target.upstreamId);
        const tool = index < 0 ? undefined : results[index]?.find(candidate => candidate.name === route.name);
        const fingerprint = tool?._meta?.['com.example.relay/contractFingerprint'];
        if (typeof fingerprint !== 'string') {
          hiddenAliases.add(route.name);
          await input.onRejected(target.upstreamId, route.name, new Error('Routed tool contract is unavailable on every eligible target'));
          break;
        }
        if (expected !== undefined && expected !== fingerprint) {
          hiddenAliases.add(route.name);
          await input.onRejected(target.upstreamId, route.name, new Error('Routed tool contracts differ across eligible targets'));
          break;
        }
        expected = fingerprint;
      }
    }
    return [...new Map(results.flat().filter(tool => !hiddenAliases.has(tool.name)).map(tool => [tool.name, tool])).values()];
  } finally { controller.abort(); }
}

const cursorSchema = z.object({ v: z.literal(1), offset: z.number().int().min(1).max(10000), etag: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export function catalogPage(tools: Tool[], cursor: string | undefined, pageSize: number, binding: unknown) {
  const etag = createHash('sha256').update(JSON.stringify([binding, tools])).digest('hex');
  let offset = 0;
  if (cursor !== undefined) {
    try {
      if (cursor.length > 512 || !/^[a-zA-Z0-9_-]+$/.test(cursor)) throw new Error();
      const value = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
      if (value.etag !== etag || value.offset >= tools.length) throw new Error();
      offset = value.offset;
    } catch { throw new InvalidCatalogCursor(); }
  }
  const end = offset + pageSize;
  return { tools: tools.slice(offset, end), ...(end < tools.length ? { nextCursor: Buffer.from(JSON.stringify({ v: 1, offset: end, etag })).toString('base64url') } : {}) };
}

export function searchCatalog(tools: Tool[], query: string) {
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  return tools.map(tool => {
    const name = tool.name.toLowerCase(), description = (tool.description ?? '').toLowerCase();
    if (!terms.every(term => name.includes(term) || description.includes(term))) return { tool, score: -1 };
    return { tool, score: terms.reduce((sum, term) => sum + (name.startsWith(term) ? 9 : name.includes(term) ? 3 : 1), 0) };
  }).filter(item => item.score >= 0).sort((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0)).map(item => item.tool);
}
