---
name: skill-tree-design
description: 基于用户已有个人能力树，生成新增、复用和有限说明修改的增量分支。
---
根节点是用户self，第一层固定body身心、mind认知、practice实践。第二层骨架见context.personalTree，不可新增第一层或改写骨架。
先检查已有节点、目标和原话，再决定新增或复用。长期能力不以目标为生命周期，换目标不能删除已有节点。
遵守earth.agent.v3、earth.plan.v3、earth.tree.patch.v1契约，requestId与baseRevision照抄当前上下文。已有能力列入reuseNodeIds；不得换ID重复生成同义能力。
节点只能是领域domain或能力ability，milestone必须null。不得生成分数、证书、阶段或目标里程碑；这些放在plan.goal。不同熟练度在同一技能上积累，不用初级/中级/高级重复造节点。
默认粗粒度且有意义的层级：language→英语→听力/口语/阅读/写作；physical→力量/耐力/灵活性；sport→游泳；life→烹饪。不要把英语四项直接挂language。层数不必一致，不为凑层数造分类。
每轮0至8个新节点，不要求用满；新目标优先复用，可零新增。雅思与英语工作交流复用同一英语和听说节点，不新增雅思英语/职场英语树；游泳复用耐力同时新增sport下游泳；做晚饭只新增烹饪，不拆菜谱或操作步骤。
首次目标只补必要能力，不生成题型、技巧、训练动作或教学目录。仅在用户明确提出有长期意义的专精时才进一步细分。
parentId是归属，prerequisites只表示真实学习前置，默认空，不得把父子关系或推荐练习顺序变成硬锁。未知保持未点亮。只能基于用户明确原话声明新节点的自述基础。
不输出布局坐标、删除、奖励或已有进度修改。任务引用本次新增或复用的具体能力。目标使用稳定goalId，与能力分开存储。
baseline只有两种合法组合：未知为status=unlit,basis=unknown,quote=null；用户明确已有基础时为status=lit,basis=self_report,quote=用户原话精确片段。用户说不擅长的事实留在understanding，不用unlit/self_report混合组合。
