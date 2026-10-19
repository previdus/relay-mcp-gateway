import express, { type ErrorRequestHandler } from 'express';
import { accessTokenCredential, bearerToken } from './authentication.js';
import { withinDeadline } from './deadline.js';
import { randomUUID } from 'node:crypto';
import { Server, createMcpHandler, ProtocolError, ProtocolErrorCode, InMemoryServerEventBus, type Tool, type ServerContext, type SubscriptionFilter } from '@modelcontextprotocol/server';
import { CallToolRequestSchema, CallToolResultSchema } from '@modelcontextprotocol/core/internal';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { hostHeaderValidation } from '@modelcontextprotocol/express';
import { Client, SdkError, SdkErrorCode, type PriorDiscovery, type Transport } from '@modelcontextprotocol/client';
import type { AuditSink, AuditOutcome, GatewayConfig, Upstream } from './types.js';
import { validateConfig } from './validation.js';
import { ApiKeyAuthenticator, AllowListAuthorizer, ConfigRouter, InsufficientScopeError, MtlsAuthenticator, type Authenticator, type Authorizer, type Router } from './plugins.js';
import { LocalLimiter, type ConcurrencyLimiter } from './limiter.js';
import { registerFeatures } from './features.js';
import { checkToolArguments, findToolDefinitionWithHints, InvalidToolArguments } from './tool-contracts.js';
import { schemaPool } from './schema-pool.js';
import { sameTenant, tenantConfig } from './tenancy.js';
import { ContinuationCodec, callbackCapabilities, callBinding, stateFor, wrapInput } from './continuations.js';
import { rewriteResourceLinks } from './resource-names.js';
import { OAuthCredentialProvider, type CredentialProvider } from './credentials.js';
import { createUpstreamTransport } from './transports.js';
import type { EgressPolicy } from './egress.js';
import { DpopNonceRequired } from './dpop.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { relaySubscriptions, validateSubscription } from './subscriptions.js';
import { enforceRoutedContract, CatalogDenied } from './contracts.js';
import { enforceInvocation, InvocationDenied } from './invocation-policy.js';
import { InspectionPipeline, InspectionDenied, type ToolInspector } from './inspection.js';
import { collectCatalog, catalogPage, searchCatalog, InvalidCatalogCursor, CatalogLimitExceeded } from './catalog.js';
import { z } from 'zod';
import { parameterHeaders, validateParameterHeaders, InvalidParameterHeaders, ParameterHeaderMismatch } from './parameter-headers.js';
import { requestTrace, runTrace, traceOutcome, traceHeaders } from './telemetry.js';
import { LocalRateLimiter, CircuitBreakers, rateKey, type RateLimiter, type CircuitBreaker } from './traffic.js';
import { createHash } from 'node:crypto';
import { TLSSocket } from 'node:tls';
import { DiscoveryCache } from './discovery-cache.js';
import { RouteContractCache } from './route-contract-cache.js';
import { ApprovalDenied, type ToolApprovalGate } from './approval-gate.js';
import { TASKS_EXTENSION_ID_V2, CreateTaskResultV2Schema, GetTaskRequestV2Schema, UpdateTaskRequestV2Schema, InputResponsesV2Schema, CancelTaskRequestV2Schema, GetTaskResultV2Schema, UpdateTaskResultV2Schema, CancelTaskResultV2Schema, hasTaskClientCapabilityV2 } from '@modelcontextprotocol/ext-tasks/core/v2';
import { McpTaskCodec, taskStorageKey, type McpTaskState } from './task-state.js';
import type { ConfigStore } from './store.js';
import { TaskAwareServer } from './task-server.js';
import { RawTaskTransport } from './raw-task-transport.js';

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize((item as Record<string, unknown>)[key])]))
    : item;
  return JSON.stringify(normalize(value));
}

