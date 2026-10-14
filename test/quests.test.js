import test from "node:test";
import assert from "node:assert/strict";
import { initialState, applyCommand, expireState } from "../src/domain.js";
import { commandSchema, envelopeSchema } from "../src/schemas.js";
import { deliverableSchema } from "../src/skill-tree/plan-v2.js";
import { tierOf } from "../src/quests.js";

const goalId = "9c6f9f51-ec3a-4bd0-8b0b-e9d25b842b34";
const NOW = "2026-10-14T04:00:00Z";
const DAY = "2026-10-14";
const task = (id, extra = {}) => ({
  id,
  name: "任务 " + id,
  skillIds: ["english_speaking"],
  minutes: 30,
  stat: 0,
  purpose: "目的",
  resourceIds: [],
  readiness: "ready",
  materialQuestion: null,
  actions: [
    { name: "第一步", minutes: 10, detail: "做第一步" },
    { name: "第二步", minutes: 20, detail: "做第二步" },
  ],
  ...extra,
});
function world(tasks, updatedAt = "2026-10-14T03:00:00Z") {
  const s = initialState();
  s.goals.push({
    id: goalId,
    title: "英语面试",
    status: "active",
    stage: 0,
    revision: 1,
    deletedAt: null,
  });
  s.skillPlans[goalId] = { tasks, updatedAt };
  return expireState(s, NOW);
}
const run = (s, cmd) => applyCommand(s, cmd, NOW);
const q = (s, taskId) => s.quests.find((x) => x.taskId === taskId);
const finish = (s, id) => {
  for (const o of s.quests.find((x) => x.id === id).objectives)
    s = run(s, {
      type: "quest.objective",
      id,
      objective: o.id,
      done: true,
    }).state;
  return s;
};

test("skill plan tasks become main quests that unlock one at a time", () => {
  const s = world([
    task("a", {
      deliverable: {
        type: "text",
        prompt: "贴提纲",
        name: "英文提纲",
        fields: [],
      },
    }),
    task("b"),
    task("c"),
  ]);
  assert.deepEqual(
    s.quests.map((x) => [x.taskId, x.status, x.delivery.type]),
    [
      ["a", "available", "text"],
      ["b", "locked", "checklist"],
      ["c", "locked", "checklist"],
    ],
  );
  assert.throws(
    () => run(s, { type: "quest.accept", id: q(s, "b").id }),
    /前一个任务/,
  );
  const accepted = run(s, { type: "quest.accept", id: q(s, "a").id }).state;
  assert.equal(q(accepted, "a").status, "accepted");
  assert.equal(
    accepted.trackedQuestId,
    q(s, "a").id,
    "first accept is tracked",
  );
  // Syncing again is idempotent.
  assert.deepEqual(expireState(accepted, NOW).quests, accepted.quests);
});

test("delivery requires every objective and the declared deliverable", () => {
  let s = world([
    task("a", {
      deliverable: {
        type: "text",
        prompt: "贴提纲",
        name: "英文提纲",
        fields: [],
      },
    }),
    task("b"),
  ]);
  const id = q(s, "a").id;
  const deliver = (extra = {}) => ({
    type: "quest.deliver",
    id,
    day: DAY,
    minutes: 30,
    note: "",
    ...extra,
  });
  assert.throws(() => run(s, deliver()), /请先接取/);
  s = run(s, { type: "quest.accept", id }).state;
  assert.throws(() => run(s, deliver({ content: "x" })), /还差 2 个目标项/);
  s = finish(s, id);
  assert.throws(() => run(s, deliver({ content: "   " })), /填写要交付的成果/);
  const out = run(
    s,
    deliver({ content: "Background: agent runtime", minutes: 90 }),
  );
  assert.equal(
    out.result.gain,
    12,
    "growth-v1 single-action cap still applies",
  );
  assert.equal(out.state.levelXp, 12);
  assert.equal(out.rewards.length, 1);
  assert.equal(out.rewards[0].kind, "effort");
  assert.equal(q(out.state, "a").status, "delivered");
  assert.equal(q(out.state, "b").status, "available", "next quest unlocks");
  assert.equal(out.result.unlocked, q(out.state, "b").id);
  assert.equal(out.state.trackedQuestId, null);
  const loot = out.state.loot.find((l) => l.id === out.result.lootId);
  assert.equal(loot.name, "英文提纲");
  assert.equal(loot.content, "Background: agent runtime");
  assert.deepEqual(out.state.skillProgress.english_speaking, {
    points: 90,
    minutes: 90,
    quests: 1,
  });
  const record = out.state.records.at(-1);
  assert.equal(record.questId, id);
  assert.equal(record.source, "任务交付");
  assert.throws(() => run(out.state, deliver({ content: "again" })), /已交付/);
  // The legacy shortcut cannot credit the same task a second time.
  assert.throws(
    () =>
      run(out.state, {
        type: "action.record",
        skillTaskId: "a",
        goal: goalId,
        plan: null,
        name: "任务 a",
        stat: 0,
        day: "2026-10-15",
        minutes: 10,
        note: "",
        completion: "done",
      }),
    /任务详情中交付/,
  );
});

