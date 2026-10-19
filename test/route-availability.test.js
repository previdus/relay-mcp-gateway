import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigRouter } from '../dist/plugins.js';
import { loadConfig } from '../dist/config.js';
import { createGateway } from '../dist/gateway.js';
import { createModernDemoServer } from '../dist/demo-modern.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { listen, serviceToken } from './helpers.js';

test('all routing strategies exclude disabled targets and hide aliases with no enabled targets', () => {
  for(const strategy of ['weighted','sticky','rendezvous','priority']) {
    const config=loadConfig({clients:[{id:'agent',subject:'workload',allow:['echo']}],upstreams:[{id:'alpha',url:'https://alpha.example/mcp'},{id:'beta',url:'https://beta.example/mcp'}],routes:[{name:'echo',strategy,targets:[{upstreamId:'alpha',tool:'echo',enabled:false,priority:0,weight:10000},{upstreamId:'beta',tool:'echo',priority:5}]}]},{});
    const context={principal:config.clients[0],requestId:'request'},router=new ConfigRouter(config);
    for(let i=0;i<50;i++) assert.equal(router.resolve('echo',context).upstream.id,'beta');
    assert.deepEqual(router.names('alpha','echo',context),['alpha__echo']);
    assert.deepEqual(router.names('beta','echo',context),['beta__echo','echo']);
    config.routes[0].targets[1].enabled=false;
    assert.equal(router.resolve('echo',context),undefined);
    assert.deepEqual(router.names('beta','echo',context),['beta__echo']);
    // Alias availability does not revoke separately granted physical names.
    assert.equal(router.resolve('alpha__echo',context).upstream.id,'alpha');
  }
});

test('MCP discovery and invocation honor disabled alias targets without granting direct access',async t=>{
  const alpha=await listen(createModernDemoServer('alpha'),t),beta=await listen(createModernDemoServer('beta'),t);
  const upstreams=[{id:'alpha',url:`${alpha}/mcp`},{id:'beta',url:`${beta}/mcp`}];
  for(const allDisabled of [false,true]) {
    const gateway=createGateway({allowLocalHttp:true,clients:[{id:'agent',token:serviceToken,allow:['echo']}],upstreams,routes:[{name:'echo',strategy:'priority',targets:[{upstreamId:'alpha',tool:'echo',enabled:false},{upstreamId:'beta',tool:'echo',enabled:!allDisabled}]}]});
    const url=await listen(gateway,t),client=new Client({name:'availability-check',version:'1'});t.after(()=>client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${serviceToken}`}}}));
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),allDisabled?[]:['echo']);
    if(allDisabled) await assert.rejects(client.callTool({name:'echo',arguments:{text:'check'}}),/unavailable|forbidden/i);
    else {
      const result=await client.callTool({name:'echo',arguments:{text:'check'}});
      assert.match(result.content[0].text,/beta: check/);
    }
    await assert.rejects(client.callTool({name:'alpha__echo',arguments:{text:'check'}}),/unavailable|forbidden/i);
    await client.close();
  }
});
