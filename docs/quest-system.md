# 任务系统（quest-v1）

技能规划生成的任务，现在以「主线任务」的形式出现：用户自己接取，勾选目标项，交付成果，结算奖励。这是任务系统 RPG 化的第 1 阶段，支线、限时、公告板刷新和章节地图在后续阶段实现。

## 数据

主线任务保存在玩家状态的 `quests` 中，由 `src/quests.js` 的 `syncQuests()` 从 `skillPlans[goalId].tasks` 确定性地生成。每次读取和写入前都会运行 `syncQuests()`，结果幂等，已有账号不需要数据库迁移。

| 字段 | 说明 |
| --- | --- |
| `id` | `goalId:planKey:taskId`，`planKey` 取自规划的 `updatedAt` |
| `status` | `locked` / `available` / `accepted` / `delivered` |
| `objectives` / `progress` | 来自任务的 `actions`，以及每一项的勾选状态 |
| `delivery` | `confirm`、`checklist`、`text`、`log` 之一；旧任务默认是 `checklist` |

另外新增的状态字段：

- `loot`：交付时的文字成果、记录表数值和留言，在界面中显示为「行囊」。
- `skillProgress`：按技能节点累计的熟练度、投入分钟数和完成任务数。
- `trackedQuestId`：首页正在追踪的任务。

## 规则

- **解锁**：同一规划中的任务按顺序解锁，同一时间只有一个可接取的任务。
- **规划更新**：重新生成规划后，旧规划中未完成的任务会被移除，已交付的保留为历史。
- **旧记录迁移**：同一规划生成之后，用旧方式（`action.record` + `skillTaskId`）记录过的任务，迁移时视为已交付。
- **XP**：交付时沿用 growth-v1 规则：每 5 分钟 1 XP，单次最多 12 XP，每日最多 40 XP；奖励照常写入成长账本。交付日期必须是今天。
- **熟练度**：每次交付，给任务关联的每个技能节点加 `min(120, 实际分钟)` 点。技能树按子树汇总显示等级：萌芽、成长、熟练、精通。
- **旧入口关闭**：`action.record` 不能再带 `skillTaskId` 记录已经成为主线任务的任务，防止同一任务重复得到 XP。

## 命令

以下命令只接受用户请求，不在 `commandSchema` 中，因此不会出现在聊天提案里：

```
quest.accept    { id }
quest.abandon   { id }                         // 保留目标项进度
quest.track     { id }
quest.objective { id, objective, done }
quest.deliver   { id, day, minutes, note, content?, fields? }
```

`quest.deliver` 会做以下校验：

- 所有目标项都已勾选；
- `text` 类型必须填写成果；
- `log` 类型的必填字段要填写，数字字段要是有效数字。

## 生成

技能规划任务新增了可选字段 `deliverable`，规定用户完成任务时交付什么：

```
{ type: "confirm" | "text" | "log", prompt, name, fields[] }
```

- `fields` 只用于 `log` 类型，最多 4 个字段。
- 只允许用户能用文字提交的成果，不能要求录音、照片或文件。

模型负责写任务内容；状态、解锁、奖励和校验全部由代码决定。

## 界面

| 页面 | 内容 |
| --- | --- |
| 首页 | 任务追踪卡：当前任务、下一个目标项、进度 |
| 任务板 | 按主线分组的任务列表；本阶段任务全部交付后，显示阶段挑战入口 |
| 任务详情 | 目标项、交付表单（按交付类型显示）、实际投入分钟数、奖励预览 |
| 结算 | 经验、熟练度、战利品、下一个解锁的任务 |
| 行囊 | 战利品，以及原有的投入记录 |
