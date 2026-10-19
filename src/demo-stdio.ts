import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
serveStdio(() => {
  const server = new Server({ name: 'stdio-fixture', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }));
  server.setRequestHandler('tools/call', async ({ params }) => ({ content: [{ type: 'text', text: JSON.stringify({ text: params.arguments?.text, explicit: process.env.EXPLICIT_SECRET, inherited: Boolean(process.env.NOT_ALLOWED_PARENT_SECRET) }) }] }));
  return server;
});
