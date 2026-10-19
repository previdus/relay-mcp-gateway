import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { loadConfig } from '../dist/config.js';
import { validateConfig } from '../dist/validation.js';
import { ExactCredentialBindings, environmentCredentialBindings } from '../dist/credential-bindings.js';
import { upstreamFetch } from '../dist/egress.js';
import { createGateway } from '../dist/gateway.js';
import { createRuntime } from '../dist/runtime.js';
import { environmentPlugins } from '../dist/runtime.js';
import { SqliteStore } from '../dist/store.js';
import { ConfigRouter, AllowListAuthorizer } from '../dist/plugins.js';
import { createModernDemoServer } from '../dist/demo-modern.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { listen, serviceToken } from './helpers.js';
import { configureTracing } from '../dist/telemetry.js';

const document={clients:[{id:'agent',tokenEnv:'AGENT_KEY',allow:['alpha__*']}],upstreams:[{id:'alpha',url:'https://service.example/mcp',tokenEnv:'BACKEND_KEY'}]};
const rule={reference:'BACKEND_KEY',endpoint:'https://service.example/mcp',purpose:'upstream'};
const destination={reference:'MCP_UPSTREAM_ALPHA',endpoint:'https://service.example/mcp',purpose:'upstream-endpoint'};
const env={AGENT_KEY:serviceToken,BACKEND_KEY:'backend-private-key',OAUTH_SECRET:'oauth-private-key',OAUTH_ID:'gateway'};

test('deployment bindings deny destination repointing before reading a secret',()=>{
  let reads=0;const environment={...env,GATEWAY_CREDENTIAL_BINDINGS:JSON.stringify([rule,destination])};
  Object.defineProperty(environment,'BACKEND_KEY',{get(){reads++;return 'private';}});
  for(const url of ['https://attacker.example/mcp','https://service.example/other','https://service.example:444/mcp','http://service.example/mcp','https://service.example/mcp?recipient=other']) {
    assert.throws(()=>loadConfig({...document,upstreams:[{...document.upstreams[0],url}]},environment),/not approved/);
  }
  assert.equal(reads,0);
  assert.equal(loadConfig(document,environment).upstreams[0].token,'private');assert.equal(reads,1);
});

test('OAuth upstream client authentication defaults to Basic and permits only explicit post compatibility', () => {
  const upstream = { id: 'alpha', url: 'https://service.example/mcp', oauth: { mode: 'client_credentials', tokenEndpoint: 'https://identity.example/token', clientIdEnv: 'OAUTH_ID', clientSecretEnv: 'OAUTH_SECRET' } };
  const basic = loadConfig({ ...document, upstreams: [upstream] }, env);
  assert.equal(basic.upstreams[0].oauth.clientAuthMethod, 'client_secret_basic');
  const post = loadConfig({ ...document, upstreams: [{ ...upstream, oauth: { ...upstream.oauth, clientAuthMethod: 'client_secret_post' } }] }, env);
  assert.equal(post.upstreams[0].oauth.clientAuthMethod, 'client_secret_post');
  assert.throws(() => loadConfig({ ...document, upstreams: [{ ...upstream, oauth: { ...upstream.oauth, clientAuthMethod: 'none' } }] }, env), /Invalid gateway configuration/);
  assert.throws(() => validateConfig({ ...basic, upstreams: [{ ...basic.upstreams[0], oauth: { ...basic.upstreams[0].oauth, clientAuthMethod: 'none' } }] }), /Invalid upstream OAuth client authentication configuration/);
});

test('administrator API cannot repoint a bound upstream and error responses reveal no credential',async t=>{
  const policy=[rule,destination],environment={...env,GATEWAY_CREDENTIAL_BINDINGS:JSON.stringify(policy)};
  const store=new SqliteStore(':memory:',document);t.after(()=>store.close());
  const base=await listen(createRuntime(store,{adminKey:'administrator-key-longer-than-24-characters',environment}),t);
  const response=await fetch(`${base}/admin/api/validate`,{method:'POST',headers:{Authorization:'Bearer administrator-key-longer-than-24-characters','Content-Type':'application/json'},body:JSON.stringify({...document,upstreams:[{...document.upstreams[0],url:'https://attacker.example/collect'}]})});
  assert.equal(response.status,400);
  const body=await response.text();assert.ok(!body.includes(env.BACKEND_KEY));assert.ok(!body.includes('attacker.example'));
  assert.equal((await store.read()).document.upstreams[0].url,document.upstreams[0].url);
});

