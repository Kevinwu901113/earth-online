import { initialTree, applyTreePatch } from "./skill-tree/tree-patch.js";
import { skillGoalId } from "./skill-tree/generation.js";
import { randomUUID } from "node:crypto";
import { validateOutput } from "./agent-output.js";
export class DomainError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.statusCode = status;
  }
}
export const rules = Object.freeze({
  version: "growth-v1",
  minutesPerXp: 5,
  maxActionXp: 12,
  dailyXpCap: 40,
  xpPerLevel: 100,
  attributeXpPerRank: 100,
});
export const initialState = () => ({
  profile: {
    name: "未完待续的我",
    daily: 30,
    timezone: "Asia/Shanghai",
    preferences: "",
  },
  goals: [],
  plans: [],
  records: [],
  notes: [],
  submissions: [],
  events: [],
  messages: [],
  candidates: [],
  achievements: [],
  personalTree: initialTree(),
  skillPlans: {},
  levelXp: 0,
});
const find = (list, id) => {
  const x = list.find((i) => i.id === id);
  if (!x) throw new DomainError("记录不存在", 404);
  return x;
};
const findGoal = (s, id) => {
  const g = find(s.goals, id);
  if (g.deletedAt) throw new DomainError("任务已删除，请先恢复");
  return g;
};
const note = (s, kind, name, body, now, extra = {}) =>
  s.notes.push({
    id: randomUUID(),
    kind,
    name,
    body,
    createdAt: now,
    ...extra,
  });
