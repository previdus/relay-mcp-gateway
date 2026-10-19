import { StreamableHTTPClientTransport, SSEClientTransport, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { closeEgressFetch, upstreamFetch, type EgressPolicy } from './egress.js';
import type { Upstream } from './types.js';
export function createUpstreamTransport(upstream: Upstream, headers: Record<string, string>, maxBytes?: number, egress?: EgressPolicy): Transport {
  if (upstream.transport === 'stdio') {
    const transport = new StdioClientTransport({ command: upstream.command!, args: upstream.args ?? [], env: upstream.environment ?? {}, stderr: 'pipe' });
    // Drain stderr without forwarding credentials or arbitrary server logs into gateway audit output.
    transport.stderr?.on('data', () => {}); return transport;
  }
  const paths = upstream.requestPaths ?? (upstream.transport === 'sse' ? undefined : [new URL(upstream.url).pathname]);
  const guardedFetch = upstreamFetch(upstream.url, maxBytes, paths, egress);
  const options = { requestInit: { headers, redirect: 'error' as const }, fetch: guardedFetch };
  const transport = upstream.transport === 'sse' ? new SSEClientTransport(new URL(upstream.url), options) : new StreamableHTTPClientTransport(new URL(upstream.url), options);
  if (egress) {
    const close = transport.close.bind(transport);
    transport.close = async () => { try { await close(); } finally { await closeEgressFetch(guardedFetch); } };
  }
  return transport;
}
