import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const endpoint = option('--url') ?? process.env.MCP_DEMO_URL ?? 'http://127.0.0.1:3000/mcp';
const token = option('--token') ?? process.env.MCP_DEMO_TOKEN;
const tool = option('--tool');
const rawArguments = option('--args') ?? '{}';
const listOnly = process.argv.includes('--list');
if (!token || token.length < 12) throw new Error('Set MCP_DEMO_TOKEN or pass --token with a demo service credential.');
if (!tool && !listOnly) throw new Error('Choose --list or provide --tool <name> [--args <json>].');
let args;
try { args = JSON.parse(rawArguments); }
catch { throw new Error('--args must contain valid JSON.'); }
if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('--args must be a JSON object.');

const client = new Client({ name: 'relay-demo-cli', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
try {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  if (listOnly) {
    const result = await client.listTools();
    process.stdout.write(`${JSON.stringify(result.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), null, 2)}\n`);
  } else {
    const result = await client.callTool({ name: tool, arguments: args });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.isError) process.exitCode = 2;
  }
} catch (error) {
  const message = error instanceof Error ? error.message.slice(0, 500) : 'MCP request failed';
  process.stderr.write(`MCP request failed: ${message}\n`);
  process.exitCode = 2;
} finally {
  await client.close().catch(() => {});
}