test('bindings canonicalize default ports but never accept wildcard or suffix matches',()=>{
  const policy=new ExactCredentialBindings([rule]);
  assert.doesNotThrow(()=>policy.assertAllowed('BACKEND_KEY','https://SERVICE.example:443/mcp','upstream'));
  for(const endpoint of ['https://service.example.evil/mcp','https://evil@service.example/mcp','https://service.example/mcp#x']) assert.throws(()=>policy.assertAllowed('BACKEND_KEY',endpoint,'upstream'));
  assert.throws(()=>policy.assertAllowed('OTHER_KEY',rule.endpoint,'upstream'));
  assert.throws(()=>policy.assertAllowed('BACKEND_KEY',rule.endpoint,'oauth-token'));
});

test('malformed binding policy fails closed without echoing document or secrets',()=>{
  for(const raw of ['', '{private-secret', '{}', '[{"reference":"BACKEND_KEY","endpoint":"https://example.com","purpose":"any"}]', 'x'.repeat(1024*1024+1)]) {
    assert.throws(()=>environmentCredentialBindings({GATEWAY_CREDENTIAL_BINDINGS:raw}),error=>error.message==='Invalid deployment credential bindings');
  }
  assert.throws(()=>loadConfig(document,{...env,GATEWAY_CREDENTIAL_BINDINGS:'[]'}),/not approved/);
  assert.throws(()=>loadConfig({...document,credentialBindings:[rule]},env),/Invalid gateway configuration/);
});

test('OAuth bindings require both the token issuer destination and downstream token recipient',()=>{
  const oauth={mode:'client_credentials',tokenEndpoint:'https://identity.example/token',clientIdEnv:'OAUTH_ID',clientSecretEnv:'OAUTH_SECRET'};
  const config={...document,upstreams:[{id:'alpha',url:rule.endpoint,oauth}]};
  const issuer={reference:'OAUTH_SECRET',endpoint:oauth.tokenEndpoint,purpose:'oauth-token'};
  const recipient={reference:'OAUTH_SECRET',endpoint:rule.endpoint,purpose:'oauth-recipient'};
  assert.throws(()=>loadConfig(config,env,new ExactCredentialBindings([issuer])),/not approved/);
  const policy=new ExactCredentialBindings([issuer,recipient,destination]);assert.doesNotThrow(()=>loadConfig(config,env,policy));
  assert.throws(()=>loadConfig({...config,upstreams:[{...config.upstreams[0],url:'https://attacker.example/mcp'}]},env,policy),/not approved/);
  assert.throws(()=>loadConfig({...config,upstreams:[{...config.upstreams[0],oauth:{...oauth,tokenEndpoint:'https://attacker.example/token'}}]},env,policy),/not approved/);
});

test('deployment-bound SSE requires approval for each message path',()=>{
  const config={...document,upstreams:[{...document.upstreams[0],transport:'sse'}]};
  const base={...destination,endpoint:'https://service.example/mcp'};
  assert.throws(()=>loadConfig(config,env,new ExactCredentialBindings([rule,base])),/explicit request paths/);
  config.upstreams[0].requestPaths=['/mcp','/messages'];
  assert.throws(()=>loadConfig(config,env,new ExactCredentialBindings([rule,base])),/not approved/);
  assert.doesNotThrow(()=>loadConfig(config,env,new ExactCredentialBindings([rule,base,{...rule,endpoint:'https://service.example/messages',purpose:'upstream'},{...base,endpoint:'https://service.example/messages'}])));
});

test('stdio secret references have a separate purpose and endpoint binding',()=>{
  const config={...document,upstreams:[{id:'worker',url:'stdio://worker',transport:'stdio',command:'/approved/node',envRefs:{API_KEY:'BACKEND_KEY'}}]};
  assert.throws(()=>loadConfig(config,env,new ExactCredentialBindings([rule])),/not approved/);
  const commandBinding={...rule,endpoint:'stdio://worker/%2Fapproved%2Fnode',purpose:'stdio-environment'};
  assert.doesNotThrow(()=>loadConfig(config,env,new ExactCredentialBindings([commandBinding])));
  assert.throws(()=>loadConfig({...config,upstreams:[{...config.upstreams[0],command:'/approved/other'}]},env,new ExactCredentialBindings([commandBinding])),/not approved/);
});

