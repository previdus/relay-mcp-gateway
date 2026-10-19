import type { Client, Tool } from '@modelcontextprotocol/client';
import { schemaPool } from './schema-pool.js';

export class InvalidToolArguments extends Error {}
function boundStructure(value: unknown, limit: number, maximumDepth: number, schema = false) {
  const pending = [{ value, depth: 0 }]; let count = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++count > limit || current.depth > maximumDepth) throw new Error('Structure exceeds validation limits');
    if (typeof current.value === 'object' && current.value !== null) {
      for (const [name, value] of Object.entries(current.value)) {
        if (schema && name === '$ref' && typeof value === 'string' && !value.startsWith('#')) throw new Error('External schema references are disabled');
        pending.push({ value, depth: current.depth + 1 });
      }
    }
  }
}
export async function findToolDefinitionWithHints(client: Client, name: string, options: { signal: AbortSignal; timeout: number }, budget?: { maxScannedTools?: number; maxBytes?: number }) {
  const cursors = new Set<string>(); let cursor: string | undefined; let tool: Tool | undefined;
  let ttlMs: number | undefined, cacheScope: 'public' | 'private' | undefined;
  let scanned = 0, bytes = 0;
  do {
    const page = await client.request({ method: 'tools/list', params: cursor ? { cursor } : {} }, options);
    scanned += page.tools.length; bytes += Buffer.byteLength(JSON.stringify(page.tools));
    if (scanned > (budget?.maxScannedTools ?? 10000) || bytes > (budget?.maxBytes ?? 1024 * 1024)) throw new InvalidToolArguments('Tool lookup exceeds discovery limits');
    tool = page.tools.find(tool => tool.name === name);
    if (tool) {
      const cacheable = page as typeof page & { ttlMs?: unknown; cacheScope?: unknown };
      if (typeof cacheable.ttlMs === 'number' && Number.isSafeInteger(cacheable.ttlMs) && cacheable.ttlMs >= 0) ttlMs = cacheable.ttlMs;
      if (cacheable.cacheScope === 'public' || cacheable.cacheScope === 'private') cacheScope = cacheable.cacheScope;
      break;
    }
    cursor = page.nextCursor;
    if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error('Invalid tool catalog pagination');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (!tool) throw new InvalidToolArguments('Tool unavailable');
  return { tool, ...(ttlMs !== undefined ? { ttlMs } : {}), ...(cacheScope ? { cacheScope } : {}) };
}
export async function findToolDefinition(client: Client, name: string, options: { signal: AbortSignal; timeout: number }, budget?: { maxScannedTools?: number; maxBytes?: number }) {
  return (await findToolDefinitionWithHints(client, name, options, budget)).tool;
}
export async function checkToolArguments(client: Client, name: string, args: Record<string, unknown>, options: { signal: AbortSignal; timeout: number }, budget?: { maxScannedTools?: number; maxBytes?: number }) {
  const tool = await findToolDefinition(client, name, options, budget);
  boundStructure(tool.inputSchema, 2048, 32, true);
  try { boundStructure(args, 10000, 64); } catch { throw new InvalidToolArguments('Arguments exceed validation limits'); }
  const validation = await schemaPool.validate(tool.inputSchema, args);
  if (validation.invalidSchema) throw new Error('Tool schema is unsupported or validation exceeded its budget');
  if (!validation.valid) throw new InvalidToolArguments('Arguments do not match the tool input schema');
  return tool;
}
