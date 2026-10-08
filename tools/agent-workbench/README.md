# Earth Agent 工作台

图标库：`/icon-library.html` 可搜索 87 个语义图标。`public/skill-icons.js` 是 Agent 枚举和前端渲染的共同来源；新增图标后运行 `node export-contracts.js`。新增内容沿用本地 Lucide，不访问第三方 CDN。历史节点继续使用原图标，新的生成可以选择更具体的图标。


## 长期技能节点规则（2026-10-08 修订）

新增节点仅允许 domain/ability，milestone 固定为 null，单轮最多 8 个，允许零新增。目标、考试分数、阶段和任务步骤留在目标/任务系统。英语采用“语言 → 英语 → 听说读写”，健身采用“体能 → 力量/耐力”，不强制相同层数。多个目标共享能力节点；节点详情显示关联目标。普通任务不触发细分，只有明确的长期专精需求才扩展。

解析器拒绝 milestone 类型、明显分数/阶段节点、超量新增及使用听说读写图标直接挂语言的扁平结构。语义同义合并和适当粒度仍依赖 Agent 判断，机器规则不能穷尽语义。旧对话和旧里程碑历史不自动删除，使用新对话验证新版规则。

## 2026-10-08：个人技能树增量协议

新生成使用 `earth.agent.v3`，内含 `earth.plan.v3`（当前任务批次）与 `earth.tree.patch.v1`（分支变更）。v1/v2 历史响应仍可读取。以下旧版 v2 字段说明仅适用于历史响应；最新契约以 `/api/workbench/contracts` 和导出的 JSON Schema 为准。

个人树根节点 `self` 是用户，一级固定 `body` 身心、`mind` 认知、`practice` 实践，预设二级入口由 `tree-patch.js` 提供。Agent 从 `context.personalTree` 获取已有节点/目标和 revision，并回填服务端生成的 `treeRequestId`。

补丁包含 `baseRevision`、`requestId`、`goalId`、`addNodes`、`reuseNodeIds`、`updateNodes`。只能新增非核心节点；复用必须引用已存在 ID；说明修改只支持已复用的非骨架节点的 description。不能删除节点、迁移父节点、改变已有 baseline/进度或生成第四个一级分支。同父级同名节点会被拒绝；同义但不同名称仍依赖 Agent 判断，当前没有自动语义合并。

目标独立保存在 `conversation.tree.goals`，任务按目标与请求存入 `taskBatches`，旧批次保留；本实验没有任务完成或 XP 结算。所有新任务、策略和目标引用必须明确指向本次新增或复用的具体能力。未知不等于不会，新增节点点亮仍要求用户原话。

`applyTreePatch` 是纯函数事务：先检查完整补丁及任务，包括 ID、图关系、材料与时间规则，再返回新树。版本冲突拒绝；相同 requestId 与相同载荷重放不再增加版本或任务批次，改载荷则拒绝。工作台将树、任务批次与对话结果一次原子改名保存。失败恢复仍有运行诊断，但不会写入半棵树。

UI 展示合并后的个人树：一级方向固定、点击逐层展开、可拖动缩放，节点默认只显示图标。`result.plan` 是供旧渲染器使用的合并视图，`result.agentPlan` 与 `result.treePatch` 是原始可解析增量输出；JSON 导出使用后两者，不混淆为 Agent 返回完整树。

范围：一段工作台对话对应一棵独立测试树，连续输入目标会累积；新建对话另起一棵树。没有正式账号级共享或跨对话合并。旧 v2 树不会自动迁移，原响应保留在历史中。每次规划收口后，下一条新的普通需求会开启新的信息收集周期，最多五轮；重试和额外背景不会重置。未收口的回答继续当前周期。旧对话通过最后一条助手消息兼容识别边界；预算只读取当前周期的明确时间。是否需要追问由 Agent 结合已有事实判断，关键缺口优先 clarify，而非先建任务再补数字。

