import test from "node:test";
import assert from "node:assert/strict";
import { initialState, applyCommand, settleJob } from "../src/domain.js";
import { skillGoalId } from "../src/skill-tree/generation.js";
const create = {
  type: "goal.create",
  title: "英语交流",
  base: "我会简单英语",
  minutes: 20,
  criterion: "日常交流",
  requiresExternal: false,
};
const setup = () => {
  const r = applyCommand(initialState(), create);
  return applyCommand(r.state, {
    type: "skills.generate",
    id: r.result.goalId,
  });
};
function output(r) {
  const g = r.state.goals[0],
    id = "english";
  return {
    treePatch: {
      schemaVersion: "earth.tree.patch.v1",
      baseRevision: r.state.personalTree.revision,
      requestId: r.jobs[0].id,
      goalId: skillGoalId(g.id),
      addNodes: [
        {
          id,
          name: "英语",
          description: "长期英语能力",
          icon: "language",
          kind: "domain",
          parentId: "language",
          prerequisites: [],
          baseline: {
            status: "lit",
            basis: "self_report",
            quote: "我会简单英语",
          },
          stat: 0,
          milestone: null,
        },
      ],
      reuseNodeIds: [],
      updateNodes: [],
    },
    plan: {
      schemaVersion: "earth.plan.v3",
      goal: { title: g.title, target: g.criterion, minutes: g.minutes },
      summary: "练习日常交流",
      assumptions: [],
      targetSkillIds: [id],
      strategy: [
        {
          name: "练习",
          skillIds: [id],
          approach: "通过情境练习",
          timing: "今天",
        },
      ],
      resources: [],
      tasks: [
        {
          id: "practice",
          name: "口头介绍",
          skillIds: [id],
          minutes: 10,
          stat: 0,
          purpose: "练习表达",
          resourceIds: [],
          readiness: "ready",
          materialQuestion: null,
          actions: [
            {
              name: "介绍自己",
              minutes: 10,
              detail: "用英语说出姓名、职业与爱好，再重复一遍。",
            },
          ],
        },
      ],
    },
  };
}
test("production skill generation persists nodes and linked tasks without awarding XP", () => {
  const r = setup(),
    before = structuredClone(r.state),
    s = settleJob(r.state, r.jobs[0], output(r)).state;
  assert.equal(s.personalTree.revision, 1);
  assert.ok(s.skillPlans[s.goals[0].id]);
  assert.equal(s.levelXp, 0);
  assert.deepEqual(r.state, before);
});
test("deleted goals, superseded jobs and stale tree revisions cannot overwrite skills", () => {
  for (const change of ["deleted", "job", "tree"]) {
    const r = setup(),
      out = output(r);
    if (change === "deleted")
      r.state.goals[0].deletedAt = new Date().toISOString();
    if (change === "job") r.state.goals[0].skillJobId = "another";
    if (change === "tree") r.state.personalTree.revision++;
    assert.throws(() => settleJob(r.state, r.jobs[0], out));
  }
});
test("model cannot change goal identity or claim an invented baseline", () => {
  for (const change of ["goal", "quote", "budget"]) {
    const r = setup(),
      out = output(r);
    if (change === "goal") out.treePatch.goalId = "other";
    if (change === "quote")
      out.treePatch.addNodes[0].baseline.quote = "我精通英语";
    if (change === "budget") out.plan.goal.minutes = 200;
    assert.throws(() => settleJob(r.state, r.jobs[0], out));
  }
});
test("legacy player states gain a tree on first successful generation", () => {
  const r = setup(),
    out = output(r);
  delete r.state.personalTree;
  delete r.state.skillPlans;
  assert.equal(
    settleJob(r.state, r.jobs[0], out).state.personalTree.revision,
    1,
  );
});
test("confirming a route automatically queues a skill generation job", () => {
  const r = applyCommand(initialState(), create),
    out = {
      summary: "练习",
      minutes: 20,
      stat: 0,
      stages: [
        {
          name: "交流",
          criterion: "交流",
          exercise: "练习",
          steps: "开口",
          challenge: "交流",
          standardId: null,
          standardVersion: null,
        },
      ],
      sources: [],
    };
  const s = settleJob(r.state, r.jobs[0], out).state;
  const confirmed = applyCommand(s, {
    type: "goal.confirm",
    id: r.result.goalId,
    draftId: r.jobs[0].id,
  });
  assert.equal(confirmed.jobs[0].kind, "skills");
  assert.equal(confirmed.jobs[0].input.revision, 1);
});
