# 人生 RPG · Earth Online

用真实行动积累成长记录，用成果证据检验目标。前端沿用 2026-10-01 发布的最新角色界面，后端使用 **DSH + PostgreSQL + Redis**。

## 本地启动

需要 Node.js 24+、Docker Compose，以及 DeepSeek API 凭据（账号、记录、排程等功能不依赖模型；规划、评估、复盘与管家需要）。

```sh
npm ci --ignore-scripts
cp .env.example .env
# 在本机编辑 .env，填写 DEEPSEEK_API_KEY；不要提交该文件。
docker compose up -d --wait
npm run migrate
npm start
# 另一个终端：
npm run worker
```

打开 http://localhost:3000 注册账号。API 与前端同源；APP_ORIGIN 必须与地址栏一致。`EXA_API_KEY` 可选：未配置时规划明确缺少检索来源，不生成假引用。

也可以用容器运行 API、worker 和迁移：

```sh
docker compose -f compose.yaml -f compose.app.yaml up --build -d
```

本地 Compose 默认密码仅用于本机开发。对外部署前按 [运行手册](docs/operations.md) 配置 HTTPS、独立凭据、备份和注册开关。

## 已实现

- 邮箱密码账号、服务端会话、账号隔离、数据导出。
- 画像、目标起点与完成条件、异步路线草案、用户确认、调整历史、暂停/恢复/结束。
- 日期与时区排程、冲突检测、过期处理、投入记录、确定性 XP 账本。
- 练习与独立挑战、固定标准快照、评估失败重试、外部结果待核实。
- 生活事件去重、机会领取/执行期限、记忆修正/删除、复盘。
- 管家读取真实状态、提出操作建议、用户确认后执行。
- 版本化公共标准、运营审核入口、任务取消与中断恢复。

当前证据评估仅支持文字。音视频、链接内容和现实证书不会被当成已验证能力。公共标准初始为空，必须由运营审核发布。成长数值是版本化初始规则，不代表已完成产品效果验证。

## 验证

```sh
npm run check
npm test
docker compose exec -T postgres createdb -U earth earth_online_test
export TEST_DATABASE_URL=postgres://earth:local-development-only@127.0.0.1:55432/earth_online_test
export TEST_REDIS_URL=redis://127.0.0.1:56379
npm run test:integration
npx playwright install chromium
npm run test:e2e
```

集成测试必须使用专用 `*_test` 数据库。测试使用本地模型协议夹具，不消耗真实模型额度；DSH 子进程、工具调用、数据库和 HTTP 都实际运行。真实模型质量及公开部署验收需要单独执行，见 [验收范围](docs/acceptance.md)。

## 文档

- [架构与数据边界](docs/backend-architecture.md)
- [API 与命令](docs/api.md)
- [运行、审核与恢复](docs/operations.md)
- [验收范围与需求对应](docs/acceptance.md)
- [原有协作文档](docs/README.md)

原有 GitBook 同步配置及协作资料继续保留。该仓库没有内置模型密钥，也不会自动部署覆盖已发布的 Sites 演示。
