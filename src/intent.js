import { z } from "zod";
import { AgentError } from "./agent-output.js";
import { initialTree, applyTreePatch } from "./skill-tree/tree-patch.js";

export const intentSchema = z
  .object({
    kind: z.enum([
      "planning",
      "schedule_change",
      "goal_change",
      "reflection",
      "question",
      "context",
      "greeting",
      "clarification",
      "retry",
    ]),
    confidence: z.enum(["high", "medium", "low"]),
    shouldRetrieve: z.boolean(),
    requiresClarification: z.boolean(),
    targetGoalId: z.string().nullable(),
    targetPlanId: z.string().nullable(),
    timeBudget: z.number().int().min(1).max(1440).nullable(),
    explicitPlanning: z.boolean(),
    requestedActions: z.array(
      z.enum([
        "plan",
        "reschedule",
        "delete_goal",
        "delete_plan",
        "manage_goal",
        "review",
      ]),
    ),
    blockedActions: z.array(z.enum(["plan", "delete_goal", "delete_plan"])),
    reasonCodes: z.array(
      z.enum([
        "explicit_request",
        "followup_context",
        "ambiguous_reference",
        "multiple_requests",
        "negated_request",
        "quoted_example",
        "informational",
        "insufficient_signal",
      ]),
    ),
  })
  .strict();

export const isRetryMessage = (text) =>
  /^(?:重试|再试一次|重新试一下|retry|try again)[!！。\s]*$/i.test(text.trim());
const normalized = (text) =>
  String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "");
const clauses = (text) =>
  text.split(/[，,。！!?？;；\n]|(?:但是|但请|而是|\bbut\b|\binstead\b)/i);
const negated = (prefix) =>
  /(?:不要|不用|不必|不需要|不想|不是要|不是想|不|先别|别|暂不|先不|不能|do\s+not|don't|not)[^，。;]{0,14}$/i.test(
    prefix,
  );
function actionMatch(text, pattern) {
  let positive = false,
    negative = false;
  for (const clause of clauses(text)) {
    const match = clause.match(pattern);
    if (!match) continue;
    const verb = match[0].search(
      /删除|删掉|移除|放弃|取消|修改|调整|移动|规划|安排|制定|生成|设计|delete|remove|cancel|plan|schedule/i,
    );
    if (negated(clause.slice(0, match.index + Math.max(0, verb))))
      negative = true;
    else positive = true;
  }
  return { positive, negative };
}
const patterns = {
  plan: /(?:规划|安排|制定|生成|设计|给我|帮我).{0,18}(?:计划|任务|行动|时间块|日程|路线|技能树)|(?:规划|安排|制定|生成).{0,18}(?:练习|学习|复习|阅读|写作)|(?:计划|规划|安排|制定|生成).{0,12}(?:今晚|今天|明天)|(?:帮我|开始|直接|现在|请).{0,8}(?:规划|安排)|(?:怎么|如何|怎样).{0,12}(?:开始|实现|达成|提高|养成|学习)|\b(?:plan|schedule|create a plan|how can i achieve)\b/i,
  reschedule:
    /(?:修改|调整|移动|挪|改到|改成|延长|缩短).{0,15}(?:时间|分钟|日程|计划|任务|行动|事件|安排)|(?:任务|行动|事件|时间块|计划).{0,15}(?:调整|挪|移动|改到|改成|延长|缩短)|\b(?:reschedule|move .{0,20}(?:task|block)|adjust .{0,20}(?:plan|schedule))\b/i,
  delete_goal:
    /(?:删除|删掉|移除|放弃).{0,15}(?:目标|主线|支线)|(?:目标|主线|支线).{0,15}(?:删除|删掉|移除)|\b(?:delete|remove|drop).{0,15}goal\b/i,
  delete_plan:
    /(?:删除|删掉|移除|取消).{0,15}(?:事件|时间块|日程|安排|计划|任务)|(?:事件|时间块|任务|计划).{0,15}(?:删除|删掉|移除|取消)|\b(?:delete|remove|cancel).{0,15}(?:task|block|schedule)\b/i,
  manage_goal:
    /(?:修改|改名|暂停|恢复|继续|调整).{0,15}(?:目标|主线|支线)|(?:目标|主线|支线).{0,15}(?:改名|暂停|恢复|调整)|\b(?:rename|pause|resume).{0,15}goal\b/i,
  review:
    /复盘|回顾|总结.{0,12}(?:今天|昨天|本周|进度)|(?:今天|昨天|本周|进度).{0,12}(?:做得怎么样|总结)|\b(?:review|reflect)\b/i,
};

function chineseNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  let total = 0,
    digit = 0;
  for (const c of value) {
    if (c === "十" || c === "百") {
      total += (digit || 1) * (c === "十" ? 10 : 100);
      digit = 0;
    } else if (Object.hasOwn(digits, c)) digit = digits[c];
    else return null;
  }
  return total + digit;
}
export function extractTimeBudget(text) {
  const values = [];
  const durations = [
    ...text.matchAll(
      /([\d一二两三四五六七八九十百]+|一个半|半|一半)\s*(分钟|小时|minutes?|mins?|hours?|hrs?)/gi,
    ),
  ];
  for (const match of durations) {
    const amount = ["半", "一半"].includes(match[1])
      ? 0.5
      : match[1] === "一个半"
        ? 1.5
        : chineseNumber(match[1]);
    const minutes = /^(小时|hours?|hrs?)$/i.test(match[2])
      ? amount * 60
      : amount;
    const prefix = text
      .slice(0, match.index)
      .split(/[，,。;；\n]/)
      .at(-1)
      .slice(-40);
    if (/不是\s*$|not\s*$/i.test(prefix)) continue;
    const explicit =
      /(?:只有|只剩|最多|不超过|预算|可用|空闲|时间|控制在|改为|改成|调整到|改到|延长到|延长为|缩短到|缩短为|现在是|而是|总共|总计|总时长|合计|有|\b(?:have|only|budget|total))[^\d一二两三四五六七八九十百]{0,8}$/i.test(
        prefix,
      );
    const soleDaily =
      durations.length === 1 &&
      /每天|每次|今晚|今天|这次|本批|daily|per day/i.test(prefix);
    const requestedBudget =
      durations.length === 1 &&
      /(?:的)?(?:计划|任务|安排)|\bplan\b/i.test(
        text.slice(match.index + match[0].length),
      );
    const standalone = text.trim() === match[0].trim();
    if (!explicit && !soleDaily && !standalone && !requestedBudget) continue;
    if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440)
      values.push(minutes);
  }
  return values.at(-1) ?? null;
}

function resolveReference(text, records, nameKey, { implicit = false } = {}) {
  const valid = records.filter(
    (r) => !r.deletedAt && !["cancelled", "expired"].includes(r.status),
  );
  const value = normalized(text);
  const named = valid.filter(
    (r) =>
      (r.id && value.includes(normalized(r.id))) ||
      (normalized(r[nameKey]).length >= 2 &&
        value.includes(normalized(r[nameKey]))),
  );
  if (named.length === 1) return { id: named[0].id, ambiguous: false };
  if (named.length > 1) return { id: null, ambiguous: true };
  const pronoun =
    /这个|那个|它|这项|那项|该目标|当前目标|当前任务|主线|支线|\b(?:it|this|that|current)\b/i.test(
      text,
    );
  if (valid.length === 1 && (pronoun || implicit))
    return { id: valid[0].id, ambiguous: false };
  return { id: null, ambiguous: pronoun && valid.length !== 1 };
}

