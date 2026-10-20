import express from 'express';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Tool } from '@modelcontextprotocol/client';

/** Safe, deterministic stand-ins for common enterprise MCP integrations.
 * These servers never call vendor APIs or mutate real accounts.
 */
export type DemoIntegration = 'jira' | 'aws' | 'gmail' | 'slack' | 'drive' | 'logs';
const searchSchema: Tool['inputSchema'] = { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['query'], additionalProperties: false };
const definitions = {
  jira: [
    { name: 'search', description: 'Search across demo enterprise records', inputSchema: searchSchema },
    { name: 'create_issue', description: 'Preview creation of a Jira issue (demo only)', inputSchema: { type: 'object', properties: { project: { type: 'string', maxLength: 32 }, summary: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['project', 'summary'], additionalProperties: false } }
  ],
  aws: [
    { name: 'search', description: 'Search across demo enterprise records', inputSchema: searchSchema },
    { name: 'cloudwatch_logs', description: 'Read sample CloudWatch-style log events', inputSchema: { type: 'object', properties: { logGroup: { type: 'string', maxLength: 128 }, contains: { type: 'string', maxLength: 128 } }, required: ['logGroup'], additionalProperties: false } }
  ],
  gmail: [
    { name: 'search', description: 'Search across demo enterprise records', inputSchema: searchSchema },
    { name: 'create_draft', description: 'Preview a Gmail draft (does not send email)', inputSchema: { type: 'object', properties: { to: { type: 'string', maxLength: 254 }, subject: { type: 'string', maxLength: 200 }, body: { type: 'string', maxLength: 4000 } }, required: ['to', 'subject', 'body'], additionalProperties: false } }
  ],
  slack: [
    { name: 'search', description: 'Search across demo enterprise records', inputSchema: searchSchema },
    { name: 'post_message', description: 'Preview posting a Slack message (does not post)', inputSchema: { type: 'object', properties: { channel: { type: 'string', maxLength: 80 }, text: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['channel', 'text'], additionalProperties: false } }
  ],
  drive: [
    { name: 'search', description: 'Search across demo enterprise records', inputSchema: searchSchema },
    { name: 'read_file', description: 'Read a sample Drive file by ID', inputSchema: { type: 'object', properties: { fileId: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['fileId'], additionalProperties: false } }
  ],
  logs: [
    { name: 'search', description: 'Search across demo enterprise records', inputSchema: searchSchema },
    { name: 'query', description: 'Query sample logs by service and severity', inputSchema: { type: 'object', properties: { service: { type: 'string', maxLength: 80 }, severity: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] } }, required: ['service'], additionalProperties: false } }
  ]
} satisfies Record<DemoIntegration, Tool[]>;

export function createDemoIntegrationServer(integration: DemoIntegration) {
  const serverFactory = () => {
    const server = new Server({ name: `relay-demo-${integration}`, version: '1.0.0' }, { capabilities: { tools: {}, prompts: {}, resources: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: [...definitions[integration]] }));
    server.setRequestHandler('tools/call', async ({ params }) => {
      const args = params.arguments ?? {};
      const query = typeof args.query === 'string' ? args.query : '';
      let value: Record<string, unknown>;
      switch (`${integration}:${params.name}`) {
        case 'jira:search': value = { source: 'jira-demo', query, issues: [{ key: 'OPS-42', summary: 'Rotate integration credentials', status: 'In Progress' }] }; break;
        case 'jira:create_issue': value = { source: 'jira-demo', preview: true, issueKey: 'DEMO-101', project: args.project, summary: args.summary }; break;
        case 'aws:search': value = { source: 'aws-demo', query, resources: ['demo-api', 'demo-worker'], region: 'us-east-1' }; break;
        case 'aws:cloudwatch_logs': value = { source: 'aws-demo', logGroup: args.logGroup, events: [{ timestamp: '2026-10-20T10:00:00Z', message: 'request completed', severity: 'info' }] }; break;
        case 'gmail:search': value = { source: 'gmail-demo', query, messages: [{ id: 'mail-1', subject: 'Quarterly access review', from: 'security@example.test' }] }; break;
        case 'gmail:create_draft': value = { source: 'gmail-demo', preview: true, draftId: 'draft-demo-1', to: args.to, subject: args.subject }; break;
        case 'slack:search': value = { source: 'slack-demo', query, messages: [{ channel: 'incidents', user: 'oncall-bot', text: 'Database latency returned to normal.' }] }; break;
        case 'slack:post_message': value = { source: 'slack-demo', preview: true, channel: args.channel, accepted: true }; break;
        case 'drive:search': value = { source: 'drive-demo', query, files: [{ id: 'file-7', name: 'Incident runbook', mimeType: 'text/markdown' }] }; break;
        case 'drive:read_file': value = { source: 'drive-demo', fileId: args.fileId, content: 'Demo runbook: check service health, then inspect recent logs.' }; break;
        case 'logs:search': value = { source: 'logs-demo', query, entries: [{ service: 'gateway', severity: 'info', message: 'tool call authorized' }] }; break;
        case 'logs:query': value = { source: 'logs-demo', service: args.service, severity: args.severity ?? 'info', entries: [{ timestamp: '2026-10-20T10:01:00Z', message: 'sample log event' }] }; break;
        default: return { content: [{ type: 'text', text: 'Unknown demo tool' }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    });
    server.setRequestHandler('prompts/list', async () => ({ prompts: [{ name: 'triage_incident', description: `Build an incident context from ${integration} demo data` }] }));
    server.setRequestHandler('prompts/get', async ({ params }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Use the ${integration} demo tools to investigate: ${JSON.stringify(params.arguments ?? {})}` } }] }));
    const uri = `${integration}://demo/overview`;
    server.setRequestHandler('resources/list', async () => ({ resources: [{ uri, name: `${integration} demo overview`, mimeType: 'text/plain' }] }));
    server.setRequestHandler('resources/read', async ({ params }) => ({ contents: [{ uri: params.uri, mimeType: 'text/plain', text: `${integration} connector is a local simulation. No vendor account or production data is accessed.` }] }));
    return server;
  };
  const handler = createMcpHandler(serverFactory);
  const node = toNodeHandler(handler);
  const app = express(); app.use(express.json({ limit: '1mb' }));
  app.all('/mcp', (req, res) => void node(req, res, req.body));
  return app;
}
