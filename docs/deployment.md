# 部署指南

前端 `public/` 和 API 共用一个地址；worker 独立处理 AI 任务。两种部署方式共用 PostgreSQL、Redis 和相同业务代码，不绑定某家云平台。

| 方式                   | 适合情况                                       | 前置条件                                                                       |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| Docker Compose（推荐） | 新服务器，整套搬迁，减少手动配置               | Docker Engine、Compose v2（支持 `up --wait`）、Git；无需主机安装 Node          |
| Node.js 原生部署       | 已有 PostgreSQL、Redis，或希望省去 Docker 引擎 | Node 24+、PostgreSQL、Redis；长期运行建议 Linux systemd；公网 HTTPS 另配 Caddy |

Docker Engine 在 Linux 上使用容器隔离；Windows/macOS 的 Docker Desktop 还涉及 Linux 虚拟机。原生部署减少运行环境开销，但不会消除数据库、Redis、API、worker 或 DSH 子进程自身的资源消耗。不要把这里的配置视为已测量的内存预算。上机后用 `docker stats` 或系统监控测量真实 AI 任务的峰值。

## 1. 本机测试（Docker）

```sh
git clone https://github.com/Kevinwu901113/earth-online.git
cd earth-online
sh scripts/deploy.sh init
# 编辑 .env，填写 DEEPSEEK_API_KEY；EXA_API_KEY 可选。
sh scripts/deploy.sh check
sh scripts/deploy.sh up
```

打开 `http://localhost:3000`。生成的 `.env` 权限为 600，密码随机；再次 init 不会覆盖文件。若已有旧数据库，保留原密码：修改环境变量不会自动修改已有 PostgreSQL 数据卷内的账号密码。

本机脚本需要 Linux/macOS shell。Windows 可用 WSL2，或安装 Node 24 后用 `npm run deploy -- init/check/up` 对应命令。`npm run deploy -- help` 显示 Node 入口；Docker 启动和配置验证不需要先安装 npm 依赖。

## 2. 公网 HTTPS（Docker）

准备服务器和域名：域名 A/AAAA 记录指向服务器，开放入站 TCP 80/443（UDP 443 可选），不要留下指向其他服务器的 AAAA 记录。服务器出站需要能下载镜像及访问模型服务。已有服务占用 80/443 时，先使用已有网关，不要启动内置 Caddy。

在全新部署目录执行：

```sh
sh scripts/deploy.sh init --production --domain=earth.example.com
# 编辑 .env：模型凭据；需要注册时设置 REGISTRATION_ENABLED=true。
sh scripts/deploy.sh check --production
sh scripts/deploy.sh up --production
sh scripts/deploy.sh status --production
```

用你的域名替换示例。初始化会同步设置 `APP_DOMAIN`、`APP_ORIGIN` 和 `NODE_ENV=production`；注册默认关闭。Caddy 自动申请/续期证书并把 HTTPS 请求转发给 API。PostgreSQL、Redis、API 没有主机公网端口；只有网关对外。

生产文件 `compose.production.yaml` 是独立配置，不与开发文件混用。PostgreSQL 和证书用命名卷保存；Redis 是可重建缓存，不持久化。`down` 保留卷，禁止用 `down -v` 更新或回滚。

已有 `.env` 请手动补充 `APP_DOMAIN`、HTTPS `APP_ORIGIN`、`NODE_ENV=production` 和随机十六进制 `POSTGRES_PASSWORD`（至少 32 字符）。生产容器内部的数据库地址和 API 端口由 Compose 固定配置。切换旧的 Compose 项目名前，先查看 `docker compose ls` 和卷名称并备份；脚本固定项目名 `earth-online`，不会自动寻找/迁移其他项目的数据卷。

如果使用托管平台提供的 HTTPS 预览或现有反向代理，无需独立域名/内置 Caddy：直接使用开发的两个 Compose 文件启动应用，保留 `NODE_ENV=production`、正确的 HTTPS `APP_ORIGIN`，将网关接到 `127.0.0.1:3000`。这条路径手动执行 Compose，勿使用生产启动脚本；生产脚本要求自己的网关域名。

## 3. 无 Docker：Node.js + systemd

先通过操作系统包管理器或托管服务准备 PostgreSQL 和 Redis，并创建专用数据库账号/数据库；仓库不替你修改已有数据库账号或系统服务。安装 Node 24+：

```sh
npm ci --omit=dev --ignore-scripts
npm run deploy -- init --production --domain=earth.example.com
# 编辑 .env：DATABASE_URL/REDIS_URL 指向真实服务；填写模型凭据。
# 保留 HOST=127.0.0.1，PORT=3000。
npm run deploy -- check --native
npm run deploy -- native-install --native
```

