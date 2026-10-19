import type { GatewayConfig, ServiceClient, Upstream } from './types.js';
export const tenantId = (value: { tenantId?: string }) => value.tenantId ?? 'default';
export const sameTenant = (client: ServiceClient, upstream: Upstream) => tenantId(client) === tenantId(upstream);
export function tenantConfig(config: GatewayConfig, client: ServiceClient): GatewayConfig {
  const upstreams = config.upstreams.filter(upstream => sameTenant(client, upstream));
  const ids = new Set(upstreams.map(upstream => upstream.id));
  return { ...config, upstreams, routes: config.routes?.filter(route => route.targets.every(target => ids.has(target.upstreamId))) };
}
