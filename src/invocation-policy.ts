import { z } from 'zod';
import type { ServiceClient } from './types.js';

const scalar = z.union([z.string().max(2048), z.number().finite(), z.boolean(), z.null()]);
const field = z.array(z.string().min(1).max(128)).min(1).max(16);
export const constraintSchema = z.discriminatedUnion('op', [
  z.object({ field, op: z.literal('equals'), value: scalar }).strict(),
  z.object({ field, op: z.literal('oneOf'), values: z.array(scalar).min(1).max(100) }).strict(),
  z.object({ field, op: z.literal('numberRange'), min: z.number().finite().optional(), max: z.number().finite().optional() }).strict(),
  z.object({ field, op: z.literal('matchesIdentity'), claim: z.enum(['id', 'tenantId', 'subject']) }).strict()
]);
const constraint = constraintSchema.refine(c => c.op !== 'numberRange' || (c.min !== undefined || c.max !== undefined) && (c.min === undefined || c.max === undefined || c.min <= c.max));
const ruleSchema = z.object({ clients: z.array(z.string().min(1).max(128)).min(1).max(100).optional(), constraints: z.array(constraint).min(1).max(32) }).strict();
export const invocationPoliciesSchema = z.record(z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/), z.object({
  allow: z.array(ruleSchema).max(32),
  deny: z.array(ruleSchema).max(32).optional()
}).strict()).refine(policies => Object.keys(policies).length <= 1000);
export const catalogPolicySchema = z.object({ requirePinned: z.boolean().optional(), rejectControlCharacters: z.boolean().optional() }).strict();
export type InvocationPolicies = z.infer<typeof invocationPoliciesSchema>;
export type CatalogPolicy = z.infer<typeof catalogPolicySchema>;
export class InvocationDenied extends Error {
  constructor() { super('Tool invocation forbidden by argument policy'); }
}

function atField(args: unknown, path: string[]): unknown {
  let value = args;
  for (const key of path) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
/** Policies only narrow existing grants. Both alias and physical policies must allow the call. */
export function enforceInvocation(policies: InvocationPolicies | undefined, names: string[], principal: ServiceClient, args: unknown) {
  for (const name of new Set(names)) {
    if (!policies || !Object.hasOwn(policies, name)) continue;
    const policy = policies[name]!;
    const matches = (rule: z.infer<typeof ruleSchema>) => (!rule.clients || rule.clients.includes(principal.id)) && rule.constraints.every(c => {
      const value = atField(args, c.field);
      switch (c.op) {
        case 'equals': return value === c.value;
        case 'oneOf': return c.values.some(candidate => value === candidate);
        case 'numberRange': return typeof value === 'number' && Number.isFinite(value) && (c.min === undefined || value >= c.min) && (c.max === undefined || value <= c.max);
        case 'matchesIdentity': return typeof principal[c.claim] === 'string' && value === principal[c.claim];
      }
    });
    if (policy.deny?.some(matches) || !policy.allow.some(matches)) throw new InvocationDenied();
  }
}
