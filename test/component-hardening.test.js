import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { IntrospectionAuthenticator, bearerToken } from '../dist/authentication.js';
import { JwtAuthenticator, ConfigRouter, OpenFgaAuthorizer, RoleAuthorizer } from '../dist/plugins.js';
import { environmentPlugins } from '../dist/runtime.js';
import { validateConfig } from '../dist/validation.js';
import { boundedJson, securityEndpoint } from '../dist/security-http.js';
import { listen, serviceToken } from './helpers.js';
import { createGateway } from '../dist/gateway.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { withinDeadline } from '../dist/deadline.js';
import { enforceInvocation } from '../dist/invocation-policy.js';

const principal = { id: 'agent', token: serviceToken, allow: ['alpha__*'], roles: ['reader'], subject: 'workload' };
const config = { clients: [principal], upstreams: [{ id: 'alpha', url: 'https://alpha.example/mcp' }] };

test('bearer extraction rejects duplicate, oversized, whitespace and alternate credentials', () => {
  const read = (...authorization) => bearerToken({ headersDistinct: { authorization } });
  assert.equal(read(`bearer ${serviceToken}`), serviceToken);
  for (const values of [[], [`Bearer ${serviceToken}`, `Bearer ${serviceToken}`], ['Basic a'], ['Bearer a b'], ['Bearer a,b'], [`Bearer ${'x'.repeat(8193)}`]]) assert.equal(read(...values), '');
});

test('JWT bearer profile rejects proof bindings, ambiguous tenants, old tokens and wrong token types', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'one';
  const options = { issuer: 'https://issuer.example', audience: 'gateway', jwksUrl: 'https://issuer.example/keys', clients: [principal], key: createLocalJWKSet({ keys: [jwk] }), requiredTyp: 'at+jwt', maxTokenAgeSeconds: 60 };
  const auth = new JwtAuthenticator(options);
  const sign = (payload = {}, typ = 'at+jwt', iat = Math.floor(Date.now()/1000)) => new SignJWT(payload).setProtectedHeader({ alg: 'ES256', kid: 'one', typ }).setIssuer(options.issuer).setAudience(options.audience).setSubject('workload').setIssuedAt(iat).setExpirationTime('5m').sign(privateKey);
  assert.equal((await auth.authenticate(await sign())).id, principal.id);
  for (const p of [{ cnf: { jkt: 'key' } }, { cnf: null }, { tenant_id: 7 }, { tenant_id: '' }, { tenant_id: 'another' }]) assert.equal(await auth.authenticate(await sign(p)), undefined);
  assert.equal(await auth.authenticate(await sign({}, 'JWT')), undefined);
  assert.equal(await auth.authenticate(await sign({}, 'at+jwt', Math.floor(Date.now()/1000)-120)), undefined);
  assert.throws(() => new JwtAuthenticator({ ...options, clients: [principal, { ...principal, id: 'other' }] }), /Ambiguous/);
  assert.throws(() => new JwtAuthenticator({ ...options, issuer: 'https://user:pass@issuer.example' }), /Security endpoint/);
  const byAgent=new JwtAuthenticator({...options,clients:[{...principal,oauthClientId:'agent-a'},{...principal,id:'agent-b',oauthClientId:'agent-b'}]});
  assert.equal(await byAgent.authenticate(await sign({client_id:'unknown'})),undefined);
  assert.equal((await byAgent.authenticate(await sign({client_id:'agent-b'}))).id,'agent-b');
});

