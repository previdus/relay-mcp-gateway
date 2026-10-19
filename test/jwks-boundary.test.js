import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { JwtAuthenticator } from '../dist/plugins.js';
import { listen, serviceToken } from './helpers.js';

test('remote JWKS bounds streamed responses, rejects redirects, and preserves cache and kid cooldown', async t => {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const key = { ...await exportJWK(publicKey), kid: 'one' };
  let mode = 'valid', calls = 0, redirectCalls = 0;
  const app = express();
  app.get('/keys', (_req, res) => {
    calls++;
    if (mode === 'redirect') return res.redirect('/other');
    if (mode === 'many') return res.json({ keys: Array.from({length:65}, (_,i)=>({...key,kid:String(i)})) });
    if (mode === 'array') return res.json([key]);
    if (mode === 'empty') return res.json({ keys: [] });
    if (mode === 'type') return res.type('text/html').send(JSON.stringify({keys:[key]}));
    if (mode === 'large') {
      res.type('application/jwk-set+json');
      res.write('{"padding":"'); res.write('x'.repeat(65536)); return res.end('","keys":[]}');
    }
    res.type('application/jwk-set+json').send(JSON.stringify({keys:[key]}));
  });
  app.get('/other', (_req,res) => { redirectCalls++; res.json({keys:[key]}); });
  const local = await listen(app,t), originalFetch = globalThis.fetch;
  // Only the socket destination is replaced. Production HTTPS URL validation,
  // redirect behavior, streaming, timeouts and jose key resolution remain active.
  t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(String(url), 'https://issuer.example/keys');
    assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    return originalFetch(`${local}/keys`, init);
  });
  const options = { issuer:'https://issuer.example', audience:'gateway', jwksUrl:'https://issuer.example/keys', requiredTyp:'at+jwt', clients:[{id:'agent',token:serviceToken,allow:[],subject:'workload'}] };
  const sign = kid => new SignJWT({}).setProtectedHeader({alg:'ES256',kid,typ:'at+jwt'}).setIssuer(options.issuer).setAudience(options.audience).setSubject('workload').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const token = await sign('one');
  for (mode of ['large','many','array','empty','type','redirect']) assert.equal(await new JwtAuthenticator(options).authenticate(token),undefined,mode);
  assert.equal(redirectCalls,0);
  mode='valid'; const auth = new JwtAuthenticator(options), before = calls;
  const results = await Promise.all(Array.from({length:8},()=>auth.authenticate(token)));
  assert.ok(results.every(r=>r?.id==='agent')); assert.equal(calls-before,1);
  assert.equal(await auth.authenticate(await sign('unknown')),undefined);
  assert.equal((await auth.authenticate(token)).id,'agent'); assert.equal(calls-before,1);
  const [header,payload] = token.split('.');
  const none = `${Buffer.from(JSON.stringify({alg:'none',kid:'one',typ:'at+jwt'})).toString('base64url')}.${payload}.`;
  assert.equal(await auth.authenticate(none),undefined);
  const hmac = await new SignJWT(JSON.parse(Buffer.from(payload,'base64url'))).setProtectedHeader({alg:'HS256',kid:'one',typ:'at+jwt'}).sign(new TextEncoder().encode(JSON.stringify(key)));
  assert.equal(await auth.authenticate(hmac),undefined);
  assert.equal(await auth.authenticate(`${header}.${payload}.invalid`),undefined);
});
