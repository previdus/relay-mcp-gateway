import { UriTemplate } from '@modelcontextprotocol/server';
export const resourceUri = (id: string, uri: string) => `mcp-gateway://${id}/${encodeURIComponent(uri)}`;
export function templateUri(id: string, template: string) {
  const variables = new UriTemplate(template).variableNames;
  return `mcp-gateway://${id}/template/${Buffer.from(template).toString('base64url')}${variables.length ? `{?${variables.map(name => `${name}*`).join(',')}}` : ''}`;
}
export function decodeResource(uri: string) {
  // Completion references carry the template itself, before its query expression is expanded.
  const url = new URL(uri.replace(/\{\?[^}]+\}$/, ''));
  if (url.protocol !== 'mcp-gateway:' || url.username || url.password || url.hash) throw new Error('Invalid resource URI');
  if (url.pathname.startsWith('/template/')) {
    const template = Buffer.from(url.pathname.slice('/template/'.length), 'base64url').toString();
    const engine = new UriTemplate(template); const values: Record<string, string | string[]> = {};
    for (const name of engine.variableNames) { const all = url.searchParams.getAll(name); if (all.length) values[name] = all.length === 1 ? all[0] : all; }
    return { id: url.hostname, original: engine.expand(values), template };
  }
  if (url.search) throw new Error('Invalid resource URI');
  return { id: url.hostname, original: decodeURIComponent(url.pathname.slice(1)), template: undefined };
}
function content(value: unknown, upstream: string): unknown {
  if (!value || typeof value !== 'object') return value;
  const block = value as Record<string, unknown>;
  if (block.type === 'resource_link' && typeof block.uri === 'string') return { ...block, uri: resourceUri(upstream, block.uri) };
  if (block.type === 'resource' && block.resource && typeof block.resource === 'object' && 'uri' in block.resource && typeof block.resource.uri === 'string') return { ...block, resource: { ...block.resource, uri: resourceUri(upstream, block.resource.uri) } };
  return value;
}
export function rewriteResourceLinks<T>(result: T, upstream: string): T {
  const object = result as Record<string, unknown>;
  return { ...object,
    ...(Array.isArray(object.content) ? { content: object.content.map(value => content(value, upstream)) } : {}),
    ...(Array.isArray(object.messages) ? { messages: object.messages.map(message => ({ ...message, content: content(message.content, upstream) })) } : {})
  } as T;
}