test("log deliveries validate required and numeric fields and keep them as loot", () => {
  let s = world([
    task("base", {
      skillIds: ["strength"],
      deliverable: {
        type: "log",
        prompt: "记录基线",
        name: "基线记录",
        fields: [
          {
            key: "max_reps",
            label: "最多次数",
            kind: "number",
            unit: "个",
            required: true,
          },
          {
            key: "feel",
            label: "哪里吃力",
            kind: "text",
            unit: null,
            required: false,
          },
        ],
      },
    }),
  ]);
  const id = q(s, "base").id;
  s = finish(run(s, { type: "quest.accept", id }).state, id);
  const base = { type: "quest.deliver", id, day: DAY, minutes: 25, note: "" };
  assert.throws(() => run(s, base), /最多次数/);
  assert.throws(
    () => run(s, { ...base, fields: { max_reps: "很多" } }),
    /需要填写数字/,
  );
  const out = run(s, { ...base, fields: { max_reps: 6, feel: "" } }).state;
  assert.deepEqual(out.loot[0].fields, [
    { label: "最多次数", value: "6", unit: "个" },
  ]);
  assert.equal(tierOf(out.skillProgress.strength.points).label, "萌芽");
});

test("confirm quests deliver with one tap and store loot only when the user leaves a note", () => {
  let s = world([
    task("walk", {
      actions: [],
      deliverable: {
        type: "confirm",
        prompt: "走完就点完成",
        name: null,
        fields: [],
      },
    }),
  ]);
  const id = q(s, "walk").id;
  s = run(s, { type: "quest.accept", id }).state;
  const out = run(s, {
    type: "quest.deliver",
    id,
    day: DAY,
    minutes: 20,
    note: "",
  });
  assert.equal(out.result.gain, 4);
  assert.equal(out.result.lootId, null);
  assert.equal(out.state.loot.length, 0);
});

test("abandoning keeps objective progress, tracking follows accepted quests only", () => {
  let s = world([task("a"), task("b")]);
  const id = q(s, "a").id;
  s = run(s, { type: "quest.accept", id }).state;
  s = run(s, {
    type: "quest.objective",
    id,
    objective: "o0",
    done: true,
  }).state;
  s = run(s, { type: "quest.abandon", id }).state;
  assert.equal(q(s, "a").status, "available");
  assert.equal(q(s, "a").progress.o0, true);
  assert.equal(s.trackedQuestId, null);
  assert.throws(() => run(s, { type: "quest.track", id }), /请先接取/);
  assert.throws(
    () => run(s, { type: "quest.objective", id, objective: "o0", done: false }),
    /请先接取/,
  );
});

test("regenerated plans retire open quests but keep delivered history", () => {
  let s = world([task("a"), task("b")]);
  const a = q(s, "a").id;
  s = finish(run(s, { type: "quest.accept", id: a }).state, a);
  s = run(s, {
    type: "quest.deliver",
    id: a,
    day: DAY,
    minutes: 30,
    note: "",
  }).state;
  const oldB = q(s, "b").id;
  s.skillPlans[goalId] = {
    tasks: [task("x")],
    updatedAt: "2026-10-14T05:00:00Z",
  };
  s = expireState(s, "2026-10-14T05:01:00Z");
  assert.equal(s.quests.find((x) => x.id === a).status, "delivered");
  assert.equal(
    s.quests.find((x) => x.id === oldB),
    undefined,
  );
  assert.equal(q(s, "x").status, "available");
  assert.throws(
    () => run(s, { type: "quest.accept", id: oldB }),
    /新的规划替换/,
  );
});

