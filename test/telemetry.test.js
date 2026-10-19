import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { configureTracing } from '../dist/telemetry.js';
import { createGateway } from '../dist/gateway.js';
import { createModernDemoServer } from '../dist/demo-modern.js';
import { listen, serviceToken } from './helpers.js';

test('OpenTelemetry links request/upstream spans, records MCP denial and exports without payloads or credentials',async t=>{
  const memory=new InMemorySpanExporter(),provider=configureTracing({OTEL_TRACES_SAMPLE_RATIO:'1',OTEL_SERVICE_NAME:'relay-test'},memory);
  t.after(()=>provider.shutdown());
  const seen=[];const app=express();app.use((req,_res,next)=>{seen.push(req.headers.traceparent);next();});app.use(createModernDemoServer('traced'));
  const upstream=await listen(app,t);
  const url=await listen(createGateway({allowLocalHttp:true,clients:[{id:'secret-identity',token:serviceToken,allow:['alpha__echo']}],upstreams:[{id:'alpha',url:`${upstream}/mcp`}]}),t);
  const traceId='1234567890abcdef1234567890abcdef';
  const client=new Client({name:'trace-test',version:'1'});t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${serviceToken}`,traceparent:`00-${traceId}-1234567890abcdef-01`,baggage:'secret=do-not-export'}}}));
  await client.listTools();
  await client.callTool({name:'alpha__echo',arguments:{text:'private-tool-payload'}});
  await assert.rejects(client.callTool({name:'forbidden',arguments:{text:'never-send'}}),/forbidden/);
  for(let i=0;i<50 && memory.getFinishedSpans().filter(s=>s.name==='mcp.request').length<3;i++) await new Promise(r=>setTimeout(r,10));
  await provider.forceFlush();
  const spans=memory.getFinishedSpans();
  const calls=spans.filter(s=>s.name==='mcp.request');assert.ok(calls.length>=3);
  assert.ok(calls.every(s=>s.spanContext().traceId===traceId));
  assert.ok(spans.some(s=>s.name==='mcp.upstream'&&calls.some(parent=>s.parentSpanContext?.spanId===parent.spanContext().spanId)));
  assert.ok(calls.some(s=>s.attributes['mcp.outcome']==='denied'&&s.status.code===2));
  assert.ok(seen.some(value=>value?.includes(traceId)));
  const serialized=JSON.stringify(spans.map(s=>({name:s.name,attributes:s.attributes,events:s.events,status:s.status})));
  for(const secret of [serviceToken,'private-tool-payload','secret-identity','do-not-export','never-send']) assert.equal(serialized.includes(secret),false);
  let exported;
  const receiver=express();receiver.use(express.raw({type:'*/*'}));receiver.post('/v1/traces',(req,res)=>{exported=JSON.parse(req.body.toString());res.json({});});
  const endpoint=await listen(receiver,t);
  const exporter=new OTLPTraceExporter({url:`${endpoint}/v1/traces`,timeoutMillis:3000});
  await new Promise((resolve,reject)=>exporter.export(spans,result=>result.code===0?resolve():reject(result.error)));
  await exporter.shutdown();
  assert.ok(exported.resourceSpans.length>0);assert.equal(JSON.stringify(exported).includes(serviceToken),false);
});

test('tracing rejects unsafe endpoints and invalid sampling configuration',()=>{
  assert.equal(configureTracing({}),undefined);
  assert.throws(()=>configureTracing({OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:'http://untrusted.example/v1/traces'}),/HTTPS/);
  assert.throws(()=>configureTracing({OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:'https://collector.example/v1/traces',OTEL_TRACES_SAMPLE_RATIO:'NaN'}),/sampling/);
});

test('strict telemetry egress denies secret-bearing OTLP export before an unsafe resolved endpoint receives it',async t=>{
  let hits=0;const receiver=express();receiver.use(express.raw({type:'*/*'}));receiver.post('/v1/traces',(_req,res)=>{hits++;res.json({});});
  const local=await listen(receiver,t),endpoint=`https://otel-egress.test${new URL(local).port?`:${new URL(local).port}`:''}/v1/traces`;
  let resolutions=0;
  const bindings=[
    {reference:'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',endpoint,purpose:'telemetry-endpoint'},
    {reference:'OTEL_EXPORTER_OTLP_TRACES_HEADERS',endpoint,purpose:'telemetry-export'}
  ];
  const provider=configureTracing({
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:endpoint,
    OTEL_EXPORTER_OTLP_TRACES_HEADERS:'authorization=telemetry-secret',
    OTEL_TRACES_SAMPLE_RATIO:'1',
    GATEWAY_REQUIRE_CREDENTIAL_BINDINGS:'true',
    GATEWAY_CREDENTIAL_BINDINGS:JSON.stringify(bindings)
  },undefined,async hostname=>{resolutions++;assert.equal(hostname,'otel-egress.test');return[{address:'127.0.0.1',family:4}];});
  t.after(()=>provider.shutdown());
  provider.getTracer('egress-test').startSpan('safe-span').end();
  await provider.forceFlush().catch(()=>{});
  assert.equal(resolutions,1);
  assert.equal(hits,0,'the collector must not receive a credential-bearing request to a forbidden address');
});

test('strict telemetry egress exports to an explicitly allowed private collector using the pinned address',async t=>{
  let hits=0;const receiver=express();receiver.use(express.raw({type:'*/*'}));receiver.post('/v1/traces',(req,res)=>{hits++;assert.ok(req.body.length>0);res.json({});});
  const local=await listen(receiver,t),port=new URL(local).port;let resolutions=0;
  const provider=configureTracing({
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:`http://localhost:${port}/v1/traces`,
    OTEL_ALLOW_LOCAL_HTTP:'true',OTEL_TRACES_SAMPLE_RATIO:'1',
    GATEWAY_REQUIRE_EGRESS_VALIDATION:'true',GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS:'127.0.0.0/8'
  },undefined,async hostname=>{resolutions++;assert.equal(hostname,'localhost');return[{address:'127.0.0.1',family:4}];});
  t.after(()=>provider.shutdown());
  provider.getTracer('egress-allowed-test').startSpan('safe-span').end();
  await provider.forceFlush();
  assert.equal(resolutions,1);
  assert.equal(hits,1,'an explicitly allowed private collector should receive the export');
});
