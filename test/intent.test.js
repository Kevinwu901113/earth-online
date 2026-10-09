import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeIntent,
  extractTimeBudget,
  validateIntentOutput,
} from "../src/intent.js";
import { planningQuery } from "../src/planning-context.js";
import { initialTree } from "../src/skill-tree/tree-patch.js";
import { skillFixture } from "./skill-fixture.js";

const goals = [
  { id: "english", title: "英语阅读", minutes: 30 },
  { id: "python", title: "Python 入门", minutes: 60 },
];
const job = { kind: "chat", input: { messageId: "now" } };
const context = (text, history = []) => ({
  goals,
  plans: [],
  messages: [
    ...history.map((content, i) => ({ id: `m${i}`, role: "user", content })),
    { id: "now", role: "user", content: text },
  ],
});
const intent = (text, history) => analyzeIntent(job, context(text, history));
const guidance = (minutes = 30) => ({
  title: "今晚行动",
  summary: "按预算练习",
  steps: [{ title: "阅读短文", minutes, kind: "main" }],
});

test("greetings, explanations and quoted commands are not planning or deletion requests", () => {
  assert.equal(intent("你好").kind, "greeting");
  assert.equal(intent("间隔复习是什么，为什么有效？").shouldRetrieve, false);
  assert.equal(
    intent("解释示例“删除英语阅读目标”是什么意思").requestedActions.length,
    0,
  );
  assert.equal(intent("你好，请帮我安排今晚的任务").kind, "planning");
});
test("negation is local to the requested action, and does not hide another positive request", () => {
  const value = intent("不要删除英语阅读目标，帮我制定今晚计划");
  assert.ok(value.blockedActions.includes("delete_goal"));
  assert.ok(value.requestedActions.includes("plan"));
  assert.equal(value.targetGoalId, "english");
  assert.equal(intent("先不要安排任务，请解释学习方法").shouldRetrieve, false);
});
test("ambiguous deletion asks for the target instead of guessing a goal ID", () => {
  assert.equal(intent("删除这个目标").requiresClarification, true);
  assert.equal(intent("删除英语阅读目标").targetGoalId, "english");
  assert.equal(
    intent("删除英语阅读和Python 入门目标").requiresClarification,
    true,
  );
});
test("schedule references are scoped to current event names, and repeated names remain ambiguous", () => {
  const ctx = context("把阅读短文任务缩短到10分钟");
  ctx.plans = [{ id: "p1", name: "阅读短文", status: "planned" }];
  assert.equal(analyzeIntent(job, ctx).targetPlanId, "p1");
  ctx.plans.push({ id: "p2", name: "阅读短文", status: "planned" });
  assert.equal(analyzeIntent(job, ctx).requiresClarification, true);
});
test("time budgets preserve complete numbers, corrections and Chinese hour forms", () => {
  for (const [text, value] of [
    ["每天只有30分钟", 30],
    ["这次不是30分钟，而是45分钟", 45],
    ["每天半小时", 30],
    ["每天一个半小时", 90],
    ["每天四十五分钟", 45],
    ["I have 45 minutes", 45],
    ["给我30分钟的计划", 30],
    ["我今晚读10分钟，再做5分钟回忆练习", null],
  ])
    assert.equal(extractTimeBudget(text), value, text);
});
test("follow-up planning uses earlier objective and latest time budget; a new goal resets the old budget", () => {
  const ctx = context("我现在只有20分钟，继续安排今晚", [
    "我想学Python，刚能运行代码",
    "每天有60分钟",
  ]);
  assert.equal(analyzeIntent(job, ctx).timeBudget, 20);
  assert.match(planningQuery(job, ctx), /Python/);
  assert.equal(
    intent("我还想学画画", ["我想学Python，每天60分钟"]).timeBudget,
    null,
  );
  assert.equal(planningQuery(job, context("你好", ["我想学英语"])), "");
});
test("retry resolves the original user intent instead of retrieving the word retry", () => {
  const ctx = context("重试", ["请帮我制定Python 入门计划，今天30分钟"]);
  assert.equal(analyzeIntent(job, ctx).kind, "planning");
  assert.match(planningQuery(job, ctx), /Python/);
  assert.doesNotMatch(planningQuery(job, ctx), /^重试/);
});
test("explicit planning requires action blocks or genuine clarification and respects the shared budget", () => {
  const ctx = context("请安排今晚30分钟的计划");
  assert.throws(
    () =>
      validateIntentOutput(
        { reply: "一大段文字", guidance: null, proposals: [] },
        { job, context: ctx },
      ),
    (e) => e.failure.code === "intent_mismatch",
  );
  assert.doesNotThrow(() =>
    validateIntentOutput(
      {
        guidance: null,
        questions: [{ question: "当前基础是什么？" }],
        proposals: [],
      },
      { job, context: ctx },
    ),
  );
  assert.throws(() =>
    validateIntentOutput(
      { guidance: guidance(45), proposals: [] },
      { job, context: ctx },
    ),
  );
  assert.doesNotThrow(() =>
    validateIntentOutput(
      { guidance: guidance(30), proposals: [] },
      { job, context: ctx },
    ),
  );
});
test("delete commands cannot be smuggled into an unrelated answer or point at another goal", () => {
  const output = {
    guidance: null,
    proposals: [{ command: { type: "goal.delete", id: "english" } }],
  };
  assert.throws(() =>
    validateIntentOutput(output, {
      job,
      context: context("帮我解释英语阅读的学习方法"),
    }),
  );
  assert.doesNotThrow(() =>
    validateIntentOutput(output, { job, context: context("删除英语阅读目标") }),
  );
  assert.throws(() =>
    validateIntentOutput(output, {
      job,
      context: context("删除Python 入门目标"),
    }),
  );
  assert.throws(() =>
    validateIntentOutput(output, { job, context: context("删除这个目标") }),
  );
});
test("stale event references and over-budget proposed blocks are rejected before settlement", () => {
  const ctx = context("请安排今晚30分钟的任务");
  assert.throws(() =>
    validateIntentOutput(
      {
        guidance: guidance(),
        proposals: [
          { command: { type: "plan.update", id: "missing", minutes: 20 } },
        ],
      },
      { job, context: ctx },
    ),
  );
  assert.throws(() =>
    validateIntentOutput(
      {
        guidance: guidance(),
        proposals: [
          {
            command: {
              type: "plan.batch",
              goal: "english",
              blocks: [{ minutes: 20 }, { minutes: 20 }],
            },
          },
        ],
      },
      { job, context: ctx },
    ),
  );
});
test("intent errors contain fixed codes and field paths, never the user sentence", () => {
  const secret = "私密目标名字不该出现在诊断";
  assert.throws(
    () =>
      validateIntentOutput(
        {
          guidance: null,
          proposals: [{ command: { type: "goal.delete", id: secret } }],
        },
        { job, context: context("解释学习方法是什么？") },
      ),
    (e) => !JSON.stringify(e.failure).includes(secret),
  );
});
test("explicit schedule edits and cancellation remain allowed without creating a new plan", () => {
  const ctx = context("把阅读短文任务缩短到10分钟");
  ctx.plans = [
    { id: "read", name: "阅读短文", status: "planned" },
    { id: "other", name: "复习词汇", status: "planned" },
  ];
  const update = {
    guidance: null,
    proposals: [
      {
        command: {
          type: "plan.update",
          id: "read",
          name: "阅读短文",
          day: "2026-10-10",
          time: "09:00",
          minutes: 10,
        },
      },
    ],
  };
  assert.equal(analyzeIntent(job, ctx).kind, "schedule_change");
  assert.doesNotThrow(() =>
    validateIntentOutput(update, { job, context: ctx }),
  );
  const wrongTarget = structuredClone(update);
  wrongTarget.proposals[0].command.id = "other";
  assert.throws(() => validateIntentOutput(wrongTarget, { job, context: ctx }));
  const cancelContext = {
    ...ctx,
    messages: [
      {
        id: "now",
        role: "user",
        content: "不用规划新任务，删除阅读短文时间块",
      },
    ],
  };
  const cancel = {
    guidance: null,
    proposals: [
      { command: { type: "plan.status", id: "read", status: "cancelled" } },
    ],
  };
  assert.doesNotThrow(() =>
    validateIntentOutput(cancel, { job, context: cancelContext }),
  );
  const unrelated = {
    ...ctx,
    messages: [{ id: "now", role: "user", content: "间隔复习是什么？" }],
  };
  assert.throws(() =>
    validateIntentOutput(update, { job, context: unrelated }),
  );
  assert.throws(() =>
    validateIntentOutput(cancel, { job, context: unrelated }),
  );
  const create = {
    guidance: null,
    proposals: [{ command: { type: "plan.create", goal: null, minutes: 10 } }],
  };
  assert.throws(() => validateIntentOutput(create, { job, context: ctx }));
});
test("skill generation validates the actual goal and tree patch before settlement without changing the tree", () => {
  const skillJob = {
    kind: "skills",
    id: "00000000-0000-4000-8000-000000000001",
    input: { goalId: "english" },
  };
  const ctx = {
    goals: [{ ...goals[0], criterion: "总结文章", base: "能看懂简单句" }],
    messages: [],
    personalTree: initialTree(),
    skillGoalId: "goal_english",
    treeRequestId: "00000000-0000-4000-8000-000000000001",
  };
  const before = JSON.stringify(ctx.personalTree);
  const valid = skillFixture(skillJob, ctx);
  assert.doesNotThrow(() =>
    validateIntentOutput(valid, { job: skillJob, context: ctx }),
  );
  assert.equal(JSON.stringify(ctx.personalTree), before);
  const bad = structuredClone(valid);
  bad.plan.goal.title = "另一个目标";
  assert.throws(
    () => validateIntentOutput(bad, { job: skillJob, context: ctx }),
    (e) => e.failure.issues[0].code === "goal_contract_mismatch",
  );
  bad.plan.goal.title = valid.plan.goal.title;
  bad.treePatch.addNodes[0].parentId = "missing";
  assert.throws(
    () => validateIntentOutput(bad, { job: skillJob, context: ctx }),
    (e) => e.failure.issues[0].code === "tree_contract_invalid",
  );
  assert.equal(JSON.stringify(ctx.personalTree), before);
});

