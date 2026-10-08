import test from 'node:test';import assert from 'node:assert/strict';
import {intakeState,compactContext,enforceIntake,verifyBaselines} from '../intake.js';
import {runMessage} from '../workbench.js';
import {fixture,exampleInput} from '../fixtures.js';
const user=content=>({role:'user',content});
const c=()=>({id:'test',title:'test',revision:0,plan:null,messages:[user('想学英语')],capabilities:{plugins:[],skills:[]}});
const response=()=>({schemaVersion:'earth.agent.v1',status:'draft',reply:'已规划',questions:[],understanding:{objective:'英语',knownFacts:[],unknowns:[]},plan:fixture(exampleInput)});
test('retry messages do not consume the five-round intake budget',()=>assert.equal(intakeState({messages:[user('goal'),user('重试'),user('retry'),user('answer')]}).round,2));
test('fifth substantive input mandates a plan and ends questions',()=>{const state=intakeState({messages:Array.from({length:5},(_,i)=>user(String(i)))});assert.equal(state.mustPlan,true);assert.throws(()=>enforceIntake({plan:null,questions:[]},state));assert.deepEqual(enforceIntake({plan:{},questions:['another']},state).questions,[])});
test('one free background round is separate from intake',()=>{const state=intakeState({messages:[user('goal'),{...user('我能读懂普通文章'),turnType:'background'}]});assert.equal(state.round,1);assert.equal(state.backgroundUsed,true)});
test('early finalized intake is not restarted',()=>assert.equal(intakeState({...c(),intake:{finalized:true}}).mustPlan,true));
test('a new request after a finalized plan starts a fresh intake, including legacy conversations',()=>{
 const value={messages:[user('英语'),{role:'assistant',content:'已规划'},user('我还想存钱买一台车')],intake:{finalized:true}};
 assert.equal(intakeState(value).round,1);assert.equal(intakeState(value).mustPlan,false);assert.equal(intakeState(value).startIndex,2);
 value.intake={...intakeState(value),processedThrough:2,finalized:false};value.messages.push({role:'assistant',content:'预算多少'},user('十万'));assert.equal(intakeState(value).round,2);
});
test('retry and optional background do not reopen completed intake',()=>{const value={messages:[user('英语'),{role:'assistant',content:'已规划'},user('重试'),{...user('补充'),turnType:'background'}],intake:{finalized:true,processedThrough:0}};assert.equal(intakeState(value).mustPlan,true)});
test('new goal can clarify without inheriting a completed goal or its time budget',async()=>{
 const value=c();await runMessage(value,{persist:async()=>{},agent:{run:async()=>response()}});
 value.messages.push(user('我还想存钱买一台车'));
 const r=await runMessage(value,{persist:async()=>{},agent:{run:async(job,ctx)=>{assert.equal(ctx.intake.round,1);assert.equal(ctx.intake.mustPlan,false);assert.equal(ctx.explicitBatchBudget,null);return {schemaVersion:'earth.agent.v3',status:'clarify',reply:'先了解预算',understanding:{objective:'购车储蓄',knownFacts:[],unknowns:['预算']},questions:[{prompt:'购车预算？',options:[{label:'还没确定',value:'还没确定'},{label:'有预算',value:'有预算'}],allowCustom:true}],plan:null,treePatch:null}}}});assert.equal(r.result.status,'clarify');assert.equal(value.revision,1);assert.equal(value.intake.finalized,false);
});
test('compaction retains user answers without repeated full assistant plans',()=>{const value=c();value.messages.push({role:'assistant',content:'x'.repeat(20000)},user('每次30分钟'));const ctx=compactContext(value);assert.ok(JSON.stringify(ctx).length<2000);assert.ok(ctx.userStatements.includes('每次30分钟'))});
test('lit nodes require an actual user quote',()=>{const output={plan:{skills:[{id:'read',baseline:{status:'lit',basis:'self_report',quote:'我能读懂普通文章'}}]}};assert.throws(()=>verifyBaselines(output,c()));assert.ok(verifyBaselines(output,{messages:[user('我能读懂普通文章，但写作不行')]}))});
test('two transient failures recover without asking user to resend',async()=>{const value=c();let calls=0;const r=await runMessage(value,{persist:async()=>{},agent:{run:async()=>{if(++calls<3)throw {failure:{code:'model_timeout'}};return response()}}});assert.equal(calls,3);assert.equal(r.result.attempts.length,3);assert.equal(value.messages.filter(m=>m.role==='user').length,1);assert.equal(value.lastRun.status,'completed')});
test('automatic recovery is bounded and saves diagnostics',async()=>{const value=c();let calls=0;await assert.rejects(runMessage(value,{persist:async()=>{},agent:{run:async()=>{calls++;throw {failure:{code:'model_execution_failed'}}}}}));assert.equal(calls,3);assert.equal(value.lastRun.status,'failed');assert.equal(value.lastRun.attempts.length,3)});
test('configuration errors do not trigger repeated model calls',async()=>{const value=c();let calls=0;await assert.rejects(runMessage(value,{persist:async()=>{},agent:{run:async()=>{calls++;throw {failure:{code:'model_unconfigured'}}}}}));assert.equal(calls,1)});
