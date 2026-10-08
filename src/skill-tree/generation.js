import { z } from "zod";
import { treePatchSchema, planSchemaV3 } from "./tree-patch.js";
import { skillIconCatalog } from "../../public/skill-tree/skill-icons.js";
export const skillGenerationSchema = z
  .object({ plan: planSchemaV3, treePatch: treePatchSchema })
  .strict();
export const skillGoalId = (id) => "goal_" + id.replaceAll("-", "");
export const skillPrompt = `为已经保存的用户目标生成长期个人技能树增量及当前批次任务。只输出{plan,treePatch} JSON。
context.goals[0]是本次目标，不得改变目标。plan.goal.title/target/minutes分别照抄目标title/criterion/minutes；treePatch.goalId照抄context.skillGoalId，requestId照抄context.treeRequestId，baseRevision照抄context.personalTree.revision。
plan为earth.plan.v3；任务不是验收，action.detail写清具体步骤、资源和遇到困难怎么办。行动分钟之和等于任务分钟，任务总时长不超过目标minutes。未知信息写入assumptions，不能伪称已知。技能树不是路线阶段，技能在不同目标之间长期复用。
resources中verified_link只能用earth_search或context.knowledge实际返回的来源；缺资料用needs_user，对应task标记needs_material，materialQuestion说明需要什么。stat为0知识/1胆量/2灵巧/3温柔/4魅力。
个人树的根永远是self（我），一级只有body身心、mind认知、practice实践，二级骨架已在context.personalTree.nodes中给出。不能新造英语核心、改写骨架或让新节点直接挂self。语言挂language，健身基础挂physical等已存在二级入口。
treePatch={schemaVersion:"earth.tree.patch.v1",baseRevision:context.personalTree.revision,requestId:context.treeRequestId,goalId,addNodes,reuseNodeIds,updateNodes}。addNodes使用节点字段id,name,description,icon,kind(domain/ability)，milestone固定null,parentId,prerequisites,baseline,stat,milestone。只增加缺少的节点，不重复返回已有节点。已有同义能力也应复用，不换ID新建。reuseNodeIds列出本次使用的已有具体能力；updateNodes只允许修改已复用且非骨架节点的description，不改已有基础或进度。
先完整检查已有节点和目标，再选择新增或复用。goalId由程序分配，始终照抄context.skillGoalId。目标是独立记录，不能以新目标覆盖旧目标。所有任务、strategy与targetSkillIds引用的能力必须在addNodes或reuseNodeIds中，不能以宏观骨架节点作为具体训练能力。
prerequisites可引用全树已有或本次新增节点；parentId只表示归属。不可输出坐标、经验、进度修改或删除指令。baseline必须为unlit/unknown/null，或lit/self_report/用户原话精确片段；不熟练的事实留在plan.assumptions，禁止unlit/self_report组合。添加目标愿望不能点亮能力。
新增节点禁止core和milestone图标。图标除其余旧枚举还支持body,mind,action,sport,emotion,focus,language,logic,information,social,home,money,work,art,strength,stamina,mobility。UI决定图标形状和固定方向。
技能节点是换目标后仍属于用户的长期能力，不是目标、分数、证书、阶段、题型、菜谱或训练动作。熟练度增长留在同一节点，不新建入门/进阶/高级节点。每轮只新增必要的0至8个节点，可零新增；不要为了填满数量而拆细。
默认语言层级：language→英语→听力/口语/阅读/写作。雅思7分只写plan.goal，不出现在节点中。听说读写不得直接挂language，不拆到定位信息/句子组织等课程细节。健身：physical→力量/耐力/灵活性；游泳：sport→游泳，同时复用耐力；做晚饭：life→烹饪，不按菜名扩树。层数允许不同。
新目标为英语工作交流时，复用已有英语听力与口语，不生成职场英语或新的同义节点。目标不同不等于技能不同。所有涉及的能力都关联目标。默认prerequisites=[]，归属不是解锁条件。只有用户明确需要长期专精才继续细分。

可用图标：${skillIconCatalog.map((i) => i.key + "=" + i.label).join("、")}。
`;
