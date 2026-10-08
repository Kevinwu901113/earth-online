import { ContractError } from './contract.js';
export const isRetry=message=>/^(重试|再试一次|retry)$/i.test(message.trim());
export function intakeState(c){
 const substantive=m=>m.role==='user'&&!isRetry(m.content)&&m.turnType!=='background';
 let startIndex=c.intake?.startIndex??0,finalized=!!c.intake?.finalized;
 const lastAssistant=c.messages.findLastIndex(m=>m.role==='assistant');
 const processedThrough=c.intake?.processedThrough??(lastAssistant>=0?lastAssistant:c.messages.length-1);
 if(finalized){const next=c.messages.findIndex((m,i)=>i>processedThrough&&substantive(m));if(next>=0){startIndex=next;finalized=false}}
 const rounds=Math.min(5,c.messages.slice(startIndex).filter(substantive).length);
 return {startIndex,round:rounds,maxRounds:5,mustPlan:rounds>=5||finalized,finalized,backgroundUsed:c.messages.some(m=>m.role==='user'&&m.turnType==='background')};
}
export function compactContext(c){const users=c.messages.filter(m=>m.role==='user'&&!isRetry(m.content));const selected=[...new Set([...users.slice(0,5),...users.slice(-8)])];const last=[...c.messages].reverse().find(m=>m.result)?.result;const p=c.plan;return {
 userStatements:selected.map(m=>m.content),
 messages:c.messages.slice(-4).map(m=>({role:m.role,content:m.role==='assistant'?m.content.slice(0,220):m.content})),
 knownFacts:last?.understanding?.knownFacts??[],lastQuestions:last?.questions??[],
 previousPlan:p?{schemaVersion:p.schemaVersion,goal:p.goal,coreSkillId:p.coreSkillId,skills:(p.skills??[]).map(n=>({id:n.id,name:n.name,kind:n.kind,parentId:n.parentId,prerequisites:n.prerequisites,baseline:n.baseline})),targetSkillIds:p.targetSkillIds,strategy:p.strategy,resources:p.resources,tasks:p.tasks.map(t=>({id:t.id,name:t.name,minutes:t.minutes,skillIds:t.skillIds,purpose:t.purpose}))}:null,
 revision:c.revision,intake:intakeState(c),standards:[],profile:{},goals:[],plans:[],records:[]};}
export function enforceIntake(output,intake){if(intake.mustPlan&&!output.plan)throw new ContractError('invalid_semantics',[{path:['plan'],code:'intake_limit_requires_plan'}]);if(intake.mustPlan)output.questions=[];else if(output.questions.length>2)throw new ContractError('invalid_semantics',[{path:['questions'],code:'only_two_priority_questions'}]);return output;}
export function verifyBaselines(output,c){const statements=c.messages.filter(m=>m.role==='user'&&!isRetry(m.content)).map(m=>m.content);for(const n of output.plan?.skills??[]){const b=n.baseline;if(b?.status==='lit'&&(!b.quote?.trim()||b.basis!=='self_report'||!statements.some(s=>s.includes(b.quote))))throw new ContractError('invalid_semantics',[{path:['skills',n.id,'baseline'],code:'baseline_requires_user_quote'}]);}return output;}
export function failureSummary(e){return {code:e.code??e.failure?.code??(e.name==='ZodError'?'output_schema_invalid':'internal_error'),...(e.failure?.execution?{execution:e.failure.execution}:{}),...(e.failure?.phase?{phase:e.failure.phase}:{}),...(e.failure?.json?{json:e.failure.json}:{}),issues:(e.issues??[]).slice(0,8).map(i=>({path:i.path,code:i.code}))};}
export const recoverable=new Set(['invalid_semantics','output_schema_invalid','output_json_invalid','model_timeout','model_execution_failed','model_output_empty','model_output_limit']);
