import { mkdir,readFile,writeFile,rename,readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve,join } from 'node:path';
import { isRetry,intakeState,compactContext,enforceIntake,verifyBaselines,failureSummary,recoverable } from './intake.js';
import { resourceCatalog } from './resources.js';
import { checkResources } from './plan-v2.js';
import { agentConfig } from './engine.js';
import { DshAgent } from './current/src/agent.js';
import { parseResponse,explicitBudget,checkBudget } from './workbench-contract.js';
const root=resolve('var/workbench');
export const catalog={
  plugins:[{id:'earth-tools',name:'Earth 业务工具',description:'上下文、标准查询、资料检索（未配置搜索时明确返回不可用）'},
    {id:'skills',name:'DSH 技能运行时',description:'挂载 dsh-skill、skill-filesystem、tool-skill；卸载后 Agent 无法加载以下技能'}],
  skills:[{id:'goal-intake',name:'目标理解',description:'提炼目的、区分事实与假设、必要追问'},
    {id:'skill-tree-design',name:'技能树设计',description:'核心能力、分支与阶段里程碑'},
    {id:'task-design',name:'任务设计',description:'学习顺序、软件材料与详细操作'},
    {id:'plan-adjustment',name:'反馈调整',description:'结合历史调整时间、难度与目标'}],
  availableOnly:[{id:'mcp-client',name:'MCP 接入',reason:'已安装；尚未配置外部服务，本工作台不提供任意包安装'},
    {id:'ask-user',name:'DSH 等待式提问',reason:'未接入网页答复通道；当前使用持久化聊天消息追问'}]
};
const file=id=>join(root,`${id}.json`);
async function save(c){await mkdir(root,{recursive:true});await writeFile(file(c.id)+'.tmp',JSON.stringify(c),{mode:0o600});await rename(file(c.id)+'.tmp',file(c.id));}
export async function getConversation(id){if(!/^[a-f0-9-]{36}$/.test(id))throw Object.assign(new Error(),{code:'not_found'});try{return JSON.parse(await readFile(file(id),'utf8'))}catch(e){if(e.code==='ENOENT')throw Object.assign(new Error(),{code:'not_found'});throw e}}
export async function listConversations(){await mkdir(root,{recursive:true});const names=(await readdir(root)).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n));const rows=await Promise.all(names.map(async n=>{const c=await getConversation(n.slice(0,-5));return {id:c.id,title:c.title,updatedAt:c.updatedAt,revision:c.revision}}));return rows.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
export async function prepareMessage(input){
  const c=input.conversationId?await getConversation(input.conversationId):{id:randomUUID(),title:input.message.slice(0,36),messages:[],revision:0,plan:null};
  if(c.messages.length>=120)throw Object.assign(new Error(),{code:'conversation_full'});
  if(input.turnType==='background'&&intakeState(c).backgroundUsed)throw Object.assign(new Error(),{code:'background_used'});
  c.messages.push({id:randomUUID(),turnType:input.turnType??'message',role:'user',content:input.message,at:new Date().toISOString()});c.updatedAt=new Date().toISOString();c.capabilities=input.capabilities;await save(c);return c;
}
export async function runMessage(c,{agent,persist=save,onProgress=()=>{},runId=randomUUID()}={}){
 if(c.lastRun&&c.lastRun.id!==runId)c.runHistory=[...(c.runHistory??[]),c.lastRun].slice(-10);
 const trace={calls:[]},baseCfg={...agentConfig(),labCapabilities:c.capabilities,labTrace:trace};
 const lastUser=[...c.messages].reverse().find(m=>m.role==='user'&&!isRetry(m.content));
 const job={user_id:'workbench',kind:'workbench',input:{message:lastUser?.content??c.messages.at(-1).content}};
 const context=compactContext(c);context.resourceCatalog=resourceCatalog;context.searchAvailable=!!baseCfg.EXA_API_KEY&&c.capabilities.plugins.includes('earth-tools');context.explicitBatchBudget=explicitBudget(c.messages);
 const start=Date.now();let output;const attempts=[];
 async function progress(status,attempt,error){c.lastRun={id:runId,status,attempt,maxAttempts:3,attempts:[...attempts],updatedAt:new Date().toISOString(),...(error?{error}: {})};await persist(c);await onProgress(c.lastRun);}
 for(let attempt=1;attempt<=3;attempt++){
  await progress('running',attempt);const at=Date.now();
  try{
   const cfg={...baseCfg,DSH_REASONING_EFFORT:attempt===1?baseCfg.DSH_REASONING_EFFORT:'low'};
   output=checkBudget(parseResponse(await (agent||new DshAgent(cfg)).run({...job,id:randomUUID()},context)),context.explicitBatchBudget);
   checkResources(output,[...resourceCatalog.map(r=>r.url),...(trace.sourceUrls??[])]);enforceIntake(output,context.intake);verifyBaselines(output,c);
   attempts.push({attempt,status:'completed',elapsedMs:Date.now()-at});break;
  }catch(e){const error=failureSummary(e);attempts.push({attempt,status:'failed',elapsedMs:Date.now()-at,error});
   if(attempt===3||!recoverable.has(error.code)){await progress('failed',attempt,error);throw e;}
   await progress('retrying',attempt,error);context.validationFeedback={instruction:'自动恢复：使用原始用户输入重新输出合法响应。缩短非必要解释，严格遵守收集轮次和输出契约。',...error};
  }
 }
 if(output.plan){c.plan=output.plan;c.revision++;}
 c.intake={...context.intake,finalized:context.intake.mustPlan||(output.status==='draft'&&output.questions.length===0)};
 const result={...output,intake:c.intake,revision:c.revision,capabilities:structuredClone(c.capabilities),toolCalls:trace.calls,attempts,elapsedMs:Date.now()-start,model:baseCfg.DSH_MODEL,checks:{schema:true,semantics:true},writes:{productionDatabase:false,xp:false}};
 c.messages.push({id:randomUUID(),role:'assistant',content:output.reply,result,at:new Date().toISOString()});c.updatedAt=new Date().toISOString();await progress('completed',attempts.length);return {conversation:c,result};
}
