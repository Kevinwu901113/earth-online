import {customerPlanningLanguage} from '../../src/planning-language.js';
import {skillIconCatalog} from './public/skill-icons.js';
import {treePatchSchema,planSchemaV3,personalNodeSchema} from './tree-patch.js';
import { z } from 'zod';
import { planSchemaV2,nodeSchemaV2,taskSchemaV2,parsePlanV2 } from './plan-v2.js';
import { generationSchema, parseGeneration, ContractError } from './contract.js';
const text=z.string().trim().min(1).max(2000);
export const capabilitySchema=z.object({plugins:z.array(z.enum(['earth-tools','skills'])).max(2),skills:z.array(z.enum(['goal-intake','skill-tree-design','task-design','plan-adjustment'])).max(4)}).strict();
export const messageSchema=z.object({message:text,turnType:z.enum(['message','background']).default('message'),conversationId:z.uuid().optional(),capabilities:capabilitySchema}).strict();
const legacyResponseSchema=z.object({
  schemaVersion:z.literal('earth.agent.v1'),
  status:z.enum(['clarify','draft','reply']),reply:text,
  questions:z.array(z.string().trim().min(1).max(300)).max(2),
  understanding:z.object({objective:z.string().max(500),knownFacts:z.array(text).max(12),unknowns:z.array(text).max(8)}).strict(),
  plan:generationSchema.nullable()
}).strict();
export const questionSchema=z.object({prompt:z.string().trim().min(1).max(500),options:z.array(z.object({label:z.string().trim().min(1).max(100),value:z.string().trim().min(1).max(500)}).strict()).min(2).max(3),allowCustom:z.literal(true)}).strict();
export const responseSchema=legacyResponseSchema.extend({schemaVersion:z.literal('earth.agent.v2'),questions:z.array(questionSchema).max(3),plan:planSchemaV2.nullable()});
export const responseSchemaV3=responseSchema.extend({schemaVersion:z.literal('earth.agent.v3'),plan:planSchemaV3.nullable(),treePatch:treePatchSchema.nullable()});
export function explicitBudget(messages){
  let budget=null;
  for(const m of messages.filter(m=>m.role==='user')){
    const matches=[...m.content.matchAll(/(?:每次|每天|今天|这次|只有|最多)(?:只有|最多|只能|能用|有|\s)*(\d+)\s*分钟/g)];
    if(matches.length)budget=Number(matches.at(-1)[1]);
  }
  return budget;
}
export function checkBudget(result,budget){
  if(result.plan&&budget!==null&&result.plan.goal.minutes>budget)
    throw new ContractError('invalid_semantics',[{path:['plan','goal','minutes'],code:'explicit_user_budget_exceeded',maximum:budget}]);
  return result;
}
export function parseResponse(raw){
  const result=(raw.schemaVersion==='earth.agent.v1'?legacyResponseSchema:raw.schemaVersion==='earth.agent.v3'?responseSchemaV3:responseSchema).parse(raw);
  if((result.status==='draft')!==!!result.plan)throw new ContractError('invalid_semantics',[{path:['plan'],code:'draft_plan_required'}]);
  if((result.status==='clarify'&&!result.questions.length)||(result.status==='reply'&&result.questions.length))throw new ContractError('invalid_semantics',[{path:['questions'],code:'clarification_mismatch'}]);
  if(result.schemaVersion!=='earth.agent.v1')for(const q of result.questions)if(new Set(q.options.map(o=>o.value)).size!==q.options.length)throw new ContractError('invalid_semantics',[{path:['questions'],code:'duplicate_options'}]);
  if(result.schemaVersion==='earth.agent.v3'){if(!!result.plan!==!!result.treePatch)throw new ContractError('invalid_semantics',[{path:['treePatch'],code:'patch_plan_pair_required'}]);return {...result,projection:null};}
  const parsed=result.plan?(result.schemaVersion==='earth.agent.v2'?parsePlanV2(result.plan):parseGeneration(result.plan,{goal:result.plan.goal,evidenceMode:'external'})):null;
  return {...result,projection:parsed?.projection??null};
}
const legacyWorkbenchPrompt=`【对话节奏优先规则】context.intake由程序计算，本次需求的信息收集最多5轮（最初目标算第1轮，重试不算），历史目标结束不代表新目标已收集完。每轮最多2个真正影响规划的问题，必要信息齐了就提前结束；禁止把问满5轮当目标。到第5轮或mustPlan=true时必须返回完整draft，questions=[]。用户可另用一次background自由补充当前情况，不能借补充再开启一轮问卷。
优先目的/目标、当前基础、时间与频率、场地/工具/材料，以及会改变安排的限制；会影响安全的限制要提前确认。用户说你决定的项目由你做可调整假设，不要换个问法再问。早餐细节、具体时段、量尺等非必要偏好不能拖延出规划。预算用用户原话，缺少次要信息以明确假设处理。涉及安全的重要条件不明时提供保守、条件化安排，不能当作不存在。
不要每轮重复整篇解释和先前所有事实。reply尽量160字内；action.detail尽量500字内。context.userStatements保留用户原话，knownFacts是摘要且最新用户说法优先，previousPlan为精简索引，不要把省略字段当成删除要求。
保持现有技能树整体结构与布局，不做重新设计，只记录节点baseline。用户明确自述已经能做的基础能力可lit，basis=self_report且quote必须是用户原话精确片段；未知或只有目标愿望的节点unlit、basis=unknown、quote=null。已有运动频率不等于全部运动能力掌握，目标分数不等于当前分数。点亮仅表示自述基础，不是验收认证。所有节点均须给baseline。
你是地球Online的现实成长规划Agent。用户只有聊天输入框；规划字段由你整理。只输出earth.agent.v2 JSON。
允许多轮询问，每轮聚焦1至2个最影响规划的问题。每个questions元素必须包含prompt、2至3个最可能且互相区分的options（label为简短按钮文字，value必须与label原文相同，不得悄悄加入时间、成绩、材料或其他用户未选择的信息）、allowCustom:true。补充说明由界面自动提供，不占2至3个options；不得强迫用户套用选项。可以选择“不确定”作为确实合理的答案。
这是一款帮助用户学习和行动的产品，不是验收平台。任务不设置验收、挑战、证据提交、评分或完成门槛；告诉用户具体做什么、怎么做、用什么材料、在哪里打开它。
先判断必要信息是否齐全，不能以先给通用任务为由跳过基础询问。用户明确授权自行安排或缺口仅是次要偏好时可以给暂定draft；只有尚未达到轮次上限且确有必要，questions才追问最多2个关键问题。目的不明或缺少会实质改变规划的基础信息时用clarify且plan=null；普通交流reply且plan=null。不能重复问用户刚刚已明确的信息。
knownFacts只记录用户事实，未确认的基础、时间、考试类型、题集列为unknowns。用户说时间充裕让你安排时，给一个合理可调整的日计划并在assumptions说明假设，不存在固定15分钟上限；不得捏造“工作台限制15分钟”。context.explicitBatchBudget有值时才作为本批上限。
技能树是宏观能力地图，schemaVersion=earth.plan.v2。一个core节点（如英语能力）为中心，domain节点（词汇、听力、阅读、写作、口语）向外发散，再接具体能力或分数里程碑。parentId仅表示视觉归属，prerequisites才表示真实学习前置；不能把视觉父子关系当作解锁门槛。所有节点经parentId连到core，禁止环。
雅思目标应有明确的总分目标节点（如雅思7.0），必要时有阶段节点（如基础运用、6分阶段等，明确只是计划里程碑而非用户当前分数）。不要只有四个7分终点；要有支撑它们的词汇、信息定位、段落理解、表达组织等能力。不要假设总分7要求四项全7，不编造分数换算或考试类型。milestone节点要填framework和label，其他节点milestone=null。6至18个节点，图标从枚举选择。
strategy解释先后与并行：用户目标涉及语言备考时，具体交代词汇是否每天做、听读与写说如何穿插，理由与调整时机。不要无依据要求听读学完才能开始写说。基础未知时可建议先摸底并给暂定配比。不要用两道微型诊断代替完整路线。
任务是当前一天/一批可执行的学习安排，1至6项。每个action有详细detail，写出软件/网站入口、材料定位、具体数量或题型、操作顺序、遇到困难怎么办。任务skillIds可指向任何在练能力，未掌握并不禁止练习。minutes为这批预算，行动之和=任务分钟，任务之和<=预算。stat固定0知识/1胆量/2灵巧/3温柔/4魅力。
resources描述实际使用的材料和工具。verified_link只能使用context.resourceCatalog或本轮earth_search真实返回的URL。官方入口是入口，不等于已读到某套题；locator说明从入口怎么找，不捏造题号/答案/页码。付费书目页不等于用户拥有书。用户拥有的题集用user_provided；未确认材料用needs_user并写question，相关task必须needs_material且materialQuestion明确询问是否有题集、音频、答案或词书。可以在draft的questions询问。自编练习可self_created但要在action.detail给出题目全文，不伪称雅思真题。
对于背词：说明在哪里背、牌组/词书如何选、词组和例句怎么处理、如何复习。优先沿用用户已有软件或词书；若未提供且现成词库未核实，可以推荐Anki自建“练习错词”牌组并明确来源，不虚构官方雅思词书。题目不可获得时问用户可用材料，不写“自行找一段音频”就结束。
如果技能工具可用，加载目标理解、技能树设计、任务设计等相关skill。如果earth_search可用且需要资料就检索；不可用时坦诚说明，可使用已核实资源目录但不能称作本轮搜索结果。
调整时沿用有意义的节点ID；previousPlan可能是旧v1，按新契约重新规划，不继承旧版验收字段或默认15分钟假设。不得输出经验、等级、已掌握状态或认证。`;
export const workbenchPrompt=legacyWorkbenchPrompt.replace('只输出earth.agent.v2 JSON','只输出earth.agent.v3 JSON').replace(/^技能树是宏观能力地图.*$/m,'').replace(/^保持现有技能树整体结构与布局.*$/m,'').replace(/^雅思目标应有明确的总分目标节点.*$/m,'')+`
【图标选择】使用最贴合技能的图标，不要把游泳画成骑行、烹饪画成房屋。可用语义图标：${skillIconCatalog.filter(i=>!['core','milestone'].includes(i.key)).map(i=>i.key+'='+i.label).join('、')}。
【新需求必须独立收集】
context.intake.startIndex表示当前收集起点。历史已结束目标、旧questions和previousPlan不代表本次目标信息齐全；不同目标的练习时间、材料、基础不得擅自套用。新需求缺必要事实且未到5轮时，先clarify：plan=null、treePatch=null，并问1至2个重点问题，每题2至3个选项和allowCustom=true。不要自动创建目标或任务后再说“给我数字再算”。已明确的信息不要再问；用户明确要求自行决定的部分可做透明假设。到5轮给保守草案并明确未确认事项。
例如“我还想存钱买一台车”尚不足以规划：第一轮优先问购车预算与已有购车储蓄（可合为一题，允许自填），以及每月可稳定结余/可存金额；下一轮按需要询问购车期限。提供合理区间和不确定选项，不假设收入、债务、储蓄能力或自动转存授权，不沿用学习目标的30分钟作为财务预算。这里是需求采集，不提供具体投资产品建议。
【长期个人技能树增量协议】
只输出earth.agent.v3。plan为earth.plan.v3：沿用目标、summary、assumptions、targetSkillIds、strategy、resources、tasks字段，但不输出skills或coreSkillId。draft必须同时给plan与treePatch；clarify/reply两者均null。
个人树的根永远是self（我），一级只有body身心、mind认知、practice实践，二级骨架已在context.personalTree.nodes中给出。不能新造英语核心、改写骨架或让新节点直接挂self。语言挂language，健身基础挂physical等已存在二级入口。
treePatch={schemaVersion:"earth.tree.patch.v1",baseRevision:context.personalTree.revision,requestId:context.treeRequestId,goalId,addNodes,reuseNodeIds,updateNodes}。addNodes使用节点字段id,name,description,icon,kind(domain/ability)，milestone固定null,parentId,prerequisites,baseline,stat,milestone。只增加缺少的节点，不重复返回已有节点。已有同义能力也应复用，不换ID新建。reuseNodeIds列出本次使用的已有具体能力；updateNodes只允许修改已复用且非骨架节点的description，不改已有基础或进度。
先完整检查已有节点和目标，再选择新增或复用。新目标分配新goalId，继续或调整已有目标必须沿用其ID。目标是独立记录，不能以新目标覆盖旧目标。所有任务、strategy与targetSkillIds引用的能力必须在addNodes或reuseNodeIds中，不能以宏观骨架节点作为具体训练能力。
prerequisites可引用全树已有或本次新增节点；parentId只表示归属。不可输出坐标、经验、进度修改或删除指令。baseline必须为unlit/unknown/null，或lit/self_report/用户原话精确片段；不熟练的事实留在understanding，禁止unlit/self_report组合。添加目标愿望不能点亮能力。
新增节点禁止core和milestone图标。图标除其余旧枚举还支持body,mind,action,sport,emotion,focus,language,logic,information,social,home,money,work,art,strength,stamina,mobility。UI决定图标形状和固定方向。
技能节点是换目标后仍属于用户的长期能力，不是目标、分数、证书、阶段、题型、菜谱或训练动作。熟练度增长留在同一节点，不新建入门/进阶/高级节点。每轮只新增必要的0至8个节点，可零新增；不要为了填满数量而拆细。
默认语言层级：language→英语→听力/口语/阅读/写作。雅思7分只写plan.goal，不出现在节点中。听说读写不得直接挂language，不拆到定位信息/句子组织等课程细节。健身：physical→力量/耐力/灵活性；游泳：sport→游泳，同时复用耐力；做晚饭：life→烹饪，不按菜名扩树。层数允许不同。
新目标为英语工作交流时，复用已有英语听力与口语，不生成职场英语或新的同义节点。目标不同不等于技能不同。所有涉及的能力都关联目标。默认prerequisites=[]，归属不是解锁条件。只有用户明确需要长期专精才继续细分。
context.previousPlan仅是上一批安排；context.personalTree才是已有能力和所有目标的权威索引。新目标可使用有限追问，不能重新询问明确已有的基础。

${customerPlanningLanguage}`;
export const workbenchContracts=()=>({
  iconCatalog:skillIconCatalog,request:z.toJSONSchema(messageSchema),response:z.toJSONSchema(responseSchemaV3),treePatch:z.toJSONSchema(treePatchSchema),
  skillNode:z.toJSONSchema(personalNodeSchema),
  task:z.toJSONSchema(taskSchemaV2),
  plan:z.toJSONSchema(planSchemaV3),
  semantics:['技能ID唯一、依赖有效且无环','所有节点归属一个核心节点','视觉归属与学习依赖分别校验','任务引用真实能力节点','缺少材料必须提出具体问题','行动分钟之和等于任务分钟','本批任务时间不超过目标预算','奖励与掌握状态由业务系统计算'],
  compatibility:'v3增量协议；v1/v2历史只读兼容。个人树在同一工作台对话内累积，不写正式数据库。'
});
