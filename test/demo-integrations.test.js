import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createGateway } from '../dist/gateway.js';
import { createDemoIntegrationServer } from '../dist/demo-integrations.js';
import { listen, serviceToken } from './helpers.js';

test('demo SaaS, cloud, file and observability MCP servers integrate through one governed gateway', async t => {
  const ids = ['jira', 'aws', 'gmail', 'slack', 'drive', 'logs', 'github', 'calendar', 'database', 'observability'];
  const observedHeaders = [];
  const servers = await Promise.all(ids.map(id => {
    const app = express();
    app.use((req, _res, next) => { observedHeaders.push({ integration: id, apiKey: req.get('x-api-key') }); next(); });
    app.use(createDemoIntegrationServer(id));
    return listen(app, t);
  }));
  const upstreams = ids.map((id, index) => ({ id, url: `${servers[index]}/mcp`, ...(id === 'jira' ? { headers: { 'X-API-Key': 'only-jira-demo-key' } } : {}) }));
  const routes = [{ name: 'enterprise_search', strategy: 'priority', targets: ids.map((upstreamId, priority) => ({ upstreamId, tool: 'search', priority })) }];
  const grants = [...ids.map(id => `${id}__*`), 'enterprise_search'];
  const gateway = await listen(createGateway({
    allowLocalHttp: true, features: { prompts: true, resources: true },
    clients: [{ id: 'demo-agent', token: serviceToken, allow: grants, permissions: { prompts: ids.map(id => `${id}__*`), resources: ids.map(id => `${id}__*`) } }], upstreams, routes
  }), t);
  const client = new Client({ name: 'integration-demo', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
  t.after(() => client.close());

  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('enterprise_search'));
  for (const id of ids) assert.ok(names.includes(`${id}__search`), `missing ${id} search tool`);
  const result = await client.callTool({ name: 'enterprise_search', arguments: { query: 'incident' } });
  assert.equal(result.structuredContent.source, 'jira-demo', 'priority routing chooses the configured first target');
  const incident = await client.callTool({ name: 'jira__search', arguments: { query: 'checkout' } });
  assert.equal(incident.structuredContent.issues[0].key, 'OPS-204', 'linked dataset supports a realistic incident search');
  assert.equal((await client.callTool({ name: 'aws__search', arguments: { query: 'us-west-2' } })).structuredContent.resources[0].id, 'i-demo-worker');
  assert.equal((await client.callTool({ name: 'gmail__search', arguments: { query: 'credentials' } })).structuredContent.messages[0].id, 'mail-118');
  assert.equal((await client.callTool({ name: 'slack__search', arguments: { query: 'checkout' } })).structuredContent.messages[0].id, 'msg-204');
  assert.equal((await client.callTool({ name: 'aws__cloudwatch_logs', arguments: { logGroup: '/demo/app' } })).structuredContent.source, 'aws-demo');
  assert.equal((await client.callTool({ name: 'gmail__create_draft', arguments: { to: 'user@example.test', subject: 'Demo', body: 'No email is sent' } })).structuredContent.preview, true);
  assert.equal((await client.callTool({ name: 'slack__post_message', arguments: { channel: 'incidents', text: 'Demo only' } })).structuredContent.preview, true);
  assert.equal((await client.callTool({ name: 'drive__read_file', arguments: { fileId: 'runbook-checkout' } })).structuredContent.content.includes('checkout-api logs'), true);
  assert.equal((await client.callTool({ name: 'logs__query', arguments: { service: 'checkout-api', severity: 'error' } })).structuredContent.entries[0].id, 'log-204a');
  assert.equal((await client.callTool({ name: 'aws__cloudwatch_logs', arguments: { logGroup: '/demo/checkout', contains: 'retry' } })).structuredContent.events[0].id, 'log-204b');
  assert.equal((await client.callTool({ name: 'github__list_pull_requests', arguments: { repository: 'acme/checkout' } })).structuredContent.pullRequests[0].id, 'PR-204');
  assert.equal((await client.callTool({ name: 'calendar__list_events', arguments: {} })).structuredContent.events[0].id, 'event-204');
  assert.equal((await client.callTool({ name: 'database__get_record', arguments: { recordId: 'order-demo-17' } })).structuredContent.record.safePreview, true);
  assert.equal((await client.callTool({ name: 'observability__get_trace', arguments: { traceId: 'trace-204' } })).structuredContent.trace.durationMs, 2301);
  assert.equal((await client.callTool({ name: 'github__preview_review_comment', arguments: { pullRequest: 'PR-204', body: 'Reviewed' } })).structuredContent.posted, false);
  assert.ok((await client.listPrompts()).prompts.some(prompt => prompt.name === 'jira__triage_incident'));
  assert.ok((await client.listResources()).resources.some(resource => resource.uri.startsWith('drive://') || resource.uri.includes('drive')));
  assert.ok(observedHeaders.some(entry => entry.integration === 'jira' && entry.apiKey === 'only-jira-demo-key'));
  assert.ok(observedHeaders.filter(entry => entry.integration !== 'jira').every(entry => entry.apiKey === undefined), 'upstream credentials must not leak across servers');
});