test('production binding mode is explicit, validated and rejects missing policy',()=>{
  const config={...document,upstreams:[{...document.upstreams[0],tokenEnv:undefined}]};
  assert.throws(()=>environmentPlugins(config,{GATEWAY_REQUIRE_CREDENTIAL_BINDINGS:'true'}),/require deployment credential bindings/);
  assert.throws(()=>environmentPlugins(config,{GATEWAY_REQUIRE_CREDENTIAL_BINDINGS:'treu'}),/Invalid credential binding enforcement/);
  assert.doesNotThrow(()=>environmentPlugins(config,{GATEWAY_REQUIRE_CREDENTIAL_BINDINGS:'false'}));
  const strict = environmentPlugins(config,{GATEWAY_REQUIRE_CREDENTIAL_BINDINGS:'true',GATEWAY_CREDENTIAL_BINDINGS:JSON.stringify([destination])});
  assert.deepEqual(strict.egressPolicy?.allowedPrivateCidrs, []);
  assert.throws(()=>environmentPlugins({...config,upstreams:[]},{GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS:'10.0.0.0/8'}),/require egress validation/);
  assert.deepEqual(environmentPlugins({...config,upstreams:[]},{GATEWAY_REQUIRE_EGRESS_VALIDATION:'true',GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS:'10.24.0.0/16,fc00::/7'}).egressPolicy?.allowedPrivateCidrs,['10.24.0.0/16','fc00::/7']);
  assert.throws(()=>environmentPlugins({...config,upstreams:[]},{GATEWAY_REQUIRE_EGRESS_VALIDATION:'true',GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS:'169.254.0.0/16'}),/Egress CIDRs/);
});

test('introspection and OpenFGA secrets bind to their exact service operations',()=>{
  const base={...document,upstreams:[]};
  const introspectPolicy={GATEWAY_CREDENTIAL_BINDINGS:JSON.stringify([{reference:'OAUTH_INTROSPECTION_CLIENT_SECRET',endpoint:'https://issuer.example/introspect',purpose:'oauth-token'}])};
  const opaque={OAUTH_INTROSPECTION_URL:'https://issuer.example/introspect',OAUTH_ISSUER:'https://issuer.example',OAUTH_AUDIENCE:'gateway',OAUTH_INTROSPECTION_CLIENT_ID:'gateway',OAUTH_INTROSPECTION_CLIENT_SECRET:'opaque-secret',...introspectPolicy};
  assert.throws(()=>environmentPlugins(base,{...opaque,OAUTH_INTROSPECTION_URL:'https://attacker.example/introspect'}),/not approved/);
  assert.doesNotThrow(()=>environmentPlugins(base,opaque));
  const fgaEndpoint='https://fga.example/stores/store-1/check';
  const fga={FGA_URL:'https://fga.example',FGA_STORE_ID:'store-1',FGA_MODEL_ID:'model-1',FGA_API_TOKEN:'fga-secret',GATEWAY_CREDENTIAL_BINDINGS:JSON.stringify([{reference:'FGA_API_TOKEN',endpoint:fgaEndpoint,purpose:'authorization-service'}])};
  assert.throws(()=>environmentPlugins(base,{...fga,FGA_URL:'https://attacker.example'}),/not approved/);
  assert.doesNotThrow(()=>environmentPlugins(base,fga));
  assert.throws(()=>environmentPlugins(base,{...fga,GATEWAY_REQUIRE_CREDENTIAL_BINDINGS:'true',GATEWAY_CREDENTIAL_BINDINGS:undefined}),/require deployment credential bindings/);
  const fgaBasePath={...fga,FGA_URL:'https://fga.example/api/v1',GATEWAY_CREDENTIAL_BINDINGS:JSON.stringify([{reference:'FGA_API_TOKEN',endpoint:'https://fga.example/api/v1/stores/store-1/check',purpose:'authorization-service'}])};
  assert.doesNotThrow(()=>environmentPlugins(base,fgaBasePath));
});

