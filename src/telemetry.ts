import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, type SpanExporter } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { environmentCredentialBindings } from './credential-bindings.js';
import { assertEgressEndpointAllowed, pinnedEgressLookup, validateEgressCidrs, type EgressPolicy } from './egress.js';
const methods = new Set(['initialize', 'ping', 'tools/list', 'tools/call', 'prompts/list', 'prompts/get', 'resources/list', 'resources/read', 'resources/templates/list', 'completion/complete', 'subscriptions/listen']);
export const traceMethod = (value: unknown) => typeof value === 'string' && methods.has(value) ? value : 'other';
export function configureTracing(env: NodeJS.ProcessEnv, exporter?: SpanExporter, resolveAddresses?: EgressPolicy['resolveAddresses']) {
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (!endpoint && !exporter) return undefined;
  let traceEndpoint = endpoint;
  if (!traceEndpoint && env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    const root = env.OTEL_EXPORTER_OTLP_ENDPOINT.endsWith('/') ? env.OTEL_EXPORTER_OTLP_ENDPOINT : `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/`;
    traceEndpoint = new URL('v1/traces', root).href;
  }
  if (!traceEndpoint && !exporter) return undefined;
  if (env.GATEWAY_REQUIRE_EGRESS_VALIDATION !== undefined && !['true', 'false'].includes(env.GATEWAY_REQUIRE_EGRESS_VALIDATION)) throw new Error('Invalid egress validation mode');
  const requireEgressValidation = env.GATEWAY_REQUIRE_CREDENTIAL_BINDINGS === 'true' || env.GATEWAY_REQUIRE_EGRESS_VALIDATION === 'true';
  if (env.GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS !== undefined && !requireEgressValidation) throw new Error('Private egress CIDRs require egress validation to be enabled');
  const egressPolicy: EgressPolicy | undefined = requireEgressValidation ? {
    allowedPrivateCidrs: validateEgressCidrs(env.GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS?.split(',').map(cidr => cidr.trim()) ?? []),
    ...(resolveAddresses ? { resolveAddresses } : {})
  } : undefined;
  const bindings = environmentCredentialBindings(env);
  if (env.GATEWAY_REQUIRE_CREDENTIAL_BINDINGS !== undefined && !['true', 'false'].includes(env.GATEWAY_REQUIRE_CREDENTIAL_BINDINGS)) throw new Error('Invalid credential binding enforcement mode');
  if (traceEndpoint) {
    const url = new URL(traceEndpoint);
    if (url.username || url.password || url.hash || url.protocol !== 'https:' && !(env.OTEL_ALLOW_LOCAL_HTTP === 'true' && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Trace endpoint requires HTTPS or explicit loopback HTTP');
    if (egressPolicy) assertEgressEndpointAllowed(url, egressPolicy);
    if (env.GATEWAY_REQUIRE_CREDENTIAL_BINDINGS === 'true') {
      if (!bindings) throw new Error('Trace endpoint requires deployment credential bindings');
      bindings.assertAllowed('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', url.href, 'telemetry-endpoint');
    }
    for (const reference of ['OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_TRACES_HEADERS']) if (env[reference]) {
      if (!bindings) throw new Error('Telemetry credentials require deployment credential bindings');
      bindings.assertAllowed(reference, url.href, 'telemetry-export');
    }
    for (const reference of ['OTEL_EXPORTER_OTLP_CLIENT_KEY', 'OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY']) if (env[reference]) {
      if (!bindings) throw new Error('Telemetry credentials require deployment credential bindings');
      bindings.assertAllowed(reference, url.href, 'telemetry-client-identity');
    }
  }
  const ratio = Number(env.OTEL_TRACES_SAMPLE_RATIO ?? '0.1');
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new Error('Invalid trace sampling ratio');
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': env.OTEL_SERVICE_NAME ?? 'relay-gateway', 'service.version': '0.12.0' }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }),
    spanProcessors: [exporter ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(new OTLPTraceExporter({ url: traceEndpoint, timeoutMillis: 3000, ...(egressPolicy ? { httpAgentOptions: async (protocol: string) => {
      const node = protocol === 'http:' ? await import('node:http') : await import('node:https');
      return new node.Agent({ keepAlive: false, lookup: pinnedEgressLookup(egressPolicy) });
    } } : {}) }), { maxQueueSize: 2048, maxExportBatchSize: 128, scheduledDelayMillis: 1000, exportTimeoutMillis: 4000 })]
  });
  provider.register();
  return provider;
}
export function requestTrace<T>(method: unknown, incoming: unknown, operation: () => Promise<T>) {
  // Accept trace linkage only, never caller baggage or arbitrary headers as attributes.
  const parent = propagation.extract(ROOT_CONTEXT, typeof incoming === 'string' ? { traceparent: incoming } : {});
  return context.with(parent, () => runTrace('mcp.request', { 'mcp.method': traceMethod(method) }, operation, SpanKind.SERVER));
}
export function runTrace<T>(name: string, attributes: Attributes, operation: () => Promise<T>, kind = SpanKind.CLIENT): Promise<T> {
  return trace.getTracer('relay-gateway', '0.12.0').startActiveSpan(name, { attributes, kind }, async span => {
    try { return await operation(); }
    catch (error) { span.setStatus({ code: SpanStatusCode.ERROR, message: 'Operation failed' }); throw error; }
    finally { span.end(); }
  });
}
export function traceOutcome(outcome: string) {
  const span = trace.getActiveSpan(); span?.setAttribute('mcp.outcome', outcome);
  if (outcome !== 'ok') span?.setStatus({ code: SpanStatusCode.ERROR, message: 'MCP operation did not succeed' });
}
export function traceHeaders() { const carrier: Record<string, string> = {}; propagation.inject(context.active(), carrier); return carrier; }
