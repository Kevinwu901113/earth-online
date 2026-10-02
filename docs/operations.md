# 运行与运营

## 部署

1. 固定 Node 24+，`npm ci --ignore-scripts` 安装锁定依赖；应用不用 DSH 的 shell/native 插件。
2. 创建独立 PostgreSQL 和 Redis。`POSTGRES_PASSWORD` 使用随机十六进制字符串，避免未编码的 URL 特殊字符。数据库持久卷须备份。
3. 配置 `.env`：DATABASE_URL、REDIS_URL、APP_ORIGIN、DEEPSEEK_API_KEY；模型默认 deepseek-v4-flash，DeepSeek Messages 端点默认 `https://api.deepseek.com/anthropic`。可选 EXA_API_KEY。
4. 对外部署设 NODE_ENV=production、APP_ORIGIN=https://实际域名，反向代理 TLS；不公开数据库/Redis 端口。初始建议 REGISTRATION_ENABLED=false，只在邀请注册时开放。
5. 先 `npm run migrate`，再分别运行 API 与 worker。容器参考 compose.app.yaml；在编排系统中为两进程设置自动重启、资源限制和日志保留。
6. 确认 `/api/health` 为 ok，再做注册/登录、创建真实目标、确认路线、提交成果、查询任务终态的真实模型验收。health 不检测模型额度、模型回复质量或 worker 是否运行。

Fastify 当前不信任外来代理头，API 限流每来源 IP 120/分钟、登录注册 10/分钟。反向代理部署会聚合来源，应在受信任网关额外实施用户/IP 级限流，不能直接信任任意 X-Forwarded-For。当前版本未提供弹性伸缩、付款或多租户组织管理。

## 模型及任务故障

任务保存在 PostgreSQL。正常 worker 会将失败置为 failed；进程崩溃后其他 worker 将租约过期的 running 任务终结为 failed，不悄悄重新调用模型。用户看到失败，已提交成果保留，可重试。最多每用户 3 个待处理任务。取消 queued/running 后不接收晚到结果；运行中的子进程在约 1 秒内收到关闭请求。

缺少凭据时任务明确失败，基础业务继续可用。Redis 短暂失效时正在运行的 worker 从数据库重建上下文；API 读写持久数据不依赖缓存，但 health 返回 503。初次启动需要依赖服务可连接。

DSH 运行数据在 `DATA_DIR/agent/<user>/<job>`，正常结束自动删除。崩溃后的目录可能含用户上下文；确认对应任务不再 running 后删除遗留目录。不要将它们放进日志收集或公开目录。API/worker 错误日志只输出错误类型/代码和任务 ID，不记录原文、密码或密钥。

## 不可变公共标准

准备运营审核后的 JSON 文件：

```json
{"id":"text-introduction","version":1,"name":"英文文字介绍","scope":"仅文字，不代表口语能力","criteria":"需要运营填写可观察、可复核的完整标准","reviewedBy":"运营姓名","sourceUrl":"https://实际来源"}
```

```sh
npm run admin -- publish-standard /path/to/reviewed-standard.json
```

可选 questions 数组支持客观选择题，每题含 id、prompt、choices（id/text）、correctChoice、explanation。答案只保存在服务端，提交后按固定答案判分并给解析；不让模型随意改分，也不把练习变成能力认证。

已存在的 ID+version 不可覆盖；发布变更使用新版本。用户建议只进 candidates，模型不能发布。示例不是正式标准，不应直接发布。上线前需整理第一批经人工审查的标准。

## 外部证据审核

用户完成阶段后如目标需要现实结果，先在目标详情提交证据，状态仍为 awaiting_external。运营核实独立来源后准备：

```json
{"userId":"UUID","goalId":"UUID","reviewedBy":"审核者","evidenceReference":"独立核实依据或工单号","note":"核实过程与结论","accepted":true}
```

```sh
npm run admin -- verify-external /path/to/review.json
```

拒绝不标记完成；用户可补交资料。此入口依赖数据库操作权限，不暴露给普通客户端。

## 数据与备份

PostgreSQL 是事实来源。定期执行 `pg_dump --format=custom` 到加密、受控的备份位置，并在隔离数据库中演练 `pg_restore`。部署环境自行设定 RPO/RTO 与备份保留期限；本仓库不假设已有托管备份。迁移 001 只创建表/索引，可重复运行。

发布前先备份；当前数据库变更是新增结构，应用回滚到上一镜像不会删除数据。后续破坏性迁移需单独设计回滚，不通过 `docker compose down -v` 回滚。

用户可下载全部业务数据。删除单条记忆不等于删除原始业务证据。如处理全量账号删除，先取消该账号任务、等待 running 结束，再准备 `{userId,confirmUserId}`（两者相同），执行 `npm run admin -- delete-account /path/to/request.json`。外键删除该账号的持久数据，Redis 缓存副本在 30 分钟内到期，备份按已公布的保留政策清除。只对已核实身份并明确要求删除的账号操作。

## 依赖

DSH SDK 固定 rc.2。其间接依赖 fflate 使用兼容补丁 0.8.3 覆盖已知 ZIP64 拒绝服务漏洞；应用不启用 office 插件。升级 SDK 前跑真实 SDK 协议测试、API 和浏览器验收，尤其检查 sdk-minimal 默认工具集合。不要为了清理依赖提示执行未经评估的强制大版本升级。