export function analyzeIntent(job, context = {}) {
  if (["route", "skills"].includes(job.kind)) {
    const goal = context.goals?.find(
      (g) => g.id === job.input?.goalId && !g.deletedAt,
    );
    // A goal button creates a scoped job; unrelated chat cannot override it.
    return intentSchema.parse({
      kind: "planning",
      confidence: "high",
      shouldRetrieve: !!goal,
      requiresClarification: !goal,
      targetGoalId: job.input?.goalId ?? null,
      targetPlanId: null,
      timeBudget: job.input?.minutes ?? goal?.minutes ?? null,
      explicitPlanning: true,
      requestedActions: ["plan"],
      blockedActions: [],
      reasonCodes: ["explicit_request"],
    });
  }
  const messages = context.messages ?? [];
  let current =
    (job.input?.messageId
      ? messages.find((m) => m.id === job.input.messageId && m.role === "user")
      : null) ?? messages.findLast((m) => m.role === "user");
  let text = current?.content ?? job.input?.message ?? "";
  const retry = isRetryMessage(text);
  if (retry)
    text =
      messages
        .filter((m) => m.role === "user" && !isRetryMessage(m.content))
        .at(-1)?.content ?? text;
  const request = String(text).slice(0, 5000);
  const quotedExample =
    /(?:例如|示例|他说|原文|网页写|翻译|解释).{0,20}[“"「『]/.test(request);
  const analyzed = quotedExample
    ? request.replace(/[“"「『][^”"」』]*[”"」』]/g, "")
    : request;
  const detected = Object.entries(patterns).map(([name, pattern]) => [
    name,
    actionMatch(analyzed, pattern),
  ]);
  const deletionQuestion =
    /(?:要不要|是否|能否|可不可以|需不需要|该不该|should i|should we|can i|could i).{0,20}(?:删|移除|取消|delete|remove|cancel)|(?:删除|删掉|移除|取消|delete|remove|cancel).{0,12}(?:好吗|可以吗|吗)/i.test(
      analyzed,
    );
  const requestedActions = detected
    .filter(
      ([name, state]) =>
        state.positive &&
        !(deletionQuestion && ["delete_goal", "delete_plan"].includes(name)),
    )
    .map(([name]) => name);
  const blockedActions = detected
    .filter(
      ([name, state]) =>
        ["plan", "delete_goal", "delete_plan"].includes(name) &&
        state.negative &&
        !state.positive &&
        !(deletionQuestion && ["delete_goal", "delete_plan"].includes(name)),
    )
    .map(([name]) => name);
  let kind = "clarification",
    confidence = "low";
  const reasonCodes = [];
  if (deletionQuestion) kind = "question";
  else if (
    requestedActions.some((k) => ["delete_goal", "manage_goal"].includes(k))
  )
    kind = "goal_change";
  else if (
    requestedActions.some((k) => ["delete_plan", "reschedule"].includes(k))
  )
    kind = "schedule_change";
  else if (requestedActions.includes("review")) kind = "reflection";
  else if (requestedActions.includes("plan")) kind = "planning";
  else if (
    /^(?:你好|您好|嗨|hello|hi|谢谢|感谢|thanks)[!！。\s]*$/i.test(analyzed)
  )
    kind = "greeting";
  else if (
    /是什么|有什么|为什么|区别|介绍|解释|推荐.{0,8}(?:资料|书|网站)|如何使用|怎么用|what|why|explain|how does/i.test(
      analyzed,
    ) ||
    quotedExample
  )
    kind = "question";
  else if (
    /想(?:学|做|练|写|读|存|买|考|健身|减脂|运动|提高|养成|达到|实现)|目标|我的情况|基础|每天|分钟|小时|我.{0,12}(?:能|会|不会|分钟|小时)|\b(?:want to|my goal|i can|i have)\b/i.test(
      analyzed,
    )
  )
    kind = "context";
  else if (
    context.lastQuestions?.length ||
    messages.some((m) => m.role === "assistant" && m.questions?.length)
  ) {
    kind = "context";
    reasonCodes.push("followup_context");
  }
  if (requestedActions.length) {
    confidence = "high";
    reasonCodes.push("explicit_request");
  } else if (kind !== "clarification") confidence = "medium";
  if (requestedActions.length > 1) reasonCodes.push("multiple_requests");
  if (blockedActions.length) reasonCodes.push("negated_request");
  if (quotedExample) reasonCodes.push("quoted_example");
  if (["greeting", "question"].includes(kind))
    reasonCodes.push("informational");
  if (kind === "clarification") reasonCodes.push("insufficient_signal");
  const goal = resolveReference(request, context.goals ?? [], "title", {
    implicit: kind === "goal_change",
  });
  const plan = resolveReference(request, context.plans ?? [], "name", {
    implicit: kind === "schedule_change",
  });
  const ambiguous =
    (kind === "goal_change" && (!goal.id || goal.ambiguous)) ||
    (kind === "schedule_change" && (!plan.id || plan.ambiguous));
  if (ambiguous) reasonCodes.push("ambiguous_reference");
  const newGoal = /新目标|另一个目标|还想|换个目标/.test(request);
  const recent = (newGoal ? [] : messages)
    .filter(
      (m) =>
        m.role === "user" &&
        (!current?.id || m.id !== current.id) &&
        !isRetryMessage(m.content),
    )
    .slice(-5);
  const budget =
    extractTimeBudget(request) ??
    recent
      .map((m) => extractTimeBudget(m.content))
      .filter((m) => m !== null)
      .at(-1) ??
    null;
  const explicitPlanning = requestedActions.includes("plan");
  return intentSchema.parse({
    kind: retry && kind === "clarification" ? "retry" : kind,
    confidence,
    shouldRetrieve:
      !blockedActions.includes("plan") &&
      !ambiguous &&
      ["planning", "context"].includes(kind),
    requiresClarification: !!ambiguous || kind === "clarification",
    targetGoalId: goal.id,
    targetPlanId: plan.id,
    timeBudget: budget,
    explicitPlanning,
    requestedActions,
    blockedActions,
    reasonCodes: [...new Set(reasonCodes)],
  });
}

export function intentInstruction(intent) {
  if (!intent) return "";
  return (
    "\n应用已分析本轮意图（这是规划边界，不是已经执行的操作）：" +
    JSON.stringify(intent) +
    "\n先处理用户此刻的问题，再利用历史背景。问候/原理解释不要强行创建目标。否定的操作不能提议。指代不清时用questions问最多两个关键问题，不猜ID。明确规划请求用行动块呈现或先澄清必要信息；已有时间预算不得超出。用户最新说法优先于旧计划。"
  );
}

export function validateIntentOutput(output, { job, context }) {
  const intent = context.intent ?? analyzeIntent(job, context);
  const reject = (code, path) => {
    throw new AgentError("intent_mismatch", {
      phase: "validation",
      issues: [{ path, code }],
    });
  };
  if (["route", "skills"].includes(job.kind)) {
    const plan = job.kind === "skills" ? output.plan : output;
    const total =
      job.kind === "skills"
        ? plan?.tasks?.reduce((n, t) => n + t.minutes, 0)
        : plan?.minutes;
    if (intent.timeBudget && total > intent.timeBudget)
      reject("route_over_budget", ["minutes"]);
    if (
      job.kind === "route" &&
      output.stages?.some(
        (s) => s.actions.reduce((n, a) => n + a.minutes, 0) > output.minutes,
      )
    )
      reject("action_over_budget", ["stages", "actions", "minutes"]);
    if (job.kind === "skills" && context.personalTree) {
      const goal = context.goals?.find((g) => g.id === job.input.goalId);
      if (
        !goal ||
        output.plan.goal.title !== goal.title ||
        output.plan.goal.target !== goal.criterion ||
        output.treePatch.goalId !== context.skillGoalId
      )
        reject("goal_contract_mismatch", ["plan", "goal"]);
      try {
        applyTreePatch(
          { ...initialTree(), ...context.personalTree },
          output.treePatch,
          output.plan,
          {
            requestId: context.treeRequestId ?? job.id,
            userStatements: [
              goal.base ?? "",
              ...(context.messages ?? [])
                .filter((m) => m.role === "user")
                .map((m) => m.content),
            ],
          },
        );
      } catch {
        reject("tree_contract_invalid", ["treePatch"]);
      }
    }
    return;
  }
  if (job.kind !== "chat") return;
  const proposals = output.proposals ?? [];
  if (intent.blockedActions.includes("plan") && output.guidance)
    reject("command_not_requested", ["guidance"]);
  if (intent.requiresClarification && (proposals.length || output.guidance))
    reject("intent_requires_clarification", ["proposals"]);
  if (
    intent.explicitPlanning &&
    !intent.requiresClarification &&
    !output.guidance?.steps?.length &&
    !output.questions?.length
  )
    reject("planning_requires_visual_guidance", ["guidance"]);
  if (
    intent.timeBudget &&
    output.guidance?.steps?.reduce((n, step) => n + step.minutes, 0) >
      intent.timeBudget
  )
    reject("guidance_over_budget", ["guidance", "steps", "minutes"]);
  const canPlan =
    ["planning", "context"].includes(intent.kind) ||
    intent.requestedActions.includes("plan");
  if (
    (!canPlan || intent.blockedActions.includes("plan")) &&
    proposals.some((p) =>
      ["goal.create", "plan.create", "plan.batch"].includes(p.command.type),
    )
  )
    reject("command_not_requested", ["proposals", "command"]);
  const newDayMinutes = new Map();
  for (const { command } of proposals) {
    if (
      (command.type === "plan.update" ||
        (command.type === "plan.status" && command.status !== "cancelled")) &&
      !canPlan &&
      !intent.requestedActions.includes("reschedule")
    )
      reject("command_not_requested", ["proposals", "command"]);
    const proposalMinutes =
      command.type === "plan.batch"
        ? command.blocks.reduce((n, block) => n + block.minutes, 0)
        : ["goal.create", "plan.create", "plan.update"].includes(command.type)
          ? command.minutes
          : null;
    if (intent.timeBudget && proposalMinutes > intent.timeBudget)
      reject("guidance_over_budget", ["proposals", "command", "minutes"]);
    if (
      intent.timeBudget &&
      ["plan.create", "plan.batch"].includes(command.type)
    ) {
      const dayMinutes =
        (newDayMinutes.get(command.day) ?? 0) + proposalMinutes;
      newDayMinutes.set(command.day, dayMinutes);
      if (dayMinutes > intent.timeBudget)
        reject("guidance_over_budget", ["proposals", "command", "minutes"]);
    }
    const isGoalDelete = command.type === "goal.delete";
    const isPlanDelete =
      command.type === "plan.status" && command.status === "cancelled";
    if (
      (isGoalDelete && !intent.requestedActions.includes("delete_goal")) ||
      (isPlanDelete && !intent.requestedActions.includes("delete_plan"))
    )
      reject("command_not_requested", ["proposals", "command"]);
    if (command.type.startsWith("goal.") && command.type !== "goal.create") {
      const target = (context.goals ?? []).find(
        (g) =>
          g.id === command.id &&
          (command.type === "goal.restore" || !g.deletedAt),
      );
      if (!target)
        reject("target_not_available", ["proposals", "command", "id"]);
      if (intent.targetGoalId && command.id !== intent.targetGoalId)
        reject("target_mismatch", ["proposals", "command", "id"]);
    }
    if (
      ["plan.create", "plan.batch"].includes(command.type) &&
      command.goal &&
      !(context.goals ?? []).some((g) => g.id === command.goal && !g.deletedAt)
    )
      reject("target_not_available", ["proposals", "command", "goal"]);
    if (["plan.update", "plan.status"].includes(command.type)) {
      if (
        !(context.plans ?? []).some(
          (p) =>
            p.id === command.id &&
            !["done", "cancelled", "expired"].includes(p.status),
        )
      )
        reject("target_not_available", ["proposals", "command", "id"]);
      if (intent.targetPlanId && command.id !== intent.targetPlanId)
        reject("target_mismatch", ["proposals", "command", "id"]);
    }
  }
}
