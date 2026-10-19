import express from 'express';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

export function createModernDemoServer(label: string) {
  const handler = createMcpHandler(() => {
    const server = new Server({ name: label, version: '1.0.0' }, { capabilities: { tools: {}, prompts: {}, resources: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'echo', description: 'Echo a message', inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 1000 } }, required: ['text'], additionalProperties: false } }] }));
    server.setRequestHandler('tools/call', async ({ params }) => ({ content: [{ type: 'text', text: `${label}: ${params.arguments?.text ?? ''}` }] }));
    server.setRequestHandler('prompts/list', async () => ({ prompts: [{ name: 'welcome', description: 'A welcome prompt' }] }));
    server.setRequestHandler('prompts/get', async () => ({ messages: [{ role: 'user', content: { type: 'text', text: `Welcome from ${label}` } }] }));
    server.setRequestHandler('resources/list', async () => ({ resources: [{ uri: 'notes://welcome', name: 'Welcome note', mimeType: 'text/plain' }] }));
    server.setRequestHandler('resources/read', async ({ params }) => ({ contents: [{ uri: params.uri, mimeType: 'text/plain', text: `${label} note` }] }));
    return server;
  });
  const app = express(); app.use(express.json());
  const node = toNodeHandler(handler);
  app.all('/mcp', (req, res) => void node(req, res, req.body));
  return app;
}