export interface GatewayPlugins {
  pluginApiVersion?: 1;
  configurationRevision?: number;
  audit?: AuditSink; authenticator?: Authenticator; authorizer?: Authorizer; router?: Router; limiter?: ConcurrencyLimiter;
  requireAudit?: boolean;
  transportFactory?: (upstream: Upstream) => Transport;
  egressPolicy?: EgressPolicy;
  resourceMetadataUrl?: string;
  stateKey?: string;
  credentials?: CredentialProvider;
  isRevisionCurrent?: () => Promise<boolean>;
  rateLimiter?: RateLimiter;
  circuitBreakers?: CircuitBreaker;
  inspectors?: readonly ToolInspector[];
  approvalGate?: ToolApprovalGate;
  taskStore?: Pick<ConfigStore, 'putMcpTask' | 'getMcpTask' | 'compareAndSetMcpTask'>;
}
export function createGateway(input: GatewayConfig, plugins: GatewayPlugins = {}) {
  if (plugins.pluginApiVersion !== undefined && plugins.pluginApiVersion !== 1) throw new Error('Unsupported gateway plugin API version');
  const config = validateConfig(input);
  if (config.approvalRequiredTools?.length && !plugins.approvalGate) throw new Error('Approval-required tools need an approval gate');
  const audit = plugins.audit ?? (async () => {});
  if (plugins.requireAudit && !plugins.audit) throw new Error('Required audit mode needs a durable audit sink');
  const authenticator: Authenticator = plugins.authenticator ?? new ApiKeyAuthenticator(config.clients);
  const authorizer = plugins.authorizer ?? new AllowListAuthorizer();
  const router = plugins.router ?? new ConfigRouter(config);
  const configuredTarget = (name: string, principal: import('./types.js').ServiceClient, upstreamId: string, tool: string) => {
    if (name === `${upstreamId}__${tool}`) return true;
    if (name.includes('__')) return false;
    const rule = config.routes?.find(candidate => candidate.name === name);
    return Boolean(rule && (!rule.clients || rule.clients.includes(principal.id)) &&
      (!rule.tenants || rule.tenants.includes(principal.tenantId ?? 'default')) &&
      (!rule.requiredRoles || rule.requiredRoles.every(role => principal.roles?.includes(role))) &&
      rule.targets.some(target => target.enabled !== false && target.upstreamId === upstreamId && target.tool === tool));
  };
  // Routing plugins may choose among administrator-configured route targets,
  // but cannot relabel a different physical tool as an authorized public name.
  const catalogRouter: Router = {
    names: (upstreamId, tool, context) => router.names(upstreamId, tool, context).filter(name => configuredTarget(name, context.principal, upstreamId, tool)),
    resolve: (name, context) => router.resolve(name, context),
  };
  const inspectors = new InspectionPipeline(plugins.inspectors, config.inspectionTimeoutMs);
  const continuation = config.features?.callbacks ? new ContinuationCodec(plugins.stateKey ?? '') : undefined;
  const taskCodec = config.features?.tasks ? new McpTaskCodec(plugins.stateKey ?? '') : undefined;
  if (config.features?.tasks && (!plugins.taskStore?.putMcpTask || !plugins.taskStore.getMcpTask || !plugins.taskStore.compareAndSetMcpTask)) throw new Error('MCP Tasks require a shared task store with atomic updates');
  const credentials = plugins.credentials ?? new OAuthCredentialProvider(config.allowLocalHttp, plugins.egressPolicy);
  const discoveryCache = new DiscoveryCache();
  const routeContractCache = new RouteContractCache(4096, config.discovery?.routeContractCacheMaxTtlMs ?? 5000);
  const credentialContext = new AsyncLocalStorage<{ principal: import('./types.js').ServiceClient; token: string }>();
  const app = express();
  app.disable('x-powered-by');
  app.use(hostHeaderValidation(config.allowedHosts ?? ['127.0.0.1', 'localhost', '[::1]']));
  app.use(express.json({ limit: '256kb' }));
  app.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); next(); });
  const timeout = config.timeoutMs ?? 5000;
  const limiter = plugins.limiter ?? new LocalLimiter();
  const rateLimiter = plugins.rateLimiter ?? new LocalRateLimiter();
  const circuitBreakers = plugins.circuitBreakers ?? new CircuitBreakers();
  type Bridge = { principal: import('./types.js').ServiceClient; ctx?: ServerContext; subscription?: boolean };
  type OperationOptions = { signal: AbortSignal; timeout: number; rawTaskDispatch?: (request: { method: string; params?: Record<string, unknown> }, headers?: Readonly<Record<string, string>>) => Promise<{ result?: unknown; error?: { code: number; message: string } }> };
  type Operation<T> = (client: Client, options: OperationOptions) => Promise<T>;
  const rawTaskRequest = async (options: OperationOptions, method: string, params: Record<string, unknown>, headers?: Readonly<Record<string, string>>, clientCapabilities: Record<string, unknown> = {}) => {
    if (!options.rawTaskDispatch) throw new ProtocolError(ProtocolErrorCode.MethodNotFound, 'Upstream transport does not support MCP Tasks');
    const meta = (params._meta && typeof params._meta === 'object' ? params._meta : {}) as Record<string, unknown>;
    const response = await options.rawTaskDispatch({ method, params: { ...params, _meta: {
      ...meta,
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'gateway-upstream', version: '0.12.0' },
      'io.modelcontextprotocol/clientCapabilities': { ...clientCapabilities, extensions: { ...((clientCapabilities.extensions && typeof clientCapabilities.extensions === 'object') ? clientCapabilities.extensions as Record<string, unknown> : {}), [TASKS_EXTENSION_ID_V2]: {} } },
    } } }, headers);
    if (response.error) throw new ProtocolError(response.error.code, response.error.message);
    return response.result;
  };
  async function performUpstreamRequest<T>(upstream: Upstream, operation: Operation<T>, callerSignal?: AbortSignal, bridge?: Bridge): Promise<T> {
    const operationTimeout = upstream.timeoutMs ?? timeout;
    const connectTimeout = Math.min(upstream.connectTimeoutMs ?? operationTimeout, operationTimeout);
    const signal = AbortSignal.any([AbortSignal.timeout(bridge?.subscription ? 120000 : operationTimeout), ...(callerSignal ? [callerSignal] : [])]);
    signal.throwIfAborted();
    const caller = credentialContext.getStore();
    const principal = bridge?.principal ?? caller?.principal;
    const clientCapabilities = bridge && continuation ? callbackCapabilities(bridge.principal, bridge.ctx) : {};
    const credentialHeaders = await withinDeadline(credentials.headers(upstream, principal, caller?.token), signal);
    signal.throwIfAborted();
    const headers = { ...traceHeaders(), ...credentialHeaders };
    // The v2 SDK lets a host supply its recent protocol-era verdict and skip a
    // modern `server/discover` round trip. Scope it to the endpoint, revision,
    // authenticated identity, and a digest of the actual outbound credentials.
    // A custom transport has opaque routing/auth state, so it opts out.
    const cacheKey = createHash('sha256').update(JSON.stringify([
      upstream.id, upstream.url, upstream.transport ?? 'streamable-http', upstream.command ?? null,
      upstream.args ?? [], Object.entries(upstream.environment ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      plugins.configurationRevision ?? null,
      principal && [principal.id, principal.tenantId ?? null, principal.subject ?? null, principal.oauthClientId ?? null, principal.authScheme ?? null],
      clientCapabilities,
      Object.entries(credentialHeaders).sort(([a], [b]) => a.localeCompare(b)),
    ])).digest('hex');
    const cacheDiscovery = !plugins.transportFactory && upstream.transport !== 'sse' && upstream.discoveryCacheTtlMs !== undefined;
    const prior = cacheDiscovery ? discoveryCache.get(cacheKey) : undefined;
    const makeClient = () => new Client({ name: 'gateway-upstream', version: '0.12.0' }, { capabilities: clientCapabilities, versionNegotiation: { mode: upstream.transport === 'sse' ? 'legacy' : 'auto', probe: { timeoutMs: connectTimeout, maxRetries: 0 } } });
    const makeTransport = () => plugins.transportFactory?.(upstream) ?? createUpstreamTransport(upstream, headers, config.maxUpstreamResponseBytes, plugins.egressPolicy);
    let client = makeClient();
    const baseTransport = makeTransport();
    const rawTransport = config.features?.tasks && !plugins.transportFactory && (upstream.transport ?? 'streamable-http') === 'streamable-http' ? new RawTaskTransport(baseTransport) : undefined;
    let transport = (rawTransport ?? baseTransport) as Transport;
    const abort = () => { void transport.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      try {
        await client.connect(transport, { signal, timeout: connectTimeout, ...(prior ? { prior } : {}) });
      } catch (error) {
        // A server behind a load balancer may have changed protocol support.
        // Only retry a cached-verdict negotiation mismatch, before tool work;
        // never retry a call that may already have had side effects.
        if (!prior || !(error instanceof SdkError) || error.code !== SdkErrorCode.EraNegotiationFailed) throw error;
        discoveryCache.delete(cacheKey);
        await client.close().catch(() => {});
        signal.throwIfAborted();
        client = makeClient();
        transport = makeTransport();
        await client.connect(transport, { signal, timeout: connectTimeout });
      }
      if (cacheDiscovery) {
        const discovered = client.getDiscoverResult();
        const verdict: PriorDiscovery = discovered ? { kind: 'modern', discover: discovered } : { kind: 'legacy' };
        discoveryCache.set(cacheKey, verdict, upstream.discoveryCacheTtlMs);
      }
      return await operation(client, { signal, timeout: operationTimeout, ...(rawTransport ? { rawTaskDispatch: (request, requestHeaders) => rawTransport.dispatch(request, { signal, timeout: operationTimeout, headers: requestHeaders }) } : {}) });
    } finally {
      signal.removeEventListener('abort', abort);
      await client.close().catch(() => {});
    }
  }
  async function upstreamRequest<T>(upstream: Upstream, operation: Operation<T>, callerSignal?: AbortSignal, bridge?: Bridge): Promise<T> {
    const run = () => runTrace('mcp.upstream', { 'gateway.upstream': upstream.id, 'gateway.transport': upstream.transport ?? 'streamable-http' }, () => performUpstreamRequest(upstream, operation, callerSignal, bridge));
    const policy = config.traffic?.circuitBreaker;
    return policy && !bridge?.subscription ? circuitBreakers.run(rateKey(['upstream', upstream], { capacity: policy.failureThreshold, refillPerSecond: policy.resetAfterMs }), policy, run, error => !callerSignal?.aborted && !(error instanceof ProtocolError) && !(error instanceof ApprovalDenied) && !(error instanceof InvalidToolArguments) && !(error instanceof InvalidParameterHeaders) && !(error instanceof ParameterHeaderMismatch)) : run();
  }
  async function assertAliasContracts(name: string, principal: import('./types.js').ServiceClient, selectedUpstreamId: string, selectedTool: string, selectedFingerprint: string, signal: AbortSignal) {
    const rule = config.routes?.find(candidate => candidate.name === name);
    if (!rule) return;
    const targets = rule.targets.filter(target => target.enabled !== false).filter(target => target.upstreamId !== selectedUpstreamId || target.tool !== selectedTool);
    for (let offset = 0; offset < targets.length; offset += 4) {
      await Promise.all(targets.slice(offset, offset + 4).map(async target => {
        const candidate = config.upstreams.find(upstream => upstream.id === target.upstreamId && sameTenant(principal, upstream));
        if (!candidate) return;
        try {
          const caller = credentialContext.getStore();
          const cacheKey = createHash('sha256').update(JSON.stringify([
            name, candidate.id, candidate.url, candidate.transport ?? 'streamable-http', target.tool,
            plugins.configurationRevision ?? null, principal.id, principal.tenantId ?? 'default', principal.subject ?? null,
            principal.oauthIssuer ?? null, principal.oauthClientId ?? null, principal.certificateSha256 ?? null,
            [...(principal.roles ?? [])].sort(), createHash('sha256').update(caller?.token ?? '').digest('hex')
          ])).digest('hex');
          let fingerprint = routeContractCache.get(cacheKey);
          if (!fingerprint) {
            const lookup = await upstreamRequest(candidate, (client, options) => findToolDefinitionWithHints(client, target.tool, options, config.discovery), signal);
            fingerprint = enforceRoutedContract(lookup.tool, name, candidate.id, config);
            if (lookup.cacheScope && lookup.ttlMs && lookup.ttlMs > 0) routeContractCache.set(cacheKey, fingerprint, lookup.ttlMs);
          }
          if (fingerprint !== selectedFingerprint) throw new CatalogDenied('Routed tool contracts differ across eligible targets');
        } catch (error) {
          if (error instanceof CatalogDenied) throw error;
          throw new CatalogDenied('Routed tool contract is unavailable across eligible targets');
        }
      }));
    }
  }
  const catalogBinding = (principal: import('./types.js').ServiceClient) => [principal.id, principal.tenantId, principal.subject, plugins.configurationRevision ?? null, config.discovery];
  app.get('/healthz', (_req, res) => res.json({ status: 'ok', version: '0.12.0' }));
  app.use(['/mcp', '/catalog/search'], async (req, res, next) => {
    const credential = accessTokenCredential(req);
    const token = credential.token;
    const tlsSocket = req.socket instanceof TLSSocket ? req.socket : undefined;
    const peerCertificate = tlsSocket?.authorized ? tlsSocket.getPeerCertificate() : undefined;
    const authenticationContext = {
      authorizationHeaderCount: req.headersDistinct.authorization?.length ?? 0,
      authorizationScheme: credential.scheme,
      dpopProofHeaderCount: req.headersDistinct.dpop?.length ?? 0,
      ...(req.headersDistinct.dpop?.length === 1 ? { dpopProof: req.headersDistinct.dpop[0] } : {}),
      method: req.method,
      requestTarget: req.originalUrl,
      ...(peerCertificate?.raw ? { certificateSha256: createHash('sha256').update(peerCertificate.raw).digest('base64url') } : {})
    };
    let principal;
    try { principal = await authenticator.authenticate(token, authenticationContext); }
    catch (error) {
      if (error instanceof InsufficientScopeError) return res.status(403).set('WWW-Authenticate', `${authenticator.challengeScheme ?? 'Bearer'} error="insufficient_scope", scope="${error.requiredScopes.join(' ')}"${plugins.resourceMetadataUrl ? `, resource_metadata="${plugins.resourceMetadataUrl}"` : ''}`).json({ error: 'Insufficient scope' });
      if (error instanceof DpopNonceRequired) return res.status(401).set('WWW-Authenticate', `DPoP error="use_dpop_nonce"${plugins.resourceMetadataUrl ? `, resource_metadata="${plugins.resourceMetadataUrl}"` : ''}`).set('DPoP-Nonce', error.nonce).json({ error: 'use_dpop_nonce' });
      return res.status(503).json({ error: 'Authentication service unavailable' });
    }
    if (!principal) {
      const response = res.status(401);
      if (!(authenticator instanceof MtlsAuthenticator)) response.set('WWW-Authenticate', plugins.resourceMetadataUrl ? `${authenticator.challengeScheme ?? 'Bearer'} resource_metadata="${plugins.resourceMetadataUrl}"` : `${authenticator.challengeScheme ?? 'Bearer'} realm="mcp-gateway"`);
      return response.json({ error: 'Unauthorized' });
    }
    // Only the credential provider receives the inbound token, separately and
    // explicitly. Policy/routing contexts must not inherit a configured API key.
    const { token: _serviceCredential, ...identity } = principal;
    principal = identity;
    req.principal = principal;
    if (req.headers.origin && !(config.allowedOrigins ?? []).includes(req.headers.origin)) return res.status(403).json({ error: 'Origin denied' });
    const policy = principal.rateLimit ?? config.traffic?.rateLimit;
    const tool = req.body?.method === 'tools/call' && typeof req.body?.params?.name === 'string' ? req.body.params.name.slice(0, 128) : undefined;
    const toolPolicy = tool ? config.traffic?.toolRateLimits?.[tool] : undefined;
    try {
      for (const [scope, limit] of [[null, policy], [tool, toolPolicy]] as const) {
        if (!limit) continue;
        if (!await rateLimiter.consume(rateKey([principal.tenantId ?? 'default', principal.id, scope], limit), limit)) {
          await audit({ requestId: randomUUID(), at: new Date().toISOString(), clientId: principal.id, outcome: 'denied', method: 'gateway/rate_limit', ...(tool ? { tool } : {}) });
          return res.status(429).set('Retry-After', String(Math.max(1, Math.ceil(1 / limit.refillPerSecond)))).json({ error: 'Rate limit exceeded' });
        }
      }
    } catch { return res.status(503).json({ error: 'Traffic policy service unavailable' }); }
    let release;
    try { release = await limiter.acquire(principal.id, config.maxConcurrentPerClient ?? 8); }
    catch { return res.status(503).json({ error: 'Concurrency service unavailable' }); }
    if (!release) return res.status(429).set('Retry-After', '1').json({ error: 'Concurrency limit exceeded' });
    const releaseLease = release;
    const deadline = setTimeout(() => res.destroy(), 125000);
    res.once('close', () => {
      clearTimeout(deadline);
      void releaseLease().catch(() => console.error('Concurrency lease release failed'));
    });
    credentialContext.run({ principal, token }, next);
  });
  app.post('/catalog/search', async (req, res) => {
    if (!config.features?.catalogSearch) { res.status(404).json({ error: 'Catalog search is disabled' }); return; }
    const parsed = z.object({ query: z.string().trim().min(1).max(128), limit: z.number().int().min(1).max(200).default(20), detail: z.enum(['summary', 'full']).default('summary'), cursor: z.string().max(512).optional() }).strict().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid catalog search request' }); return; }
    const principal = req.principal!, requestId = randomUUID(), started = Date.now();
    const controller = new AbortController(); res.once('close', () => controller.abort());
    let outcome: AuditOutcome = 'ok';
    const safeAudit: AuditSink = async event => { try { await audit(event); } catch { console.error('Audit sink failed'); } };
    try {
      if (plugins.requireAudit) await audit({ requestId, at: new Date().toISOString(), clientId: principal.id, method: 'gateway/catalog.search', outcome: 'started' });
      const tools = await collectCatalog({ config, principal, router: catalogRouter, context: { principal, requestId }, signal: controller.signal, execute: upstreamRequest,
        canCall: async name => { try { return await authorizer.canCall(principal, name); } catch { return false; } },
        onRejected: async (upstream, name) => { outcome = 'partial'; await safeAudit({ requestId, at: new Date().toISOString(), clientId: principal.id, upstream, tool: name, outcome: 'denied', method: 'gateway/catalog_rejected' }); },
        onFailure: async upstream => { outcome = 'partial'; await safeAudit({ requestId, at: new Date().toISOString(), clientId: principal.id, upstream, outcome: 'discovery_failed' }); }
      });
      const { query, limit, detail, cursor } = parsed.data;
      const page = catalogPage(searchCatalog(tools, query), cursor, limit, [catalogBinding(principal), query, limit, detail]);
      res.set('X-Request-Id', requestId).json({ ...page, tools: detail === 'full' ? page.tools : page.tools.map(tool => ({ name: tool.name, description: tool.description, _meta: tool._meta ? { 'com.example.relay/contractFingerprint': tool._meta['com.example.relay/contractFingerprint'] } : undefined })) });
    } catch (error) {
      outcome = 'error';
      res.status(error instanceof InvalidCatalogCursor ? 400 : 503).json({ error: error instanceof InvalidCatalogCursor || error instanceof CatalogLimitExceeded ? error.message : 'Catalog search unavailable' });
    } finally {
      controller.abort();
      await safeAudit({ requestId, at: new Date().toISOString(), clientId: principal.id, method: 'gateway/catalog.search', outcome, durationMs: Date.now() - started });
    }
  });
  app.all('/mcp', (req, res) => requestTrace(req.body?.method, req.headers.traceparent, async () => {
    const principal = req.principal;
    if (!principal) { res.status(401).end(); return; }
    const requestId = randomUUID();
    const start = Date.now();
    const context = { principal, requestId };
    const streamAbort = new AbortController();
    const bus = new InMemoryServerEventBus();
    const visibleConfig = tenantConfig(config, principal);
    const listening = req.body?.method === 'subscriptions/listen' && config.features?.notifications;
    if (req.body?.method === 'subscriptions/listen' && !config.features?.notifications) { res.status(400).json({ jsonrpc: '2.0', id: req.body?.id, error: { code: -32601, message: 'Subscriptions are disabled' } }); return; }
    if (listening) {
      try { await validateSubscription(req.body.params?.notifications ?? {}, visibleConfig, principal, authorizer); }
      catch { res.status(403).json({ error: 'Subscription resource denied' }); return; }
    }
    let outcome: AuditOutcome = 'ok';
    let parameterMismatch = false;
    res.set('X-Request-Id', requestId);
    // Persist admission before any upstream work. Completion records are best effort:
    // an admitted operation may succeed even if the audit store later fails.
    if (plugins.requireAudit) {
      try { await audit({ requestId, at: new Date().toISOString(), clientId: principal.id, outcome: 'started', method: typeof req.body?.method === 'string' ? req.body.method.slice(0, 128) : 'invalid' }); }
      catch { res.status(503).json({ error: 'Audit store unavailable', requestId }); return; }
    }
    const safeAudit: AuditSink = async event => { try { await audit(event); } catch { console.error('Audit sink failed'); } };
    const canCall = async (name: string) => { try { return await authorizer.canCall(principal, name); } catch { return false; } };
    const handler = createMcpHandler(() => {
      const changes = Boolean(config.features?.notifications);
      const ServerImpl = config.features?.tasks ? TaskAwareServer : Server;
      const server = new ServerImpl({ name: 'agent-mcp-gateway', version: '0.12.0' }, { capabilities: {
        tools: changes ? { listChanged: true } : {},
        ...(config.features?.prompts ? { prompts: changes ? { listChanged: true } : {} } : {}),
        ...(config.features?.resources ? { resources: changes ? { listChanged: true, subscribe: true } : {} } : {}),
        ...(config.features?.prompts || config.features?.resources ? { completions: {} } : {}),
        ...(config.features?.tasks ? { extensions: { [TASKS_EXTENSION_ID_V2]: {} } } : {})
      } });
      registerFeatures(server, tenantConfig(config, principal), principal, authorizer, upstreamRequest, () => { outcome = 'denied'; }, continuation);
      server.setRequestHandler('tools/list', async (request, ctx) => {
        try {
          const tools = await collectCatalog({ config, principal, router: catalogRouter, context, signal: ctx.mcpReq.signal, canCall, execute: upstreamRequest,
            onRejected: async (upstream, name, error) => {
              outcome = 'partial';
              await safeAudit({ requestId, at: new Date().toISOString(), clientId: principal.id, upstream, tool: name, outcome: 'denied', method: error instanceof Error && error.message.startsWith('Tool definition changed') ? 'gateway/contract_drift' : 'gateway/catalog_rejected' });
            },
            onFailure: async upstream => { outcome = 'partial'; await safeAudit({ requestId, at: new Date().toISOString(), clientId: principal.id, upstream, outcome: 'discovery_failed' }); }
          });
          return catalogPage(tools, request.params?.cursor, config.discovery?.pageSize ?? 100, catalogBinding(principal));
        } catch (error) {
          outcome = 'error';
          throw new ProtocolError(error instanceof InvalidCatalogCursor ? ProtocolErrorCode.InvalidParams : ProtocolErrorCode.InternalError, error instanceof InvalidCatalogCursor || error instanceof CatalogLimitExceeded ? error.message : 'Tool catalog unavailable');
        }
      });
      server.setRequestHandler('tools/call', { params: CallToolRequestSchema.shape.params, result: CallToolResultSchema.or(CreateTaskResultV2Schema) }, async (params, ctx) => {
        const name = params.name;
        const tasksRequested = Boolean(config.features?.tasks && hasTaskClientCapabilityV2({ _meta: ctx.mcpReq.envelope as Record<string, unknown> }));
        if (!await canCall(name)) { outcome = 'denied'; throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Tool unavailable or forbidden'); }
        const binding = callBinding('tools/call', name, params.arguments ?? {});
        const state = stateFor(ctx, continuation, principal, binding);
        // A sealed continuation is bound to its previously selected target and
        // revalidated below; do not make it depend on a fresh router decision.
        let route = state ? undefined : await router.resolve(name, { ...context, signal: ctx.mcpReq.signal });
        if (state) {
          const target = config.upstreams.find(upstream => upstream.id === state.upstreamId && sameTenant(principal, upstream));
          const rule = config.routes?.find(rule => rule.name === name);
          const eligible = rule ? (!rule.clients || rule.clients.includes(principal.id)) && (!rule.tenants || rule.tenants.includes(principal.tenantId ?? 'default')) && (!rule.requiredRoles || rule.requiredRoles.every(role => principal.roles?.includes(role))) && rule.targets.some(target => target.enabled !== false && target.upstreamId === state.upstreamId && target.tool === state.upstreamTool) : name === `${state.upstreamId}__${state.upstreamTool}`;
          if (!target || !eligible) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Continuation route is no longer available');
          route = { upstream: target, tool: state.upstreamTool };
        }
        if (!route) { outcome = 'denied'; throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Tool unavailable or forbidden'); }
        // A trusted router can only select a configured upstream, never an arbitrary destination.
        const upstream = config.upstreams.find(upstream => upstream.id === route.upstream.id && sameTenant(principal, upstream));
        if (!upstream) { outcome = 'denied'; throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unregistered route'); }
        if (!configuredTarget(name, principal, upstream.id, route.tool)) { outcome = 'denied'; throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Route target is not configured for this tool'); }
        const physicalName = `${upstream.id}__${route.tool}`;
        try { enforceInvocation(config.invocationPolicies, [name, physicalName], principal, params.arguments ?? {}); }
        catch (error) { if (error instanceof InvocationDenied) { outcome = 'denied'; throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message); } throw error; }
        const inspection = { requestId, principal, requestedTool: name, upstreamId: upstream.id, upstreamTool: route.tool, arguments: params.arguments ?? {}, signal: ctx.mcpReq.signal };
        try {
          await inspectors.inspect('beforeCall', inspection);
        let routedFingerprint: string | undefined;
        const result = await upstreamRequest(upstream, async (client, options) => {
            const args = params.arguments ?? {};
            const tool = await checkToolArguments(client, route.tool, args, options, config.discovery);
            const toolContractFingerprint = enforceRoutedContract(tool, name, upstream.id, config);
            routedFingerprint = toolContractFingerprint;
            await assertAliasContracts(name, principal, upstream.id, route.tool, toolContractFingerprint, options.signal);
            const approvalRequired = (config.approvalRequiredTools ?? []).some(pattern => pattern.endsWith('__*') ? name.startsWith(pattern.slice(0, -1)) || physicalName.startsWith(pattern.slice(0, -1)) : pattern === name || pattern === physicalName);
            if (approvalRequired) {
              const requestMeta = params._meta && typeof params._meta === 'object' ? params._meta as Record<string, unknown> : {};
              const permit = requestMeta['com.agentrelay/approvalId'];
              if (permit !== undefined && (typeof permit !== 'string' || !/^[a-zA-Z0-9_.-]{16,256}$/.test(permit))) throw new ApprovalDenied();
              const decision = await plugins.approvalGate!.requestOrConsume({
                requestId, principal: { id: principal.id, tenantId: principal.tenantId, subject: principal.subject, oauthClientId: principal.oauthClientId },
                requestedTool: name, upstreamId: upstream.id, upstreamTool: route.tool,
                configurationRevision: plugins.configurationRevision ?? 0, toolContractFingerprint,
                arguments: args, signal: options.signal
              }, permit as string | undefined);
              if (permit === undefined) {
                if (decision.decision !== 'pending' || typeof decision.approvalId !== 'string' || !/^[a-zA-Z0-9_.-]{16,256}$/.test(decision.approvalId)) throw new ApprovalDenied();
                const event: import('./types.js').AuditEvent = { requestId, at: new Date().toISOString(), clientId: principal.id, upstream: upstream.id, tool: name, outcome: 'approval_pending', method: 'gateway/approval.requested', ...(plugins.configurationRevision !== undefined ? { configurationRevision: plugins.configurationRevision } : {}) };
                if (plugins.requireAudit) {
                  try { await audit(event); }
                  catch { throw new ProtocolError(-32023, 'Approval event could not be recorded; the action was not forwarded'); }
                } else await safeAudit(event);
                throw new ApprovalDenied(decision.approvalId);
              }
              if (decision.decision !== 'allow') throw new ApprovalDenied();
              const event: import('./types.js').AuditEvent = { requestId, at: new Date().toISOString(), clientId: principal.id, upstream: upstream.id, tool: name, outcome: 'approval_consumed', method: 'gateway/approval.consumed', ...(plugins.configurationRevision !== undefined ? { configurationRevision: plugins.configurationRevision } : {}) };
              if (plugins.requireAudit) {
                try { await audit(event); }
                catch { throw new ProtocolError(-32023, 'Approval event could not be recorded; the action was not forwarded'); }
              } else await safeAudit(event);
            }
            if (req.headers['mcp-protocol-version'] === '2026-07-28') validateParameterHeaders(tool.inputSchema, args, Object.fromEntries(Object.entries(req.headersDistinct).map(([key, values]) => [key, values?.length === 1 ? values[0] : values])));
            const headers = (upstream.transport ?? 'streamable-http') === 'streamable-http' && client.getProtocolEra() === 'modern' ? parameterHeaders(tool.inputSchema, args) : undefined;
            const callParams = { name: route.tool, arguments: args, ...(ctx.mcpReq.inputResponses ? { inputResponses: ctx.mcpReq.inputResponses } : {}), ...(state?.state ? { requestState: state.state } : {}) };
            const callRequest = { method: 'tools/call' as const, params: callParams };
            const callOptions = { ...options, headers, allowInputRequired: true };
            const result = tasksRequested && options.rawTaskDispatch
              ? await rawTaskRequest(options, 'tools/call', callRequest.params, undefined, callbackCapabilities(principal, ctx) as unknown as Record<string, unknown>) as Record<string, any>
              : config.features?.tasks
                ? await client.request(callRequest, CallToolResultSchema.or(CreateTaskResultV2Schema), callOptions) as unknown as Record<string, any>
                : await client.request(callRequest, callOptions) as unknown as Record<string, any>;
            if (result && typeof result === 'object' && (result as { resultType?: unknown }).resultType === 'task') {
              if (!config.features?.tasks || !taskCodec || !tasksRequested) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task results require an enabled, negotiated Tasks extension');
              const task = CreateTaskResultV2Schema.parse(result);
              if (!task.taskId || task.taskId.length > 1024) throw new Error('Invalid upstream task ID');
              const ttlMs = task.ttlMs === null ? 24 * 60 * 60 * 1000 : Math.min(task.ttlMs, 24 * 60 * 60 * 1000);
              if (ttlMs <= 0) throw new Error('Upstream task already expired');
              const publicTaskId = taskCodec.createId(), expiresAtMs = Date.now() + ttlMs;
              if (!routedFingerprint) throw new Error('Task route contract could not be pinned');
              const state: McpTaskState = { upstreamTaskId: task.taskId, upstreamId: upstream.id, upstreamTool: route.tool, publicTool: name, arguments: args, contractFingerprint: routedFingerprint, expiresAtMs };
              const ciphertext = taskCodec.seal(state, principal);
              try { await plugins.taskStore!.putMcpTask!(taskStorageKey(publicTaskId), ciphertext, expiresAtMs); }
              catch {
                // Do not hand out an ID that cannot be resolved after restart; cancellation is cooperative and best-effort.
                try { await rawTaskRequest(options, 'tasks/cancel', { taskId: task.taskId }, { 'Mcp-Name': task.taskId }, callbackCapabilities(principal, ctx) as unknown as Record<string, unknown>); } catch { /* The upstream may not support cancellation. */ }
                throw new ProtocolError(-32023, 'Task state could not be persisted; no task handle was returned');
              }
              return { ...task, taskId: publicTaskId, ttlMs } as any;
            }
            const pending = wrapInput(result, { codec: continuation, principal, ctx, binding, upstreamId: upstream.id, upstreamTool: route.tool, rounds: state?.rounds });
            if (pending) return pending;
            if (tool.outputSchema && !result.isError) {
              if (result.structuredContent === undefined || !(await schemaPool.validate(tool.outputSchema, result.structuredContent)).valid) throw new Error('Invalid upstream output');
            }
            return config.features?.resources ? rewriteResourceLinks(result, upstream.id) : result;
          }, ctx.mcpReq.signal, { principal, ctx });
          await inspectors.inspect('afterCall', inspection, result);
          if ((result as { isError?: boolean }).isError) outcome = 'tool_error';
          return result;
        } catch (error) {
          if (error instanceof ApprovalDenied) { outcome = 'denied'; throw new ProtocolError(-32022, error.message, error.approvalId ? { approvalId: error.approvalId } : undefined); }
          if (error instanceof ParameterHeaderMismatch) { outcome = 'error'; parameterMismatch = true; throw new ProtocolError(-32020, error.message); }
          if (error instanceof InspectionDenied) { outcome = 'denied'; throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message); }
          if (error instanceof ProtocolError) { outcome = 'error'; throw error; }
          if (error instanceof InvalidToolArguments || error instanceof InvalidParameterHeaders) { outcome = error instanceof CatalogDenied ? 'denied' : 'error'; throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message); }
          outcome = 'upstream_error';
          return { isError: true, content: [{ type: 'text' as const, text: 'Upstream unavailable or request timed out. The operation may have completed; do not retry side effects blindly.' }] };
        }
      });
      if (config.features?.tasks && taskCodec && plugins.taskStore) {
        const resolveTask = async (publicId: string) => {
          if (!/^[A-Za-z0-9_-]{43}$/.test(publicId)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task unavailable');
          const stored = await plugins.taskStore!.getMcpTask!(taskStorageKey(publicId));
          if (!stored) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task unavailable');
          let state: McpTaskState;
          try { state = taskCodec!.open(stored.ciphertext, principal); }
          catch { throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task unavailable'); }
          const upstream = config.upstreams.find(candidate => candidate.id === state.upstreamId && sameTenant(principal, candidate));
          if (!upstream || !await canCall(state.publicTool) || !configuredTarget(state.publicTool, principal, state.upstreamId, state.upstreamTool)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task unavailable');
          try { enforceInvocation(config.invocationPolicies, [state.publicTool, `${state.upstreamId}__${state.upstreamTool}`], principal, state.arguments); }
          catch { throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task unavailable'); }
          return { state, upstream };
        };
        const claimTaskInputs = async (publicId: string, baseline: McpTaskState, responses: Record<string, unknown>) => {
          for (let attempt = 0; attempt < 40; attempt++) {
            const stored = await plugins.taskStore!.getMcpTask!(taskStorageKey(publicId));
            if (!stored) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task unavailable');
            let current: McpTaskState;
            try { current = taskCodec!.open(stored.ciphertext, principal); }
            catch { throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task unavailable'); }
            if (current.upstreamTaskId !== baseline.upstreamTaskId || current.upstreamId !== baseline.upstreamId || current.contractFingerprint !== baseline.contractFingerprint) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task unavailable');
            const consumed = new Set(current.consumedInputKeys ?? []);
            const accepted: Record<string, unknown> = {};
            const claims: NonNullable<McpTaskState['pendingInputClaims']> = {};
            let waitingForClaim = false;
            for (const [key, response] of Object.entries(responses)) {
              const method = current.pendingInputMethods?.[key];
              if (!method || consumed.has(key) || !(principal.callbackMethods ?? []).includes(method)) continue;
              const existing = current.pendingInputClaims?.[key];
              if (existing) {
                if (canonicalJson(existing.response) !== canonicalJson(response)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task input response conflicts with an in-flight response');
                if (existing.leaseUntilMs > Date.now()) { waitingForClaim = true; continue; }
              }
              accepted[key] = response;
              claims[key] = { response, method, claimId: randomUUID(), leaseUntilMs: Date.now() + 180_000 };
            }
            if (!Object.keys(accepted).length) {
              if (!waitingForClaim) return { accepted, claimIds: {} as Record<string, string> };
              await new Promise(resolve => setTimeout(resolve, 50));
              continue;
            }
            const next: McpTaskState = { ...current, pendingInputClaims: { ...current.pendingInputClaims, ...claims } };
            if (await plugins.taskStore!.compareAndSetMcpTask!(taskStorageKey(publicId), stored.ciphertext, taskCodec!.seal(next, principal), current.expiresAtMs)) return { accepted, claimIds: Object.fromEntries(Object.entries(claims).map(([key, claim]) => [key, claim.claimId])) };
          }
          throw new ProtocolError(-32023, 'Task input update is already being processed; retry after observing the task');
        };
        const completeTaskInputs = async (publicId: string, baseline: McpTaskState, claimIds: Record<string, string>) => {
          for (let attempt = 0; attempt < 8; attempt++) {
            const stored = await plugins.taskStore!.getMcpTask!(taskStorageKey(publicId));
            if (!stored) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task unavailable');
            let current: McpTaskState;
            try { current = taskCodec!.open(stored.ciphertext, principal); }
            catch { throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task unavailable'); }
            if (current.upstreamTaskId !== baseline.upstreamTaskId || current.upstreamId !== baseline.upstreamId) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task unavailable');
            const claims = { ...current.pendingInputClaims };
            const methods = { ...current.pendingInputMethods };
            const consumed = new Set(current.consumedInputKeys ?? []);
            let changed = false;
            for (const [key, claimId] of Object.entries(claimIds)) {
              if (claims[key]?.claimId !== claimId) continue;
              delete claims[key]; delete methods[key]; consumed.add(key); changed = true;
            }
            if (!changed) return;
            const next: McpTaskState = { ...current, pendingInputClaims: claims, pendingInputMethods: methods, consumedInputKeys: [...consumed] };
            if (await plugins.taskStore!.compareAndSetMcpTask!(taskStorageKey(publicId), stored.ciphertext, taskCodec!.seal(next, principal), current.expiresAtMs)) return;
          }
          throw new ProtocolError(-32023, 'Task acknowledgement could not be committed; observe the task before retrying');
        };
        const persistTaskPoll = async (publicId: string, baseline: McpTaskState, task: import('@modelcontextprotocol/ext-tasks/core/v2').GetTaskResultV2, requestCtx: ServerContext) => {
          for (let attempt = 0; attempt < 8; attempt++) {
            const stored = await plugins.taskStore!.getMcpTask!(taskStorageKey(publicId));
            if (!stored) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task unavailable');
            let current: McpTaskState;
            try { current = taskCodec!.open(stored.ciphertext, principal); }
            catch { throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task unavailable'); }
            if (current.upstreamTaskId !== baseline.upstreamTaskId || current.upstreamId !== baseline.upstreamId) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task unavailable');
            const consumed = new Set(current.consumedInputKeys ?? []);
            let publicTask = task;
            const pending: Record<string, string> = {};
            if (task.status === 'input_required') {
              if (!config.features?.callbacks || !continuation) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task callback support is disabled');
              const caps = callbackCapabilities(principal, requestCtx);
              const visibleRequests: Record<string, (typeof task.inputRequests)[string]> = {};
              for (const [key, inputRequest] of Object.entries(task.inputRequests)) {
                if (consumed.has(key)) continue;
                const method = inputRequest.method;
                if (current.pendingInputClaims?.[key] && current.pendingInputClaims[key].method !== method) throw new ProtocolError(ProtocolErrorCode.InternalError, 'Upstream reused a task input key for a different request');
                if (!(principal.callbackMethods ?? []).includes(method) || method === 'sampling/createMessage' && !caps.sampling || method === 'roots/list' && !caps.roots || method === 'elicitation/create' && !caps.elicitation) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task callback permission or capability missing');
                pending[key] = method;
                visibleRequests[key] = inputRequest;
              }
              publicTask = { ...task, inputRequests: visibleRequests };
            }
            const activeClaimMethods = Object.fromEntries(Object.entries(current.pendingInputClaims ?? {}).flatMap(([key, claim]) => current.pendingInputMethods?.[key] === claim.method ? [[key, claim.method]] : []));
            const next = { ...current, pendingInputMethods: { ...pending, ...activeClaimMethods } };
            if (await plugins.taskStore!.compareAndSetMcpTask!(taskStorageKey(publicId), stored.ciphertext, taskCodec!.seal(next, principal), current.expiresAtMs)) {
              const remaining = Math.max(0, Math.min(task.ttlMs ?? 24 * 60 * 60 * 1000, current.expiresAtMs - Date.now()));
              return { ...publicTask, taskId: publicId, ttlMs: remaining };
            }
          }
          throw new ProtocolError(-32023, 'Task state changed repeatedly; retry task observation');
        };
        const authorizedTaskRequest = async (publicId: string, requestCtx: ServerContext, operation: (client: Client, options: OperationOptions, state: McpTaskState, tool: Tool) => Promise<unknown>) => {
          const suppliedName = req.headers['mcp-name'];
          if (typeof suppliedName !== 'string' || suppliedName !== publicId) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task routing header mismatch');
          const { state, upstream } = await resolveTask(publicId);
          return upstreamRequest(upstream, async (client, options) => {
            const tool = await checkToolArguments(client, state.upstreamTool, state.arguments, options, config.discovery);
            const fingerprint = enforceRoutedContract(tool, state.publicTool, state.upstreamId, config);
            if (fingerprint !== state.contractFingerprint) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task contract has changed');
            await assertAliasContracts(state.publicTool, principal, state.upstreamId, state.upstreamTool, fingerprint, options.signal);
            return operation(client, options, state, tool);
          }, requestCtx.mcpReq.signal, { principal, ctx: requestCtx });
        };
        server.setRequestHandler('tasks/get', { params: GetTaskRequestV2Schema.shape.params, result: GetTaskResultV2Schema }, (async (params: { taskId: string }, requestCtx: ServerContext) => {
          const result = await authorizedTaskRequest(params.taskId, requestCtx, async (_client, options, state, tool) => {
            await inspectors.inspect('beforeCall', { requestId, principal, requestedTool: state.publicTool, upstreamId: state.upstreamId, upstreamTool: state.upstreamTool, arguments: state.arguments, signal: requestCtx.mcpReq.signal });
            return { task: await rawTaskRequest(options, 'tasks/get', { taskId: state.upstreamTaskId }, { 'Mcp-Name': state.upstreamTaskId }, callbackCapabilities(principal, requestCtx) as unknown as Record<string, unknown>), tool, state };
          });
          const { task: rawTask, tool, state } = result as { task: unknown; tool: Tool; state: McpTaskState };
          const task = GetTaskResultV2Schema.parse(rawTask);
          if (task.status === 'completed' && tool.outputSchema && task.result && typeof task.result === 'object') {
            const toolResult = task.result as { isError?: boolean; structuredContent?: unknown };
            if (!toolResult.isError && (toolResult.structuredContent === undefined || !(await schemaPool.validate(tool.outputSchema, toolResult.structuredContent)).valid)) throw new ProtocolError(ProtocolErrorCode.InternalError, 'Invalid upstream task result');
          }
          if (task.taskId !== state.upstreamTaskId) throw new ProtocolError(ProtocolErrorCode.InternalError, 'Upstream task response mismatch');
          const publicTask = await persistTaskPoll(params.taskId, state, task, requestCtx);
          await inspectors.inspect('afterCall', { requestId, principal, requestedTool: state.publicTool, upstreamId: state.upstreamId, upstreamTool: state.upstreamTool, arguments: state.arguments, signal: requestCtx.mcpReq.signal }, publicTask);
          return publicTask;
        }) as any);
        server.setRequestHandler('tasks/update', { params: GetTaskRequestV2Schema.shape.params, result: UpdateTaskResultV2Schema }, async (params, requestCtx) => authorizedTaskRequest(params.taskId, requestCtx, async (_client, options, state) => {
          const rawInputResponses = req.body?.params?.inputResponses ?? requestCtx.mcpReq.inputResponses;
          const inputParsed = UpdateTaskRequestV2Schema.shape.params.safeParse({ taskId: params.taskId, inputResponses: rawInputResponses });
          const inputResponses = inputParsed.success ? inputParsed.data.inputResponses : undefined;
          if (!inputResponses || typeof inputResponses !== 'object' || Array.isArray(inputResponses)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task input responses are required');
          const typedResponses = InputResponsesV2Schema.safeParse(inputResponses);
          if (!typedResponses.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task input responses are invalid');
          const currentlyAuthorized = Object.fromEntries(Object.entries(typedResponses.data).filter(([key]) => state.pendingInputMethods?.[key] && (principal.callbackMethods ?? []).includes(state.pendingInputMethods[key])));
          if (Object.keys(currentlyAuthorized).length) await inspectors.inspect('beforeCall', { requestId, principal, requestedTool: state.publicTool, upstreamId: state.upstreamId, upstreamTool: state.upstreamTool, arguments: state.arguments, taskInputResponses: currentlyAuthorized, signal: requestCtx.mcpReq.signal });
          const { accepted, claimIds } = await claimTaskInputs(params.taskId, state, currentlyAuthorized);
          if (!Object.keys(accepted).length) return { resultType: 'complete' };
          const result = UpdateTaskResultV2Schema.parse(await rawTaskRequest(options, 'tasks/update', { taskId: state.upstreamTaskId, inputResponses: accepted }, { 'Mcp-Name': state.upstreamTaskId }, callbackCapabilities(principal, requestCtx) as unknown as Record<string, unknown>));
          await completeTaskInputs(params.taskId, state, claimIds);
          await inspectors.inspect('afterCall', { requestId, principal, requestedTool: state.publicTool, upstreamId: state.upstreamId, upstreamTool: state.upstreamTool, arguments: state.arguments, signal: requestCtx.mcpReq.signal }, result);
          return result;
        }) as any);
        server.setRequestHandler('tasks/cancel', { params: CancelTaskRequestV2Schema.shape.params, result: CancelTaskResultV2Schema }, async (params, requestCtx) => CancelTaskResultV2Schema.parse(await authorizedTaskRequest(params.taskId, requestCtx, async (_client, options, state) => {
          await inspectors.inspect('beforeCall', { requestId, principal, requestedTool: state.publicTool, upstreamId: state.upstreamId, upstreamTool: state.upstreamTool, arguments: state.arguments, signal: requestCtx.mcpReq.signal });
          const result = await rawTaskRequest(options, 'tasks/cancel', { taskId: state.upstreamTaskId }, { 'Mcp-Name': state.upstreamTaskId });
          await inspectors.inspect('afterCall', { requestId, principal, requestedTool: state.publicTool, upstreamId: state.upstreamId, upstreamTool: state.upstreamTool, arguments: state.arguments, signal: requestCtx.mcpReq.signal }, result);
          return result;
        })) as any);
      }
      return server;
    }, { legacy: 'stateless', bus, maxRequestBodySize: 256 * 1024, onerror: () => { if (outcome === 'ok') outcome = 'error'; } });
    const cleanup = () => { streamAbort.abort(); void handler.close(); };
    res.once('close', cleanup);
    let revisionTimer: NodeJS.Timeout | undefined;
    if (listening) {
      if (plugins.isRevisionCurrent) revisionTimer = setInterval(() => { void plugins.isRevisionCurrent!().then(current => { if (!current) cleanup(); }).catch(cleanup); }, 1000);
      void relaySubscriptions({ config: visibleConfig, principal, filter: (req.body.params?.notifications ?? {}) as SubscriptionFilter, authorizer, bus, execute: (upstream, operation, signal) => upstreamRequest(upstream, operation, signal, { principal, subscription: true }), signal: streamAbort.signal, current: plugins.isRevisionCurrent, close: cleanup });
    }
    try {
      await toNodeHandler({ fetch: async (request, options) => {
        const response = await handler.fetch(request, options);
        // The low-level SDK dispatches protocol errors with HTTP 200. SEP-2243 requires 400.
        return parameterMismatch ? new Response(response.body, { status: 400, headers: response.headers }) : response;
      } })(req, res, req.body);
      if (res.statusCode >= 400 && outcome === 'ok') outcome = 'error';
    } catch {
      outcome = 'error';
      if (!res.headersSent) res.status(500).json({ error: 'Gateway error', requestId });
    } finally {
      if (revisionTimer) clearInterval(revisionTimer);
      streamAbort.abort();
      traceOutcome(outcome);
      await safeAudit({ requestId, at: new Date().toISOString(), clientId: principal.id, method: typeof req.body?.method === 'string' ? req.body.method.slice(0, 128) : 'invalid', tool: typeof req.body?.params?.name === 'string' ? req.body.params.name.slice(0, 128) : undefined, outcome, durationMs: Date.now() - start });
    }
  }));
  const errors: ErrorRequestHandler = (error, req, res, _next) => {
    const status = error.type === 'entity.too.large' ? 413 : 400;
    const modern = req.headers['mcp-protocol-version'] === '2026-07-28';
    res.status(status).json({ jsonrpc: '2.0', ...(modern ? {} : { id: null }), error: { code: error.type === 'entity.parse.failed' ? -32700 : -32600, message: status === 413 ? 'Request too large' : 'Invalid request' } });
  };
  app.use(errors);
  return app;
}

