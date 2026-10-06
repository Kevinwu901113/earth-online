# 人生 RPG · Earth Online

用真实行动积累成长记录，用成果证据检验目标。前端沿用 2026-10-01 发布的最新角色界面，后端使用 **DSH + PostgreSQL + Redis**。

## 快速部署

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

API 与前端同源；APP_ORIGIN 必须与地址栏一致。`EXA_API_KEY` 未配置时规划明确缺少检索来源，不生成假引用。

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
- [验收范围与需求对应](docs/acceptance.md)
- [原有协作文档](docs/README.md)

原有 GitBook 同步配置及协作资料继续保留。该仓库没有内置模型密钥，也不会自动部署覆盖已发布的 Sites 演示。
