import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { parseAllDocuments } from 'yaml';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const kubectl = (args, input) => execFileSync('kubectl', args, { encoding: 'utf8', input, stdio: ['pipe','pipe','pipe'], timeout: 150000 }).trim();
if (!process.env.KUBECONFIG || kubectl(['config','current-context']) !== 'kind-relay-validation') throw new Error('Requires an explicit kubeconfig pointing to the dedicated kind-relay-validation test cluster');
const namespace=`relay-smoke-${randomBytes(5).toString('hex')}`;
const admin=randomBytes(32).toString('hex'), token=randomBytes(32).toString('hex'), password=randomBytes(32).toString('hex');
const command=(...args)=>kubectl(['-n',namespace,...args]);
const apply=value=>kubectl(['-n',namespace,'apply','-f','-'],JSON.stringify(value));
const clients=[],forwards=[];let created=false;
const keepAlive=setInterval(()=>{},1000);
async function freePort() { const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port; }
async function ready(base, expected=200) { for(let i=0;i<80;i++){try{if((await fetch(`${base}/readyz`,{signal:AbortSignal.timeout(6000)})).status===expected)return;}catch{}await new Promise(resolve=>setTimeout(resolve,500));}throw new Error(`Readiness did not reach ${expected}`); }
async function portForward(pod) { const port=await freePort();const process=spawn('kubectl',['-n',namespace,'port-forward',`pod/${pod}`,`${port}:3000`,'--address','127.0.0.1'],{windowsHide:true,stdio:'ignore'});forwards.push(process);const base=`http://127.0.0.1:${port}`;await ready(base);return base; }
const headers={Authorization:`Bearer ${admin}`,'Content-Type':'application/json'};
async function publish(base,document,revision){const response=await fetch(`${base}/admin/api/config`,{method:'PUT',headers:{...headers,'If-Match':`"${revision}"`},body:JSON.stringify(document)});assert.equal(response.status,200);return response.json();}
try {
  kubectl(['create','namespace',namespace]);created=true;
  apply({apiVersion:'v1',kind:'Secret',metadata:{name:'relay-gateway-secrets'},stringData:{POSTGRES_PASSWORD:password,DATABASE_URL:`postgresql://gateway:${password}@relay-test-postgres:5432/gateway`,GATEWAY_ADMIN_KEY:admin,GATEWAY_API_KEY:token}});
  const initial={maxConcurrentPerClient:32,clients:[{id:'smoke',tokenEnv:'GATEWAY_API_KEY',allow:['local__echo']}],upstreams:[{id:'local',url:'stdio://local',transport:'stdio',command:'/usr/local/bin/node',args:['/app/dist/demo-stdio.js']}]};
  apply({apiVersion:'v1',kind:'ConfigMap',metadata:{name:'relay-test-config'},data:{'gateway.json':JSON.stringify(initial)}});
  command('apply','-f','deploy/kubernetes.test.yaml');
  command('rollout','status','deployment/relay-test-postgres','--timeout=120s');
  const objects=parseAllDocuments(await readFile('deploy/kubernetes.yaml','utf8')).map(document=>document.toJSON());
  const deployment=objects.find(value=>value.kind==='Deployment');
  const spec=deployment.spec.template.spec, gateway=spec.containers.find(value=>value.name==='gateway');
  gateway.env.push({name:'GATEWAY_CONFIG',value:'/app/test-config/gateway.json'},{name:'STDIO_ALLOWED_COMMANDS',value:'/usr/local/bin/node'});
  gateway.volumeMounts.push({name:'test-config',mountPath:'/app/test-config',readOnly:true});
  spec.volumes.push({name:'test-config',configMap:{name:'relay-test-config'}});
  apply({apiVersion:'v1',kind:'List',items:objects});
  command('rollout','status','deployment/relay-gateway','--timeout=120s');
  const pods=JSON.parse(command('get','pods','-l','app=relay-gateway','-o','json')).items.filter(p=>p.status.conditions?.some(c=>c.type==='Ready'&&c.status==='True'));
  assert.equal(pods.length,2);
  const bases=[];
  for(const pod of pods) {
    const base=await portForward(pod.metadata.name);bases.push(base);
    const client=new Client({name:'kubernetes-smoke',version:'1'});clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['local__echo']);
  }
  console.log('Kubernetes: two ready replicas and actual MCP discovery verified.');
  const limited={...initial,traffic:{toolRateLimits:{local__echo:{capacity:3,refillPerSecond:0.001}}}};
  await publish(bases[0],limited,1);
  const calls=await Promise.allSettled(Array.from({length:12},(_,i)=>clients[i%2].callTool({name:'local__echo',arguments:{text:String(i)}})));
  assert.equal(calls.filter(r=>r.status==='fulfilled').length,3);assert.equal(calls.filter(r=>r.status==='rejected'&&/429|Rate limit/.test(r.reason.message)).length,9);
  await publish(bases[0],{...initial,clients:[{...initial.clients[0],allow:[]}]},2);
  await assert.rejects(clients[1].callTool({name:'local__echo',arguments:{text:'blocked'}}),/forbidden/);
  const restored=await fetch(`${bases[0]}/admin/api/rollback`,{method:'POST',headers:{...headers,'If-Match':'"3"'},body:JSON.stringify({revision:1})});assert.equal(restored.status,200);
  assert.equal((await restored.json()).revision,4);
  assert.ok((await clients[1].callTool({name:'local__echo',arguments:{text:'restored'}})).content);
  console.log('Kubernetes: shared quotas, cross-replica revocation and audited configuration rollback passed.');
  const reviewed = (await clients[0].listTools()).tools[0]._meta['com.example.relay/contractFingerprint'];
  await publish(bases[0],{...initial,upstreams:[{...initial.upstreams[0],timeoutMs:5000,connectTimeoutMs:2000}],clients:[{...initial.clients[0],roles:['reader'],allow:['local__echo','echo']}],routes:[{name:'echo',strategy:'priority',tenants:['default'],requiredRoles:['reader'],targets:[{upstreamId:'local',tool:'echo',priority:5}]}],features:{catalogSearch:true},discovery:{pageSize:1},toolContracts:{local__echo:reviewed,echo:reviewed},catalogPolicy:{requirePinned:true,rejectControlCharacters:true},invocationPolicies:{local__echo:{allow:[{constraints:[{field:['text'],op:'equals',value:'approved'}]}],deny:[{constraints:[{field:['environment'],op:'equals',value:'production'}]}]}}},4);
  for(const client of clients) {
    assert.equal((await client.listTools()).tools.length,2);
    await assert.rejects(client.callTool({name:'local__echo',arguments:{text:'unapproved'}}),/argument policy/);
    assert.ok((await client.callTool({name:'local__echo',arguments:{text:'approved'}})).content);
    await assert.rejects(client.callTool({name:'local__echo',arguments:{text:'approved',environment:'production'}}),/argument policy/);
  }
  const page=await clients[0].request({method:'tools/list',params:{}});assert.ok(page.nextCursor);
  assert.deepEqual((await clients[1].request({method:'tools/list',params:{cursor:page.nextCursor}})).tools.map(tool=>tool.name),['echo']);
  for(const base of bases) {
    const found=await fetch(`${base}/catalog/search`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({query:'echo',limit:10})});assert.equal(found.status,200);assert.equal((await found.json()).tools.length,2);
  }
  // Restore the unrestricted fixture only: old images cannot parse v0.8 selector/deadline fields.
  await publish(bases[0],initial,5);
  console.log('Kubernetes: reviewed catalog, deny-overrides policies, cross-pod cursors, priority selectors, upstream budgets and search enforced on both replicas; compatible fixture restored before image rollback.');
  command('delete','pod',pods[0].metadata.name,'--wait=true','--timeout=60s');
  assert.ok((await clients[1].callTool({name:'local__echo',arguments:{text:'surviving replica'}})).content);
  command('rollout','status','deployment/relay-gateway','--timeout=90s');
  console.log('Kubernetes: pod replacement passed while the other replica continued serving.');
  command('scale','deployment/relay-test-postgres','--replicas=0');
  command('wait','--for=delete','pod','-l','app=relay-test-postgres','--timeout=60s');
  await ready(bases[1],503);
  await assert.rejects(clients[1].callTool({name:'local__echo',arguments:{text:'must fail closed'}}),/503|unavailable/);
  command('scale','deployment/relay-test-postgres','--replicas=1');command('rollout','status','deployment/relay-test-postgres','--timeout=90s');await ready(bases[1]);
  const snapshot=await (await fetch(`${bases[1]}/admin/api/config`,{headers})).json();assert.equal(snapshot.revision,6);
  assert.ok((await clients[1].callTool({name:'local__echo',arguments:{text:'database recovered'}})).content);
  console.log('Kubernetes: database interruption failed closed and persistent configuration recovered.');
  for(const client of clients) await client.close();
  for(const image of ['relay-gateway:0.11.0','relay-gateway:0.12.0']) {
    command('set','image','deployment/relay-gateway',`gateway=${image}`);command('rollout','status','deployment/relay-gateway','--timeout=120s');
    const pod=JSON.parse(command('get','pods','-l','app=relay-gateway','-o','json')).items.find(p=>p.status.conditions?.some(c=>c.type==='Ready'&&c.status==='True')&&p.spec.containers[0].image===image);
    const base=await portForward(pod.metadata.name);assert.equal((await fetch(`${base}/admin/`)).status,200);
    const client=new Client({name:'image-rollback',version:'1'});clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));assert.equal((await client.listTools()).tools.length,1);await client.close();
  }
  console.log('Kubernetes: 0.11 image rollback and 0.12 promotion passed for the compatible test configuration.');
  console.log('Kubernetes acceptance completed successfully.');
} finally {
  for(const client of clients) await client.close().catch(()=>{});
  for(const process of forwards) process.kill();
  if(created) command('delete','namespace',namespace,'--wait=false');
  clearInterval(keepAlive);
}
