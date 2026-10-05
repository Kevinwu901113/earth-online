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