用非 root 的专用部署用户运行。`native-install` 执行迁移并生成/重启当前用户的 `earth-api`、`earth-worker` systemd 服务，使用当前 Node 的绝对路径，无需 PM2。重复执行会更新这两个专用服务文件。Node 安装路径/项目目录改变后重新执行安装。

开机及退出登录后继续运行需管理员执行 `sudo loginctl enable-linger <部署用户名>`。用户会话须支持 `systemctl --user`。数据库、Redis 需要各自开机启动或由托管服务保证可用。

将 `deploy/Caddyfile.native` 的域名、端口改成真实值，安装到 `/etc/caddy/Caddyfile`；先 `sudo caddy validate --config /etc/caddy/Caddyfile`，再 `sudo systemctl reload caddy`（首次部署需启动 Caddy 服务）。域名和端口必须对应 `.env`，仍需开放 80/443。已有网关也可代理 `127.0.0.1:3000`。

本机开发无需 systemd：`npm run migrate` 后，在两个终端分别执行 `npm start` 和 `npm run worker`。使用 development 和 HTTP localhost；公网 production 会启用 Secure Cookie，不能直接通过 HTTP 测试登录。

## 4. 检查、更新、备份

Docker：

```sh
sh scripts/deploy.sh status --production
sh scripts/deploy.sh logs --production
sh scripts/deploy.sh backup --production
sh scripts/deploy.sh update --production
```

原生：

```sh
npm run deploy -- status --native
npm run deploy -- logs --native
npm run deploy -- backup --native
npm run deploy -- update --native
```

原生备份需安装兼容数据库版本的 `pg_dump`。URL 支持常规主机/账号/密码/数据库及 `sslmode`；复杂 SSL 参数、Unix socket、托管服务特殊认证请按供应商工具自行备份。

update 要求干净的源码目录，有跟踪远端分支；先备份，再 `git pull --ff-only`，构建/安装依赖、停应用、迁移、重新启动。更新有短暂停机，不是零停机部署。失败时脚本立即停止，保留备份；查看错误后手动恢复，避免自动重复迁移或模型调用。

备份保存在被 Git/Docker 构建忽略的 `backups/`，目录 700、文件 600；备份失败删除不完整文件。请定期把备份复制到受控的异机存储并设置保留策略，本仓库不自动建立外部备份。数据库可能包含个人数据。

恢复应先演练到隔离数据库，不能盲目覆盖运行中的业务库。例如 Docker 下创建单独数据库再恢复：

```sh
docker compose --project-name earth-online --env-file .env -f compose.production.yaml exec -T postgres createdb -U earth earth_restore_test
docker compose --project-name earth-online --env-file .env -f compose.production.yaml exec -T postgres pg_restore -U earth -d earth_restore_test --exit-on-error < backups/你的备份.dump
```

恢复后核对用户、目标、任务和账本。应用回滚可切换到之前确认过的 Git commit 后重新构建/启动；数据库回滚需根据迁移内容单独处理，不能靠回滚镜像或删除数据卷完成。

## 5. 部署验收与故障定位

`check` 只检查配置、Docker 可用性/Compose 配置；原生模式还检查数据库和 Redis 连通性。`up --wait` 等待数据库、缓存和 API 健康，worker 只有进程状态检查，不会消耗模型额度。Caddy 启动不等于 DNS/证书已成功。

上线后必须访问 HTTPS `/api/health`，再走注册/登录、创建目标、等待路线生成、确认路线、记录行动、提交文字成果、等待评估、刷新后核对数据；重启后再次核对。查看 worker 日志并验证真实 AI 任务终态。缺密钥时基础业务可用，AI 任务明确失败；EXA 缺失不会生成虚假检索引用。

| 现象                     | 首先检查                                                        |
| ------------------------ | --------------------------------------------------------------- |
| 浏览器打不开 localhost   | 浏览器和服务是否在同一机器；云环境是否有受支持的 HTTPS 预览入口 |
| HTTPS 不通               | DNS、80/443、防火墙、旧 AAAA、Caddy 日志                        |
| 登录 Cookie 不生效或 403 | 地址栏与 APP_ORIGIN 完全一致，production 使用 HTTPS             |
| API 健康但 AI 任务不完成 | worker 状态/日志、模型凭据和网络、任务是否失败                  |
| 数据库认证失败           | 现有数据卷密码与 .env 是否一致；不要删除卷解决                  |

业务审核、代理限流、账号删除、DSH 数据清理等见 [运行与运营](operations.md)。服务运行/单次测试通过不代表模型质量与产品效果已验证。
