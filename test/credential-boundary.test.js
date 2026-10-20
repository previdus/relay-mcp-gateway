import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { OAuthCredentialProvider } from '../dist/credentials.js';
import { validateConfig } from '../dist/validation.js';
import { listen } from './helpers.js';

test('expired OAuth tokens refresh once under concurrent callers and reject unsafe token responses', async t => {
  let calls = 0, mode = 'valid', lifetime = 1; const requests = [];
  const app=express(); app.use(express.urlencoded({extended:false}));
  app.post('/token',(req,res)=>{
    calls++;
    requests.push({ authorization: req.get('authorization'), body: req.body });
    const value={access_token:'backend-token',token_type:'Bearer',expires_in:lifetime,scope:'read',issued_token_type:'urn:ietf:params:oauth:token-type:access_token'};
    if(mode==='scope') value.scope='write';
    if(mode==='unsafe') value.access_token='token\r\nInjected: header';
    if(mode==='large') value.access_token='x'.repeat(8193);
    if(mode==='type') value.issued_token_type='urn:ietf:params:oauth:token-type:id_token';
    if(mode==='missing') delete value.issued_token_type;
    if(mode==='html') return res.type('html').send(JSON.stringify(value));
    res.json(value);
  });
  const url=await listen(app,t);
  const upstream={id:'alpha',url:'https://backend.example/mcp',oauth:{mode:'client_credentials',tokenEndpoint:`${url}/token`,clientId:'gateway',clientSecret:'secret',scope:'read'}};
  const provider=new OAuthCredentialProvider(true);
  await provider.headers(upstream); assert.equal(calls,1);
  assert.equal(requests[0].authorization, `Basic ${Buffer.from('gateway:secret').toString('base64')}`);
  assert.equal(requests[0].body.client_id, undefined);
  assert.equal(requests[0].body.client_secret, undefined);
  lifetime=300;
  const results=await Promise.all(Array.from({length:20},()=>provider.headers(upstream)));
  assert.ok(results.every(r=>r.Authorization==='Bearer backend-token'));
  assert.equal(calls,2,'expiry must not create an exchange stampede');
  const exchange={...upstream,oauth:{...upstream.oauth,mode:'token_exchange'}};
  for(mode of ['scope','unsafe','large','type','missing','html']) {
    await assert.rejects(new OAuthCredentialProvider(true).headers(exchange,{id:'agent',allow:[],authScheme:'jwt'},'subject-token'),undefined,mode);
  }
  mode='valid'; const recovering=new OAuthCredentialProvider(true);
  mode='scope'; await assert.rejects(recovering.headers(upstream));
  mode='valid'; assert.equal((await recovering.headers(upstream)).Authorization,'Bearer backend-token');
});

test('OAuth client-secret Basic encodes credentials before base64 and body auth is explicit compatibility', async t => {
  const requests = [];
  const app = express(); app.use(express.urlencoded({ extended: false }));
  app.post('/token', (req, res) => { requests.push({ authorization: req.get('authorization'), body: req.body }); res.json({ access_token: 'backend-token', token_type: 'Bearer', expires_in: 300 }); });
  const url = await listen(app, t);
  const encode = value => new URLSearchParams({ value }).toString().slice('value='.length);
  const credentials = { id: 'alpha', url: 'https://backend.example/mcp', oauth: { mode: 'client_credentials', tokenEndpoint: `${url}/token`, clientId: 'gateway:tenant', clientSecret: 's+cret:päss' } };
  await new OAuthCredentialProvider(true).headers(credentials);
  assert.equal(requests[0].authorization, `Basic ${Buffer.from(`${encode(credentials.oauth.clientId)}:${encode(credentials.oauth.clientSecret)}`).toString('base64')}`);
  assert.equal(requests[0].body.client_id, undefined);
  const legacy = { ...credentials, oauth: { ...credentials.oauth, clientAuthMethod: 'client_secret_post' } };
  await new OAuthCredentialProvider(true).headers(legacy);
  assert.equal(requests[1].authorization, undefined);
  assert.equal(requests[1].body.client_id, credentials.oauth.clientId);
  assert.equal(requests[1].body.client_secret, credentials.oauth.clientSecret);
  await assert.rejects(new OAuthCredentialProvider(true).headers({ ...credentials, oauth: { ...credentials.oauth, clientAuthMethod: 'arbitrary' } }), /Unsupported OAuth client authentication method/);
});