test('opaque tokens are introspected with separate credentials, fresh revocation and strict resource binding', async t => {
  let active = true, mode = 'normal', calls = 0;
  const app = express(); app.use(express.urlencoded({ extended: false }));
  app.post('/introspect', (req,res) => {
    calls++; assert.equal(req.body.token, 'opaque-access-token'); assert.equal(req.body.token_type_hint, 'access_token');
    assert.equal(req.headers.authorization, `Basic ${Buffer.from('gateway:private').toString('base64')}`);
    const p = { active, iss: 'https://issuer.example', aud: ['gateway'], sub: 'workload', exp: Math.floor(Date.now()/1000)+60, iat: Math.floor(Date.now()/1000), scope: 'mcp:access' };
    if (mode === 'audience') p.aud = ['other'];
    if (mode === 'scope') p.scope = 'other';
    if (mode === 'bound') p.cnf = { jkt: 'key' };
    res.json(p);
  });
  const url = await listen(app,t);
  const auth = new IntrospectionAuthenticator({ endpoint: `${url}/introspect`, issuer: 'https://issuer.example', audience: 'gateway', clientId: 'gateway', clientSecret: 'private', clients: [principal], requiredScopes: ['mcp:access'], allowLocalHttp: true });
  const result = await auth.authenticate('opaque-access-token'); assert.equal(result.id, 'agent'); assert.equal(result.authScheme, 'introspection');
  active = false; assert.equal(await auth.authenticate('opaque-access-token'), undefined); active = true;
  for (mode of ['audience','bound']) assert.equal(await auth.authenticate('opaque-access-token'), undefined);
  mode = 'scope'; await assert.rejects(auth.authenticate('opaque-access-token'), /Insufficient scope/);
  assert.equal(calls, 5);
});

test('security responses enforce streaming size, JSON type and object shape', async () => {
  assert.deepEqual(await boundedJson(Response.json({ allowed: true })), { allowed: true });
  for (const response of [Response.json([]), new Response('{}'), new Response('{"x":"'+'x'.repeat(17000)+'"}', { headers: { 'Content-Type':'application/json' } }), new Response('failure', { status:503 })]) await assert.rejects(boundedJson(response));
  for (const url of ['http://remote.example','https://user:pass@host','https://host/?secret=1','https://host/#a']) assert.throws(() => securityEndpoint(url,true));
  assert.equal(securityEndpoint('http://127.0.0.1:8080',true).hostname, '127.0.0.1');
  assert.throws(() => new OpenFgaAuthorizer({ url: 'http://remote.example', storeId:'s',modelId:'m',allowLocalHttp:true }));
});

test('OpenFGA denies oversized, malformed and redirected decisions while preserving tenant binding', async t => {
  let mode = 'normal', seen;
  const app=express(); app.use(express.json());
  app.post('/stores/s/check',(req,res)=>{ seen=req.body; if(mode==='large') return res.json({ allowed:true, padding:'x'.repeat(20000) }); if(mode==='string') return res.json({allowed:'true'}); if(mode==='redirect') return res.redirect(307,'/allow'); res.json({allowed:true}); });
  const url=await listen(app,t), fga=new OpenFgaAuthorizer({url,storeId:'s',modelId:'m',allowLocalHttp:true});
  assert.equal(await fga.canCall({...principal,tenantId:'acme'},'alpha__echo'),true);
  assert.equal(seen.tuple_key.user,'user:acme%2Fagent'); assert.equal(seen.consistency,'HIGHER_CONSISTENCY');
  for(mode of ['large','string','redirect']) assert.equal(await fga.canCall(principal,'alpha__echo'),false);
  mode='normal';
  const v2=new OpenFgaAuthorizer({url,storeId:'s',modelId:'m',allowLocalHttp:true,namespaceFormat:'tuple-v2'});
  await v2.canCall({...principal,id:'acme/agent',tenantId:undefined},'alpha__echo');const defaultUser=seen.tuple_key.user;
  await v2.canCall({...principal,id:'agent',tenantId:'acme'},'alpha__echo');assert.notEqual(seen.tuple_key.user,defaultUser);
  assert.deepEqual(JSON.parse(decodeURIComponent(seen.tuple_key.user.slice(5))),['acme','agent']);
  assert.equal(await new RoleAuthorizer({}).canCall({...principal,roles:['constructor']},'alpha__echo'),false);
});

test('authentication configuration rejects mixed and partial modes instead of falling back to keys', () => {
  const base={OAUTH_INTROSPECTION_URL:'https://issuer.example/introspect', OAUTH_ISSUER:'https://issuer.example',OAUTH_AUDIENCE:'gateway',OAUTH_INTROSPECTION_CLIENT_ID:'gateway',OAUTH_INTROSPECTION_CLIENT_SECRET:'private'};
  assert.ok(environmentPlugins(config,base).authenticator instanceof IntrospectionAuthenticator);
  assert.throws(()=>environmentPlugins(config,{...base,JWT_AUDIENCE:'other'}),/Select JWT/);
  assert.throws(()=>environmentPlugins(config,{OAUTH_AUDIENCE:'gateway'}),/Incomplete/);
  assert.throws(()=>environmentPlugins(config,{...base,OAUTH_INTROSPECTION_CLIENT_SECRET:''}),/requires/);
});

