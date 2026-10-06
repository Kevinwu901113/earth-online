import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Repository } from "../src/repository.js";
import { initialState } from "../src/domain.js";

test("deleted goals are excluded from fresh and cached model context and cannot be planned or assessed", async () => {
  const deletedId = randomUUID(),
    activeId = randomUUID(),
    submissionId = randomUUID();
  const state = initialState();
  state.goals = [
    {
      id: deletedId,
      title: "已删除任务",
      status: "completed",
      deletedAt: "2026-10-06T00:00:00.000Z",
      draft: null,
    },
    { id: activeId, title: "继续阅读", status: "active", draft: null },
  ];
  state.submissions = [
    {
      id: submissionId,
      goal: deletedId,
      status: "error",
      content: "历史成果证据",
      criteria: {},
    },
  ];
  const values = new Map();
  const repo = new Repository(null, {
    get: async (key) => values.get(key),
    set: async (key, value) => values.set(key, value),
  });
  repo.state = async () => ({ state, version: 2 });
  const uid = randomUUID();
  for (let pass = 0; pass < 2; pass++) {
    const context = await repo.context(uid);
    assert.deepEqual(
      context.goals.map((g) => g.id),
      [activeId],
    );
    assert.equal(context.goals[0].kind, "main");
  }
  await assert.rejects(
    () => repo.context(uid, { kind: "route", input: { goalId: deletedId } }),
    /任务已删除/,
  );
  await assert.rejects(
    () => repo.context(uid, { kind: "assessment", input: { submissionId } }),
    /任务已删除/,
  );
  assert.deepEqual(
    (
      await repo.context(uid, { kind: "route", input: { goalId: activeId } })
    ).goals.map((g) => g.id),
    [activeId],
  );
  assert.equal(state.submissions[0].content, "历史成果证据");
});
