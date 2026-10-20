import express from 'express';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Tool } from '@modelcontextprotocol/client';

/** Safe, deterministic stand-ins for common enterprise MCP integrations.
 * These servers never call vendor APIs or mutate real accounts.
 */
export type DemoIntegration = 'jira' | 'aws' | 'gmail' | 'slack' | 'drive' | 'logs' | 'github' | 'calendar' | 'database' | 'observability';
/** Linked, synthetic incident-response records shared across the demo MCPs. */
const records = {
  jira: [
    { key: 'OPS-204', summary: 'Checkout API elevated error rate', status: 'Investigating', labels: ['incident', 'checkout'], service: 'checkout-api' },
    { key: 'SEC-118', summary: 'Rotate integration credentials', status: 'In Progress', labels: ['security', 'credentials'], service: 'gateway' },
    { key: 'OPS-197', summary: 'Worker queue latency after deploy', status: 'Resolved', labels: ['incident', 'queue'], service: 'demo-worker' },
    { key: 'CHG-042', summary: 'Planned certificate rotation', status: 'Scheduled', labels: ['change', 'mtls'], service: 'gateway' }
  ],
  aws: [
    { id: 'i-demo-api', name: 'demo-api', region: 'us-east-1', service: 'checkout-api', environment: 'demo' },
    { id: 'i-demo-worker', name: 'demo-worker', region: 'us-west-2', service: 'demo-worker', environment: 'demo' },
    { id: 'db-demo-01', name: 'demo-orders', region: 'us-east-1', service: 'checkout-api', environment: 'demo' }
  ],
  gmail: [
    { id: 'mail-204', subject: 'Checkout incident update', from: 'oncall@example.test', labels: ['incident', 'checkout'], snippet: 'Error rate is elevated in us-east-1; investigation is ongoing.' },
    { id: 'mail-118', subject: 'Credential rotation window', from: 'security@example.test', labels: ['security', 'credentials'], snippet: 'Rotate the demo integration credential during the approved window.' },
    { id: 'mail-197', subject: 'Queue latency resolved', from: 'platform@example.test', labels: ['incident', 'queue'], snippet: 'Worker backlog returned to normal after the rollback.' }
  ],
  slack: [
    { id: 'msg-204', channel: 'incidents', user: 'oncall-bot', text: 'OPS-204: checkout-api errors increased after the 10:00 UTC deploy.', labels: ['incident', 'checkout'] },
    { id: 'msg-118', channel: 'security-ops', user: 'security-bot', text: 'SEC-118: schedule credential rotation; do not paste secrets into chat.', labels: ['security', 'credentials'] },
    { id: 'msg-197', channel: 'platform', user: 'release-bot', text: 'OPS-197: queue latency cleared after rollback.', labels: ['incident', 'queue'] }
  ],
  drive: [
    { id: 'runbook-checkout', name: 'Checkout incident runbook', mimeType: 'text/markdown', labels: ['incident', 'checkout'], content: '1. Confirm the alert. 2. Inspect checkout-api logs. 3. Check the last deployment. 4. Escalate before changing production.' },
    { id: 'runbook-mtls', name: 'Certificate rotation checklist', mimeType: 'text/markdown', labels: ['security', 'credentials', 'mtls'], content: 'Verify issuer and SAN, install the new certificate, test mutual TLS, then revoke the old certificate after the overlap window.' },
    { id: 'runbook-queue', name: 'Worker queue recovery', mimeType: 'text/markdown', labels: ['incident', 'queue'], content: 'Check queue depth, compare worker versions, and prefer a reviewed rollback over an unapproved replay.' }
  ],
  logs: [
    { id: 'log-204a', timestamp: '2026-10-20T10:02:11Z', service: 'checkout-api', severity: 'error', message: 'upstream timeout while reading order record', labels: ['incident', 'checkout'] },
    { id: 'log-204b', timestamp: '2026-10-20T10:02:13Z', service: 'checkout-api', severity: 'warn', message: 'retry budget nearly exhausted', labels: ['incident', 'checkout'] },
    { id: 'log-118', timestamp: '2026-10-20T09:40:00Z', service: 'gateway', severity: 'info', message: 'mTLS certificate expires in 14 days', labels: ['security', 'credentials', 'mtls'] },
    { id: 'log-197', timestamp: '2026-10-20T09:15:44Z', service: 'demo-worker', severity: 'info', message: 'queue depth returned below recovery threshold', labels: ['incident', 'queue'] },
    { id: 'log-401', timestamp: '2026-10-20T10:03:00Z', service: 'gateway', severity: 'warn', message: 'unauthorized tool call rejected before upstream dispatch', labels: ['security', 'authorization'] }
  ],
  github: [
    { id: 'PR-204', repository: 'acme/checkout', title: 'Add bounded upstream retry budget', status: 'open', labels: ['incident', 'checkout'], author: 'demo-bot' },
    { id: 'PR-118', repository: 'acme/gateway', title: 'Rotate demo certificate binding', status: 'review', labels: ['security', 'credentials'], author: 'platform-demo' }
  ],
  calendar: [
    { id: 'event-204', title: 'Checkout incident review', start: '2026-10-20T14:00:00Z', owner: 'platform@example.test', labels: ['incident', 'checkout'] },
    { id: 'event-118', title: 'Certificate rotation window', start: '2026-10-21T09:00:00Z', owner: 'security@example.test', labels: ['security', 'credentials', 'mtls'] }
  ],
  database: [
    { id: 'order-demo-17', entity: 'order', status: 'awaiting_review', region: 'us-east-1', labels: ['incident', 'checkout'], safePreview: true },
    { id: 'account-demo-2', entity: 'account', status: 'active', region: 'us-west-2', labels: ['demo'], safePreview: true }
  ],
  observability: [
    { id: 'trace-204', service: 'checkout-api', status: 'error', durationMs: 2301, spanCount: 8, labels: ['incident', 'checkout'] },
    { id: 'trace-197', service: 'demo-worker', status: 'ok', durationMs: 164, spanCount: 4, labels: ['incident', 'queue'] }
  ]
} as const;
const searchSchema: Tool['inputSchema'] = { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['query'], additionalProperties: false };
const definitions: Record<DemoIntegration, Tool[]> = {
  jira: [
    { name: 'search', description: 'Search the linked synthetic enterprise incident dataset', inputSchema: searchSchema },
    { name: 'create_issue', description: 'Preview creation of a Jira issue (demo only)', inputSchema: { type: 'object', properties: { project: { type: 'string', maxLength: 32 }, summary: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['project', 'summary'], additionalProperties: false } }
  ],
  aws: [
    { name: 'search', description: 'Search the linked synthetic enterprise incident dataset', inputSchema: searchSchema },
    { name: 'cloudwatch_logs', description: 'Read sample CloudWatch-style log events', inputSchema: { type: 'object', properties: { logGroup: { type: 'string', maxLength: 128 }, contains: { type: 'string', maxLength: 128 } }, required: ['logGroup'], additionalProperties: false } }
  ],
  gmail: [
    { name: 'search', description: 'Search the linked synthetic enterprise incident dataset', inputSchema: searchSchema },
    { name: 'create_draft', description: 'Preview a Gmail draft (does not send email)', inputSchema: { type: 'object', properties: { to: { type: 'string', maxLength: 254 }, subject: { type: 'string', maxLength: 200 }, body: { type: 'string', maxLength: 4000 } }, required: ['to', 'subject', 'body'], additionalProperties: false } }
  ],
  slack: [
    { name: 'search', description: 'Search the linked synthetic enterprise incident dataset', inputSchema: searchSchema },
    { name: 'post_message', description: 'Preview posting a Slack message (does not post)', inputSchema: { type: 'object', properties: { channel: { type: 'string', maxLength: 80 }, text: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['channel', 'text'], additionalProperties: false } }
  ],
  drive: [
    { name: 'search', description: 'Search the linked synthetic enterprise incident dataset', inputSchema: searchSchema },
    { name: 'read_file', description: 'Read a sample Drive file by ID', inputSchema: { type: 'object', properties: { fileId: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['fileId'], additionalProperties: false } }
  ],
  logs: [
    { name: 'search', description: 'Search the linked synthetic enterprise incident dataset', inputSchema: searchSchema },
    { name: 'query', description: 'Query sample logs by service and severity', inputSchema: { type: 'object', properties: { service: { type: 'string', maxLength: 80 }, severity: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] } }, required: ['service'], additionalProperties: false } }
  ],
  github: [
    { name: 'search', description: 'Search the linked synthetic enterprise incident dataset', inputSchema: searchSchema },
    { name: 'list_pull_requests', description: 'List sample pull requests for an allowed demo repository', inputSchema: { type: 'object', properties: { repository: { type: 'string', maxLength: 128 } }, required: ['repository'], additionalProperties: false } },
    { name: 'preview_review_comment', description: 'Preview a GitHub review comment; no comment is posted', inputSchema: { type: 'object', properties: { pullRequest: { type: 'string', maxLength: 32 }, body: { type: 'string', minLength: 1, maxLength: 1000 } }, required: ['pullRequest', 'body'], additionalProperties: false } }
  ],
  calendar: [
    { name: 'search', description: 'Search the linked synthetic enterprise incident dataset', inputSchema: searchSchema },
    { name: 'list_events', description: 'List demo calendar events', inputSchema: { type: 'object', properties: { from: { type: 'string', maxLength: 40 } }, additionalProperties: false } },
    { name: 'preview_event', description: 'Preview a calendar event; no invitation is sent', inputSchema: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, start: { type: 'string', maxLength: 40 } }, required: ['title', 'start'], additionalProperties: false } }
  ],
  database: [
    { name: 'search', description: 'Search the linked synthetic enterprise incident dataset', inputSchema: searchSchema },
    { name: 'get_record', description: 'Read one synthetic record by ID; arbitrary SQL is not accepted', inputSchema: { type: 'object', properties: { recordId: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['recordId'], additionalProperties: false } }
  ],
  observability: [
    { name: 'search', description: 'Search the linked synthetic enterprise incident dataset', inputSchema: searchSchema },
    { name: 'get_trace', description: 'Inspect a synthetic trace by ID', inputSchema: { type: 'object', properties: { traceId: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['traceId'], additionalProperties: false } }
  ]
};

export function createDemoIntegrationServer(integration: DemoIntegration) {
  const serverFactory = () => {
    const server = new Server({ name: `relay-demo-${integration}`, version: '1.0.0' }, { capabilities: { tools: {}, prompts: {}, resources: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: [...definitions[integration]] }));
    server.setRequestHandler('tools/call', async ({ params }) => {
      const args = params.arguments ?? {};
      const query = typeof args.query === 'string' ? args.query : '';
      let value: Record<string, unknown>;
      switch (`${integration}:${params.name}`) {
        case 'jira:search': value = { source: 'jira-demo', query, issues: matching(records.jira, query) }; break;
        case 'jira:create_issue': value = { source: 'jira-demo', preview: true, issueKey: 'DEMO-101', project: args.project, summary: args.summary }; break;
        case 'aws:search': value = { source: 'aws-demo', query, resources: matching(records.aws, query) }; break;
        case 'aws:cloudwatch_logs': value = { source: 'aws-demo', logGroup: args.logGroup, events: matching(records.logs, String(args.contains ?? '')).filter(row => row.service === 'checkout-api' || row.service === 'gateway') }; break;
        case 'gmail:search': value = { source: 'gmail-demo', query, messages: matching(records.gmail, query) }; break;
        case 'gmail:create_draft': value = { source: 'gmail-demo', preview: true, draftId: 'draft-demo-1', to: args.to, subject: args.subject }; break;
        case 'slack:search': value = { source: 'slack-demo', query, messages: matching(records.slack, query) }; break;
        case 'slack:post_message': value = { source: 'slack-demo', preview: true, channel: args.channel, accepted: true }; break;
        case 'drive:search': value = { source: 'drive-demo', query, files: matching(records.drive, query).map(({ content: _content, ...file }) => file) }; break;
        case 'drive:read_file': {
          const file = records.drive.find(row => row.id === args.fileId);
          value = file ? { source: 'drive-demo', fileId: file.id, name: file.name, content: file.content } : { source: 'drive-demo', fileId: args.fileId, notFound: true };
          break;
        }
        case 'logs:search': value = { source: 'logs-demo', query, entries: matching(records.logs, query) }; break;
        case 'logs:query': value = { source: 'logs-demo', service: args.service, severity: args.severity ?? 'info', entries: records.logs.filter(row => row.service === args.service && (!args.severity || row.severity === args.severity)) }; break;
        case 'github:search': value = { source: 'github-demo', query, items: matching(records.github, query) }; break;
        case 'github:list_pull_requests': value = { source: 'github-demo', repository: args.repository, pullRequests: records.github.filter(row => row.repository === args.repository) }; break;
        case 'github:preview_review_comment': value = { source: 'github-demo', preview: true, pullRequest: args.pullRequest, body: args.body, posted: false }; break;
        case 'calendar:search': value = { source: 'calendar-demo', query, events: matching(records.calendar, query) }; break;
        case 'calendar:list_events': value = { source: 'calendar-demo', from: args.from ?? null, events: [...records.calendar] }; break;
        case 'calendar:preview_event': value = { source: 'calendar-demo', preview: true, event: { title: args.title, start: args.start }, invitationSent: false }; break;
        case 'database:search': value = { source: 'database-demo', query, records: matching(records.database, query) }; break;
        case 'database:get_record': value = { source: 'database-demo', record: records.database.find(row => row.id === args.recordId) ?? null }; break;
        case 'observability:search': value = { source: 'observability-demo', query, traces: matching(records.observability, query) }; break;
        case 'observability:get_trace': value = { source: 'observability-demo', trace: records.observability.find(row => row.id === args.traceId) ?? null }; break;
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

function matching<T extends object>(rows: readonly T[], query: string): T[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...rows];
  return rows.filter(row => {
    const text = JSON.stringify(row).toLowerCase();
    return terms.some(term => text.includes(term));
  });
}
