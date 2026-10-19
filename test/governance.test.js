import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createRuntime } from '../dist/runtime.js';
import { createGateway } from '../dist/gateway.js';
import { SqliteStore } from '../dist/store.js';
import { contractFingerprint } from '../dist/contracts.js';
import { listen, document, adminToken, serviceToken } from './helpers.js';

test('history and reviewed rollback preserve revisions, require authorization and reject stale updates', async t => {
  const store = new SqliteStore(':memory:', document);t.after(()=>store.close());
  const url=await listen(createRuntime(store,{adminKey:adminToken,environment:{SERVICE_TOKEN:serviceToken}}),t);
  const headers={Authorization:`Bearer ${adminToken}`,'Content-Type':'application/json'};
  const post=(body,revision)=>fetch(`${url}/admin/api/rollback`,{method:'POST',headers:{...headers,...(revision?{'If-Match':`"${revision}"`}:{})},body:JSON.stringify(body)});
  assert.equal((await fetch(`${url}/admin/api/history`,{headers:{Authorization:`Bearer ${serviceToken}`}})).status,401);
  await store.write({...document,clients:[{...document.clients[0],allow:[]}]},1);
  assert.equal((await post({revision:1})).status,428);
  assert.equal((await post({revision:0},2)).status,400);
  assert.equal((await post({revision:999},2)).status,404);
  assert.equal((await post({revision:1},1)).status,409);
  const result=await post({revision:1},2);assert.equal(result.status,200);
  const saved=await result.json();assert.equal(saved.revision,3);assert.deepEqual(saved.document,document);
  const history=await (await fetch(`${url}/admin/api/history`,{headers})).json();
  assert.deepEqual(history.map(r=>r.revision),[3,2,1]);
  assert.deepEqual((await store.revision(2)).document.clients[0].allow,[]);
  assert.ok((await store.recentAudit()).some(event=>event.method==='admin/config.rollback'));
  assert.equal(JSON.stringify(history).includes(serviceToken),false);
});

test('rollback revalidates old credential references using current deployment settings', async t => {
  const old={...document,clients:[{...document.clients[0],tokenEnv:'OLD_TOKEN'}]};
  const store=new SqliteStore(':memory:',old);t.after(()=>store.close());
  await store.write(document,1);
  const url=await listen(createRuntime(store,{adminKey:adminToken,environment:{SERVICE_TOKEN:serviceToken}}),t);
  const response=await fetch(`${url}/admin/api/rollback`,{method:'POST',headers:{Authorization:`Bearer ${adminToken}`,'Content-Type':'application/json','If-Match':'"2"'},body:JSON.stringify({revision:1})});
  assert.equal(response.status,400);assert.equal((await store.read()).revision,2);
});

test('contract fingerprints are order-stable and include descriptions, schemas and annotations',()=>{
  const a={name:'a',description:'trusted',inputSchema:{type:'object',properties:{x:{type:'string'}}}};
  const b={inputSchema:{properties:{x:{type:'string'}},type:'object'},description:'trusted',name:'renamed'};
  assert.equal(contractFingerprint(a),contractFingerprint(b));
  assert.notEqual(contractFingerprint(a),contractFingerprint({...a,description:'changed instructions'}));
  assert.notEqual(contractFingerprint(a),contractFingerprint({...a,annotations:{readOnlyHint:true}}));
});

test('pinned tools disappear on drift and direct execution is blocked until definitions match again',async t=>{
  let tool={name:'echo',description:'Reviewed instructions',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}};
  let invoked=0;
  const handler=createMcpHandler(()=>{
    const server=new Server({name:'mutable',version:'1'},{capabilities:{tools:{}}});
    server.setRequestHandler('tools/list',async()=>({tools:[tool]}));
    server.setRequestHandler('tools/call',async()=>{invoked++;return {content:[{type:'text',text:'executed'}]};});return server;
  });
  t.after(()=>handler.close());
  const app=express();app.use(express.json());app.all('/mcp',(req,res)=>toNodeHandler(handler)(req,res,req.body));
  const upstream=await listen(app,t),events=[];
  const url=await listen(createGateway({allowLocalHttp:true,clients:[{id:'one',token:serviceToken,allow:['mutable__*']}],upstreams:[{id:'mutable',url:`${upstream}/mcp`}],toolContracts:{mutable__echo:contractFingerprint(tool)}},{audit:async event=>{events.push(event);}}),t);
  const client=new Client({name:'drift-test',version:'1'});t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${serviceToken}`}}}));
  assert.equal((await client.listTools()).tools.length,1);
  const original=tool;tool={...tool,description:'Unreviewed instructions'};
  assert.deepEqual((await client.listTools()).tools,[]);
  await assert.rejects(client.callTool({name:'mutable__echo',arguments:{text:'blocked'}}),/definition changed/);
  assert.equal(invoked,0);assert.ok(events.some(event=>event.method==='gateway/contract_drift'));
  tool=original;assert.equal((await client.callTool({name:'mutable__echo',arguments:{text:'approved'}})).content[0].text,'executed');assert.equal(invoked,1);
});