修改入口：`tree-patch.js`（骨架/补丁/合并）、`workbench-contract.js`（v3 响应和提示）、`workbench.js`（调用与持久化）、`public/personal-tree-ui.js`（个人树展示）。执行 `npm test` 和 `node export-contracts.js`，后者同时导出 `tree-patch.schema.json`。图标采用仓库既有 Lucide，许可证见 `public/LICENSE-lucide.txt`。

独立实验工具，用来测试用户只输入自然语言时，DSH Agent 能否收集必要信息并生成可解析的技能树、学习策略和详细任务。它不是正式网站的新版本，也不会写入正式用户、任务或 XP 数据。

## 快速运行

需要 Node.js 24+、npm；真实生成需要可用的 DeepSeek 凭据。无需 PostgreSQL 或 Redis。

```sh
cd tools/agent-workbench
npm ci
```

将 `.env.example` 复制为 `.env`（PowerShell：`Copy-Item .env.example .env`；Linux/macOS：`cp .env.example .env`），填写 `DEEPSEEK_API_KEY`，然后：

```sh
npm start
```

打开 http://127.0.0.1:3188。所有命令均在本目录执行：运行数据按当前工作目录写入 `var/`。密钥、用户对话及运行数据不应提交；本目录已配置忽略规则。

服务仅监听回环地址，并检查 Host、Origin 与 POST 请求令牌。它没有公网用户认证，不要直接反向代理成公开服务。远程运行时使用 SSH 本地转发，例如：

```sh
ssh -N -L 3188:127.0.0.1:3188 USER@HOST -p PORT
```

`LAB_PORT` 控制端口；模型、供应商、推理强度和 token 上限见 `.env.example`。每次 Agent 尝试超时目前在 `engine.js` 固定为 120 秒。`EXA_API_KEY` 可选，未配置时实时检索不可用；`resources.js` 中少量人工核实的入口不等于实时搜索或已读取具体题目。

## 本地规划知识库（RAG）

工作台复用仓库的 `packages/planning-rag/` 检索代码，使用独立的 **file 向量索引**，不连接生产数据库，也不需要 pgvector。中文 embedding 由本地 `Xenova/bge-small-zh-v1.5` 模型生成；`EXA_API_KEY` 仅影响实时网络搜索，不影响本地知识检索。

在本目录初始化并检查知识库：

```sh
npm run knowledge -- setup
npm run knowledge -- seed
npm run knowledge -- status
npm run knowledge -- search '我想学习英语，怎么安排复习和练习'
```

CLI 固定使用 `--backend=file --namespace=workbench`，索引保存在本目录的 `var/knowledge/workbench.json`。`seed` 导入 8 条原创规划参考；首次下载公开中文模型到本目录的 `var/models/`，以后从本地缓存加载，无需额外 embedding API 密钥。空库首次规划可自动导入内置参考；提前运行 `seed` 可避免第一条请求等待模型下载。

可导入自己的 UTF-8 Markdown、纯文本或 JSON，JSON 支持单个文档或文档数组：

```sh
npm run knowledge -- import /完整路径/学习方法.md
npm run knowledge -- import /完整路径/学习笔记.txt
npm run knowledge -- import /完整路径/参考资料.json
```

对话与规划预览中的「规划依据」默认折叠，展开后查看命中数量、索引信息、短来源与适用理由，并可打开原文。界面不铺开检索全文；来源用于辅助规划，不作为能力认证依据。`earth-tools` 开关包含只读 `earth_knowledge` 工具。

本目录的 `.env` 密钥和 `var/` 下的向量索引、模型缓存及对话不入 Git。完整导入格式、资料权限、模型配置及正式应用的 pgvector 初始化见 [RAG 使用说明](../../docs/rag.md)。

## 协作者怎么测试

1. 新建对话，像真实用户一样输入「我想练英文」等目的，不预填规划字段。
2. Agent 每轮最多问两个重点问题，每题给 2～3 个选项并允许补充；点击选项会填入可编辑输入框，发送后才生效。
3. 常规收集最多 5 轮（重试不计数），充分时可以提前生成；另有一次自由补充当前情况的入口。
4. 查看右侧技能树、任务、原始 JSON 和 Schema。树默认显示图标，选中后查看介绍；当前整体布局仍是实验版。
5. 切换技能/工具后发送下一条消息，检查运行记录中的配置及实际工具调用，比较输出。

