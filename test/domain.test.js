import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  initialState,
  applyCommand,
  settleJob,
  expireState,
} from "../src/domain.js";
import { commandSchema } from "../src/schemas.js";
const now = "2026-10-03T08:00:00.000Z";
const create = {
  type: "goal.create",
  title: "英文自我介绍",
  base: "初学者",
  minutes: 30,
  criterion: "写清背景、经历和目标",
  requiresExternal: false,
};
const stage = {
  name: "介绍",
  criterion: "有背景、经历和目标",
  exercise: "写一段介绍",
  steps: "先列出三个要点",
  challenge: "独立写完整段落",
  standardId: null,
  standardVersion: null,
};
const route = {
  summary: "先写再修改",
  minutes: 30,
  stat: 0,
  stages: [stage],
  sources: [],
};
function ready(extra = {}) {
  const r = applyCommand(initialState(), { ...create, ...extra }, now);
  const s = settleJob(r.state, r.jobs[0], route, [], now).state;
  return applyCommand(
    s,
    { type: "goal.confirm", id: r.result.goalId, draftId: r.jobs[0].id },
    now,
  ).state;
}
function submit(s, options = {}) {
  return applyCommand(
    s,
    {
      type: "submission.create",
      goal: s.goals[0].id,
      kind: "challenge",
      content: "I study design. I built a chair. I want to learn more.",
      helpUsed: false,
      ...options,
    },
    now,
  );
}
const assess = {
  outcome: "passed",
  feedback: "包含三个要点",
  quotes: ["I study design."],
  evidenceType: "text",
  standardId: null,
  standardVersion: null,
};
test("route requires explicit confirmation; stale draft cannot replace active route", () => {
  const r = applyCommand(initialState(), create, now);
  assert.equal(r.state.goals[0].status, "draft");
  const s = settleJob(r.state, r.jobs[0], route, [], now).state;
  assert.equal(s.goals[0].status, "draft");
  assert.throws(() =>
    applyCommand(
      s,
      { type: "goal.confirm", id: r.result.goalId, draftId: randomUUID() },
      now,
    ),
  );
  const active = ready();
  assert.equal(active.goals[0].status, "active");
  assert.throws(() =>
    settleJob(
      { ...active, goals: [{ ...active.goals[0], id: r.result.goalId }] },
      r.jobs[0],
      route,
    ),
  );
});
test("practice, assisted challenges and unverified media never prove stage completion", () => {
  for (const opts of [{ kind: "practice" }, { helpUsed: true }]) {
    const r = submit(ready(), opts);
    const s = settleJob(r.state, r.jobs[0], assess, [], now).state;
    assert.equal(s.goals[0].status, "active");
  }
  const r = submit(ready());
  assert.equal(
    settleJob(
      r.state,
      r.jobs[0],
      { ...assess, evidenceType: "external_unverified" },
      [],
      now,
    ).state.goals[0].status,
    "active",
  );
  assert.throws(() =>
    settleJob(
      r.state,
      r.jobs[0],
      { ...assess, quotes: ["invented text"] },
      [],
      now,
    ),
  );
});
test("independent text challenge completes only personal goal, external outcomes remain pending", () => {
  for (const external of [true, false]) {
    const r = submit(ready({ requiresExternal: external }));
    const s = settleJob(r.state, r.jobs[0], assess, [], now).state;
    assert.equal(
      s.goals[0].status,
      external ? "awaiting_external" : "completed",
    );
    assert.equal(s.achievements.length, 0);
  }
});
test("completed goals can be deleted and restored without losing earned XP or evidence", () => {
  let state = ready();
  const goal = state.goals[0];
  const planned = applyCommand(
    state,
    {
      type: "plan.create",
      goal: goal.id,
      name: "写介绍",
      minutes: 20,
      day: "2026-10-03",
      time: "09:00",
      stat: 0,
    },
    now,
  );
  const recorded = applyCommand(
    planned.state,
    {
      type: "action.record",
      plan: planned.result.planId,
      goal: goal.id,
      name: "写介绍",
      minutes: 20,
      day: "2026-10-03",
      stat: 0,
      note: "写好了介绍",
      completion: "done",
    },
    now,
  );
  state = applyCommand(
    recorded.state,
    {
      type: "plan.create",
      goal: goal.id,
      name: "修改介绍",
      minutes: 10,
      day: "2026-10-03",
      time: "19:00",
      stat: 0,
    },
    now,
  ).state;
  state = applyCommand(
    state,
    {
      type: "plan.create",
      goal: null,
      name: "散步",
      minutes: 20,
      day: "2026-10-03",
      time: "20:00",
      stat: 1,
    },
    now,
  ).state;
  const submitted = submit(state);
  state = settleJob(submitted.state, submitted.jobs[0], assess, [], now).state;
  assert.equal(state.goals[0].status, "completed");
  const deleted = applyCommand(
    state,
    commandSchema.parse({ type: "goal.delete", id: goal.id }),
    now,
  );
  assert.equal(deleted.state.goals[0].deletedAt, now);
  assert.equal(deleted.state.goals[0].status, "completed");
  assert.equal(deleted.state.goals[0].revision, state.goals[0].revision);
  assert.deepEqual(deleted.state.goals[0].stages, state.goals[0].stages);
  assert.deepEqual(deleted.state.records, state.records);
  assert.deepEqual(deleted.state.submissions, state.submissions);
  assert.deepEqual(deleted.state.achievements, state.achievements);
  assert.equal(deleted.state.levelXp, 4);
  assert.deepEqual(deleted.rewards, []);
  assert.deepEqual(
    deleted.state.plans.map((p) => p.status),
    ["done", "cancelled", "planned"],
  );
  assert.equal(deleted.state.plans[1].cancelReason, "goal_deleted");
  const restored = applyCommand(
    deleted.state,
    commandSchema.parse({ type: "goal.restore", id: goal.id }),
    now,
  );
  assert.equal(restored.state.goals[0].deletedAt, null);
  assert.equal(restored.state.goals[0].status, "completed");
  assert.equal(restored.state.levelXp, 4);
  assert.equal(restored.state.plans[1].status, "cancelled");
  assert.throws(
    () =>
      applyCommand(restored.state, { type: "goal.restore", id: goal.id }, now),
    /没有被删除/,
  );
  assert.throws(
    () =>
      applyCommand(deleted.state, { type: "goal.delete", id: goal.id }, now),
    /已删除列表/,
  );
  assert.throws(
    () => applyCommand(state, { type: "goal.delete", id: randomUUID() }, now),
    /不存在/,
  );
});
test("deletion stops pending routes and assessments, including late results after restoration", () => {
  const created = applyCommand(initialState(), create, now);
  let deleted = applyCommand(
    created.state,
    { type: "goal.delete", id: created.result.goalId },
    now,
  );
  assert.throws(
    () => settleJob(deleted.state, created.jobs[0], route, [], now),
    /任务已删除/,
  );
  const restored = applyCommand(
    deleted.state,
    { type: "goal.restore", id: created.result.goalId },
    now,
  );
  assert.throws(
    () => settleJob(restored.state, created.jobs[0], route, [], now),
    /不再适用/,
  );
  const submitted = submit(ready());
  const id = submitted.state.goals[0].id;
  deleted = applyCommand(submitted.state, { type: "goal.delete", id }, now);
  assert.equal(deleted.state.submissions[0].status, "error");
  assert.throws(
    () => settleJob(deleted.state, submitted.jobs[0], assess, [], now),
    /任务已删除/,
  );
  assert.throws(
    () =>
      applyCommand(
        deleted.state,
        { type: "submission.retry", id: submitted.result.submissionId },
        now,
      ),
    /任务已删除/,
  );
  const activeAgain = applyCommand(
    deleted.state,
    { type: "goal.restore", id },
    now,
  );
  const retried = applyCommand(
    activeAgain.state,
    { type: "submission.retry", id: submitted.result.submissionId },
    now,
  );
  assert.throws(
    () => settleJob(retried.state, submitted.jobs[0], assess, [], now),
    /不再适用/,
  );
  const result = settleJob(retried.state, retried.jobs[0], assess, [], now);
  assert.equal(result.state.goals[0].status, "completed");
});
test("deleted goals reject changes and cannot receive new actions or route confirmations", () => {
  const state = ready(),
    goal = state.goals[0];
  const deleted = applyCommand(
    state,
    { type: "goal.delete", id: goal.id },
    now,
  );
  for (const command of [
    { type: "goal.confirm", id: goal.id, draftId: randomUUID() },
    { type: "goal.status", id: goal.id, status: "active" },
    { type: "goal.adjust", id: goal.id, reason: "重新规划", minutes: 30 },
    { type: "goal.external", id: goal.id, content: "提供证据" },
    {
      type: "plan.create",
      goal: goal.id,
      name: "写介绍",
      minutes: 20,
      day: "2026-10-03",
      time: "19:00",
      stat: 0,
    },
    {
      type: "plan.batch",
      goal: goal.id,
      stage: goal.stage,
      revision: goal.revision,
      day: "2026-10-03",
      time: "19:00",
      blocks: [{ name: "写介绍", minutes: 20 }],
    },
    {
      type: "action.record",
      plan: null,
      goal: goal.id,
      name: "写介绍",
      minutes: 20,
      day: "2026-10-03",
      stat: 0,
      note: "写好了",
      completion: "done",
    },
    {
      type: "submission.create",
      goal: goal.id,
      kind: "challenge",
      content: "I study design.",
      helpUsed: false,
    },
  ])
    assert.throws(
      () => applyCommand(deleted.state, command, now),
      /任务已删除/,
    );
  for (const status of [
    "draft",
    "active",
    "paused",
    "ended",
    "awaiting_external",
  ]) {
    const other = structuredClone(state);
    other.goals[0].status = status;
    assert.equal(
      applyCommand(other, { type: "goal.delete", id: goal.id }, now).state
        .goals[0].status,
      status,
    );
  }
});
test("visual chat guidance is persisted as advice without scheduling actions or changing XP", () => {
  const state = ready();
  const guidance = {
    title: "今天先做这两件事",
    summary: "先列要点，再完成介绍。",
    steps: [
      { title: "列出三个要点", minutes: 10, kind: "main" },
      {
        title: "写完整介绍",
        minutes: 20,
        kind: "main",
        detail: "每个要点写一句话。",
      },
    ],
  };
  const result = settleJob(
    state,
    { id: randomUUID(), kind: "chat", input: {} },
    { reply: "可以从这两件小事开始。", guidance, proposals: [] },
    [],
    now,
  );
  assert.deepEqual(result.state.messages.at(-1).guidance, guidance);
  assert.deepEqual(result.state.messages.at(-1).proposals, []);
  assert.deepEqual(result.state.goals, state.goals);
  assert.equal(result.state.plans.length, 0);
  assert.equal(result.state.levelXp, 0);
  const old = settleJob(
    state,
    { id: randomUUID(), kind: "chat", input: {} },
    { reply: "你好。", proposals: [] },
    [],
    now,
  );
  assert.equal(old.state.messages.at(-1).guidance, null);
});
test("adjustments preserve completed prefix and fixed public criteria", () => {
  const r = applyCommand(initialState(), create, now),
    pub = { id: "write-intro", version: 1, body: { criteria: "固定标准" } };
  let s = settleJob(
    r.state,
    r.jobs[0],
    {
      ...route,
      stages: [
        {
          ...stage,
          criterion: "不能覆盖",
          standardId: pub.id,
          standardVersion: 1,
        },
        stage,
      ],
    },
    [pub],
    now,
  ).state;
  assert.equal(s.goals[0].draft.route.stages[0].criterion, "固定标准");
  s = applyCommand(
    s,
    { type: "goal.confirm", id: r.result.goalId, draftId: r.jobs[0].id },
    now,
  ).state;
  s.goals[0].stage = 1;
  const adjust = applyCommand(
    s,
    {
      type: "goal.adjust",
      id: r.result.goalId,
      reason: "时间变化",
      minutes: 20,
    },
    now,
  );
  s = settleJob(
    adjust.state,
    adjust.jobs[0],
    { ...route, minutes: 20 },
    [pub],
    now,
  ).state;
  s = applyCommand(
    s,
    { type: "goal.confirm", id: r.result.goalId, draftId: adjust.jobs[0].id },
    now,
  ).state;
  assert.equal(s.goals[0].stages[0].criterion, "固定标准");
  assert.equal(s.goals[0].stage, 1);
  assert.equal(s.goals[0].routeHistory.length, 1);
});
test("only the latest route request at the same stage may produce a confirmable draft", () => {
  const first = applyCommand(initialState(), create, now);
  const second = applyCommand(
    first.state,
    {
      type: "goal.adjust",
      id: first.result.goalId,
      reason: "再次规划",
      minutes: 30,
    },
    now,
  );
  assert.throws(
    () => settleJob(second.state, first.jobs[0], route, [], now),
    /不再适用/,
  );
  const done = settleJob(second.state, second.jobs[0], route, [], now);
  const moved = structuredClone(done.state);
  moved.goals[0].stage++;
  assert.throws(
    () =>
      applyCommand(
        moved,
        {
          type: "goal.confirm",
          id: first.result.goalId,
          draftId: second.jobs[0].id,
        },
        now,
      ),
    /阶段已变化/,
  );
  assert.throws(
    () => settleJob(moved, second.jobs[0], route, [], now),
    /不再适用/,
  );
});
test("daily XP cap and no rest penalty; a scheduled action cannot reward twice", () => {
  let s = initialState();
  const cmd = {
    type: "action.record",
    plan: null,
    goal: null,
    name: "阅读",
    day: "2026-10-03",
    minutes: 60,
    stat: 0,
    note: "读了一章",
    completion: "done",
  };
  for (let i = 0; i < 6; i++) s = applyCommand(s, cmd, now).state;
  assert.equal(s.levelXp, 40);
  const rest = applyCommand(s, { ...cmd, completion: "rest" }, now);
  assert.equal(rest.result.gain, 0);
  const p = applyCommand(
    initialState(),
    {
      type: "plan.create",
      goal: null,
      name: "阅读",
      minutes: 20,
      day: cmd.day,
      time: "19:00",
      stat: 0,
    },
    now,
  );
  const one = applyCommand(p.state, { ...cmd, plan: p.result.planId }, now);
  assert.throws(() =>
    applyCommand(one.state, { ...cmd, plan: p.result.planId }, now),
  );
});
test("overlap is rejected on scheduling and resume; expiry follows user timezone", () => {
  let p = applyCommand(
    initialState(),
    {
      type: "plan.create",
      goal: null,
      name: "A",
      minutes: 30,
      day: "2026-10-03",
      time: "19:00",
      stat: 0,
    },
    now,
  );
  assert.throws(() =>
    applyCommand(
      p.state,
      {
        type: "plan.create",
        goal: null,
        name: "B",
        minutes: 30,
        day: "2026-10-03",
        time: "19:15",
        stat: 0,
      },
      now,
    ),
  );
  let s = applyCommand(
    p.state,
    { type: "plan.status", id: p.result.planId, status: "paused" },
    now,
  ).state;
  s = applyCommand(
    s,
    {
      type: "plan.create",
      goal: null,
      name: "B",
      minutes: 30,
      day: "2026-10-03",
      time: "19:15",
      stat: 0,
    },
    now,
  ).state;
  assert.throws(() =>
    applyCommand(
      s,
      { type: "plan.status", id: p.result.planId, status: "planned" },
      now,
    ),
  );
  assert.equal(
    expireState(s, "2026-10-03T16:01:00.000Z").plans[0].status,
    "expired",
  );
});
test("main and side quests keep concrete AI actions and reject stage budgets above the route", () => {
  assert.equal(commandSchema.parse(create).kind, "main");
  const created = applyCommand(
    initialState(),
    { ...create, kind: "side" },
    now,
  );
  const blocks = [
    { name: "列三个要点", minutes: 10 },
    { name: "写完整介绍", minutes: 20 },
  ];
  const settled = settleJob(
    created.state,
    created.jobs[0],
    {
      ...route,
      stages: [{ ...stage, actions: blocks }],
    },
    [],
    now,
  );
  const confirmed = applyCommand(
    settled.state,
    {
      type: "goal.confirm",
      id: created.result.goalId,
      draftId: created.jobs[0].id,
    },
    now,
  );
  assert.equal(confirmed.state.goals[0].kind, "side");
  assert.deepEqual(confirmed.state.goals[0].stages[0].actions, blocks);
  assert.throws(
    () =>
      settleJob(
        created.state,
        created.jobs[0],
        {
          ...route,
          stages: [
            {
              ...stage,
              actions: [
                { name: "阅读", minutes: 20 },
                { name: "写作", minutes: 20 },
              ],
            },
          ],
        },
        [],
        now,
      ),
    /超过用户时间预算/,
  );
  assert.equal(created.state.goals[0].draft, null);
});
test("time block edits ignore their own interval, reject conflicts and preserve evidence and XP", () => {
  const state = ready();
  const first = applyCommand(
    state,
    {
      type: "plan.create",
      goal: state.goals[0].id,
      name: "写介绍",
      minutes: 20,
      day: "2026-10-03",
      time: "19:00",
      stat: 0,
    },
    now,
  );
  const second = applyCommand(
    first.state,
    {
      type: "plan.create",
      goal: null,
      name: "散步",
      minutes: 30,
      day: "2026-10-03",
      time: "19:45",
      stat: 1,
    },
    now,
  );
  const update = {
    type: "plan.update",
    id: first.result.planId,
    name: "列要点并写介绍",
    minutes: 40,
    day: "2026-10-03",
    time: "19:00",
  };
  const changed = applyCommand(second.state, commandSchema.parse(update), now);
  const before = second.state.plans[0],
    after = changed.state.plans[0];
  assert.equal(after.minutes, 40);
  assert.equal(after.name, update.name);
  for (const field of [
    "id",
    "goal",
    "stat",
    "stage",
    "revision",
    "status",
    "createdAt",
  ])
    assert.equal(after[field], before[field]);
  assert.equal(changed.state.levelXp, 0);
  assert.deepEqual(changed.rewards, []);
  assert.deepEqual(changed.state.goals, second.state.goals);
  assert.throws(
    () => applyCommand(changed.state, { ...update, minutes: 50 }, now),
    /已有安排/,
  );
  assert.equal(changed.state.plans[0].minutes, 40);
  const moved = applyCommand(
    changed.state,
    { ...update, day: "2026-10-04", time: "08:30" },
    now,
  );
  assert.equal(moved.state.plans[0].start, 510);
  assert.equal(moved.state.plans[0].day, "2026-10-04");
  assert.throws(
    () => applyCommand(changed.state, { ...update, time: "23:40" }, now),
    /不能跨越/,
  );
  assert.throws(
    () => applyCommand(changed.state, { ...update, day: "2026-10-02" }, now),
    /过去/,
  );
  assert.throws(
    () => applyCommand(changed.state, { ...update, id: randomUUID() }, now),
    /不存在/,
  );
  const stale = structuredClone(changed.state);
  stale.goals[0].revision++;
  assert.throws(() => applyCommand(stale, update, now), /路线已变化/);
  const cancelled = applyCommand(
    changed.state,
    { type: "plan.status", id: update.id, status: "cancelled" },
    now,
  );
  assert.throws(() => applyCommand(cancelled.state, update, now), /行动已结束/);
});
test("batch scheduling is atomic, consecutive and bound to the confirmed current stage", () => {
  const state = ready(),
    goal = state.goals[0];
  const cmd = {
    type: "plan.batch",
    goal: goal.id,
    stage: goal.stage,
    revision: goal.revision,
    day: "2026-10-03",
    time: "19:00",
    blocks: [
      { name: "列要点", minutes: 10 },
      { name: "写介绍", minutes: 20 },
    ],
  };
  const result = applyCommand(state, commandSchema.parse(cmd), now);
  assert.equal(result.result.planIds.length, 2);
  assert.deepEqual(
    result.state.plans.map((p) => [p.time, p.start, p.minutes]),
    [
      ["19:00", 1140, 10],
      ["19:10", 1150, 20],
    ],
  );
  assert.ok(
    result.state.plans.every(
      (p) =>
        p.goal === goal.id &&
        p.revision === goal.revision &&
        p.stage === goal.stage &&
        p.stat === goal.stat,
    ),
  );
  assert.equal(result.state.levelXp, 0);
  assert.deepEqual(result.rewards, []);
  assert.throws(
    () => applyCommand(state, { ...cmd, revision: goal.revision + 1 }, now),
    /路线已变化/,
  );
  assert.throws(
    () => applyCommand(state, { ...cmd, stage: goal.stage + 1 }, now),
    /路线已变化/,
  );
  assert.throws(
    () => applyCommand(state, { ...cmd, time: "23:45" }, now),
    /不能跨越/,
  );
  assert.equal(state.plans.length, 0);
  const busy = applyCommand(
    state,
    {
      type: "plan.create",
      goal: null,
      name: "晚餐",
      minutes: 10,
      day: cmd.day,
      time: "19:20",
      stat: 0,
    },
    now,
  );
  assert.throws(() => applyCommand(busy.state, cmd, now), /已有安排/);
  assert.equal(busy.state.plans.length, 1);
  assert.equal(commandSchema.safeParse({ ...cmd, blocks: [] }).success, false);
  assert.equal(
    commandSchema.safeParse({ ...cmd, blocks: [{ name: "学习", minutes: 0 }] })
      .success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({ ...cmd, time: "24:00" }).success,
    false,
  );
  const draft = applyCommand(initialState(), create, now);
  assert.throws(
    () =>
      applyCommand(
        draft.state,
        { ...cmd, goal: draft.result.goalId, revision: 0 },
        now,
      ),
    /请先启用/,
  );
});
test("events deduplicate and enforce both deadlines without rewarding the same activity", () => {
  const c = {
    type: "event.create",
    externalId: "calendar-1",
    content: "参加分享会",
    kind: "opportunity",
    occurredAt: now,
    claimBy: "2026-10-03T09:00:00.000Z",
    executeBy: "2026-10-03T10:00:00.000Z",
  };
  let r = applyCommand(initialState(), c, now);
  assert.throws(() => applyCommand(r.state, c, now));
  assert.throws(() =>
    applyCommand(
      r.state,
      { type: "event.claim", id: r.result.eventId },
      c.claimBy,
    ),
  );
  let s = applyCommand(
    r.state,
    { type: "event.claim", id: r.result.eventId },
    now,
  ).state;
  assert.throws(() =>
    applyCommand(
      s,
      { type: "event.complete", id: r.result.eventId, note: "去过" },
      c.executeBy,
    ),
  );
  const done = applyCommand(
    s,
    { type: "event.complete", id: r.result.eventId, note: "去了分享会" },
    now,
  );
  assert.equal(done.state.events[0].status, "completed");
  assert.equal(done.rewards.length, 0);
});
test("invalid dates and unbounded values are rejected at input boundary", () => {
  assert.equal(
    commandSchema.safeParse({ type: "review.create", day: "2026-02-31" })
      .success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({ ...create, minutes: 9999 }).success,
    false,
  );
});
test("objective practice uses operator-reviewed answer, never model score or XP", () => {
  const standard = {
    id: "intro",
    version: 1,
    body: {
      questions: [
        {
          id: "q1",
          prompt: "Choose",
          choices: [{ id: "a" }, { id: "b" }],
          correctChoice: "b",
          explanation: "Reason",
        },
      ],
    },
  };
  const cmd = {
    type: "practice.grade",
    standardId: "intro",
    standardVersion: 1,
    questionId: "q1",
    choiceId: "a",
  };
  const wrong = applyCommand(initialState(), cmd, now, [standard]);
  assert.equal(wrong.result.correct, false);
  assert.equal(wrong.rewards.length, 0);
  const right = applyCommand(initialState(), { ...cmd, choiceId: "b" }, now, [
    standard,
  ]);
  assert.equal(right.result.correct, true);
  assert.equal(right.state.achievements.length, 0);
  assert.throws(() =>
    applyCommand(initialState(), { ...cmd, standardVersion: 2 }, now, [
      standard,
    ]),
  );
});