test("legacy same-plan task records migrate as delivered quests", () => {
  const s = initialState();
  s.goals.push({
    id: goalId,
    status: "active",
    stage: 0,
    revision: 1,
    deletedAt: null,
  });
  s.skillPlans[goalId] = {
    tasks: [task("a"), task("b")],
    updatedAt: "2026-10-14T03:00:00Z",
  };
  s.records.push({
    id: "r1",
    goal: goalId,
    skillTaskId: "a",
    day: DAY,
    gain: 4,
    minutes: 20,
    createdAt: "2026-10-14T03:30:00Z",
  });
  const out = expireState(s, NOW);
  assert.equal(q(out, "a").status, "delivered");
  assert.equal(q(out, "a").recordId, "r1");
  assert.equal(q(out, "b").status, "available");
});

test("paused or deleted goals block quest actions and clear tracking", () => {
  let s = world([task("a")]);
  const id = q(s, "a").id;
  s = run(s, { type: "quest.accept", id }).state;
  s.goals[0].status = "paused";
  assert.throws(
    () => run(s, { type: "quest.objective", id, objective: "o0", done: true }),
    /启用或恢复/,
  );
  s.goals[0].status = "active";
  s.goals[0].deletedAt = NOW;
  assert.equal(expireState(s, NOW).trackedQuestId, null);
  assert.throws(() => run(s, { type: "quest.track", id }), /已删除/);
});

test("quest commands are user-only and never valid chat proposals", () => {
  const deliver = { type: "quest.deliver", id: "x:y:z", day: DAY, minutes: 10 };
  assert.equal(commandSchema.safeParse(deliver).success, false);
  assert.equal(
    envelopeSchema.safeParse({ expectedVersion: 1, command: deliver }).success,
    true,
  );
});

test("deliverables only allow text-submittable shapes", () => {
  assert.equal(
    deliverableSchema.safeParse({
      type: "audio",
      prompt: "录音",
      name: null,
      fields: [],
    }).success,
    false,
  );
  assert.equal(
    deliverableSchema.safeParse({
      type: "log",
      prompt: "记录",
      name: "记录",
      fields: [
        {
          key: "reps",
          label: "次数",
          kind: "number",
          unit: "个",
          required: true,
        },
      ],
    }).success,
    true,
  );
});

test("review regressions: no backdating, no legacy double credit, robust legacy matching", () => {
  let s = world([task("a"), task("b")]);
  const id = q(s, "a").id;
  s = finish(run(s, { type: "quest.accept", id }).state, id);
  assert.throws(
    () =>
      run(s, {
        type: "quest.deliver",
        id,
        day: "2026-10-13",
        minutes: 30,
        note: "",
      }),
    /今天/,
  );
  // A stale client recording the task before delivering cannot double-credit it.
  assert.throws(
    () =>
      run(s, {
        type: "action.record",
        skillTaskId: "a",
        goal: goalId,
        plan: null,
        name: "任务 a",
        stat: 0,
        day: DAY,
        minutes: 30,
        note: "",
        completion: "done",
      }),
    /任务详情中交付/,
  );
  const legacy = (extra) => {
    const st = initialState();
    st.goals.push({
      id: goalId,
      status: "active",
      stage: 0,
      revision: 1,
      deletedAt: null,
    });
    st.skillPlans[goalId] = { tasks: [task("t1")], ...extra.plan };
    st.records.push(...extra.records);
    return q(expireState(st, NOW), "t1").status;
  };
  const rec = (id, createdAt, completion = "done") => ({
    id,
    goal: goalId,
    skillTaskId: "t1",
    day: DAY,
    gain: 1,
    minutes: 5,
    completion,
    createdAt,
  });
  // An older record of a reused task id is skipped in favour of a newer valid one.
  assert.equal(
    legacy({
      plan: { updatedAt: "2026-10-14T03:00:00Z" },
      records: [
        rec("old", "2026-10-01T00:00:00Z"),
        rec("new", "2026-10-14T03:30:00Z"),
      ],
    }),
    "delivered",
  );
  assert.equal(
    legacy({
      plan: { updatedAt: "2026-10-14T03:00:00Z" },
      records: [rec("r", "2026-10-14T03:30:00Z", "rest")],
    }),
    "available",
  );
  assert.equal(
    legacy({ plan: {}, records: [rec("r", "2026-10-01T00:00:00Z")] }),
    "delivered",
  );
});
