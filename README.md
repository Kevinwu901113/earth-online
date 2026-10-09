# 人生 RPG · Earth Online

用真实行动积累成长记录，用成果证据检验目标。首页采用手机优先的角色、五维属性和今日任务布局，后端使用 **DSH + PostgreSQL + Redis**。

### 手机主界面（2026-10-08）

`public/index.html`、`mobile.js`、`mobile.css`、`mobile-live.css` 是正式入口。底部角色、任务、成长、记录切换整页，中央「＋」打开唯一的目标收集浮窗，支持关闭、遮罩点击和 Escape。登录、角色档案和任务详情均为页面。

目标流程使用正式 `/api/commands`：`chat.send` → Agent 返回 `questions`（每题 2–3 个选项，加自由输入）或 `goal.create` 提案 → 用户确认生成路线 → 用户确认 `goal.confirm` → 后台生成 `earth.plan.v3` 与技能树增量。前端不按目标关键词编造问题或规划。生成中可关闭，路线草案可从任务页恢复；提问状态保留在当前页面会话，刷新后历史仍在高级界面的对话记录中。

任务列表优先展示 Agent 的详细任务及资源，并保留当天已排程任务。完成时填写实际分钟数，以 `action.record` 保存并由服务器计算 XP；`skillTaskId` 绑定当前规划，同一目标的同一技能任务每天只能记录一次。不会因页面点击直接点亮能力或伪造等级。首页、五维、记录和技能树均来自账号状态，无演示数据。

角色档案中的「时间轴、成果评估与完整管理」通向 `public/advanced.html`，保留旧界面与原有功能。技能树复用 `public/skill-tree/` 组件，继续支持固定方向、互斥一级分支、重点展示、点击展开、拖动和滚轮缩放。工作台仍独立运行。

## 快速部署

### Agent 工作台（独立实验）

用于协作测试「自然语言目标 → DSH Agent 多轮澄清 → 可解析的技能树与任务规划」。服务、依赖配置和运行数据独立放在 [`tools/agent-workbench/`](tools/agent-workbench/README.md)，共用规划检索代码包，但使用自己的文件向量索引，不接正式数据库，不发放 XP，也不改变正式网站的任务流程。

```sh
cd tools/agent-workbench
npm ci
# 将 .env.example 复制为 .env，填写自己的 DEEPSEEK_API_KEY
npm start
```

打开 http://127.0.0.1:3188。界面支持切换对话、挂载现有技能/工具、查看任务、技能树及 JSON/Schema。常规信息收集最多 5 轮，另可自由补充一次背景；可恢复错误最多自动尝试 3 次。

协作者请先读 [工作台 README](tools/agent-workbench/README.md)，其中包含运行配置、解析契约、代码导航、验证方式、限制及移除步骤。正式站已接入共享的 v3 规划和技能树增量协议；工作台自身的会话与运行数据仍独立。

### 正式网站

前端和 API 共用一个地址，worker 独立运行。默认整套 Docker 部署，也支持无 Docker 的 Node.js + systemd；无需绑定 Render。

**只安装 Docker Engine 和 Compose v2 的本机启动：**

```sh
sh scripts/deploy.sh init
# 编辑 .env，填写 DEEPSEEK_API_KEY；EXA_API_KEY 可选。
sh scripts/deploy.sh check
sh scripts/deploy.sh up
```

打开 http://localhost:3000。账号、记录、排程不依赖模型；规划、评估、复盘与管家需要模型凭据。init 随机生成数据库密码，不会覆盖已有 .env。

**服务器一并启动 HTTPS：**

```sh
sh scripts/deploy.sh init --production --domain=earth.example.com
# 编辑 .env：模型凭据；需要注册时设置 REGISTRATION_ENABLED=true。
sh scripts/deploy.sh check --production
sh scripts/deploy.sh up --production
```

域名指向服务器，TCP 80/443 可访问，Caddy 自动管理 HTTPS。仅网关对外，数据库和 Redis 不暴露公网。已有 .env、旧数据卷或已有网关请先按指南配置，不要重新初始化/删除数据。

**更轻量的原生方式：**已有 Node.js 24+、PostgreSQL 和 Redis 时，安装依赖、填写连接地址、迁移后直接运行 API 和 worker。Linux 可用 `npm run deploy -- native-install --native` 安装 systemd 用户服务，不要求 Docker 或 PM2。

完整步骤、Windows 入口、更新/备份/恢复及验收见 [部署指南](docs/deployment.md)。[运行手册](docs/operations.md) 说明运营、限流和数据边界。

## 本地开发

```sh
npm ci --ignore-scripts
npm run deploy -- init
# 编辑 .env，填写模型凭据。
docker compose --project-name earth-online up -d --wait
npm run migrate
npm start
# 另一个终端：
npm run worker
```

API 与前端同源；APP_ORIGIN 必须与地址栏一致。`EXA_API_KEY` 控制可选的实时网络检索；未配置时明确标注网络检索不可用，已初始化的本地知识库仍可使用。

## 规划知识库（RAG）

正式应用使用 PostgreSQL 的 **pgvector** 保存知识向量，用本地中文模型 `Xenova/bge-small-zh-v1.5` 生成 512 维 embedding。先按 [RAG 指南](docs/rag.md) 安装与 PostgreSQL 版本匹配的 pgvector，并准备数据库连接，然后在仓库根目录运行：

