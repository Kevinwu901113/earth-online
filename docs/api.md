# API

前端和 API 同源。所有写请求：`Content-Type: application/json`、`Origin: APP_ORIGIN`、`X-Earth-Client: web-v1`。登录后使用 HttpOnly / SameSite=Strict Cookie；production 额外 Secure。跨账号资源查询返回 404，未登录 401，输入错误 400，版本冲突 409，限流 429。

| 接口 | 用途 |
| --- | --- |
| POST /api/auth/register, /login | `{email,password}`，密码 12–128 字符 |
| POST /api/auth/logout | `{}`，撤销当前会话 |
| GET /api/auth/me | 当前账号 |
| GET /api/state | `{state,version,rules}` |
| POST /api/commands | `{expectedVersion,command}`；额外 Idempotency-Key（12–100 位字母、数字、下划线或横线） |
| GET /api/jobs | 最近 50 个后台任务 |
| GET /api/jobs/:id | 本账号任务结果/错误 |
| POST /api/jobs/:id/cancel | `{}`，取消未完成任务 |
| GET /api/standards | 已发布的版本化标准 |
| GET /api/growth | 成长账本 |
| GET /api/export | 账号、状态、账本 JSON 下载 |
| GET /api/health | DB 和 Redis 健康；不代表模型服务已验证 |

命令成功返回 `{result,version}`。触发异步模型时 result 带 jobId；不能以 HTTP 200 等同于模型任务完成。客户端以状态刷新 + 任务终态展示结果。POST 网络断开时保留同一 Idempotency-Key 重试；修改命令后必须换新键。服务端先检查回执再检查版本，因此同一命令的过时重试仍返回原结果。

`GET /api/state` 中每个目标包含派生字段 `planning`：当前规划有 `{jobId,status,error,code,minutes}`，没有适用于当前路线/阶段的任务则为 null。任务状态变化不一定改变业务 `version`，客户端须比较返回状态，不能只用版本判断是否刷新。路线确认后以已确认路线为准；规划失败不改变目标完成状态。

`GET /api/jobs/:id` 的 `failure` 保存安全诊断：`code,message`，可选 `phase,contract,issues,issueCount,execution,json`。结构校验失败示例：`{path:["stages",0,"steps"],code:"invalid_type",expected:"string",received:"array",length:3}`。`execution` 仅包含白名单结束原因、输出字符数、推理字符数、配置的 token 上限/推理强度和可用时的输出 token 数；`json` 仅包含语法类别、字符数和可用时的数字偏移量。结束原因为 `max-tokens` 时返回 `model_output_limit`，正常结束但无结果为 `model_output_empty`，正常结束后 JSON 无效才返回 `output_json_invalid`。仅任务所属账号可读，不返回模型失败回复原文、推理正文或异常消息。旧任务可能没有 failure 或新增诊断；不能据此反推当时的结束原因和具体字段。

## 命令目录

精确类型、长度和默认值以 `src/schemas.js` 为准。

| type | 主要字段 |
| --- | --- |
| profile.update | name, daily, timezone, preferences |
| goal.create | title, base, minutes, criterion, requiresExternal |
| goal.confirm | id, draftId |
| goal.adjust | id, reason, minutes |
| goal.status | id, status: active/paused/ended |
| goal.external | id, content（运营待核实） |
| plan.create | goal: UUID/null, name, minutes, day: YYYY-MM-DD, time: HH:mm, stat: 0–4 |
| plan.status | id, status: planned/paused/cancelled |
| action.record | plan/goal: UUID/null, name, minutes, day, stat, note, completion: done/partial/rest |
| submission.create | goal, content, kind: practice/challenge, helpUsed |
| submission.retry | id |
| memory.correct / memory.delete | id；correct 另需 body |
| review.create | day |
| chat.send | content |
| event.create | externalId, content, occurredAt: ISO UTC, kind: completed/opportunity/note；机会另需 claimBy/executeBy |
| event.claim | id |
| event.complete | id, note（不重复发 XP） |
| practice.grade | standardId, standardVersion, questionId, choiceId（服务端按固定答案判分，无 XP/认证） |
| standard.propose | name, scope, criteria（仅候选，不发布） |

stat 对应知识、胆量、灵巧、温柔、魅力。时区为 IANA 名称。过期按玩家本地日期/事件 UTC 期限派生，读取与写入均适用，无需定时器才生效。

外部系统如未来接入日历或支付宝，也必须经过账号授权和同样的业务校验；当前没有支付、日历 OAuth、推送、邮箱验证码或密码找回接口，不应在 UI 中承诺已连接这些能力。
