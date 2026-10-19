import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AllowListAuthorizer, RoleAuthorizer, AllOfAuthorizer } from '../dist/plugins.js';
import { enforceInvocation } from '../dist/invocation-policy.js';

test('relationship, local grants and roles form an intersection before argument narrowing',async()=>{
  for(const allow of [false,true]) for(const role of [false,true]) for(const relationship of [false,true]) {
    const principal={id:'agent',subject:'workload',tenantId:'acme',allow:allow?['alpha__echo']:[],roles:role?['reader']:[]};
    const policy=new AllOfAuthorizer([new AllowListAuthorizer(),new RoleAuthorizer({reader:['alpha__echo']}),{async canCall(){return relationship;}}]);
    assert.equal(await policy.canCall(principal,'alpha__echo'),allow&&role&&relationship);
    assert.equal(await policy.canCall(principal,'beta__echo'),false);
    assert.equal(await policy.canAccess(principal,'resources/read','alpha__private'),false);
    const args={owner:'acme',operation:'read'};
    const rules={alpha__echo:{allow:[{constraints:[{field:['owner'],op:'matchesIdentity',claim:'tenantId'}]}],deny:[{constraints:[{field:['operation'],op:'equals',value:'delete'}]}]}};
    assert.doesNotThrow(()=>enforceInvocation(rules,['alpha__echo'],principal,args));
    assert.throws(()=>enforceInvocation(rules,['alpha__echo'],principal,{...args,owner:'other'}));
    assert.throws(()=>enforceInvocation(rules,['alpha__echo'],principal,{...args,operation:'delete'}));
    assert.throws(()=>enforceInvocation(rules,['alpha__echo'],principal,Object.create(args)));
  }
});
