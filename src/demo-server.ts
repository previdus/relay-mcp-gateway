import express from 'express';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

export function createDemoServer(label: string, onRequest?: (method: unknown) => void, options: { toolListTtlMs?: number } = {}) {
  const handler = createMcpHandler(() => {
    const server = new Server({ name: label, version: '0.1.0' }, {
      capabilities: { tools: {} },
      ...(options.toolListTtlMs !== undefined ? { cacheHints: { 'tools/list': { ttlMs: options.toolListTtlMs, cacheScope: 'private' } } } : {}),
    });
    server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'echo', description: 'Echo a message', inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 1000 } }, required: ['text'], additionalProperties: false } }] }));
    server.setRequestHandler('tools/call', async ({ params }) => {
      const text = params.arguments?.text;
      if (typeof text !== 'string' || text.length > 1000 || Object.keys(params.arguments ?? {}).some(key => key !== 'text')) return { content: [{ type: 'text', text: 'Invalid echo input' }], isError: true };
      return { content: [{ type: 'text', text: `${label}: ${text}` }] };
    });
    return server;
  });
  const app = express();
  app.use(express.json());
  app.use('/mcp', (req, _res, next) => { onRequest?.(req.body?.method); next(); });
  const node = toNodeHandler(handler);
  app.all('/mcp', (req, res) => void node(req, res, req.body));
  return app;
}
