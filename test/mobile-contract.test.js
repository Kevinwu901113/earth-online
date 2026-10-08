import test from "node:test";
import assert from "node:assert/strict";
import { initialState, applyCommand, settleJob } from "../src/domain.js";
import { validateOutput } from "../src/agent-output.js";
test("clarification questions are bounded, stored and never execute proposals", () => {
  const s = initialState();
  const result = applyCommand(s, { type: "chat.send", content: "想买车" });
  const out = validateOutput("chat", {
    reply: "先确认方向。",
    questions: [
      { question: "已有心仪车型吗？", options: ["有大致方向", "尚未确定"] },
    ],
    proposals: [],
  });
  const settled = settleJob(result.state, result.jobs[0], out).state;
  assert.equal(settled.messages.at(-1).questions[0].options.length, 2);
  assert.equal(settled.goals.length, 0);
  assert.throws(() =>
    validateOutput("chat", {
      ...out,
      questions: [{ question: "问题", options: ["只有一个"] }],
    }),
  );
});
test("generated task records validate identity and reject same-day duplicate XP", () => {
  const s = initialState(),
    id = "9c6f9f51-ec3a-4bd0-8b0b-e9d25b842b34";
  s.goals.push({ id, status: "active", deletedAt: null });
  s.skillPlans[id] = { tasks: [{ id: "practice", name: "跟读", stat: 0 }] };
  const cmd = {
    type: "action.record",
    skillTaskId: "practice",
    goal: id,
    plan: null,
    name: "跟读",
    stat: 0,
    day: "2026-10-08",
    minutes: 20,
    note: "",
    completion: "done",
  };
  const first = applyCommand(s, cmd, "2026-10-08T12:00:00Z");
  assert.equal(first.state.levelXp, 4);
  assert.throws(
    () => applyCommand(first.state, cmd, "2026-10-08T12:00:00Z"),
    /已经记录/,
  );
  assert.throws(
    () => applyCommand(s, { ...cmd, name: "伪造任务" }, "2026-10-08T12:00:00Z"),
    /任务已变化/,
  );
  assert.throws(
    () =>
      applyCommand(
        s,
        { ...cmd, skillTaskId: "missing" },
        "2026-10-08T12:00:00Z",
      ),
    /任务已变化/,
  );
});