```sh
npm run knowledge -- setup
npm run knowledge -- seed
npm run knowledge -- status
npm run knowledge -- search '我想每天练英语阅读，但容易忘记单词'
```

`setup` 创建知识表及索引；`seed` 导入 28 条附原研究或官方链接的规划参考。首次运行 `seed` 会将公开模型文件下载到 `var/models/`，后续使用本地缓存，无需另配 embedding API 密钥。初始化后重启 API 和 worker。

支持导入 UTF-8 Markdown、纯文本和 JSON 文档：

```sh
npm run knowledge -- import /完整路径/学习方法.md
npm run knowledge -- import /完整路径/学习笔记.txt
npm run knowledge -- import /完整路径/参考资料.json
# 指定账号的私人资料：
npm run knowledge -- import /完整路径/个人笔记.md --user 用户UUID
```

默认导入管理员维护的共享知识；JSON 字段、私人资料权限、删除与模型配置见 [完整 RAG 说明](docs/rag.md)。聊天步骤卡片和目标路线中的「规划依据」默认折叠，可展开查看短来源、适用理由及原文链接。检索资料用于辅助规划，不替代用户的完成条件或成果评估。

工作台的同名 CLI 使用独立 **file** 向量索引，不连接生产数据库；请在 `tools/agent-workbench/` 内运行。两套环境的 `.env` 密钥及各自 `var/` 下的索引、模型缓存、对话都不入 Git。

## 已实现

- 邮箱密码账号、服务端会话、账号隔离、数据导出。
- 画像、目标起点与完成条件、异步路线草案、用户确认、调整历史、暂停/恢复/结束。
- 主线/支线任务、具体行动块与全天时间轴；确认后连续安排事项，添加、删除、编辑或拖动底边调整时长，块长度对应分钟数。
- 任意状态任务可删除并恢复；保留成长与成果历史，删除时取消未完成安排和后台任务。
- 日期与时区排程、冲突检测、过期处理、投入记录、确定性 XP 账本。
- 练习与独立挑战、固定标准快照、评估失败重试、外部结果待核实。
- 生活事件去重、机会领取/执行期限、记忆修正/删除、复盘。
- 管家读取真实状态，用带时长的步骤卡片提供指导、提出操作建议，用户确认后执行。
- 版本化公共标准、运营审核入口、任务取消与中断恢复。

当前证据评估仅支持文字。音视频、链接内容和现实证书不会被当成已验证能力。公共标准初始为空，必须由运营审核发布。成长数值是版本化初始规则，不代表已完成产品效果验证。

## 验证

```sh
npm run check
npm test
docker compose --project-name earth-online exec -T postgres createdb -U earth earth_online_test
# 将 YOUR_POSTGRES_PASSWORD 替换为 .env 的 POSTGRES_PASSWORD。
export TEST_DATABASE_URL=postgres://earth:YOUR_POSTGRES_PASSWORD@127.0.0.1:55432/earth_online_test
export TEST_REDIS_URL=redis://127.0.0.1:56379
npm run test:integration
npx playwright install chromium
npm run test:e2e
```

集成测试必须使用专用 `*_test` 数据库。测试使用本地模型协议夹具，不消耗真实模型额度；DSH 子进程、工具调用、数据库和 HTTP 都实际运行。真实模型质量及公开部署验收需要单独执行，见 [验收范围](docs/acceptance.md)。

## 文档

- [架构与数据边界](docs/backend-architecture.md)
- [API 与命令](docs/api.md)
- [部署、HTTPS、更新与备份](docs/deployment.md)
- [运行、审核与恢复](docs/operations.md)
- [规划知识库、资料导入与检索](docs/rag.md)
- [验收范围与需求对应](docs/acceptance.md)
- [原有协作文档](docs/README.md)

原有 GitBook 同步配置及协作资料继续保留。该仓库没有内置模型密钥，也不会自动部署覆盖已发布的 Sites 演示。

## 个人技能树

正式站底部「技能树」展示账号的长期能力树：我 → 身心 / 认知 / 实践。确认目标路线后自动生成能力分支；已有目标可在技能树页生成或更新。不同目标复用能力，目标分数和路线阶段不作为技能节点。支持分支聚焦、重点预览、滚轮缩放与拖动。

生成走正式 DSH worker 的 `skills` 作业，`skills.generate` 命令沿用登录鉴权、幂等请求和用户版本检查。结果使用 earth.plan.v3 + earth.tree.patch.v1，在事务内校验再保存到玩家 JSON 状态的 personalTree / skillPlans；旧账号无需数据库迁移，首次读取提供基础骨架。已删除目标、被替代作业及过期树版本不能覆盖数据。生成不发放经验，也不修改既有进度。

共享解析器位于 src/skill-tree，正式站不依赖 tools/agent-workbench。工作台使用同一合并器，保留独立对话和存储，可单独移除。此次不包含已撤回的理解/路线 decision 协议。

## Agent 规划质量与输出约束

[输出 Harness 和意图处理](docs/agent-harness.md)说明 Schema、最多三次纠错、预算和操作边界；[资料筛选记录](docs/knowledge-curation.md)记录规划知识库的来源、适用边界及原创行动案例。RAG 使用与混合检索见 [RAG 配置](docs/rag.md)，测试范围与真实模型结果见 [本地验收记录](docs/agent-validation.md)。使用 `npm run contracts` 从实际运行时 Schema 导出契约。
