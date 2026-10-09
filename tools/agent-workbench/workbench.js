import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import {
  isRetry,
  intakeState,
  compactContext,
  enforceIntake,
  verifyBaselines,
  failureSummary,
  recoverable,
} from "./intake.js";
import { resourceCatalog } from "./resources.js";
import { checkResources } from "./plan-v2.js";
import { initialTree, applyTreePatch } from "./tree-patch.js";
import { agentConfig } from "./engine.js";
import { DshAgent } from "./current/src/agent.js";
import {
  parseResponse,
  explicitBudget,
  checkBudget,
} from "./workbench-contract.js";
import {
  labDataDir,
  getLabKnowledge,
  retrieveLabKnowledge,
  retrievalSummary,
} from "./knowledge.js";
const root = resolve(labDataDir, "workbench");
export const catalog = {
  plugins: [
    {
      id: "earth-tools",
      name: "Earth 业务工具",
      description: "上下文、标准查询、资料检索（未配置搜索时明确返回不可用）",
    },
    {
      id: "skills",
      name: "DSH 技能运行时",
      description:
        "挂载 dsh-skill、skill-filesystem、tool-skill；卸载后 Agent 无法加载以下技能",
    },
  ],
  skills: [
    {
      id: "goal-intake",
      name: "目标理解",
      description: "提炼目的、区分事实与假设、必要追问",
    },
    {
      id: "skill-tree-design",
      name: "技能树设计",
      description: "核心能力、分支与阶段里程碑",
    },
    {
      id: "task-design",
      name: "任务设计",
      description: "学习顺序、软件材料与详细操作",
    },
    {
      id: "plan-adjustment",
      name: "反馈调整",
      description: "结合历史调整时间、难度与目标",
    },
  ],
  availableOnly: [
    {
      id: "mcp-client",
      name: "MCP 接入",
      reason: "已安装；尚未配置外部服务，本工作台不提供任意包安装",
    },
    {
      id: "ask-user",
      name: "DSH 等待式提问",
      reason: "未接入网页答复通道；当前使用持久化聊天消息追问",
    },
  ],
};
const file = (id) => join(root, `${id}.json`);
async function save(c) {
  await mkdir(root, { recursive: true });
  await writeFile(file(c.id) + ".tmp", JSON.stringify(c), { mode: 0o600 });
  await rename(file(c.id) + ".tmp", file(c.id));
}
export async function getConversation(id) {
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw Object.assign(new Error(), { code: "not_found" });
  try {
    return JSON.parse(await readFile(file(id), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT")
      throw Object.assign(new Error(), { code: "not_found" });
    throw e;
  }
}
export async function listConversations() {
  await mkdir(root, { recursive: true });
  const names = (await readdir(root)).filter((n) =>
    /^[a-f0-9-]{36}\.json$/.test(n),
  );
  const rows = await Promise.all(
    names.map(async (n) => {
      const c = await getConversation(n.slice(0, -5));
      return {
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        revision: c.revision,
      };
    }),
  );
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function prepareMessage(input) {
  const c = input.conversationId
    ? await getConversation(input.conversationId)
    : {
        id: randomUUID(),
        title: input.message.slice(0, 36),
        messages: [],
        revision: 0,
        plan: null,
        tree: initialTree(),
      };
  if (c.messages.length >= 120)
    throw Object.assign(new Error(), { code: "conversation_full" });
  if (input.turnType === "background" && intakeState(c).backgroundUsed)
    throw Object.assign(new Error(), { code: "background_used" });
  c.messages.push({
    id: randomUUID(),
    turnType: input.turnType ?? "message",
    role: "user",
    content: input.message,
    at: new Date().toISOString(),
  });
  c.updatedAt = new Date().toISOString();
  c.capabilities = input.capabilities;
  await save(c);
  return c;
}
export async function runMessage(
  c,
  {
    agent,
    persist = save,
    onProgress = () => {},
    runId = randomUUID(),
    knowledge,
    env = process.env,
  } = {},
) {
  if (c.lastRun && c.lastRun.id !== runId)
    c.runHistory = [...(c.runHistory ?? []), c.lastRun].slice(-10);
  const trace = { calls: [] },
    baseCfg = {
      ...agentConfig(env),
      labCapabilities: c.capabilities,
      labTrace: trace,
    };
  const lastUser = [...c.messages]
    .reverse()
    .find((m) => m.role === "user" && !isRetry(m.content));
  const job = {
    user_id: "workbench",
    kind: "workbench",
    input: { message: lastUser?.content ?? c.messages.at(-1).content },
  };
  const context = compactContext(c);
  // Legacy snapshots remain untouched; a personal tree starts only on v3 output.
  const baseTree = c.tree ?? initialTree();
  context.personalTree = {
    revision: baseTree.revision,
    nodes: baseTree.nodes,
    goals: baseTree.goals,
  };
  context.treeRequestId = runId;
  context.resourceCatalog = resourceCatalog;
  context.searchAvailable =
    !!baseCfg.EXA_API_KEY && c.capabilities.plugins.includes("earth-tools");
  context.explicitBatchBudget = explicitBudget(
    c.messages.slice(context.intake.startIndex),
  );
  const start = Date.now();
  let output;
  let merged;
  const attempts = [];
  let generations = 0;
  const deadline = start + baseCfg.DSH_TIMEOUT_MS;
  async function progress(status, attempt, error) {
    c.lastRun = {
      id: runId,
      status,
      attempt,
      maxAttempts: 3,
      attempts: [...attempts],
      updatedAt: new Date().toISOString(),
      ...(error ? { error } : {}),
    };
    await persist(c);
    await onProgress(c.lastRun);
  }
  await progress("running", 1);
  const query = context.intent.shouldRetrieve
    ? [
        c.messages[context.intake.startIndex]?.content,
        ...context.userStatements.slice(-3),
        job.input.message,
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 500)
    : "";
  context.knowledge = await retrieveLabKnowledge(
    c.capabilities.plugins.includes("earth-tools")
      ? (knowledge ?? (!agent ? getLabKnowledge(env) : null))
      : null,
    query,
    c.id,
  );
  trace.sourceUrls = context.knowledge.sources.map((s) => s.url);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await progress("running", attempt);
    const at = Date.now();
    try {
      if (Date.now() >= deadline || generations >= 3)
        throw new ContractError("model_timeout");
      if (agent) generations++;
      const cfg = {
        ...baseCfg,
        DSH_TIMEOUT_MS: Math.max(1, deadline - Date.now()),
        DSH_REASONING_EFFORT:
          attempt === 1 ? baseCfg.DSH_REASONING_EFFORT : "low",
      };
      output = checkBudget(
        parseResponse(
          await (
            agent ||
            new DshAgent(cfg, {
              maxAttempts: Math.max(1, 3 - generations),
              onAttempt: () => {
                generations++;
              },
            })
          ).run({ ...job, id: randomUUID() }, context),
        ),
        context.explicitBatchBudget,
      );
      checkResources(output, [
        ...resourceCatalog.map((r) => r.url),
        ...(trace.sourceUrls ?? []),
      ]);
      enforceIntake(output, context.intake, context.intent);
      verifyBaselines(output, c);
      if (output.schemaVersion === "earth.agent.v3" && output.plan) {
        merged = applyTreePatch(baseTree, output.treePatch, output.plan, {
          requestId: runId,
          userStatements: c.messages
            .filter((m) => m.role === "user" && !isRetry(m.content))
            .map((m) => m.content),
        });
      }
      attempts.push({
        attempt,
        status: "completed",
        elapsedMs: Date.now() - at,
      });
      break;
    } catch (e) {
      const error = failureSummary(e);
      attempts.push({
        attempt,
        status: "failed",
        elapsedMs: Date.now() - at,
        error,
      });
      if (
        attempt === 3 ||
        generations >= 3 ||
        Date.now() >= deadline ||
        !recoverable.has(error.code)
      ) {
        await progress("failed", attempt, error);
        throw e;
      }
      await progress("retrying", attempt, error);
      context.validationFeedback = {
        instruction:
          "自动恢复：使用原始用户输入重新输出合法响应。缩短非必要解释，严格遵守收集轮次和输出契约。",
        ...error,
        ...(output?.plan
          ? {
              taskDurations: output.plan.tasks.map((t) => ({
                id: t.id,
                minutes: t.minutes,
                actionMinutes: t.actions.map((a) => a.minutes),
                actionTotal: t.actions.reduce((sum, a) => sum + a.minutes, 0),
              })),
            }
          : {}),
        repairHint:
          "duration_mismatch 表示该任务的 minutes 必须等于所有 actions.minutes 的算术总和；同时所有任务合计不能超过 goal.minutes。重新分配步骤时间后再计算总和，不要重复错误数字。",
      };
    }
  }
  if (output.plan) {
    c.plan = merged?.plan ?? output.plan;
    if (merged) c.tree = merged.tree;
    c.revision++;
  }
  c.intake = {
    ...context.intake,
    processedThrough: c.messages.findLastIndex(
      (m) => m.role === "user" && !isRetry(m.content),
    ),
    finalized:
      context.intake.mustPlan ||
      context.intake.finalized ||
      (output.status === "draft" && output.questions.length === 0),
  };
  const result = {
    ...output,
    ...(merged
      ? {
          plan: merged.plan,
          agentPlan: output.plan,
          treePatch: output.treePatch,
          treeRevision: merged.tree.revision,
          tree: merged.tree.nodes,
          goals: merged.tree.goals,
        }
      : {}),
    retrieval: retrievalSummary(context.knowledge),
    intake: c.intake,
    revision: c.revision,
    capabilities: structuredClone(c.capabilities),
    toolCalls: trace.calls,
    attempts,
    elapsedMs: Date.now() - start,
    model: baseCfg.DSH_MODEL,
    checks: { schema: true, semantics: true },
    writes: { productionDatabase: false, xp: false },
  };
  c.messages.push({
    id: randomUUID(),
    role: "assistant",
    content: output.reply,
    result,
    at: new Date().toISOString(),
  });
  c.updatedAt = new Date().toISOString();
  await progress("completed", attempts.length);
  return { conversation: c, result };
}
