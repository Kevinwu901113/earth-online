// Quest rules: pure functions shared by commands, reads and the UI contract.
// The model writes quest content (via skill plans); code owns status, unlocks,
// rewards and validation. Nothing here touches the database or a model.

export const DELIVERY_TYPES = Object.freeze([
  "confirm",
  "checklist",
  "text",
  "log",
]);

export const questRules = Object.freeze({
  version: "quest-v1",
  // Proficiency is effort credited to the skill nodes a quest trains.
  maxSkillPointsPerQuest: 120,
  tiers: Object.freeze([
    { min: 0, label: "未开始" },
    { min: 1, label: "萌芽" },
    { min: 120, label: "成长" },
    { min: 600, label: "熟练" },
    { min: 1800, label: "精通" },
  ]),
});

export const tierOf = (points = 0) =>
  [...questRules.tiers].reverse().find((t) => points >= t.min);

const planKeyOf = (plan) =>
  Number.isNaN(Date.parse(plan?.updatedAt))
    ? "p0"
    : Date.parse(plan.updatedAt).toString(36);

export const questIdOf = (goalId, plan, taskId) =>
  `${goalId}:${planKeyOf(plan)}:${taskId}`;

function deliveryOf(task) {
  const d = task.deliverable;
  if (!d) return { type: "checklist", prompt: null, name: null, fields: [] };
  return {
    type: d.type,
    prompt: d.prompt,
    name: d.name ?? null,
    fields: d.type === "log" ? (d.fields ?? []) : [],
  };
}

function questFromTask(goal, plan, task, order) {
  return {
    id: questIdOf(goal.id, plan, task.id),
    kind: "main",
    goal: goal.id,
    planKey: planKeyOf(plan),
    taskId: task.id,
    order,
    chapter: goal.stage ?? 0,
    title: task.name,
    purpose: task.purpose,
    minutes: task.minutes,
    stat: task.stat,
    skillIds: task.skillIds ?? [],
    resourceIds: task.resourceIds ?? [],
    readiness: task.readiness ?? "ready",
    materialQuestion: task.materialQuestion ?? null,
    objectives: (task.actions ?? []).map((a, i) => ({
      id: "o" + i,
      name: a.name,
      minutes: a.minutes,
      detail: a.detail ?? "",
    })),
    delivery: deliveryOf(task),
    status: "locked",
    progress: {},
    acceptedAt: null,
    deliveredAt: null,
    recordId: null,
    lootId: null,
  };
}

const OPEN = ["locked", "available", "accepted"];

// Brings state.quests in line with the current skill plans. Deterministic and
// idempotent, so it can run on every read and before every write.
export function syncQuests(s) {
  s.quests = (s.quests ?? []).filter((q) => q.status !== "retired");
  s.loot ??= [];
  s.skillProgress ??= {};
  if (s.trackedQuestId === undefined) s.trackedQuestId = null;
  for (const g of s.goals) {
    if (g.deletedAt) continue;
    const plan = s.skillPlans?.[g.id];
    if (!plan?.tasks?.length) continue;
    const key = planKeyOf(plan);
    // Unfinished quests of a superseded plan are dropped; delivered ones stay as history.
    s.quests = s.quests.filter(
      (q) => !(q.goal === g.id && q.planKey !== key && OPEN.includes(q.status)),
    );
    plan.tasks.forEach((t, i) => {
      const id = questIdOf(g.id, plan, t.id);
      if (s.quests.some((q) => q.id === id)) return;
      const q = questFromTask(g, plan, t, i);
      // Legacy completions of the same skill task count as delivered.
      // A plan without a timestamp predates quests, so any record of the task counts.
      const since = Date.parse(plan.updatedAt);
      const legacy = s.records.find(
        (r) =>
          r.goal === g.id &&
          r.skillTaskId === t.id &&
          !r.questId &&
          r.completion !== "rest" &&
          (Number.isNaN(since) || Date.parse(r.createdAt) >= since),
      );
      if (legacy) {
        q.status = "delivered";
        q.deliveredAt = legacy.createdAt;
        q.recordId = legacy.id;
        q.objectives.forEach((o) => (q.progress[o.id] = true));
      }
      s.quests.push(q);
    });
    // Main quests of a plan unlock in order: one frontier at a time.
    let frontier = true;
    for (const q of s.quests
      .filter((q) => q.goal === g.id && q.planKey === key)
      .sort((a, b) => a.order - b.order)) {
      if (q.status === "delivered") continue;
      if (frontier) {
        if (q.status === "locked") q.status = "available";
        frontier = false;
      } else if (q.status === "available") q.status = "locked";
    }
  }
  const tracked = s.quests.find((q) => q.id === s.trackedQuestId);
  if (
    !tracked ||
    tracked.status !== "accepted" ||
    s.goals.find((g) => g.id === tracked.goal)?.deletedAt
  )
    s.trackedQuestId = null;
  return s;
}

export const objectivesDone = (q) =>
  q.objectives.every((o) => q.progress?.[o.id]);

// Returns a user-facing reason the quest cannot be delivered, or null.
export function deliveryBlocker(q, payload) {
  if (!objectivesDone(q)) {
    const left = q.objectives.filter((o) => !q.progress?.[o.id]).length;
    return `还差 ${left} 个目标项`;
  }
  const d = q.delivery;
  if (d.type === "text" && !String(payload.content ?? "").trim())
    return "请先填写要交付的成果";
  if (d.type === "log")
    for (const f of d.fields) {
      const v = payload.fields?.[f.key];
      const empty = v === undefined || v === null || String(v).trim() === "";
      if (f.required && empty) return `请填写「${f.label}」`;
      if (!empty && f.kind === "number" && !Number.isFinite(Number(v)))
        return `「${f.label}」需要填写数字`;
    }
  return null;
}

export const skillPointsFor = (minutes) =>
  Math.max(0, Math.min(questRules.maxSkillPointsPerQuest, Math.floor(minutes)));

export function creditSkills(s, q, minutes) {
  const points = skillPointsFor(minutes);
  s.skillProgress ??= {};
  return q.skillIds.map((id) => {
    const p = (s.skillProgress[id] ??= { points: 0, minutes: 0, quests: 0 });
    p.points += points;
    p.minutes += minutes;
    p.quests += 1;
    return { id, points };
  });
}

// Fields a delivery stores as the quest's loot (the user's own output).
export function lootFrom(q, payload, now, id) {
  const d = q.delivery;
  const fields =
    d.type === "log"
      ? d.fields
          .filter((f) => String(payload.fields?.[f.key] ?? "").trim() !== "")
          .map((f) => ({
            label: f.label,
            value: String(payload.fields[f.key]).trim(),
            unit: f.unit ?? null,
          }))
      : [];
  const content = d.type === "text" ? String(payload.content).trim() : "";
  const note = String(payload.note ?? "").trim();
  if (!content && !fields.length && !note) return null;
  return {
    id,
    quest: q.id,
    goal: q.goal,
    name: d.name || q.title,
    type: d.type,
    content,
    fields,
    note,
    createdAt: now,
  };
}
