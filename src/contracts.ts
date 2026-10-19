import { createHash } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/client';
import { InvalidToolArguments } from './tool-contracts.js';
import type { CatalogPolicy } from './invocation-policy.js';
import type { GatewayConfig } from './types.js';
export class CatalogDenied extends InvalidToolArguments {}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, ordered(value)]));
  return value;
}
/** Pin all published metadata, including descriptions and annotations, excluding the routed name. */
export function contractFingerprint(tool: Tool) {
  const { name: _name, ...contract } = tool;
  return createHash('sha256').update(JSON.stringify(ordered(contract))).digest('hex');
}
export function enforceContract(tool: Tool, expected?: string, policy?: CatalogPolicy) {
  if (policy?.requirePinned && !expected) throw new CatalogDenied('Tool definition requires administrator review and pinning');
  if (policy?.rejectControlCharacters) {
    const pending: unknown[] = [tool]; let count = 0;
    while (pending.length) {
      const value = pending.pop();
      if (++count > 10000) throw new CatalogDenied('Tool metadata exceeds review limits');
      if (typeof value === 'string' && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new CatalogDenied('Tool metadata contains unsafe display controls');
      if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) pending.push(key, child);
    }
  }
  const actual = contractFingerprint(tool);
  if (expected && actual !== expected) throw new CatalogDenied('Tool definition changed; administrator review is required');
  return actual;
}

/** A public alias never bypasses a pin on its physical target. */
export function enforceRoutedContract(tool: Tool, name: string, upstreamId: string, config: GatewayConfig) {
  const pins = config.toolContracts ?? {};
  const pin = (key: string) => Object.hasOwn(pins, key) ? pins[key] : undefined;
  const fingerprint = enforceContract(tool, pin(name), config.catalogPolicy);
  const physical = `${upstreamId}__${tool.name}`;
  if (physical !== name && pin(physical)) enforceContract(tool, pin(physical));
  return fingerprint;
}