test('OTLP credentials and client identity are pinned to the collector URL',async t=>{
  const base={OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:'https://collector.example/custom/traces',OTEL_EXPORTER_OTLP_HEADERS:'authorization=Bearer%20secret'};
  assert.throws(()=>configureTracing({...base,GATEWAY_REQUIRE_CREDENTIAL_BINDINGS:'true'}),/deployment credential bindings/);
  const headerBinding={reference:'OTEL_EXPORTER_OTLP_HEADERS',endpoint:base.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,purpose:'telemetry-export'};
  const endpointBinding={reference:'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',endpoint:base.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,purpose:'telemetry-endpoint'};
  const trusted={...base,GATEWAY_REQUIRE_CREDENTIAL_BINDINGS:'true',GATEWAY_CREDENTIAL_BINDINGS:JSON.stringify([headerBinding,endpointBinding])};
  const provider=configureTracing(trusted);assert.ok(provider);t.after(()=>provider.shutdown());
  assert.throws(()=>configureTracing({...trusted,OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:'https://attacker.example/custom/traces'}),/not approved/);
  assert.throws(()=>configureTracing({...base,OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY:'/run/secrets/key',GATEWAY_REQUIRE_CREDENTIAL_BINDINGS:'true',GATEWAY_CREDENTIAL_BINDINGS:JSON.stringify([endpointBinding])}),/not approved/);
  const mTls=configureTracing({...base,OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY:'/run/secrets/key',GATEWAY_REQUIRE_CREDENTIAL_BINDINGS:'true',GATEWAY_CREDENTIAL_BINDINGS:JSON.stringify([headerBinding,endpointBinding,{reference:'OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY',endpoint:base.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,purpose:'telemetry-client-identity'}])});
  assert.ok(mTls);t.after(()=>mTls.shutdown());
});

test('request path configuration rejects parser ambiguity and must include the connection path',()=>{
  for(const path of ['//evil/path','/a/../mcp','/mcp?x=1','/mcp#x','/mcp%2fother','/mcp\\other','/else']) assert.throws(()=>loadConfig({...document,upstreams:[{...document.upstreams[0],requestPaths:[path]}]},env),/request paths/);
});

test('real HTTP receiver sees no credential on forbidden paths, origins, redirects or host overrides',async t=>{
  let received=0;const app=express();
  app.get('/mcp',(_req,res)=>res.redirect(307,'/sink'));
  app.all('/sink',(_req,res)=>{received++;res.send('unexpected');});
  const url=await listen(app,t),request=upstreamFetch(`${url}/mcp`,1024,['/mcp']);
  await assert.rejects(request(`${url}/sink`,{headers:{Authorization:'Bearer secret'}}),/path denied/);
  await assert.rejects(request(`${url}/mcp`,{headers:{Authorization:'Bearer secret'}}));
  await assert.rejects(request('https://attacker.example/sink',{headers:{Authorization:'Bearer secret'}}),/Cross-origin/);
  for(const name of ['Host','Proxy-Authorization','Connection']) await assert.rejects(request(`${url}/mcp`,{headers:{[name]:'wrong',Authorization:'Bearer secret'}}),/Unsafe upstream/);
  assert.equal(received,0);
});

test('routing and authorizer contexts do not contain service credentials',async t=>{
  const backend=await listen(createModernDemoServer('private'),t);
  const config={allowLocalHttp:true,clients:[{id:'agent',token:serviceToken,allow:['alpha__*']}],upstreams:[{id:'alpha',url:`${backend}/mcp`}]};
  const baseRouter=new ConfigRouter(config),basePolicy=new AllowListAuthorizer();let checks=0;
  const inspect=principal=>{checks++;assert.equal(Object.hasOwn(principal,'token'),false);assert.ok(!JSON.stringify(principal).includes(serviceToken));};
  const router={names(id,tool,context){inspect(context.principal);return baseRouter.names(id,tool,context);},resolve(name,context){inspect(context.principal);return baseRouter.resolve(name,context);}};
  const authorizer={async canCall(principal,name){inspect(principal);return basePolicy.canCall(principal,name);}};
  const url=await listen(createGateway(config,{router,authorizer}),t),client=new Client({name:'context-check',version:'1'});t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${serviceToken}`}}}));
  assert.equal((await client.listTools()).tools.length,1);
  assert.ok(!(await client.callTool({name:'alpha__echo',arguments:{text:'check'}})).isError);assert.ok(checks>0);
});