任务要求写明安排顺序、目的、具体操作、时长、软件/材料与获取位置。缺材料时记录待确认问题，不编造已取得的练习题。新任务协议不要求验收或独立挑战。

可恢复的模型超时、执行失败、空输出、截断、格式和契约错误最多尝试 3 次（含首次），后续尝试降低推理强度并反馈校验问题。配置错误直接报告，持续故障仍会失败。

## Agent 与技能

使用 DSH SDK `0.2.0-rc.2`，每次尝试创建隔离的 Agent 临时目录和会话；应用负责保存并压缩跨轮上下文，不依靠 DSH 自动保存整段聊天。

| 开关 | 实际作用 |
| --- | --- |
| `earth-tools` | 挂载 `earth_context`、`earth_standards`、`earth_search`、只读 `earth_knowledge` |
| `skills` | 挂载 DSH skill、filesystem、tool-skill 组件，只复制所选技能到本轮目录 |

业务技能位于 `skills/`：`goal-intake`（目标澄清）、`skill-tree-design`（能力树）、`task-design`（详细任务）、`plan-adjustment`（反馈调整）。界面开关是本轮挂载/卸载，不是 npm 包下载、安装或删除。外部 MCP 服务及 DSH 等待式提问组件未接入；多轮询问通过工作台聊天完成。

添加技能时同时修改 `skills/<id>/SKILL.md`、`workbench-contract.js` 白名单、`workbench.js` 目录；添加插件还需修改 `current/src/agent.js` 的实际挂载逻辑。不要仅增加界面开关。

## 解析契约

当前链路：Agent JSON → 严格结构校验 → 引用/图/预算等语义校验 → 对话上下文校验 → 展示。不是从回复文案中猜测任务。

| 文件 / 版本 | 用途 |
| --- | --- |
| `agent-response.schema.json` / `earth.agent.v2` | `clarify`、`draft`、`reply`，回复、选项问题、已知/未知信息、可选 plan |
| `plan.schema.json` / `earth.plan.v2` | 目标、假设、核心技能、目标节点、策略、资源与任务的完整快照 |
| `skill-node.schema.json` | 节点 ID、名称、简介、图标、类型、父节点、前置条件、里程碑与 baseline |
| `task.schema.json` | 关联技能、目的、分钟数、资源、详细 actions、材料就绪状态及缺失材料问题 |

节点 `parentId` 控制展示层级，`prerequisites` 表示学习依赖，两者分别检查。`kind` 支持 core/domain/ability/milestone。`baseline.status` 为 lit/unlit；点亮必须基于用户原话引用及 self_report，未知保持未点亮，**不代表通过能力认证**。

资源区分 `verified_link`、`user_provided`、`needs_user`、`self_created`。已核实链接在实际生成时必须匹配预置目录或本轮工具来源；待确认材料必须有问题。任务 readiness 为 ready/needs_material，任务动作分钟之和及总预算都需一致。

解析器还检查重复 ID、引用缺失、父子或前置环、核心节点、目标节点和资源关联等。五维枚举沿用正式代码：0 知识、1 胆量、2 灵巧、3 温柔、4 魅力。常见明确分钟限制另做程序校验，复杂自然语言仍需模型理解。

修改协议源代码后，在本目录执行 `node export-contracts.js` 更新四份 JSON Schema，并运行测试。JSON Schema 不能表达所有业务规则；生成流程还会检查用户原话、轮数、预算与来源。独立 validate 接口只做响应自身校验，不能替代带对话上下文的完整流程。

旧 `earth.agent.v1` / `earth.skills.v1` 及旧实验接口仅为兼容早期案例保留。新工作优先使用 v2；不要依照旧 `skills.schema.json` 增加验收字段。

## API 与代码导航