const active = (g) => {
  if (g.status !== "active") throw new DomainError("请先启用或恢复主线");
};
const minutesAt = (time) =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const timeAt = (start) =>
  `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
const validateSchedule = (s, day, start, minutes, now, excludeId = null) => {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: s.profile.timezone,
  }).format(new Date(now));
  if (day < today) throw new DomainError("不能在过去安排新行动", 400);
  if (start + minutes > 1440)
    throw new DomainError("行动不能跨越当天，请分开安排", 400);
  if (
    s.plans.some(
      (p) =>
        p.id !== excludeId &&
        p.day === day &&
        p.status === "planned" &&
        start < p.start + p.minutes &&
        start + minutes > p.start,
    )
  )
    throw new DomainError("该时段已有安排，请调整时间");
};
const currentPlanGoal = (s, p) => {
  if (!p.goal) return;
  const g = findGoal(s, p.goal);
  active(g);
  if (p.stage !== g.stage || p.revision !== g.revision)
    throw new DomainError("路线已变化，请重新安排当前阶段");
};
export function applyCommand(
  state,
  cmd,
  now = new Date().toISOString(),
  standards = [],
) {
  const s = expireState(state, now),
    jobs = [],
    rewards = [];
  let result = {};
  const job = (kind, input) => {
    const j = { id: randomUUID(), kind, input };
    jobs.push(j);
    return j.id;
  };
  switch (cmd.type) {
    case "profile.update":
      try {
        new Intl.DateTimeFormat("en", { timeZone: cmd.timezone }).format();
      } catch {
        throw new DomainError("时区无效", 400);
      }
      s.profileHistory = [
        ...(s.profileHistory ?? []),
        { ...s.profile, at: s.profileUpdatedAt ?? null, source: "用户填写" },
      ];
      s.profileUpdatedAt = now;
      s.profile = {
        name: cmd.name,
        daily: cmd.daily,
        timezone: cmd.timezone,
        preferences: cmd.preferences,
      };
      break;
    case "skills.generate": {
      const g = findGoal(s, cmd.id);
      if (!["draft", "active", "paused"].includes(g.status))
        throw new DomainError("目标已结束");
      result.jobId = job("skills", { goalId: g.id, revision: g.revision });
      g.skillJobId = result.jobId;
      break;
    }
    case "goal.create": {
      const g = {
        id: randomUUID(),
        title: cmd.title,
        base: cmd.base,
        minutes: cmd.minutes,
        criterion: cmd.criterion,
        requiresExternal: cmd.requiresExternal,
        kind: cmd.kind ?? "main",
        status: "draft",
        stage: 0,
        stages: [],
        revision: 0,
        routeHistory: [],
        draft: null,
        createdAt: now,
        deletedAt: null,
      };
      s.goals.push(g);
      result = {
        goalId: g.id,
        jobId: job("route", {
          goalId: g.id,
          revision: g.revision,
          stage: g.stage,
          reason: "首次规划",
        }),
      };
      g.routeJobId = result.jobId;
      break;
    }
    case "goal.confirm": {
      const g = findGoal(s, cmd.id);
      if (!g.draft || g.draft.id !== cmd.draftId)
        throw new DomainError("路线草案已变动，请刷新");
      if (
        (g.routeJobId && g.routeJobId !== g.draft.id) ||
        (g.draft.stage !== undefined && g.draft.stage !== g.stage)
      )
        throw new DomainError("当前阶段已变化，请重新规划");
      if (!["draft", "active", "paused"].includes(g.status))
        throw new DomainError("已结束的目标不能启用新路线");
      if (g.stages.length)
        g.routeHistory.push({
          revision: g.revision,
          stages: g.stages,
          minutes: g.minutes,
          at: now,
        });
      const route = g.draft.route;
      // An adjustment may replace only the unfinished suffix. Completed stages retain their evidence and criteria.
      g.stages = [...g.stages.slice(0, g.stage), ...route.stages];
      g.minutes = route.minutes;
      g.stat = route.stat;
      g.sources = route.sources;
      g.revision++;
      g.status = "active";
      g.draft = null;
      g.skillJobId = job("skills", { goalId: g.id, revision: g.revision });
      note(s, "route", "路线已确认", route.summary, now, { goal: g.id });
      break;
    }
    case "goal.delete": {
      const g = find(s.goals, cmd.id);
      if (g.deletedAt) throw new DomainError("任务已在已删除列表中");
      g.deletedAt = now;
      // Invalidate in-flight routes even if the user restores the goal before they return.
      g.routeJobId = randomUUID();
      g.draft = null;
      for (const p of s.plans)
        if (p.goal === g.id && ["planned", "paused"].includes(p.status)) {
          p.status = "cancelled";
          p.cancelledAt = now;
          p.cancelReason = "goal_deleted";
        }
      for (const sub of s.submissions)
        if (sub.goal === g.id && sub.status === "pending") {
          sub.status = "error";
          sub.error = "任务已删除，评估已取消；恢复任务后可重试。";
        }
      result = { goalId: g.id };
      break;
    }
    case "goal.restore": {
      const g = find(s.goals, cmd.id);
      if (!g.deletedAt) throw new DomainError("任务没有被删除");
      g.deletedAt = null;
      g.restoredAt = now;
      result = { goalId: g.id };
      break;
    }
    case "goal.status": {
      const g = findGoal(s, cmd.id);
      if (["completed", "ended"].includes(g.status))
        throw new DomainError("目标已归档");
      if (g.status === "awaiting_external" && cmd.status !== "ended")
        throw new DomainError("请先核实外部结果");
      if (cmd.status === "active" && !g.stages.length)
        throw new DomainError("请先确认路线");
      g.status = cmd.status;
      note(s, "status", "目标状态变化", cmd.status, now, { goal: g.id });
      break;
    }
    case "goal.adjust": {
      const g = findGoal(s, cmd.id);
      if (!["draft", "active", "paused"].includes(g.status))
        throw new DomainError("目标已归档");
      result = {
        jobId: job("route", {
          goalId: g.id,
          revision: g.revision,
          stage: g.stage,
          reason: cmd.reason,
          minutes: cmd.minutes,
        }),
      };
      g.routeJobId = result.jobId;
      g.draft = null;
      break;
    }
    case "plan.create": {
      const g = cmd.goal ? findGoal(s, cmd.goal) : null;
      if (g) active(g);
      const start = minutesAt(cmd.time);
      validateSchedule(s, cmd.day, start, cmd.minutes, now);
      const p = {
        ...cmd,
        id: randomUUID(),
        start,
        status: "planned",
        stage: g?.stage ?? null,
        revision: g?.revision ?? null,
        createdAt: now,
      };
      delete p.type;
      s.plans.push(p);
      result = { planId: p.id };
      break;
    }
    case "plan.update": {
      const p = find(s.plans, cmd.id);
      if (!["planned", "paused"].includes(p.status))
        throw new DomainError("行动已结束，不能修改时间块");
      currentPlanGoal(s, p);
      const start = minutesAt(cmd.time);
      validateSchedule(s, cmd.day, start, cmd.minutes, now, p.id);
      Object.assign(p, {
        name: cmd.name,
        minutes: cmd.minutes,
        day: cmd.day,
        time: cmd.time,
        start,
        updatedAt: now,
      });
      result = { planId: p.id };
      break;
    }
    case "plan.batch": {
      const g = findGoal(s, cmd.goal);
      active(g);
      if (g.stage !== cmd.stage || g.revision !== cmd.revision)
        throw new DomainError("路线已变化，请重新安排当前阶段");
      if (!g.stages[g.stage]) throw new DomainError("当前阶段不存在");
      let start = minutesAt(cmd.time);
      const plans = [];
      for (const block of cmd.blocks) {
        validateSchedule(s, cmd.day, start, block.minutes, now);
        plans.push({
          ...block,
          id: randomUUID(),
          goal: g.id,
          day: cmd.day,
          time: timeAt(start),
          start,
          stat: g.stat,
          status: "planned",
          stage: g.stage,
          revision: g.revision,
          createdAt: now,
        });
        start += block.minutes;
      }
      // Validation completes before any block is added, so a conflict cannot leave a partial day plan.
      s.plans.push(...plans);
      result = { planIds: plans.map((p) => p.id) };
      break;
    }
    case "plan.status": {
      const p = find(s.plans, cmd.id);
      if (
        cmd.status === "planned" &&
        s.plans.some(
          (x) =>
            x.id !== p.id &&
            x.day === p.day &&
            x.status === "planned" &&
            p.start < x.start + x.minutes &&
            p.start + p.minutes > x.start,
        )
      )
        throw new DomainError("该时段已有安排");
      if (["done", "partial", "cancelled", "expired"].includes(p.status))
        throw new DomainError("行动已结束");
      if (cmd.status === "planned" && p.goal) active(findGoal(s, p.goal));
      p.status = cmd.status;
      break;
    }
    case "action.record": {
      if (cmd.skillTaskId) {
        const task = s.skillPlans?.[cmd.goal]?.tasks.find(
          (t) => t.id === cmd.skillTaskId,
        );
        if (
          cmd.plan ||
          !task ||
          task.name !== cmd.name ||
          task.stat !== cmd.stat
        )
          throw new DomainError("任务已变化，请刷新后重新选择");
        if (
          s.records.some(
            (r) =>
              r.goal === cmd.goal &&
              r.skillTaskId === cmd.skillTaskId &&
              r.day === cmd.day,
          )
        )
          throw new DomainError("今天已经记录过这项任务");
      }
      const p = cmd.plan ? find(s.plans, cmd.plan) : null;
      const g = cmd.goal ? findGoal(s, cmd.goal) : null;
      if (p) {
        if (s.records.some((r) => r.plan === p.id))
          throw new DomainError("这次行动已记录");
        if (p.status !== "planned") throw new DomainError("行动当前不可提交");
        if (p.goal !== cmd.goal) throw new DomainError("主线与安排不一致");
      }
      if (g) active(g);
      if (
        p &&
        (p.day !== cmd.day || p.name !== cmd.name || p.stat !== cmd.stat)
      )
        throw new DomainError("行动记录与安排不一致");
      if (g && p && (p.stage !== g.stage || p.revision !== g.revision))
        throw new DomainError("路线已变化，请重新安排当前阶段");
      if (p && cmd.minutes > 1440) throw new DomainError("投入时长无效");
      const dayNow = new Intl.DateTimeFormat("en-CA", {
        timeZone: s.profile.timezone,
      }).format(new Date(now));
      if (cmd.day > dayNow)
        throw new DomainError("不能记录尚未发生的行动", 400);
      const total = s.records
        .filter((r) => r.day === cmd.day)
        .reduce((a, r) => a + r.gain, 0);
      const gain =
        cmd.completion === "rest"
          ? 0
          : Math.max(
              0,
              Math.min(
                rules.maxActionXp,
                Math.floor(cmd.minutes / rules.minutesPerXp),
                rules.dailyXpCap - total,
              ),
            );
      const r = {
        ...cmd,
        id: randomUUID(),
        gain,
        source: "用户记录",
        status: cmd.completion,
        createdAt: now,
      };
      delete r.type;
      s.records.push(r);
      s.levelXp += gain;
      if (p) p.status = cmd.completion === "rest" ? "done" : cmd.completion;
      rewards.push({
        id: randomUUID(),
        sourceId: r.id,
        kind: "effort",
        xp: gain,
        attribute: cmd.stat,
        ruleVersion: rules.version,
      });
      result = { recordId: r.id, gain };
      break;
    }
    case "submission.create": {
      const g = findGoal(s, cmd.goal);
      active(g);
      const stage = g.stages[g.stage];
      if (!stage) throw new DomainError("当前阶段不存在");
      const sub = {
        id: randomUUID(),
        goal: g.id,
        stage: g.stage,
        revision: g.revision,
        criteria: structuredClone(stage),
        content: cmd.content,
        kind: cmd.kind,
        helpUsed: cmd.helpUsed,
        status: "pending",
        assessment: null,
        createdAt: now,
      };
      s.submissions.push(sub);
      result = {
        submissionId: sub.id,
        jobId: job("assessment", { submissionId: sub.id }),
      };
      sub.assessmentJobId = result.jobId;
      break;
    }
    case "submission.retry": {
      const sub = find(s.submissions, cmd.id);
      findGoal(s, sub.goal);
      if (sub.status !== "error") throw new DomainError("仅失败的评估可重试");
      sub.status = "pending";
      result = { jobId: job("assessment", { submissionId: sub.id }) };
      sub.assessmentJobId = result.jobId;
      break;
    }
    case "memory.correct": {
      const n = find(s.notes, cmd.id);
      n.previousBody = n.body;
      n.body = cmd.body;
      n.correctedAt = now;
      n.source = "用户修正";
      break;
    }
    case "memory.delete": {
      find(s.notes, cmd.id);
      s.notes = s.notes.filter((n) => n.id !== cmd.id);
      break;
    }
    case "review.create":
      result = { jobId: job("review", { day: cmd.day }) };
      break;
    case "chat.send":
      s.messages.push({
        id: randomUUID(),
        role: "user",
        content: cmd.content,
        at: now,
      });
      result = { jobId: job("chat", { messageId: s.messages.at(-1).id }) };
      break;
    case "event.create": {
      if (s.events.some((e) => e.externalId === cmd.externalId))
        throw new DomainError("这条生活事件已记录");
      if (
        cmd.kind === "opportunity" &&
        (!cmd.claimBy ||
          !cmd.executeBy ||
          cmd.claimBy > cmd.executeBy ||
          cmd.claimBy <= now)
      )
        throw new DomainError("请提供有效的领取与执行期限", 400);
      if (cmd.occurredAt > now && cmd.kind === "completed")
        throw new DomainError("已完成事件不能来自未来", 400);
      const e = {
        ...cmd,
        id: randomUUID(),
        status: cmd.kind === "opportunity" ? "offered" : "recorded",
        createdAt: now,
      };
      delete e.type;
      s.events.push(e);
      note(s, "event", "生活记录", e.content, now, { event: e.id });
      result = { eventId: e.id };
      break;
    }
    case "event.complete": {
      const e = find(s.events, cmd.id);
      if (e.status !== "claimed" || e.executeBy <= now)
        throw new DomainError("机会未领取或已过期");
      e.status = "completed";
      e.completedAt = now;
      e.note = cmd.note;
      note(s, "event", "机会执行记录", cmd.note, now, { event: e.id });
      break;
    }
    case "goal.external": {
      const g = findGoal(s, cmd.id);
      if (g.status !== "awaiting_external")
        throw new DomainError("当前不等待外部结果");
      g.externalEvidence = { content: cmd.content, status: "pending", at: now };
      note(s, "evidence", "待核实的外部结果", cmd.content, now, { goal: g.id });
      break;
    }
    case "event.claim": {
      const e = find(s.events, cmd.id);
      if (e.status !== "offered" || e.claimBy <= now)
        throw new DomainError("机会已领取或过期");
      e.status = "claimed";
      result = { eventId: e.id };
      break;
    }
    case "practice.grade": {
      const standard = standards.find(
          (v) => v.id === cmd.standardId && v.version === cmd.standardVersion,
        ),
        q = standard?.body.questions?.find((q) => q.id === cmd.questionId);
      if (!q || !q.choices.some((c) => c.id === cmd.choiceId))
        throw new DomainError("练习或选项不存在", 404);
      const correct = q.correctChoice === cmd.choiceId;
      note(
        s,
        "practice",
        "客观练习结果",
        q.prompt +
          "\n" +
          (correct ? "回答正确" : "暂未答对") +
          "：" +
          q.explanation,
        now,
        {
          standardId: standard.id,
          standardVersion: standard.version,
          questionId: q.id,
          choiceId: cmd.choiceId,
          correct,
        },
      );
      result = { correct, explanation: q.explanation };
      break;
    }
    case "standard.propose":
      s.candidates.push({
        id: randomUUID(),
        name: cmd.name,
        scope: cmd.scope,
        criteria: cmd.criteria,
        status: "pending",
        createdAt: now,
      });
      break;
    default:
      throw new DomainError("不支持的操作", 400);
  }
  return { state: s, jobs, rewards, result };
}
export function settleJob(
  state,
  job,
  output,
  standards = [],
  now = new Date().toISOString(),
) {
  const s = expireState(state, now);
  const rewards = [];
  output = validateOutput(job.kind, output);
  let result = output;
  if (job.kind === "skills") {
    const g = findGoal(s, job.input.goalId);
    if (
      g.revision !== job.input.revision ||
      g.skillJobId !== job.id ||
      !["draft", "active", "paused"].includes(g.status)
    )
      throw new DomainError("目标已变化，请重新生成能力分支");
    if (
      output.treePatch.goalId !== skillGoalId(g.id) ||
      output.plan.goal.title !== g.title ||
      output.plan.goal.target !== g.criterion ||
      output.plan.goal.minutes > g.minutes
    )
      throw new DomainError("技能规划必须对应当前目标和时间预算");
    const userStatements = [
      g.base,
      ...s.messages.filter((m) => m.role === "user").map((m) => m.content),
    ];
    const merged = applyTreePatch(
      s.personalTree ?? initialTree(),
      output.treePatch,
      output.plan,
      { requestId: job.id, userStatements },
    );
    s.personalTree = merged.tree;
    s.skillPlans ??= {};
    s.skillPlans[g.id] = { ...output.plan, updatedAt: now };
    result = { treeRevision: merged.tree.revision, goalId: g.id };
  } else if (job.kind === "route") {
    const g = findGoal(s, job.input.goalId);
    if (
      g.revision !== job.input.revision ||
      (g.routeJobId && g.routeJobId !== job.id) ||
      (job.input.stage !== undefined && job.input.stage !== g.stage) ||
      !["draft", "active", "paused"].includes(g.status)
    )
      throw new DomainError("计划已变化，本次生成结果不再适用");
    const route = output;
    if (route.minutes > (job.input.minutes ?? g.minutes))
      throw new DomainError("路线超过用户时间预算");
    if (
      route.stages.some(
        (st) =>
          st.actions.reduce((total, action) => total + action.minutes, 0) >
          route.minutes,
      )
    )
      throw new DomainError("阶段行动块超过用户时间预算");
    for (const st of route.stages)
      if (st.standardId) {
        const standard = standards.find(
          (v) => v.id === st.standardId && v.version === st.standardVersion,
        );
        if (!standard) throw new DomainError("引用了不存在的公共标准");
        st.criterion = standard.body.criteria;
      }
    const final = route.stages.at(-1);
    final.criterion =
      "目标完成条件：" + g.criterion + "\n阶段标准：" + final.criterion;
    g.draft = { id: job.id, route, stage: g.stage, createdAt: now };
    result = route;
  } else if (job.kind === "assessment") {
    const sub = find(s.submissions, job.input.submissionId),
      g = findGoal(s, sub.goal);
    if (
      sub.status !== "pending" ||
      (sub.assessmentJobId && sub.assessmentJobId !== job.id)
    )
      throw new DomainError("本次评估已结束或取消，结果不再适用");
    const a = output;
    if (a.quotes.some((q) => !sub.content.includes(q)))
      throw new DomainError("评价引用了成果中不存在的内容");
    if (
      a.outcome === "passed" &&
      (!a.quotes.length ||
        a.evidenceType !== "text" ||
        (sub.kind === "challenge" && sub.helpUsed))
    )
      a.outcome = "insufficient";
    if (
      a.standardId !== sub.criteria.standardId ||
      a.standardVersion !== sub.criteria.standardVersion
    )
      throw new DomainError("评价标准版本不一致");
    result = a;
    sub.assessment = a;
    sub.status = "evaluated";
    sub.evaluatedAt = now;
    if (
      a.outcome === "passed" &&
      sub.kind === "challenge" &&
      g.stage === sub.stage &&
      g.revision === sub.revision &&
      g.status === "active"
    ) {
      const standard = standards.find(
        (v) => v.id === a.standardId && v.version === a.standardVersion,
      );
      if (
        standard &&
        !s.achievements.some((v) => v.standardId === standard.id)
      ) {
        s.achievements.push({
          id: randomUUID(),
          standardId: standard.id,
          version: standard.version,
          submissionId: sub.id,
          at: now,
        });
      }
      if (g.stage < g.stages.length - 1) g.stage++;
      else g.status = g.requiresExternal ? "awaiting_external" : "completed";
    }
    note(s, "evidence", "成果反馈", a.feedback, now, {
      goal: g.id,
      submission: sub.id,
      outcome: a.outcome,
    });
  } else if (job.kind === "chat") {
    s.messages.push({
      id: randomUUID(),
      role: "assistant",
      content: output.reply,
      questions: output.questions ?? [],
      guidance: output.guidance,
      proposals: output.proposals ?? [],
      at: now,
    });
  } else if (job.kind === "review") {
    note(s, "review", "每日复盘", output.summary, now, { day: job.input.day });
  }
  return { state: s, rewards, result };
}

// Expiry is derived on reads and applied before each write, without a scheduler dependency.
export function expireState(state, now = new Date().toISOString()) {
  const s = structuredClone(state),
    day = new Intl.DateTimeFormat("en-CA", {
      timeZone: s.profile.timezone,
    }).format(new Date(now));
  for (const p of s.plans)
    if (p.day < day && ["planned", "paused"].includes(p.status))
      p.status = "expired";
  for (const e of s.events)
    if (
      (e.status === "offered" && e.claimBy <= now) ||
      (e.status === "claimed" && e.executeBy <= now)
    )
      e.status = "expired";
  return s;
}