test("ordinary negation and deletion questions never authorize a delete proposal", () => {
  for (const text of [
    "不删除英语阅读目标",
    "不是要删除英语阅读目标",
    "英语阅读目标不要删除",
    "英语阅读目标要不要删除？",
    "删除英语阅读目标可以吗？",
  ]) {
    const ctx = context(text);
    assert.ok(
      !analyzeIntent(job, ctx).requestedActions.includes("delete_goal"),
      text,
    );
    assert.throws(
      () =>
        validateIntentOutput(
          {
            guidance: null,
            proposals: [{ command: { type: "goal.delete", id: "english" } }],
          },
          { job, context: ctx },
        ),
      undefined,
      text,
    );
  }
});
test("reflection cannot turn into new goals or schedules", () => {
  const ctx = context("总结今天的表现");
  assert.equal(analyzeIntent(job, ctx).kind, "reflection");
  assert.throws(() =>
    validateIntentOutput(
      {
        guidance: null,
        proposals: [{ command: { type: "goal.create", minutes: 20 } }],
      },
      { job, context: ctx },
    ),
  );
});
test("extending or shortening a block replaces its older time budget", () => {
  for (const [phrase, minutes] of [
    ["延长到45分钟", 45],
    ["延长为45分钟", 45],
    ["缩短到15分钟", 15],
    ["缩短为15分钟", 15],
  ]) {
    const ctx = context("把阅读短文任务" + phrase, ["每天只有30分钟"]);
    ctx.plans = [{ id: "read", name: "阅读短文", status: "planned" }];
    assert.equal(analyzeIntent(job, ctx).timeBudget, minutes, phrase);
    assert.doesNotThrow(() =>
      validateIntentOutput(
        {
          guidance: null,
          proposals: [
            { command: { type: "plan.update", id: "read", minutes } },
          ],
        },
        { job, context: ctx },
      ),
    );
  }
});
test("new blocks share a daily budget across proposals without summing distinct days or edits", () => {
  const ctx = context("请安排每天30分钟的阅读任务");
  const create = (day, minutes = 30) => ({
    command: { type: "plan.create", goal: null, minutes, day },
  });
  const output = (proposals) => ({ guidance: guidance(), proposals });
  assert.throws(
    () =>
      validateIntentOutput(
        output([create("2026-10-10"), create("2026-10-10")]),
        { job, context: ctx },
      ),
    (error) => error.failure.issues[0].code === "guidance_over_budget",
  );
  assert.doesNotThrow(() =>
    validateIntentOutput(output([create("2026-10-10"), create("2026-10-11")]), {
      job,
      context: ctx,
    }),
  );
  const batch = {
    command: {
      type: "plan.batch",
      goal: "english",
      day: "2026-10-10",
      blocks: [{ minutes: 20 }],
    },
  };
  assert.throws(() =>
    validateIntentOutput(output([batch, create("2026-10-10", 20)]), {
      job,
      context: ctx,
    }),
  );
  ctx.plans = [{ id: "read", name: "阅读短文", status: "planned" }];
  const update = {
    command: {
      type: "plan.update",
      id: "read",
      day: "2026-10-10",
      minutes: 30,
    },
  };
  assert.doesNotThrow(() =>
    validateIntentOutput(output([update, create("2026-10-10")]), {
      job,
      context: ctx,
    }),
  );
});

test("goal-bound route and skills ignore unrelated chat negation and budgets", () => {
  const ctx = context("先不要安排任务，我今晚只有10分钟，请解释间隔复习是什么");
  for (const kind of ["route", "skills"]) {
    const scopedJob = { kind, input: { goalId: "python" } };
    const result = analyzeIntent(scopedJob, ctx);
    assert.equal(result.kind, "planning");
    assert.equal(result.timeBudget, 60);
    assert.equal(result.targetGoalId, "python");
    assert.equal(result.targetPlanId, null);
    assert.equal(result.shouldRetrieve, true);
    assert.equal(result.requiresClarification, false);
    assert.deepEqual(result.blockedActions, []);
    assert.deepEqual(result.requestedActions, ["plan"]);
    assert.equal(
      analyzeIntent(
        { ...scopedJob, input: { ...scopedJob.input, minutes: 45 } },
        ctx,
      ).timeBudget,
      45,
    );
  }
});