test('delegated exchange requests an exact downstream resource and carries the configured actor credential only to the token service', async t => {
  const received = [];
  const app = express(); app.use(express.urlencoded({ extended: false }));
  app.post('/token', (req, res) => { received.push({ body: req.body, authorization: req.get('authorization') }); res.json({ access_token: 'downstream-token', token_type: 'Bearer', expires_in: 300, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' }); });
  const tokenService = await listen(app, t);
  const upstream = { id: 'jira', url: 'https://jira.example/mcp', oauth: { mode: 'token_exchange', tokenEndpoint: `${tokenService}/token`, clientId: 'relay', clientSecret: 'relay-secret', actorToken: 'relay-actor', resource: 'https://jira.example/mcp', scope: 'issues:read' } };
  const headers = await new OAuthCredentialProvider(true).headers(upstream, { id: 'agent', authScheme: 'jwt', allow: [] }, 'agent-subject-token');
  assert.equal(headers.Authorization, 'Bearer downstream-token');
  assert.equal(received[0].body.resource, upstream.oauth.resource);
  assert.equal(received[0].body.actor_token, upstream.oauth.actorToken);
  assert.equal(received[0].body.actor_token_type, 'urn:ietf:params:oauth:token-type:access_token');
  assert.equal(received[0].body.subject_token, 'agent-subject-token');
  assert.equal(received[0].authorization, `Basic ${Buffer.from('relay:relay-secret').toString('base64')}`);
});

test('RFC 8705 token-endpoint mTLS authenticates with the dedicated upstream certificate and no shared secret', async t => {
  const cert = await readFile(fileURLToPath(new URL('./fixtures/mtls-test-cert.pem', import.meta.url)));
  const key = await readFile(fileURLToPath(new URL('./fixtures/mtls-test-key.pem', import.meta.url)));
  let authorized = false, requestBody, authorization;
  const server = https.createServer({ cert, key, ca: cert, requestCert: true, rejectUnauthorized: true }, async (req, res) => {
    authorized = req.socket.authorized;
    authorization = req.headers.authorization;
    let raw = ''; for await (const chunk of req) raw += chunk;
    requestBody = new URLSearchParams(raw);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'mtls-downstream-token', token_type: 'Bearer', expires_in: 300, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const tls = { cert: cert.toString(), key: key.toString(), ca: cert.toString() };
  const upstream = { id: 'jira', url: 'https://jira.example/mcp', tls: { clientCert: tls.cert, clientKey: tls.key, ca: tls.ca }, oauth: { mode: 'token_exchange', clientAuthMethod: 'tls_client_auth', tokenEndpoint: `https://localhost:${server.address().port}/token`, clientId: 'relay-mtls', resource: 'https://jira.example/mcp' } };
  const headers = await new OAuthCredentialProvider().headers(upstream, { id: 'agent', authScheme: 'jwt', allow: [] }, 'caller-token', tls);
  assert.equal(headers.Authorization, 'Bearer mtls-downstream-token');
  assert.equal(authorized, true);
  assert.equal(authorization, undefined);
  assert.equal(requestBody.get('client_id'), 'relay-mtls');
  assert.equal(requestBody.get('client_secret'), null);
  assert.equal(requestBody.get('resource'), upstream.oauth.resource);
});

test('outbound provider attaches configured vendor API headers without replacing MCP transport headers', async () => {
  const headers = await new OAuthCredentialProvider(true).headers({ id: 'jira', url: 'https://jira.example/mcp', headers: { 'X-API-Key': 'jira-demo-secret', 'X-Workspace': 'team-42' } });
  assert.deepEqual(headers, { 'X-API-Key': 'jira-demo-secret', 'X-Workspace': 'team-42' });
  assert.throws(() => validateConfig({ clients: [{ id: 'a', token: 'long-test-token-1234567890', allow: [] }], upstreams: [{ id: 'jira', url: 'https://jira.example/mcp', headers: { Authorization: 'Bearer should-not-be-configurable-here' } }] }), /Invalid upstream header configuration/);
});
