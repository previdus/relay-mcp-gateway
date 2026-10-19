import { ProtocolError, ProtocolErrorCode, type Server, type Resource, type Prompt, type ServerContext, type ResourceTemplateType } from '@modelcontextprotocol/server';
import type { Client } from '@modelcontextprotocol/client';
import type { GatewayConfig, Upstream, ServiceClient } from './types.js';
import type { Authorizer, AccessAction } from './plugins.js';
import { ContinuationCodec, callBinding, stateFor, wrapInput } from './continuations.js';
import { resourceUri, templateUri, decodeResource, rewriteResourceLinks } from './resource-names.js';

type RequestOptions = { signal: AbortSignal; timeout: number };
export type UpstreamExecutor = <T>(upstream: Upstream, operation: (client: Client, options: RequestOptions) => Promise<T>, signal?: AbortSignal, bridge?: { principal: ServiceClient; ctx: ServerContext }) => Promise<T>;
export { resourceUri } from './resource-names.js';
export function registerFeatures(server: Server, config: GatewayConfig, principal: ServiceClient, authorizer: Authorizer, executor: UpstreamExecutor, onDenied: () => void = () => {}, codec?: ContinuationCodec) {
  const execute: UpstreamExecutor = async (upstream, operation, signal, bridge) => { try { return await executor(upstream, operation, signal, bridge); } catch (error) { if (error instanceof ProtocolError) throw error; throw new ProtocolError(ProtocolErrorCode.InternalError, 'Upstream feature request failed'); } };
  const allowed = async (action: AccessAction, name: string) => { try { return authorizer.canAccess ? await authorizer.canAccess(principal, action, name) : false; } catch { return false; } };
  const deny = () => { onDenied(); return new ProtocolError(ProtocolErrorCode.InvalidParams, 'Feature unavailable or forbidden'); };
  function splitName(name: string) {
    const upstream = config.upstreams.find(u => name.startsWith(`${u.id}__`));
    if (!upstream) throw deny();
    return { upstream, name: name.slice(upstream.id.length + 2) };
  }
  if (config.features?.prompts) {
    server.setRequestHandler('prompts/list', async (_request, ctx) => {
      const prompts: Prompt[] = [];
      // Fail rather than silently claiming a complete prompt catalog when an upstream fails.
      for (const upstream of config.upstreams) {
        const results = await execute(upstream, async (client, options) => {
          if (!client.getServerCapabilities()?.prompts) return [];
          const results: Prompt[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
          do {
            const page = await client.listPrompts(cursor ? { cursor } : {}, options);
            for (const prompt of page.prompts) {
              const name = `${upstream.id}__${prompt.name}`;
              if (await allowed('prompts/get', name)) results.push({ ...prompt, name });
            }
            cursor = page.nextCursor;
            if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error('Invalid pagination');
            if (cursor) cursors.add(cursor);
          } while (cursor);
          return results;
        }, ctx.mcpReq.signal);
        prompts.push(...results);
      }
      return { prompts };
    });
    server.setRequestHandler('prompts/get', async ({ params }, ctx) => {
      if (!await allowed('prompts/get', params.name)) throw deny();
      const route = splitName(params.name);
      const binding = callBinding('prompts/get', params.name, params.arguments ?? {}), state = stateFor(ctx, codec, principal, binding);
      if (state && (state.upstreamId !== route.upstream.id || state.upstreamTool !== route.name)) throw deny();
      return execute(route.upstream, async (client, options) => {
        const result = await client.request({ method: 'prompts/get', params: { name: route.name, arguments: params.arguments, ...(ctx.mcpReq.inputResponses ? { inputResponses: ctx.mcpReq.inputResponses } : {}), ...(state?.state ? { requestState: state.state } : {}) } }, { ...options, allowInputRequired: true });
        return wrapInput(result, { codec, principal, ctx, binding, upstreamId: route.upstream.id, upstreamTool: route.name, rounds: state?.rounds }) ?? (config.features?.resources ? rewriteResourceLinks(result, route.upstream.id) : result);
      }, ctx.mcpReq.signal, { principal, ctx });
    });
  }
  if (config.features?.resources) {
    server.setRequestHandler('resources/templates/list', async (_request, ctx) => {
      const resourceTemplates: ResourceTemplateType[] = [];
      for (const upstream of config.upstreams) resourceTemplates.push(...await execute(upstream, async (client, options) => {
        if (!client.getServerCapabilities()?.resources) return [];
        const results: ResourceTemplateType[] = []; const seen = new Set<string>(); let cursor: string | undefined;
        do {
          const page = await client.listResourceTemplates(cursor ? { cursor } : {}, options);
          for (const template of page.resourceTemplates) if (await allowed('resources/read', `${upstream.id}__${template.uriTemplate}`)) results.push({ ...template, uriTemplate: templateUri(upstream.id, template.uriTemplate) });
          cursor = page.nextCursor;
          if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new Error('Invalid pagination');
          if (cursor) seen.add(cursor);
        } while (cursor);
        return results;
      }, ctx.mcpReq.signal));
      return { resourceTemplates };
    });
    server.setRequestHandler('resources/list', async (_request, ctx) => {
      const resources: Resource[] = [];
      for (const upstream of config.upstreams) {
        resources.push(...await execute(upstream, async (client, options) => {
          if (!client.getServerCapabilities()?.resources) return [];
          const results: Resource[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
          do {
            const page = await client.listResources(cursor ? { cursor } : {}, options);
            for (const resource of page.resources) {
              if (await allowed('resources/read', `${upstream.id}__${resource.uri}`)) results.push({ ...resource, uri: resourceUri(upstream.id, resource.uri) });
            }
            cursor = page.nextCursor;
            if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error('Invalid pagination');
            if (cursor) cursors.add(cursor);
          } while (cursor);
          return results;
        }, ctx.mcpReq.signal));
      }
      return { resources };
    });
    server.setRequestHandler('resources/read', async ({ params }, ctx) => {
      let decoded: ReturnType<typeof decodeResource>;
      try { decoded = decodeResource(params.uri); } catch { throw deny(); }
      const upstream = config.upstreams.find(u => u.id === decoded.id);
      if (!upstream || !await allowed('resources/read', `${upstream.id}__${decoded.template ?? decoded.original}`)) throw deny();
      const binding = callBinding('resources/read', params.uri, {}), state = stateFor(ctx, codec, principal, binding);
      if (state && (state.upstreamId !== upstream.id || state.upstreamTool !== decoded.original)) throw deny();
      return execute(upstream, async (client, options) => {
        const result = await client.request({ method: 'resources/read', params: { uri: decoded.original, ...(ctx.mcpReq.inputResponses ? { inputResponses: ctx.mcpReq.inputResponses } : {}), ...(state?.state ? { requestState: state.state } : {}) } }, { ...options, allowInputRequired: true });
        const pending = wrapInput(result, { codec, principal, ctx, binding, upstreamId: upstream.id, upstreamTool: decoded.original, rounds: state?.rounds });
        return pending ?? { ...result, contents: result.contents.map(content => ({ ...content, uri: resourceUri(upstream.id, content.uri) })) };
      }, ctx.mcpReq.signal, { principal, ctx });
    });
  }
  if (config.features?.prompts || config.features?.resources) server.setRequestHandler('completion/complete', async ({ params }, ctx) => {
    let upstream: Upstream | undefined; let ref = params.ref;
    if (ref.type === 'ref/prompt') {
      if (!await allowed('prompts/get', ref.name)) throw deny();
      const route = splitName(ref.name); upstream = route.upstream; ref = { ...ref, name: route.name };
    } else {
      let decoded: ReturnType<typeof decodeResource>;
      try { decoded = decodeResource(ref.uri); } catch { throw deny(); }
      upstream = config.upstreams.find(u => u.id === decoded.id);
      if (!upstream || !await allowed('resources/read', `${upstream.id}__${decoded.template ?? decoded.original}`)) throw deny();
      ref = { ...ref, uri: decoded.template ?? decoded.original };
    }
    return execute(upstream, (client, options) => client.complete({ ...params, ref }, options), ctx.mcpReq.signal);
  });
}
