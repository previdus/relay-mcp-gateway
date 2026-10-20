import { z } from 'zod';

export type CredentialPurpose = 'upstream' | 'upstream-endpoint' | 'upstream-tls' | 'oauth-token' | 'oauth-recipient' | 'oauth-token-tls' | 'stdio-environment' | 'authorization-service' | 'routing-service' | 'inspection-service' | 'approval-service' | 'telemetry-endpoint' | 'telemetry-export' | 'telemetry-client-identity' | 'database';
export interface CredentialBindingPolicy {
  assertAllowed(reference: string, endpoint: string, purpose: CredentialPurpose): void;
}
const bindingSchema = z.array(z.object({
  reference: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  endpoint: z.string().url().max(2048),
  purpose: z.enum(['upstream', 'upstream-endpoint', 'upstream-tls', 'oauth-token', 'oauth-recipient', 'oauth-token-tls', 'stdio-environment', 'authorization-service', 'routing-service', 'inspection-service', 'approval-service', 'telemetry-endpoint', 'telemetry-export', 'telemetry-client-identity', 'database'])
}).strict()).max(10000);
function canonical(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:', 'stdio:', 'postgres:', 'postgresql:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid credential destination');
  return url.href;
}
/** Deployment-owned policy: never load this from the editable gateway document. */
export class ExactCredentialBindings implements CredentialBindingPolicy {
  private readonly allowed = new Set<string>();
  constructor(document: unknown) {
    const result = bindingSchema.safeParse(document);
    if (!result.success) throw new Error('Invalid deployment credential bindings');
    for (const binding of result.data) this.allowed.add(JSON.stringify([binding.reference, binding.purpose, canonical(binding.endpoint)]));
  }
  assertAllowed(reference: string, endpoint: string, purpose: CredentialPurpose) {
    if (!this.allowed.has(JSON.stringify([reference, purpose, canonical(endpoint)]))) throw new Error('Credential destination is not approved by deployment policy');
  }
}
export function environmentCredentialBindings(env: NodeJS.ProcessEnv): CredentialBindingPolicy | undefined {
  const raw = env.GATEWAY_CREDENTIAL_BINDINGS;
  if (raw === undefined) return undefined; // Explicit opt-in for existing deployments.
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Invalid deployment credential bindings');
  let document: unknown;
  try { document = JSON.parse(raw); } catch { throw new Error('Invalid deployment credential bindings'); }
  return new ExactCredentialBindings(document);
}