| API | 用途 |
| --- | --- |
| `GET /api/status` | 模型/检索配置状态、busy、本进程请求 token |
| `GET /api/capabilities` | 可挂载的插件与技能 |
| `GET /api/workbench/contracts` | 当前请求、响应、节点、任务与计划 Schema |
| `GET /api/conversations`、`GET /api/conversations/:id` | 对话列表、详情 |
| `POST /api/messages` | 提交 `{message, conversationId?, turnType?, capabilities:{plugins,skills}}`，返回 job ID |
| `GET /api/jobs/:id` | 运行进度、重试或最终结果 |
| `POST /api/workbench/validate` | 校验原始响应 JSON |

POST 要求 `X-Lab-Token`，取自本机 status 接口，不要将 token 放进共享日志。`turnType` 默认为 message，额外背景用 background。旧 `/api/contracts`、`POST /api/jobs`、`POST /api/validate` 服务于 v1/现有路线对比实验。

- `server.js`：HTTP、访问限制、单请求并发、任务状态。
- `workbench.js`：对话持久化、能力目录、Agent 调用和自动重试。
- `knowledge.js`：独立文件知识库、检索上下文与来源元信息；检索实现共用 `../../packages/planning-rag/`。
- `intake.js`：五轮收口、上下文压缩、自述点亮引用与失败诊断。
- `workbench-contract.js`、`plan-v2.js`：协议与语义校验。
- `public/`：聊天、能力开关、树和任务展示。
- `current/`：来自正式版本 `a5514e5` 的必要代码副本，含实验扩展；不是对仓库根目录 `src/` 的动态引用，也不会自动跟随正式实现更新。
- `engine.js`、`contract.js`、`fixtures.js`：早期路线/技能生成对照实验。

## 验证与已知边界

```sh
npm test
node export-contracts.js
```

自动测试不调用真实模型，覆盖协议、图关系、预算、五轮限制、自述引用和故障注入重试。真实模型质量需另外在界面验证；`verify-live.js` 是早期生成接口的真实调用脚本，会消耗模型额度并写入本地 `evidence/`，不等于 v2 对话回归。

对话保存在 `var/workbench/*.json`，含 lastRun、近期 runHistory 和脱敏失败信息；用户正文仍是私人数据。最多保留 120 条消息/对话。单进程只生成一个请求，job 状态最多保留 20 个且在内存中；重启不会自动续跑中断任务，刷新页面只能接回仍存活的任务。

这里没有正式数据库适配、任务完成、XP 发放、自动解锁或既有技能增量合并。规划是完整快照；正式接入仍需用户/目标标识、修订号、幂等、事务和已有成果保护。结构通过也不代表内容质量已经验证。

## 隔离与移除

本目录有自己的 package.json 和 lockfile，根项目启动及部署不依赖工作台。工作台检索依赖仓库内的 `packages/planning-rag/`，运行时使用自己的文件索引，安装时须保留该共享代码目录。当前服务器试验副本在 `/opt/earth-generation-lab-20261007`，临时 systemd 服务名 `earth-generation-lab-20261007.service`，复用服务器 Node、依赖及模型环境文件；未设置开机启动。仓库安装按上面的 npm ci 独立安装即可。

停止本地进程用 Ctrl+C；服务器现有实例用 `systemctl stop earth-generation-lab-20261007.service`，随后关闭对应 SSH 转发。需要保留结果及导入资料时先备份独立目录的 `var/workbench/` 和 `var/knowledge/`。

确认停止且已备份后，可删除工作台独立目录。不要删除复用的生产 Node、node_modules 或环境文件。要从仓库移除，删除 `tools/agent-workbench/`、`.github/workflows/agent-workbench.yml` 和根 README 的工作台章节即可；正式数据库无需迁移或回滚。若只想保留解析能力，可单独迁移协议和校验代码后再移除界面。


技能树解析合并器已提升到 `src/skill-tree`，工作台的 tree-patch.js 仅转出共享模块。正式站使用同一校验和合并逻辑，工作台仍不写正式账号数据库；移除 tools/agent-workbench 不影响正式技能树。工作台运行时须保留仓库中的共享 src/skill-tree 与 public/skill-tree 目录。
