# 用知识库辅助目标规划

正式应用使用现有 PostgreSQL 的 pgvector 扩展，中文文本由本地 `Xenova/bge-small-zh-v1.5` 量化模型生成 512 维向量。每次规划先按目标与用户原话检索，再把有长度上限的片段交给 DSH；不是把全部资料拼进提示词。模型不得用资料替换用户的完成条件或给自己发放奖励。成果评估不注入规划知识库。

内置 8 条原创规划参考，涵盖目标拆解、实施意图、学习复习、习惯、反馈与材料选择，并附原研究或官方文档链接。资料是建议与不可信数据，不是新的系统指令，不承诺对所有目标都有效。规划依据在界面默认折叠，只展示来源元信息。

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
{"id":"reading-method","title":"阅读练习方法","url":"https://example.com/reference","content":"你自己的资料正文","tags":["阅读","学习"]}
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

索引记录模型、revision、量化与 pooling 标识，不混用不同向量空间。更换到其他模型需要确保仍输出 512 维，并重新导入资料。大型知识库可保留 pgvector HNSW 索引；本机工作台的文件后端适合少量资料，不替代大型并发向量服务。

普通测试不下载模型或调用真实模型；检索持久化、权限、上下文边界和伪造引用都有回归覆盖。部署前还需运行本机真实嵌入与真实 pgvector 检索，确认资料命中和规划结果。扩展与模型缓存都应作为部署步骤准备，不能仅凭服务健康接口判断 RAG 已生效。
