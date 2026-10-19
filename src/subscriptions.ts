import { InMemoryServerEventBus, type ServerEvent, type SubscriptionFilter } from '@modelcontextprotocol/server';
import { resourceUri, decodeResource } from './resource-names.js';
import type { GatewayConfig, ServiceClient } from './types.js';
import type { Authorizer } from './plugins.js';
import type { UpstreamExecutor } from './features.js';

export async function validateSubscription(filter: SubscriptionFilter, config: GatewayConfig, principal: ServiceClient, authorizer: Authorizer) {
  for (const uri of filter.resourceSubscriptions ?? []) {
    const decoded = decodeResource(uri);
    if (!config.upstreams.some(upstream => upstream.id === decoded.id) || !authorizer.canAccess || !await authorizer.canAccess(principal, 'resources/read', `${decoded.id}__${decoded.template ?? decoded.original}`)) throw new Error('Subscription resource denied');
  }
}
export function relaySubscriptions(options: {
  config: GatewayConfig; principal: ServiceClient; filter: SubscriptionFilter; authorizer: Authorizer;
  bus: InMemoryServerEventBus; execute: UpstreamExecutor; signal: AbortSignal;
  current?: () => Promise<boolean>; close: () => void;
}) {
  const emit = async (event: ServerEvent) => {
    if (options.signal.aborted) return;
    if (options.current && !await options.current().catch(() => false)) { options.close(); return; }
    if (event.kind === 'resource_updated') {
      const decoded = decodeResource(event.uri);
      if (!options.authorizer.canAccess || !await options.authorizer.canAccess(options.principal, 'resources/read', `${decoded.id}__${decoded.original}`)) return;
    }
    options.bus.publish(event);
  };
  return Promise.allSettled(options.config.upstreams.map(upstream => options.execute(upstream, async (client, request) => {
    const resources = (options.filter.resourceSubscriptions ?? []).map(decodeResource).filter(resource => resource.id === upstream.id).map(resource => resource.original);
    client.setNotificationHandler('notifications/tools/list_changed', () => options.filter.toolsListChanged ? emit({ kind: 'tools_list_changed' }) : Promise.resolve());
    client.setNotificationHandler('notifications/prompts/list_changed', () => options.filter.promptsListChanged ? emit({ kind: 'prompts_list_changed' }) : Promise.resolve());
    client.setNotificationHandler('notifications/resources/list_changed', () => options.filter.resourcesListChanged ? emit({ kind: 'resources_list_changed' }) : Promise.resolve());
    client.setNotificationHandler('notifications/resources/updated', ({ params }) => resources.includes(params.uri) ? emit({ kind: 'resource_updated', uri: resourceUri(upstream.id, params.uri) }) : Promise.resolve());
    const capabilities = client.getServerCapabilities();
    if (client.getProtocolEra() === 'modern') {
      await client.listen({ toolsListChanged: Boolean(options.filter.toolsListChanged && capabilities?.tools?.listChanged), promptsListChanged: Boolean(options.filter.promptsListChanged && capabilities?.prompts?.listChanged), resourcesListChanged: Boolean(options.filter.resourcesListChanged && capabilities?.resources?.listChanged), resourceSubscriptions: capabilities?.resources?.subscribe ? resources : [] }, request);
    } else if (capabilities?.resources?.subscribe) {
      for (const uri of resources) await client.subscribeResource({ uri }, request);
    }
    await new Promise<void>(resolve => { if (request.signal.aborted) resolve(); else request.signal.addEventListener('abort', () => resolve(), { once: true }); });
  }, options.signal)));
}
