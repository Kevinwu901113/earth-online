import { randomUUID } from "node:crypto";
import { routeSchema, assessmentSchema } from "./schemas.js";
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
  levelXp: 0,
});
const find = (list, id) => {
  const x = list.find((i) => i.id === id);
  if (!x) throw new DomainError("记录不存在", 404);
  return x;
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
    case "goal.create": {
      const g = {
        id: randomUUID(),
        title: cmd.title,
        base: cmd.base,
        minutes: cmd.minutes,
        criterion: cmd.criterion,
        requiresExternal: cmd.requiresExternal,
        status: "draft",
        stage: 0,
        stages: [],
        revision: 0,
        routeHistory: [],
        draft: null,
        createdAt: now,
      };
      s.goals.push(g);
      result = {
        goalId: g.id,
        jobId: job("route", {
          goalId: g.id,
          revision: g.revision,
          reason: "首次规划",
        }),
      };
      break;
    }
    case "goal.confirm": {
      const g = find(s.goals, cmd.id);
      if (!g.draft || g.draft.id !== cmd.draftId)
        throw new DomainError("路线草案已变动，请刷新");
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
      note(s, "route", "路线已确认", route.summary, now, { goal: g.id });
      break;
    }
    case "goal.status": {
      const g = find(s.goals, cmd.id);
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
      const g = find(s.goals, cmd.id);
      if (!["draft", "active", "paused"].includes(g.status))
        throw new DomainError("目标已归档");
      result = {
        jobId: job("route", {
          goalId: g.id,
          revision: g.revision,
          reason: cmd.reason,
          minutes: cmd.minutes,
        }),
      };
      break;
    }
    case "plan.create": {
      const g = cmd.goal ? find(s.goals, cmd.goal) : null;
      if (g) active(g);
      if (
        cmd.day <
        new Intl.DateTimeFormat("en-CA", {
          timeZone: s.profile.timezone,
        }).format(new Date(now))
      )
        throw new DomainError("不能在过去安排新行动", 400);
      const start =
        Number(cmd.time.slice(0, 2)) * 60 + Number(cmd.time.slice(3));
      if (start + cmd.minutes > 1440)
        throw new DomainError("行动不能跨越当天，请分开安排", 400);
      if (
        s.plans.some(
          (p) =>
            p.day === cmd.day &&
            p.status === "planned" &&
            start < p.start + p.minutes &&
            start + cmd.minutes > p.start,
        )
      )
        throw new DomainError("该时段已有安排，请调整时间");
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
      if (cmd.status === "planned" && p.goal) active(find(s.goals, p.goal));
      p.status = cmd.status;
      break;
    }
    case "action.record": {
      const p = cmd.plan ? find(s.plans, cmd.plan) : null;
      const g = cmd.goal ? find(s.goals, cmd.goal) : null;
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
      const g = find(s.goals, cmd.goal);
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
      break;
    }
    case "submission.retry": {
      const sub = find(s.submissions, cmd.id);
      if (sub.status !== "error") throw new DomainError("仅失败的评估可重试");
      sub.status = "pending";
      result = { jobId: job("assessment", { submissionId: sub.id }) };
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
      const g = find(s.goals, cmd.id);
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
  let result = output;
  if (job.kind === "route") {
    const g = find(s.goals, job.input.goalId);
    if (
      g.revision !== job.input.revision ||
      !["draft", "active", "paused"].includes(g.status)
    )
      throw new DomainError("计划已变化，本次生成结果不再适用");
    const route = routeSchema.parse(output);
    if (route.minutes > (job.input.minutes ?? g.minutes))
      throw new DomainError("路线超过用户时间预算");
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
    g.draft = { id: job.id, route, createdAt: now };
    result = route;
  } else if (job.kind === "assessment") {
    const sub = find(s.submissions, job.input.submissionId),
      g = find(s.goals, sub.goal);
    const a = assessmentSchema.parse(output);
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
    if (
      typeof output.reply !== "string" ||
      !output.reply.trim() ||
      output.reply.length > 10000
    )
      throw new DomainError("管家回复格式无效");
    s.messages.push({
      id: randomUUID(),
      role: "assistant",
      content: output.reply,
      proposals: output.proposals ?? [],
      at: now,
    });
  } else if (job.kind === "review") {
    if (
      typeof output.summary !== "string" ||
      !output.summary.trim() ||
      output.summary.length > 6000
    )
      throw new DomainError("复盘格式无效");
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
