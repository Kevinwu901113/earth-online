# 用知识库辅助目标规划

正式应用使用现有 PostgreSQL 的 pgvector 扩展，中文文本由本地 `Xenova/bge-small-zh-v1.5` 量化模型生成 512 维向量。每次规划先按目标与用户原话检索，再把有长度上限的片段交给 DSH；不是把全部资料拼进提示词。模型不得用资料替换用户的完成条件或给自己发放奖励。成果评估不注入规划知识库。

内置 28 条原创规划参考，涵盖目标拆解、实施意图、学习复习、编程、写作、日程、习惯、反馈与材料选择，并附原研究或官方文档链接。资料是建议与不可信数据，不是新的系统指令，不承诺对所有目标都有效。规划依据在界面默认折叠，只展示来源元信息。

## 正式应用初始化

先按 [pgvector 官方安装说明](https://github.com/pgvector/pgvector#installation) 安装与服务器 PostgreSQL 大版本匹配的扩展。数据库管理员需要允许 `CREATE EXTENSION vector`；普通任务处理不会尝试安装扩展或修改数据库权限。

```sh
npm ci
npm run knowledge -- setup
npm run knowledge -- seed
npm run knowledge -- status
npm run knowledge -- search '我想每天练英语阅读，但容易忘记单词'
```

`setup` 只创建知识表及向量索引，不清空任何业务表。`seed` 首次下载公开 ONNX/分词器文件到被忽略的 `var/models/`，并建立资料向量；后续启动从本地缓存加载，不需要新增模型 API 密钥。默认模型固定到 revision `75c43b069aac4d136ba6bc1122f995fedcfd2781`，使用 q8、CLS pooling 与归一化。短检索 query 添加模型官方推荐的中文前缀，文档不添加该前缀。[BGE 官方说明](https://huggingface.co/BAAI/bge-small-zh-v1.5)

`.env.example` 提供 `RAG_ENABLED`、`RAG_BACKEND`、资料目录与模型缓存选项。启用 pgvector 时先初始化索引，再重启 API 和 worker。模型文件下载或检索失败会明确标注知识库不可用，原聊天内容仍保留；不会伪装为检索成功。运行期间每次最多取 6 个片段、每个约 400 字，同一资料最多 2 个片段。

## 混合检索与引用

检索先并行寻找语义候选和关键词候选，再按 RRF 排序。关键词由本机中文分词与英文词边界提取，统一大小写和全角字符；标题、标签、正文的每个命中分别记 4、3、1 分。Anki、Python 等明确名称可以通过关键词通道进入候选，避免只依赖向量相近的通用资料。两个通道各保留最多 48 个候选，进入窗口前每篇资料最多占 3 个片段。[pgvector 混合检索说明](https://github.com/pgvector/pgvector#hybrid-search)

RRF 使用 `1 / (60 + 排名)`，排名从 1 开始，关键词通道权重为 1.5，语义通道为 1。先给每篇资料一个片段，再考虑第二个片段；最终每篇最多取 2 个。普通关键词命中需覆盖某个查询子句至少 34% 的关键词；含拉丁字母的名称或代码标识（如 Anki、Python、A2）在标题或标签中精确命中可单独进入候选。长查询中只有一个宽泛词命中标题也不够，例如地质问题里的“证据”不能仅凭同词标题找回英语阅读资料。没有合格关键词证据的向量候选需达到 0.62 的余弦相似度，而且最多使用 2 篇这样的资料；不够相关时允许返回空结果，不凑满 6 条。这个阈值是默认 BGE 模型的保守检索门槛，不是答案正确率；更换向量模型时应重跑评测。[RRF 定义](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion)

两种后端共用分词、评分、RRF 和去重代码。PostgreSQL 先通过 `MATERIALIZED` CTE 限定 namespace、公共或当前账号资料、模型标识，再进行精确向量距离与关键词排序；未知账号或其他 namespace 的片段不参与候选排名。关键词使用参数化正则，`%` 和 `_` 不作为 SQL 通配符。该路径兼容 PostgreSQL 16 和 pgvector 0.6，不依赖较新版本的 `iterative_scan`。现有 HNSW 索引保留，但当前检索为避免过滤后漏召回，使用权限范围内的精确扫描；资料规模变大后需用真实数据评估扫描成本。[PostgreSQL CTE materialization](https://www.postgresql.org/docs/16/queries-with.html#QUERIES-WITH-CTE-MATERIALIZATION)

`retrieve(query, { userId, topK, maxChars, signal, queryVariants })` 保留原接口，新增可选 `queryVariants`：最多 2 条补充意图，每条最多 500 字符，只参与关键词检索。每次检索仍只为主 query 计算一次 512 维嵌入，不调用生成模型扩写查询。片段引用截取真实正文，优先覆盖命中的文字，不生成或补写引用；所有返回片段的字符数之和不超过 `maxChars`。只有实际返回的片段才生成来源链接。向量计算失败而关键词仍有结果时可继续返回，同时在 `retrieval.semanticAvailable` 中标出失败。

返回片段的 `score` 继续表示余弦相似度；仅由关键词找回、没有向量候选分数的片段为 `0`。实际排序看 `fusionScore`，`lexicalScore` 是标题、标签和正文的加权命中分，`matchedBy` 表示命中的通道，`matchedTerms` 是命中的关键词。顶层 `retrieval` 给出候选数量和通道是否可用，不携带私有 owner 标识或向量。成功检索但无相关资料时 `available: true`、`reason: "no_matches"`、片段和来源均为空；通道都不可用才报告检索失败。

## Docker 初始化

`Dockerfile.pgvector` 在原有 `postgres:17-alpine` 镜像上编译 pgvector 0.8.6，核对固定源码 commit，再把扩展复制到相同基础镜像。PostgreSQL 大版本、Alpine 基础与 `postgres-data` 卷挂载路径都保留；不切换到 Debian 镜像。编译步骤参考 [pgvector 官方 Dockerfile](https://github.com/pgvector/pgvector/blob/v0.8.6/Dockerfile)，使用当前镜像的 `pg_config`，关闭扩展 LLVM 编译和本机特定的优化。

仅启动本机 PostgreSQL/Redis 仍可单独使用 `compose.yaml`。运行完整本机容器应用时：

```sh
docker compose -f compose.yaml -f compose.app.yaml up -d --build
docker compose -f compose.yaml -f compose.app.yaml logs knowledge-init
docker compose -f compose.yaml -f compose.app.yaml run --rm --no-deps knowledge-init node packages/planning-rag/cli.js status
docker compose -f compose.yaml -f compose.app.yaml run --rm --no-deps knowledge-init node packages/planning-rag/cli.js search '每天练英语阅读，但容易忘记单词'
```

生产容器使用独立的 `compose.production.yaml`；将上述命令的两个 `-f` 参数替换为 `-f compose.production.yaml`，不要与开发配置合并。

两套应用配置都依次执行业务迁移、`knowledge-init` 的 `setup` 与 `seed`，初始化成功后才启动 API/worker。`app-data` 命名卷共享 `/app/var`，模型缓存固定为 `/app/var/models`，文件知识库固定为 `/app/var/knowledge`；首次初始化后可复用模型文件，文件后端也能在容器重建后保留资料。模型下载失败时初始化服务报错并阻止 API/worker 启动，应检查该服务日志并重新运行完整启动命令；网络无法访问 Hugging Face 时，可提前把经官方 revision/hash 校验的模型缓存放入该卷的 `models/Xenova/bge-small-zh-v1.5/` 目录。

`.env` 中 `RAG_BACKEND=file` 会初始化共享卷内的文件知识库；`RAG_ENABLED=false` 会跳过知识库初始化并正常启动业务服务。上述 `status` 与真实中文检索用于验证启用后的 RAG，不能只检查应用健康接口。

## 导入自己的资料

支持 UTF-8 Markdown、纯文本和 JSON；导入程序不会根据资料中的指令执行命令或自动访问网址。PDF 等文件需先转成可检查的文本。

```sh
npm run knowledge -- import /完整路径/目标规划.md
npm run knowledge -- import /完整路径/我的学习资料.json --user 用户UUID
npm run knowledge -- remove 文档ID --user 用户UUID
```

JSON 可以是一个文档或文档数组：

```json
{
  "id": "reading-method",
  "title": "阅读练习方法",
  "url": "https://example.com/reference",
  "content": "你自己的资料正文",
  "tags": ["阅读", "学习"]
}
```

`url` 可省略；此时生成真实的、受应用访问限制保护的知识文档地址。只有导入者确定资料确实源自对应网址时才填写外链。默认 CLI 导入为管理员维护的共享知识；`--user` 创建指定账号的私人资料。检索和原文访问都限制为公共资料或当前账号自己的资料，DSH 子进程没有数据库凭据。删除或修改立即影响下一次检索，不依赖旧聊天状态缓存。文档最大 100000 字符，批次最多 200 条；JSON/文本文件不超过 2 MiB。

## 独立 Agent 工作台

工作台默认使用独立的本地向量索引，使用同一中文嵌入模型与知识包，但不会连接正式业务数据库。它保留原来的独立运行方式：

```sh
cd tools/agent-workbench
npm ci
npm run knowledge -- setup
npm run knowledge -- seed
npm start
```

资料和模型缓存放在工作台自己的 `var/`，资料按对话隔离。首次空库可自动导入内置参考；提前 `seed` 可避免第一条模型请求等待下载。工作台中的 `earth-tools` 开关控制只读 `earth_knowledge` 工具；检索依据与状态保存在本轮结果中。工作台仍是 loopback 实验工具，不是带多用户认证的公开服务。

## 更换模型与测试

索引记录模型、revision、量化与 pooling 标识，不混用不同向量空间。更换到其他模型需要确保仍输出 512 维，并重新导入资料。本机工作台的文件后端适合少量资料，不替代大型并发向量服务。

普通测试不下载模型或调用真实模型；检索持久化、权限、上下文边界和伪造引用都有回归覆盖。部署前还需运行本机真实嵌入与真实 pgvector 检索，确认资料命中和规划结果。扩展与模型缓存都应作为部署步骤准备，不能仅凭服务健康接口判断 RAG 已生效。

源码检索评测使用隔离的临时文件索引和 5 个固定样例，对比纯语义与混合检索的首条命中率、MRR、前三条召回率、无关查询拒绝率。默认固定向量验证命名关键词能补回语义遗漏；`--real` 使用已经缓存的本地 BGE，禁止远程模型下载，不调用模型 API。这是小规模回归样例，不代表全部用户目标的效果。

```sh
node --test test/knowledge.test.js test/planning-rag.test.js
node packages/planning-rag/evaluate.js
node packages/planning-rag/evaluate.js --real
```

真实 PostgreSQL 对照测试仅读取显式提供的 `TEST_DATABASE_URL`，要求数据库名以 `_test` 结尾，不回退读取业务 `DATABASE_URL` 或 `.env`。测试使用固定向量，无需下载模型，在随机临时 namespace 内导入，结束时只删除自己的资料；不删除整个数据库，也不创建业务账号。先单独创建测试数据库并安装匹配的 pgvector 扩展，再在已设置测试连接的环境运行：

```sh
node --test test/integration/knowledge.test.js
```

资料来源、56个原创行动案例及拒绝候选的审核理由见 [知识资料筛选](knowledge-curation.md)。
