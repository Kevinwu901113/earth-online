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

已删除目标仍包含在账号状态和导出中，以 `deletedAt` 标记，任务日志默认隐藏并可恢复。删除保留目标原状态、路线标准、成果与成长历史，取消关联未完成时间块及规划/评估任务；恢复保留原状态（已完成任务仍为已完成），不会自动恢复已取消的安排或后台任务。模型上下文不包含已删除目标，旧规划和评估结果不能复活它们。

管家回复包含 `reply`、`proposals` 与可选 `guidance`。可视化指导格式为 `{title,summary,steps:[{title,minutes,kind,detail?}]}`，1–6 步，kind 为 main/side/free，单步 minutes 为 1–240；旧回复缺少 guidance 时默认为 null。指导仅是建议，实际修改必须来自 proposals 的 command 并经用户确认。状态中对应消息保存为 `content`、`guidance`、`proposals`。

`GET /api/jobs/:id` 的 `failure` 保存安全诊断：`code,message`，可选 `phase,contract,issues,issueCount,execution,json`。结构校验失败示例：`{path:["stages",0,"steps"],code:"invalid_type",expected:"string",received:"array",length:3}`。`execution` 仅包含白名单结束原因、输出字符数、推理字符数、配置的 token 上限/推理强度和可用时的输出 token 数；`json` 仅包含语法类别、字符数和可用时的数字偏移量。结束原因为 `max-tokens` 时返回 `model_output_limit`，正常结束但无结果为 `model_output_empty`，正常结束后 JSON 无效才返回 `output_json_invalid`。仅任务所属账号可读，不返回模型失败回复原文、推理正文或异常消息。旧任务可能没有 failure 或新增诊断；不能据此反推当时的结束原因和具体字段。

## 命令目录

精确类型、长度和默认值以 `src/schemas.js` 为准。

| type | 主要字段 |
| --- | --- |
| profile.update | name, daily, timezone, preferences |
| goal.create | title, base, minutes, criterion, requiresExternal, kind: main/side（默认 main） |
| goal.confirm | id, draftId |
| goal.delete / goal.restore | id；可删除或恢复任意状态任务，不回退完成状态或扣除成长 |
| goal.adjust | id, reason, minutes |
| goal.status | id, status: active/paused/ended |
| goal.external | id, content（运营待核实） |
| plan.create | goal: UUID/null, name, minutes, day: YYYY-MM-DD, time: HH:mm, stat: 0–4 |
| plan.update | id, name, minutes, day, time；只编辑未结束事件块，保留目标、阶段、路线版本和投入方向 |
| plan.batch | goal, stage, revision, day, time, blocks: [{name,minutes}]（1–24 块）；从 time 起连续安排，全部成功或全部不写入 |
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

路线草案的每个阶段可包含 `actions: [{name,minutes}]`，每阶段行动块总时长不超过路线 `minutes`；旧路线没有行动块时，界面以 `exercise` 和路线分钟数显示一个事项。路线仍需 `goal.confirm` 后启用，安排事项另由用户确认。`plan.batch` 校验当前目标的阶段与路线版本；`plan.update` 也拒绝已失效的目标关联。创建、编辑和批量安排均拒绝过去日期、跨越当天或与现有安排重叠的时段。修改、取消或安排时间块不发放 XP，也不改变成果标准。

外部系统如未来接入日历或支付宝，也必须经过账号授权和同样的业务校验；当前没有支付、日历 OAuth、推送、邮箱验证码或密码找回接口，不应在 UI 中承诺已连接这些能力。
