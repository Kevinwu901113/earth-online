import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {initialTree,applyTreePatch} from '../tree-patch.js';
import {parseResponse} from '../workbench-contract.js';
import {runMessage} from '../workbench.js';

const node=(id,parentId)=>({id,parentId,name:id,description:'具体能力',icon:'knowledge',kind:'ability',prerequisites:[],stat:0,milestone:null,baseline:{status:'unlit',basis:'unknown',quote:null}});
function fixture(tree=initialTree(),name='english',parent='language'){
 const requestId=randomUUID();
 return {patch:{schemaVersion:'earth.tree.patch.v1',baseRevision:tree.revision,requestId,goalId:'goal_'+name,addNodes:[node(name,parent)],reuseNodeIds:[],updateNodes:[]},plan:{schemaVersion:'earth.plan.v3',goal:{title:name,target:'提升能力',minutes:10},summary:'行动安排',assumptions:[],targetSkillIds:[name],strategy:[{name:'练习',skillIds:[name],approach:'循序练习',timing:'今天'}],resources:[],tasks:[{id:'daily',name:'练习',skillIds:[name],minutes:10,stat:0,purpose:'提升能力',resourceIds:[],readiness:'ready',materialQuestion:null,actions:[{name:'练习',minutes:10,detail:'完成一次具体练习。'}]}]}};
}
const apply=(tree,f,options)=>applyTreePatch(tree,f.patch,f.plan,options);
test('new tree rejects milestone types, score names and excessive expansion',()=>{
 for(const change of [{kind:'milestone',milestone:{framework:'IELTS',label:'7'}},{name:'雅思7分'},{name:'基础阶段'}]){const f=fixture();Object.assign(f.patch.addNodes[0],change);assert.throws(()=>apply(initialTree(),f))}
 const f=fixture();f.patch.addNodes=Array.from({length:9},(_,i)=>node('n'+i,'language'));assert.throws(()=>apply(initialTree(),f));
});
test('new node schema rejects mixed baseline states',()=>{const f=fixture();f.patch.addNodes[0].baseline={status:'unlit',basis:'self_report',quote:'我不擅长'};assert.throws(()=>apply(initialTree(),f,{userStatements:['我不擅长']}))});
test('language subskills require a language branch and remain reusable across goals',()=>{
 const f=fixture();f.patch.addNodes[0].icon='listening';assert.throws(()=>apply(initialTree(),f));
 f.patch.addNodes=[node('english','language'),{...node('listening','english'),icon:'listening',name:'听力'}];f.plan.targetSkillIds=['listening'];f.plan.tasks[0].skillIds=['listening'];
 const a=apply(initialTree(),f),g=fixture(a.tree);g.patch.addNodes=[];g.patch.reuseNodeIds=['listening'];g.patch.goalId='work_communication';g.plan.targetSkillIds=['listening'];g.plan.strategy[0].skillIds=['listening'];g.plan.tasks[0].skillIds=['listening'];
 const b=apply(a.tree,g);assert.equal(b.tree.nodes.length,a.tree.nodes.length);assert.equal(b.tree.goals.filter(goal=>goal.targetSkillIds.includes('listening')).length,2);
});
test('fixed skeleton has exactly three first-level branches',()=>assert.deepEqual(initialTree().nodes.filter(n=>n.parentId==='self').map(n=>n.id),['body','mind','practice']));
test('two goals accumulate skills, goals and task batches without replacing progress',()=>{
 const tree=initialTree(),first=fixture(tree);first.patch.addNodes[0].baseline={status:'lit',basis:'self_report',quote:'我会英语'};
 const a=apply(tree,first,{userStatements:['我会英语']}),before=structuredClone(a.tree.nodes);
 a.tree.nodes.find(n=>n.id==='english').progress={xp:12};
 const b=apply(a.tree,fixture(a.tree,'strength','physical'));
 assert.equal(tree.revision,0);assert.equal(b.tree.revision,2);assert.equal(b.tree.goals.length,2);assert.equal(b.tree.taskBatches.length,2);
 assert.equal(b.tree.nodes.find(n=>n.id==='english').baseline.status,'lit');assert.equal(b.tree.nodes.find(n=>n.id==='english').progress.xp,12);
 assert.deepEqual(b.tree.nodes.slice(0,before.length).map(({progress,...n})=>n),before);
});
test('reuse links another goal to the same ability',()=>{const a=apply(initialTree(),fixture());const f=fixture(a.tree);f.patch.addNodes=[];f.patch.reuseNodeIds=['english'];f.patch.goalId='goal_travel';const b=apply(a.tree,f);assert.equal(b.tree.nodes.length,a.tree.nodes.length);assert.equal(b.tree.goals.length,2)});
test('same request is idempotent and changed payload is rejected',()=>{const f=fixture(),a=apply(initialTree(),f);const b=apply(a.tree,f);assert.equal(b.replayed,true);assert.equal(b.tree.taskBatches.length,1);f.plan.summary='changed';assert.throws(()=>apply(a.tree,f),/invalid_semantics/)});
test('stale base revision cannot overwrite a later tree',()=>{const f=fixture(),a=apply(initialTree(),f);f.patch.requestId=randomUUID();assert.throws(()=>apply(a.tree,f))});
test('request identity must match server context',()=>assert.throws(()=>apply(initialTree(),fixture(),{requestId:randomUUID()})));
test('invalid task references reject the entire transaction',()=>{const tree=initialTree(),before=structuredClone(tree),f=fixture(tree);f.plan.tasks[0].skillIds=['missing'];assert.throws(()=>apply(tree,f));assert.deepEqual(tree,before)});
test('fixed root cannot gain a fourth branch',()=>{const f=fixture();f.patch.addNodes[0].parentId='self';assert.throws(()=>apply(initialTree(),f))});
test('fixed skeleton and progress cannot be edited',()=>{const f=fixture();f.patch.reuseNodeIds=['language'];f.patch.updateNodes=[{id:'language',description:'change'}];assert.throws(()=>apply(initialTree(),f));f.patch.updateNodes=[{id:'language',description:'change',baseline:{status:'lit'}}];assert.throws(()=>apply(initialTree(),f))});
test('duplicate names and reused IDs are rejected',()=>{const a=apply(initialTree(),fixture());let f=fixture(a.tree);assert.throws(()=>apply(a.tree,f));f.patch.addNodes[0].id='different_id';assert.throws(()=>apply(a.tree,f))});
test('new nodes cannot form parent or learning cycles',()=>{for(const field of ['parentId','prerequisites']){const f=fixture();f.patch.addNodes[0][field]=field==='parentId'?'english':['english'];assert.throws(()=>apply(initialTree(),f))}});
test('unknown prerequisites and fake baseline claims are rejected',()=>{const f=fixture();f.patch.addNodes[0].prerequisites=['missing'];assert.throws(()=>apply(initialTree(),f));f.patch.addNodes[0].prerequisites=[];f.patch.addNodes[0].baseline={status:'lit',basis:'self_report',quote:'我会英语'};assert.throws(()=>apply(initialTree(),f))});
test('baseline domains cannot stand in for executable skill targets',()=>{const f=fixture();f.patch.addNodes=[];f.patch.reuseNodeIds=['language'];f.plan.targetSkillIds=['language'];assert.throws(()=>apply(initialTree(),f))});
test('v3 requires plan and patch together',()=>{const f=fixture(),r={schemaVersion:'earth.agent.v3',status:'draft',reply:'安排好了',understanding:{objective:'test',knownFacts:[],unknowns:[]},questions:[],plan:f.plan,treePatch:f.patch};assert.ok(parseResponse(r));assert.throws(()=>parseResponse({...r,treePatch:null}))});
test('workbench passes current tree and commits two model-generated branches',async()=>{
 const c={id:'test',title:'test',revision:0,plan:null,messages:[{role:'user',content:'我想考雅思7分'}],capabilities:{plugins:[],skills:[]}};
 let count=0;
 const agent={run:async(job,ctx)=>{const f=fixture({...initialTree(),revision:ctx.personalTree.revision},count++?'strength':'english',count===1?'language':'physical');f.patch.requestId=ctx.treeRequestId;return {schemaVersion:'earth.agent.v3',status:'draft',reply:'安排好了',understanding:{objective:'目标',knownFacts:[],unknowns:[]},questions:[],plan:f.plan,treePatch:f.patch}}};
 await runMessage(c,{agent,persist:async()=>{}});c.messages.push({role:'user',content:'我还想健身'});const r=await runMessage(c,{agent,persist:async()=>{}});
 assert.equal(c.tree.revision,2);assert.equal(c.tree.goals.length,2);assert.ok(r.result.plan.skills.some(n=>n.id==='english'));assert.ok(r.result.plan.skills.some(n=>n.id==='strength'));assert.equal(r.result.agentPlan.schemaVersion,'earth.plan.v3');
});
test('invalid duration retries with arithmetic feedback before committing',async()=>{
 const c={id:'retry-test',title:'test',revision:0,plan:null,messages:[{role:'user',content:'安排英语练习'}],capabilities:{plugins:[],skills:[]}};
 let attempts=0;
 const agent={run:async(job,ctx)=>{const f=fixture();f.patch.requestId=ctx.treeRequestId;if(attempts++===0)f.plan.tasks[0].minutes=9;else{assert.equal(c.tree?.revision??0,0);assert.equal(ctx.validationFeedback.taskDurations[0].actionTotal,10)}return {schemaVersion:'earth.agent.v3',status:'draft',reply:'安排好了',understanding:{objective:'目标',knownFacts:[],unknowns:[]},questions:[],plan:f.plan,treePatch:f.patch}}};
 const r=await runMessage(c,{agent,persist:async()=>{}});
 assert.equal(attempts,2);assert.equal(c.tree.revision,1);assert.equal(c.tree.taskBatches.length,1);assert.equal(r.result.attempts[0].status,'failed');
});
