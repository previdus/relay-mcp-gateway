import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createGateway } from '../dist/gateway.js';
import { createDemoServer } from '../dist/demo-server.js';
import { RemoteApprovalGate } from '../dist/approval-gate.js';
import { environmentPlugins } from '../dist/runtime.js';
import { adminToken, listen, serviceToken } from './helpers.js';

const approvalToken = 'approval-service-credential';
const requestId = 'request-approval-123';
const args = { account: 'acct-1', amount: 42 };
const fingerprint = 'tool-contract-sha256';
const context = () => ({
  requestId, principal: { id: 'finance-agent', tenantId: 'tenant-a', subject: 'agent-subject', oauthClientId: 'client-1' },
  requestedTool: 'send-payment', upstreamId: 'payments', upstreamTool: 'transfer',
  configurationRevision: 7, toolContractFingerprint: fingerprint, arguments: args, signal: new AbortController().signal
});

test('remote approval gate permits only a pending request then an exact, one-use consume decision', async t => {
  let approved, consumed = false, requestBody, consumeBody;
  const app = express(); app.use(express.json({ limit: '1mb' }));
  app.post('/decide', (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${approvalToken}`);
    if (req.body.phase === 'request') {
      requestBody = req.body;
      return res.json({ decision: 'pending', approvalId: 'approval-1234567890' });
    }
    consumeBody = req.body;
    const permitMatches = approved && !consumed && req.body.approvalId === approved.id && req.body.argumentDigest === approved.digest
      && req.body.principal.id === approved.principal && req.body.requestedTool === approved.tool
      && req.body.upstreamId === approved.upstream && req.body.upstreamTool === approved.upstreamTool
      && req.body.configurationRevision === approved.revision && req.body.toolContractFingerprint === approved.fingerprint;
    if (!permitMatches) return res.json({ decision: 'deny' });
    consumed = true;
    return res.json({ decision: 'allow' });
  });
  const service = await listen(app, t);
  const gate = new RemoteApprovalGate({ url: `${service}/decide`, token: approvalToken, tools: ['send-payment'], allowLocalHttp: true });
  const first = await gate.requestOrConsume(context());
  assert.deepEqual(first, { decision: 'pending', approvalId: 'approval-1234567890' });
  assert.deepEqual(requestBody.principal, { id: 'finance-agent', tenantId: 'tenant-a', subject: 'agent-subject', oauthClientId: 'client-1' });
  assert.equal(requestBody.configurationRevision, 7);
  assert.equal(requestBody.toolContractFingerprint, fingerprint);
  assert.deepEqual(requestBody.arguments, args);
  assert.equal(requestBody.argumentDigest, createHash('sha256').update(JSON.stringify(args)).digest('hex'));
  assert.deepEqual(Object.keys(requestBody).sort(), ['argumentDigest', 'arguments', 'configurationRevision', 'phase', 'principal', 'requestId', 'requestedTool', 'toolContractFingerprint', 'upstreamId', 'upstreamTool'].sort());
  assert.equal(JSON.stringify(requestBody).includes(serviceToken), false);
  assert.equal(JSON.stringify(requestBody).includes(approvalToken), false);

  approved = { id: first.approvalId, digest: requestBody.argumentDigest, principal: 'finance-agent', tool: 'send-payment', upstream: 'payments', upstreamTool: 'transfer', revision: 7, fingerprint };
  assert.deepEqual(await gate.requestOrConsume(context(), first.approvalId), { decision: 'allow' });
  assert.equal(consumeBody.phase, 'consume');
  assert.deepEqual(await gate.requestOrConsume(context(), first.approvalId), { decision: 'deny' }, 'replay must be rejected by atomic approval-service consumption');
  assert.deepEqual(await gate.requestOrConsume({ ...context(), arguments: { ...args, amount: 43 } }, first.approvalId), { decision: 'deny' }, 'permit must be bound to exact arguments');
  assert.deepEqual(await gate.requestOrConsume({ ...context(), configurationRevision: 8 }, first.approvalId), { decision: 'deny' }, 'permit must be bound to configuration revision');
  assert.deepEqual(await gate.requestOrConsume({ ...context(), toolContractFingerprint: 'changed-contract' }, first.approvalId), { decision: 'deny' }, 'permit must be bound to reviewed tool definition');
});

test('approval-gated MCP calls have no upstream effect before approval and carry the permit only to the gate', async t => {
  let effects = 0, approved = false, approvedDigest, consumed = false;
  const auditEvents = [];
  let forwardedMeta;
  const upstreamApp = express(); upstreamApp.use('/mcp', express.json(), (req, _res, next) => { if (req.body?.method === 'tools/call') forwardedMeta = req.body.params?._meta; next(); });
  const handler = toNodeHandler(createMcpHandler(() => {
    const server = new Server({ name: 'payments', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'transfer', inputSchema: { type: 'object', properties: { account: { type: 'string' }, amount: { type: 'number' } }, required: ['account', 'amount'] } }] }));
    server.setRequestHandler('tools/call', async request => {
      effects++;
      return { content: [{ type: 'text', text: `transferred ${request.params.arguments.amount}` }] };
    });
    return server;
  }));
  upstreamApp.all('/mcp', (req, res) => void handler(req, res, req.body));
  const upstream = await listen(upstreamApp, t);
  const decisions = express(); decisions.use(express.json());
  decisions.post('/decide', (req, res) => {
    if (req.body.phase === 'request') {
      approvedDigest = req.body.argumentDigest;
      return res.json({ decision: 'pending', approvalId: 'transfer-approval-12345' });
    }
    if (!approved || consumed || req.body.argumentDigest !== approvedDigest || req.body.approvalId !== 'transfer-approval-12345') return res.json({ decision: 'deny' });
    consumed = true;
    return res.json({ decision: 'allow' });
  });
  const decisionUrl = await listen(decisions, t);
  const config = {
    allowLocalHttp: true, approvalRequiredTools: ['payments__transfer'],
    clients: [{ id: 'finance-agent', token: serviceToken, tenantId: 'tenant-a', allow: ['payments__transfer'] }],
    upstreams: [{ id: 'payments', url: `${upstream}/mcp`, tenantId: 'tenant-a' }]
  };
  const gate = new RemoteApprovalGate({ url: `${decisionUrl}/decide`, token: approvalToken, tools: config.approvalRequiredTools, allowLocalHttp: true });
  const gateway = await listen(createGateway(config, { approvalGate: gate, configurationRevision: 11, audit: async event => auditEvents.push(event) }), t);
  const client = new Client({ name: 'approval-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
  t.after(() => client.close());

  let pendingError;
  try { await client.callTool({ name: 'payments__transfer', arguments: args }); } catch (error) { pendingError = error; }
  assert.match(pendingError?.message ?? '', /approval|pending/i);
  assert.deepEqual(pendingError?.data, { approvalId: 'transfer-approval-12345' }, 'the caller receives a structured permit handle instead of needing to parse error text');
  assert.ok(auditEvents.some(event => event.method === 'gateway/approval.requested' && event.outcome === 'approval_pending' && event.configurationRevision === 11));
  assert.equal(effects, 0, 'unapproved tool call must never reach the upstream');
  approved = true;
  const permitted = await client.request({ method: 'tools/call', params: { name: 'payments__transfer', arguments: args, _meta: { 'com.agentrelay/approvalId': 'transfer-approval-12345' } } });
  assert.equal(permitted.content[0].text, 'transferred 42');
  assert.equal(effects, 1);
  assert.ok(auditEvents.some(event => event.method === 'gateway/approval.consumed' && event.outcome === 'approval_consumed' && event.configurationRevision === 11));
  assert.equal(JSON.stringify(auditEvents).includes('transfer-approval-12345'), false, 'audit events must not retain permit IDs');
  assert.equal(JSON.stringify(auditEvents).includes('acct-1'), false, 'audit events must not contain tool arguments');
  assert.equal(JSON.stringify(auditEvents).includes(approvalToken), false);
  assert.equal(JSON.stringify(auditEvents).includes(serviceToken), false);
  assert.equal(forwardedMeta?.['com.agentrelay/approvalId'], undefined, 'the approval permit metadata must not be sent to the upstream');
  await assert.rejects(client.request({ method: 'tools/call', params: { name: 'payments__transfer', arguments: args, _meta: { 'com.agentrelay/approvalId': 'transfer-approval-12345' } } }), /approval|denied|forbidden/i);
  assert.equal(effects, 1, 'replayed permit cannot repeat an upstream side effect');
});

test('remote approval adapter fails closed on initial allow, malformed results, redirect, timeout, oversized request and non-matching tool', async () => {
  const gateFor = fetch => new RemoteApprovalGate({ url: 'http://127.0.0.1/decide', token: approvalToken, tools: ['payments__*'], allowLocalHttp: true, fetch });
  assert.deepEqual(await gateFor(async () => Response.json({ decision: 'allow' })).requestOrConsume(context()), { decision: 'deny' }, 'approval cannot be granted on the initial request phase');
  assert.deepEqual(await gateFor(async () => Response.json({ decision: 'pending', approvalId: 'too-short' })).requestOrConsume(context()), { decision: 'deny' });
  assert.deepEqual(await gateFor(async () => Response.json({ decision: 'pending', approvalId: 'approval-1234567890', padding: 'x'.repeat(3000) })).requestOrConsume(context()), { decision: 'deny' }, 'oversized decision responses must fail closed');
  assert.deepEqual(await gateFor(async () => Response.redirect('https://attacker.example/')).requestOrConsume(context()), { decision: 'deny' });
  const timeout = gateFor((_url, init) => new Promise((resolve, reject) => {
    const holdOpen = setTimeout(() => resolve(Response.json({ decision: 'allow' })), 200);
    init.signal.addEventListener('abort', () => { clearTimeout(holdOpen); reject(init.signal.reason); }, { once: true });
  }));
  assert.deepEqual(await timeout.requestOrConsume(context()), { decision: 'deny' });
  const small = new RemoteApprovalGate({ url: 'http://127.0.0.1/decide', token: approvalToken, tools: ['payments__*'], allowLocalHttp: true, maxRequestBytes: 1024, fetch: async () => Response.json({ decision: 'pending', approvalId: 'approval-1234567890' }) });
  assert.deepEqual(await small.requestOrConsume({ ...context(), arguments: { data: 'x'.repeat(3000) } }), { decision: 'deny' });
  let calls = 0;
  const allowListed = new RemoteApprovalGate({ url: 'http://127.0.0.1/decide', token: approvalToken, tools: ['other__*'], allowLocalHttp: true, fetch: async () => { calls++; return Response.json({ decision: 'pending', approvalId: 'approval-1234567890' }); } });
  assert.deepEqual(await allowListed.requestOrConsume(context()), { decision: 'deny' });
  assert.equal(calls, 0, 'unconfigured tool names must not send payloads to the approval endpoint');
});

test('gateway requires an approval adapter for tools selected by approval policy', () => {
  assert.throws(() => createGateway({
    allowLocalHttp: true, approvalRequiredTools: ['payments__transfer'],
    clients: [{ id: 'finance-agent', token: serviceToken, allow: ['payments__transfer'] }],
    upstreams: [{ id: 'payments', url: 'http://127.0.0.1:31337/mcp' }]
  }), /approval gate/i);
});

test('gateway core rejects an initial allow or malformed permit from a custom approval plugin', async t => {
  let effects = 0, gateCalls = 0;
  const upstream = await listen(createDemoServer('payments', method => { if (method === 'tools/call') effects++; }), t);
  const config = {
    allowLocalHttp: true, approvalRequiredTools: ['payments__echo'],
    clients: [{ id: 'finance-agent', token: serviceToken, allow: ['payments__echo'] }],
    upstreams: [{ id: 'payments', url: `${upstream}/mcp` }]
  };
  const gateway = await listen(createGateway(config, { approvalGate: { requestOrConsume: async () => { gateCalls++; return { decision: 'allow' }; } } }), t);
  const client = new Client({ name: 'approval-plugin-contract-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
  t.after(() => client.close());
  await assert.rejects(client.callTool({ name: 'payments__echo', arguments: { text: 'must-not-run' } }), /approval/i);
  assert.equal(gateCalls, 1);
  assert.equal(effects, 0, 'the core must reject initial allow even from a trusted plugin');
  await assert.rejects(client.request({ method: 'tools/call', params: { name: 'payments__echo', arguments: { text: 'must-not-run' }, _meta: { 'com.agentrelay/approvalId': 'short' } } }), /approval/i);
  assert.equal(gateCalls, 1, 'malformed permits must be denied before reaching any adapter');
  assert.equal(effects, 0);
});

test('required audit failures deny approval handoff before any upstream effect', async t => {
  let effects = 0, failMethod;
  const events = [];
  const upstream = await listen(createDemoServer('payments', method => { if (method === 'tools/call') effects++; }), t);
  const config = {
    allowLocalHttp: true, approvalRequiredTools: ['payments__echo'],
    clients: [{ id: 'finance-agent', token: serviceToken, allow: ['payments__echo'] }],
    upstreams: [{ id: 'payments', url: `${upstream}/mcp` }]
  };
  const gate = { requestOrConsume: async (_context, approvalId) => approvalId ? { decision: 'allow' } : { decision: 'pending', approvalId: 'audit-failure-12345' } };
  const audit = async event => { if (event.method === failMethod) throw new Error('storage unavailable'); events.push(event); };
  const gateway = await listen(createGateway(config, { approvalGate: gate, requireAudit: true, audit }), t);
  const client = new Client({ name: 'approval-audit-failure-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
  t.after(() => client.close());

  const pending = await client.callTool({ name: 'payments__echo', arguments: { text: 'hold' } }).catch(error => error);
  assert.deepEqual(pending.data, { approvalId: 'audit-failure-12345' });
  assert.equal(effects, 0);

  failMethod = 'gateway/approval.requested';
  await assert.rejects(client.callTool({ name: 'payments__echo', arguments: { text: 'hold' } }), /could not be recorded/i);
  assert.equal(effects, 0, 'failed pending audit must not hand off the permit');

  failMethod = 'gateway/approval.consumed';
  await assert.rejects(client.request({ method: 'tools/call', params: { name: 'payments__echo', arguments: { text: 'hold' }, _meta: { 'com.agentrelay/approvalId': 'audit-failure-12345' } } }), /could not be recorded/i);
  assert.equal(effects, 0, 'failed consume audit must stop the action even after the external permit was consumed');
  assert.ok(events.some(event => event.method === 'tools/call' && event.outcome === 'started'));
});

test('deployment wiring requires tool policy and binds approval credentials to the exact approval endpoint', () => {
  const config = { allowLocalHttp: true, approvalRequiredTools: ['payments__transfer'], clients: [], upstreams: [] };
  const endpoint = 'http://127.0.0.1:34568/decide';
  const env = { APPROVAL_DECISION_URL: endpoint, APPROVAL_BEARER_TOKEN: approvalToken, APPROVAL_ALLOW_LOCAL_HTTP: 'true', GATEWAY_REQUIRE_CREDENTIAL_BINDINGS: 'true', GATEWAY_CREDENTIAL_BINDINGS: '[]' };
  assert.throws(() => environmentPlugins(config, env), /destination is not approved/i);
  env.GATEWAY_CREDENTIAL_BINDINGS = JSON.stringify([
    { reference: 'APPROVAL_DECISION_URL', endpoint, purpose: 'approval-service' },
    { reference: 'APPROVAL_BEARER_TOKEN', endpoint, purpose: 'approval-service' }
  ]);
  assert.ok(environmentPlugins(config, env).approvalGate instanceof RemoteApprovalGate);
  assert.ok(environmentPlugins({ ...config, approvalRequiredTools: undefined }, env).approvalGate instanceof RemoteApprovalGate, 'a preconfigured adapter may remain dormant while admins edit tool policy');
});
