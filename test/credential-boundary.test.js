import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { OAuthCredentialProvider } from '../dist/credentials.js';
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