test('priority routes are stable and intersect trusted tenant, role and client selectors', () => {
  const a={id:'alpha',url:'https://alpha.example/mcp',tenantId:'acme'}, b={id:'beta',url:'https://beta.example/mcp',tenantId:'acme'}, foreign={id:'foreign',url:'https://foreign.example/mcp',tenantId:'other'};
  const rule={name:'echo',strategy:'priority',tenants:['acme'],requiredRoles:['reader'],clients:['agent'],targets:[{upstreamId:'beta',tool:'echo',priority:10},{upstreamId:'alpha',tool:'echo',priority:1},{upstreamId:'foreign',tool:'echo',priority:0}]};
  const input={clients:[principal],upstreams:[a,b,foreign],routes:[rule]}, context={principal:{...principal,tenantId:'acme'},requestId:'one'}, router=new ConfigRouter(validateConfig(input));
  assert.equal(router.resolve('echo',context).upstream.id,'alpha');
  assert.equal(new ConfigRouter({...input,routes:[{...rule,targets:[...rule.targets].reverse()}]}).resolve('echo',context).upstream.id,'alpha');
  for(const changed of [{roles:[]},{tenantId:'other'},{id:'unlisted'}]) { const denied={...context,principal:{...context.principal,...changed}}; assert.equal(router.resolve('echo',denied),undefined); assert.deepEqual(router.names('alpha','echo',denied),changed.tenantId ? [] : ['alpha__echo']); }
  assert.throws(()=>validateConfig({...input,routes:[{...rule,requiredRoles:[]}]}),/selector/);
  assert.throws(()=>validateConfig({...input,upstreams:[{...a,timeoutMs:0}]}),/timeout/);
});

test('upstream deadline includes credential acquisition and prevents a late connection', async t => {
  let transports=0;
  const app=createGateway({...config,upstreams:[{...config.upstreams[0],timeoutMs:20,connectTimeoutMs:10}]},{credentials:{headers:async()=>{await new Promise(r=>setTimeout(r,1000));return {}; }},transportFactory:()=>{transports++;throw new Error('Must not connect');}});
  const url=await listen(app,t), client=new Client({name:'deadline',version:'1'});t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${serviceToken}`}},versionNegotiation:{mode:'modern'}}));
  const started=Date.now();
  assert.equal((await client.callTool({name:'alpha__echo',arguments:{}})).isError,true);
  assert.ok(Date.now()-started<750,'credential wait must terminate before the provider settles');
  assert.equal(transports,0);
});

test('deadline propagates cancellation and consumes late dependency rejection', async () => {
  const controller=new AbortController();let reject;
  const work=new Promise((_,r)=>{reject=r;});
  const waiting=withinDeadline(work,controller.signal);controller.abort(new Error('caller cancelled'));
  await assert.rejects(waiting,/caller cancelled/);reject(new Error('late provider failure'));
  await assert.rejects(withinDeadline(Promise.reject(new Error('already failed')),AbortSignal.abort(new Error('already cancelled'))),/already cancelled/);
  await new Promise(r=>setImmediate(r));
});

test('argument forbids override allows and physical guardrails also constrain aliases', () => {
  const policies={alpha__echo:{allow:[{constraints:[{field:['amount'],op:'numberRange',min:0,max:100}]}],deny:[{constraints:[{field:['environment'],op:'equals',value:'production'}]}]}};
  const allowed={amount:10,environment:'development'};
  enforceInvocation(policies,['echo','alpha__echo'],principal,allowed);
  assert.throws(()=>enforceInvocation(policies,['echo','alpha__echo'],principal,{...allowed,environment:'production'}),/forbidden/);
  assert.throws(()=>enforceInvocation(policies,['echo','alpha__echo'],principal,{amount:101}),/forbidden/);
  assert.throws(()=>enforceInvocation({...policies,echo:{allow:[]}},['echo','alpha__echo'],principal,allowed),/forbidden/);
});
