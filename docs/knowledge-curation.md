# 规划知识库的来源筛选与案例维护

2026-10-09 这批内置资料由 8 份扩为 **28 份**，保留原 8 个文档 ID 和来源链接，新增 20 份不同用途的资料，共有 **56 个原创情景**。每份正文约 638–698 字，覆盖目标拆解、行动启动、习惯、回忆复习、反馈、写作、英语、编程、时间安排和项目复盘。不是把网页全文抓进索引，也不代表已经建立覆盖所有目标的课程库。

种子正文位于 [planning.json](../packages/planning-rag/knowledge/planning.json)，审核记录位于 [source-review.json](../packages/planning-rag/knowledge/source-review.json)。只有正文种子进入向量索引；审核 manifest 中的拒绝候选、读取状态和筛选说明不作为模型的知识材料。

## 为什么选这些来源

本批逐一打开原始研究、大学指导或工具官方文档，核对能支持的具体方法。研究摘要只支持摘要明确陈述的内容；大学和工具指南属于教学建议或第一方用法说明，不能被包装成普遍实验结论。

| 来源                                                                                                                                                                                                                                                                                                                       | 入库用途                                       | 保留的边界                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| [Locke 与 Latham 原论文](https://med.stanford.edu/content/dam/sm/s-spire/documents/PD.locke-and-latham-retrospective_Paper.pdf)、[Gollwitzer 原论文](https://www.socmot.uni-konstanz.de/sites/default/files/99_Gollwitzer_Implementation_Intentions.pdf)                                                                   | 结果含糊时拆近期步骤；启动困难时连接情境与动作 | 不把困难目标或实施意图当万能解法；块长是原创预算                       |
| [Dunlosky 等学习综述](https://www.psychologicalscience.org/journals/pspi/1529100612453266/)、[Anki 官方手册](https://docs.ankiweb.net/manual/background)                                                                                                                                                                   | 主动回忆、查错、后续复习和工具边界             | 卡片不替代真实表达或实操；不用固定遗忘百分比                           |
| [Cornell 考前安排](https://lsc.cornell.edu/how-to-study/studying-for-and-taking-exams/the-five-day-study-plan/)、[周历指南](https://lsc.cornell.edu/managing-time/)                                                                                                                                                        | 准备与自测分块；先保留固定承诺再分配空档       | 五天和页面的小时比例不是个人标准；考试材料须已取得                     |
| [Purdue 反向提纲](https://owl.purdue.edu/owl/general_writing/the_writing_process/reverse_outlining.html)                                                                                                                                                                                                                   | 已有草稿的段落主题、作用与顺序检查             | 只简短转述方法事实，不复制网页范例或模板；结构不替代证据               |
| [British Council 听力入口](https://learnenglish.britishcouncil.org/free-resources/listening/a2)、[IELTS 官方入口](https://ielts.org/take-a-test/preparation-resources/sample-test-questions)、[CEFR 官方说明](https://www.coe.int/en/web/common-european-framework-reference-languages/level-descriptions)                 | 选材料、确认考试类型、把语言目标具体到交流任务 | 核查入口不等于拿到每道题；等级标签和一次练习不构成认证                 |
| [MDN 小网页规划](https://developer.mozilla.org/en-US/docs/Learn_web_development/Getting_started/Your_first_website/What_will_your_website_look_like)、[Python 错误教程](https://docs.python.org/3/tutorial/errors.html)、[Pro Git 检查变更](https://git-scm.com/book/en/v2/Git-Basics-Recording-Changes-to-the-Repository) | 缩小项目范围、复现报错、检查真实源码与结果     | 未运行不能写成功；本机试验、提交和发布分别确认                         |
| [Edinburgh 反思工具](https://reflection.ed.ac.uk/reflectors-toolkit/reflecting-on-experience/what-so-what-now-what)、[Google SRE 复盘](https://sre.google/sre-book/postmortem-culture/)                                                                                                                                    | 用真实事实与假设找下一次可试改进               | SRE 是第一方工程实践，适配到小项目是本应用设计，不宣称复制大型系统效果 |

全部 28 个来源的发布者、类型、核查范围、适用理由和限制在 manifest 中逐项记录。`progress-record-and-adjust` 的 PubMed 网页本次返回 cookie challenge，因此实际通过 [NCBI 官方 efetch](https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=26479070&retmode=xml) 读取相同 PMID 的原论文摘要，保留原 PubMed 链接；没有绕过 challenge 或声称读到全文。Lally 习惯研究也只按已读取的摘要讨论稳定情境与个体差异。

拒绝候选同样有记录：British Council 的一篇词汇建议页含缺少充分支持的固定记忆效果保证；UNC 的候选日历入口本次无法读取正文；商业五日计划文章是二次改写且正文未读到。拒绝后两项是本次核查范围的决定，不是对机构或作者质量的笼统判断。不能把拒绝条目的标题、片段或来源当正式知识使用。

## 每份正文怎样写

文档格式仍严格为 `id/title/url/content/tags`，不把审核字段塞进导入协议。正文采用短段落和小标题：简短方法事实、应用设计步骤、两个原创情景、限制与调度提示。每个原创情景包含用户目标与材料状态、有限时间块、可检查产物及复盘选择；情景明确标注“不是研究结果”。

这些场景、分钟、顺序与失败后的调整由项目原创，不能写成论文受试者故事或效果统计。来源方法与本应用推论分开表述，不镜像论文、网页、练习题、答案或代码示例。每段保留独立含义，供约 400 字分块检索；模型仍受每轮片段数与总长度上限约束，不能把新增语料全部塞回用户界面。

材料须区分已取得、已核查入口与待确认。听力没有可播放录音、考试没有合法题卷、程序没有实际运行环境时，先安排材料或环境检查，不能假装练习已可执行。投入分钟、卡片张数、提交次数和自述等级只描述过程，不替代能力或成果证据。健康治疗、理财处方及未经支持的效果保证不属于这批资料范围。

## 更新来源与已有索引

资料文件更新后，**已有非空索引需要维护者手动运行 `seed`**；Git 更新或应用重启不会自动把已存在的库替换为新版。首次空库的自动种子只解决初次准备，不能当作持续更新机制。

正式应用在仓库根目录运行：

```sh
npm run knowledge -- seed
npm run knowledge -- status
npm run knowledge -- search '我写完报告但段落逻辑很散，怎么修订'
```

工作台在独立目录运行同名命令，使用自己的 file 索引：

```sh
cd tools/agent-workbench
npm run knowledge -- seed
npm run knowledge -- status
```

初次初始化需先 `setup`，正式应用要准备 pgvector，详见 [RAG 使用说明](rag.md)。`seed` 按稳定 ID 导入共享种子，内容或模型标识变化时重新生成片段与向量，未变化的文档跳过；不删除或覆盖不同 ID 的私人资料。若从种子删除一个文档，仅运行 `seed` 不会自动清除库中旧条目，维护者须检查影响并显式删除对应共享文档；不要删除整个索引来更新资料。

维护来源时重新打开实际 URL，记录 `reviewedAt`、读取范围及限制，保持兼容 ID；明显改变用途时使用新 ID。`reviewedAt` 是人工审核日期，不是网站更新日期，也不是运行时 `retrievedAt`。已有聊天或路线保存的是当时来源信息，新一轮检索才使用当前索引；原文网址的内容仍可能随发布方更新，不能用旧审核日期表示已经再次核查。

## 怎样验证

```sh
node --test test/knowledge-curation.test.js
```

质量回归检查兼容 ID、严格字段、可靠来源与审核记录对应关系、不同用途覆盖、原创情景的时间块/产物/复盘、以及真实导入升级后私人资料不被覆盖。测试使用临时文件索引和向量夹具，不读取密钥、不下载模型、不连接生产数据库。

这些检查不替代人工事实审核，也不证明检索相关性或规划效果。语料更新后仍应运行实际中文 embedding 与目标 backend 的检索评测，检查典型查询是否命中合适方法、错误领域是否被排除及引用是否真实。密钥和运行时 `var/` 索引、模型缓存、私人对话继续保持在 Git 忽略范围。
