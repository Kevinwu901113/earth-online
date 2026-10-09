import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DshAgent } from "../src/agent.js";
import { DshAgent as LabAgent } from "../tools/agent-workbench/current/src/agent.js";
import {
  AgentError,
  outputFromRun,
  outputContract,
} from "../src/agent-output.js";
import { initialState } from "../src/domain.js";
import { skillFixture } from "./skill-fixture.js";
import { fixture, exampleInput } from "../tools/agent-workbench/fixtures.js";
import {
  repairFeedback,
  runStructuredHarness,
} from "../src/structured-harness.js";

const completed = (body, reason = "completed") => ({
  finalResponse: typeof body === "string" ? body : JSON.stringify(body),
  events: [{ type: "turn/end", data: { reason: { kind: reason } } }],
});
const context = () => ({
  goals: [],
  messages: [],
  records: [],
  standards: [],
  personalTree: initialState().personalTree,
});
const route = {
  summary: "练习",
  minutes: 20,
  stat: 0,
  sources: [],
  stages: [
    {
      name: "阅读",
      criterion: "概括主旨",
      exercise: "读一段",
      actions: [{ name: "写三个要点", minutes: 20 }],
      steps: "先读再写",
      challenge: "独立概括",
      standardId: null,
      standardVersion: null,
    },
  ],
};

async function agentCase(
  run,
  {
    Agent = DshAgent,
    kind = "review",
    ctx = context(),
    options = {},
    timeoutMs = 2000,
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "earth-harness-"));
  const seen = { prompts: [], options: [], closed: 0, attempts: [] };
  const cfg = {
    DATA_DIR: dir,
    DEEPSEEK_API_KEY: "fixture-only",
    DSH_MAX_TOKENS: 8192,
    DSH_REASONING_EFFORT: "low",
    DSH_TIMEOUT_MS: timeoutMs,
  };
  const job = {
    id: randomUUID(),
    user_id: randomUUID(),
    kind,
    input: kind === "skills" ? { goalId: ctx.goals[0]?.id } : {},
  };
  const agent = new Agent(cfg, {
    ...options,
    onAttempt: (event) => {
      seen.attempts.push(event);
      options.onAttempt?.(event);
    },
    HarnessFactory: (launch) => {
      seen.options.push(launch);
      return {
        run: async (prompt) => {
          seen.prompts.push(prompt);
          return run(seen.prompts.length, prompt, job, ctx);
        },
        close: async () => {
          seen.closed++;
        },
      };
    },
  });
  try {
    return await options.inspect(agent, job, ctx, seen, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("completed malformed output is regenerated with the identical request and only redacted feedback", async () => {
  await agentCase(
    (attempt) =>
      attempt === 1
        ? completed('{"summary":"PRIVATE_FAILED_OUTPUT",}')
        : completed({ summary: "完整结果" }),
    {
      ctx: {
        ...context(),
        messages: [{ role: "user", content: "PRIVATE_ORIGINAL_REQUEST" }],
      },
      options: {
        inspect: async (agent, job, ctx, seen, dir) => {
          assert.deepEqual(await agent.run(job, ctx), { summary: "完整结果" });
          assert.equal(seen.prompts.length, 2);
          assert.ok(seen.prompts[1].startsWith(seen.prompts[0]));
          assert.ok(seen.prompts[1].includes("PRIVATE_ORIGINAL_REQUEST"));
          assert.ok(!seen.prompts[1].includes("PRIVATE_FAILED_OUTPUT"));
          assert.ok(seen.prompts[1].includes('"code":"output_json_invalid"'));
          assert.notEqual(seen.options[0].dshHome, seen.options[1].dshHome);
          assert.equal(seen.closed, 2);
          assert.deepEqual(
            seen.attempts.map((e) => e.attempt),
            [1, 2],
          );
          assert.ok(!JSON.stringify(seen.attempts).includes("PRIVATE"));
          assert.deepEqual(await readdir(join(dir, "agent", job.user_id)), []);
        },
      },
    },
  );
});

test("repeated invalid business fields exhaust the finite budget without coercion or private diagnostics", async () => {
  await agentCase(
    () => completed({ ...route, minutes: "20", PRIVATE_KEY: "PRIVATE_OUTPUT" }),
    {
      kind: "route",
      options: {
        inspect: async (agent, job, ctx, seen) => {
          await assert.rejects(agent.run(job, ctx), (error) => {
            assert.equal(error.failure.code, "output_schema_invalid");
            assert.deepEqual(error.failure.harness, {
              attempts: 3,
              maxAttempts: 3,
              exhausted: true,
            });
            assert.ok(!JSON.stringify(error.failure).includes("PRIVATE"));
            return true;
          });
          assert.equal(seen.prompts.length, 3);
          assert.equal(seen.closed, 3);
          assert.ok(!seen.prompts[1].includes("PRIVATE_KEY"));
          assert.ok(seen.prompts[1].includes('"path":["minutes"]'));
        },
      },
    },
  );
});

test("all production and lab kinds share the repair gate and their full runtime schema", async () => {
  const assessment = {
    outcome: "insufficient",
    feedback: "需要文字成果",
    quotes: [],
    evidenceType: "text",
    standardId: null,
    standardVersion: null,
  };
  for (const scenario of [
    {
      Agent: DshAgent,
      kind: "chat",
      value: { reply: "你好", questions: [], guidance: null, proposals: [] },
    },
    { Agent: DshAgent, kind: "route", value: route },
    { Agent: DshAgent, kind: "assessment", value: assessment },
    { Agent: DshAgent, kind: "review", value: { summary: "复盘" } },
    {
      Agent: DshAgent,
      kind: "skills",
      value: (job, ctx) => skillFixture(job, ctx),
    },
    {
      Agent: LabAgent,
      kind: "workbench",
      value: {
        schemaVersion: "earth.agent.v3",
        status: "reply",
        reply: "你好",
        questions: [],
        understanding: { objective: "", knownFacts: [], unknowns: [] },
        plan: null,
        treePatch: null,
      },
    },
    { Agent: LabAgent, kind: "skills", value: fixture(exampleInput) },
  ]) {
    const ctx = context();
    ctx.goals = [
      {
        id: randomUUID(),
        title: "阅读",
        criterion: "概括主旨",
        minutes: 20,
        base: "基础未知",
      },
    ];
    ctx.skillGoalId = "goal_example";
    let expected;
    await agentCase(
      (attempt, _prompt, job, ctx) => {
        expected =
          typeof scenario.value === "function"
            ? scenario.value(job, ctx)
            : scenario.value;
        return completed(
          attempt === 1
            ? { ...expected, privateExtraKey: "PRIVATE" }
            : expected,
        );
      },
      {
        ...scenario,
        ctx,
        options: {
          inspect: async (agent, job, ctx, seen) => {
            assert.deepEqual(
              await agent.run(job, ctx),
              expected,
              scenario.kind,
            );
            assert.equal(seen.prompts.length, 2, scenario.kind);
          },
        },
      },
    );
  }
});

test("cancellation closes a hanging runtime without retrying or accepting a late valid result", async () => {
  const abort = new AbortController();
  let release;
  await agentCase(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    {
      options: {
        inspect: async (agent, job, ctx, seen) => {
          const pending = agent.run(job, ctx, abort.signal);
          while (!release)
            await new Promise((resolve) => setImmediate(resolve));
          abort.abort(new Error("PRIVATE_ABORT_REASON"));
          await assert.rejects(
            pending,
            (e) =>
              e.failure.code === "job_interrupted" &&
              e.failure.harness.attempts === 1 &&
              !JSON.stringify(e.failure).includes("PRIVATE"),
          );
          release(completed({ summary: "迟到结果" }));
          assert.equal(seen.prompts.length, 1);
          assert.ok(seen.closed >= 1);
        },
      },
    },
  );
});

test("production skills admit only retrieved resource URLs and never repair forged citations", async () => {
  const source = {
    title: "学习参考",
    url: "https://example.org/retrieved",
    note: "检索资料",
    retrievedAt: "2026-10-09T00:00:00.000Z",
  };
  for (const verified of [true, false]) {
    const ctx = {
      ...context(),
      goals: [
        {
          id: randomUUID(),
          title: "阅读",
          criterion: "概括主旨",
          minutes: 20,
          base: "基础未知",
        },
      ],
      skillGoalId: "goal_example",
      knowledge: {
        available: true,
        backend: "file",
        sources: [source],
        chunks: [
          {
            id: "chunk",
            documentId: "doc",
            title: source.title,
            url: source.url,
            text: "阅读后概括要点。",
            score: 0.8,
          },
        ],
      },
    };
    await agentCase(
      (_attempt, _prompt, job, ctx) => {
        const out = skillFixture(job, ctx);
        out.plan.resources.push({
          id: "reference",
          name: source.title,
          kind: "website",
          availability: "verified_link",
          url: verified ? source.url : "https://example.org/PRIVATE_FORGED",
          locator: "阅读参考资料",
          purpose: "练习学习方法",
          question: null,
        });
        out.plan.tasks[0].resourceIds = ["reference"];
        return completed(out);
      },
      {
        kind: "skills",
        ctx,
        options: {
          inspect: async (agent, job, ctx, seen) => {
            if (verified)
              assert.equal(
                (await agent.run(job, ctx)).plan.resources[0].url,
                source.url,
              );
            else
              await assert.rejects(
                agent.run(job, ctx),
                (error) =>
                  error.failure.code === "source_unverified" &&
                  !JSON.stringify(error.failure).includes("PRIVATE"),
              );
            assert.equal(seen.prompts.length, 1);
          },
        },
      },
    );
  }
});

test("the deadline spans repair generations and final validators instead of resetting per attempt", async () => {
  await agentCase(
    async (attempt) => {
      if (attempt === 1) {
        await new Promise((resolve) => setTimeout(resolve, 90));
        return completed({ summary: [] });
      }
      return new Promise(() => {});
    },
    {
      timeoutMs: 150,
      options: {
        inspect: async (agent, job, ctx, seen) => {
          const at = performance.now();
          await assert.rejects(
            agent.run(job, ctx),
            (e) =>
              e.failure.code === "model_timeout" &&
              e.failure.harness.attempts === 2,
          );
          assert.ok(performance.now() - at < 230);
          assert.equal(seen.prompts.length, 2);
        },
      },
    },
  );
  await agentCase(() => completed({ summary: "格式有效" }), {
    timeoutMs: 50,
    options: {
      validate: () => new Promise(() => {}),
      inspect: async (agent, job, ctx, seen) => {
        await assert.rejects(
          agent.run(job, ctx),
          (e) => e.failure.code === "model_timeout",
        );
        assert.equal(seen.prompts.length, 1);
      },
    },
  });
});

test("the caller's remaining timeout is enforced and cannot extend configured limits", async () => {
  for (const [configured, remaining] of [
    [2000, 50],
    [50, 2000],
  ]) {
    await agentCase(() => new Promise(() => {}), {
      timeoutMs: configured,
      options: {
        inspect: async (agent, job, ctx, seen) => {
          const started = performance.now();
          await assert.rejects(
            agent.run(job, ctx, undefined, { timeoutMs: remaining }),
            (error) => error.failure.code === "model_timeout",
          );
          assert.ok(performance.now() - started < 500);
          assert.equal(seen.prompts.length, 1);
          assert.ok(seen.options[0].initializeTimeoutMs <= 50);
        },
      },
    });
  }
  await agentCase(() => completed({ summary: "too late" }), {
    options: {
      inspect: async (agent, job, ctx, seen) => {
        await assert.rejects(
          agent.run(job, ctx, undefined, { timeoutMs: 0 }),
          (error) => error.failure.code === "model_timeout",
        );
        assert.equal(seen.options.length, 0);
      },
    },
  });
});

test("empty, truncated, unknown completion and provider failures never enter the repair path", async () => {
  for (const body of [
    completed("", "completed"),
    completed({ summary: "有效但截断" }, "max-tokens"),
    completed({ summary: "有效但中断" }, "aborted"),
    completed({ summary: "未知结束" }, "PRIVATE_REASON"),
    { finalResponse: '{"summary":"ok"}', events: [{ type: "unknown/end" }] },
  ]) {
    await agentCase(() => body, {
      options: {
        inspect: async (agent, job, ctx, seen) => {
          await assert.rejects(
            agent.run(job, ctx),
            (e) =>
              !e.failure.harness.exhausted &&
              !JSON.stringify(e.failure).includes("PRIVATE"),
          );
          assert.equal(seen.prompts.length, 1);
        },
      },
    });
  }
  await agentCase(
    () => {
      throw new Error("PRIVATE_PROVIDER_BODY");
    },
    {
      options: {
        inspect: async (agent, job, ctx, seen) => {
          await assert.rejects(
            agent.run(job, ctx),
            (e) =>
              e.failure.code === "model_execution_failed" &&
              !JSON.stringify(e.failure).includes("PRIVATE"),
          );
          assert.equal(seen.prompts.length, 1);
        },
      },
    },
  );
});

test("intent and custom validators run before return, with only approved validation failures repairable", async () => {
  let validated = 0;
  await agentCase(
    (attempt) =>
      completed(
        attempt === 1
          ? { reply: "只说一段文字", guidance: null, proposals: [] }
          : {
              reply: "按块安排",
              guidance: {
                title: "开始阅读",
                summary: "先做一小步",
                steps: [{ title: "写三个要点", minutes: 10, kind: "main" }],
              },
              proposals: [],
            },
      ),
    {
      kind: "chat",
      ctx: {
        ...context(),
        messages: [
          {
            id: "user-message",
            role: "user",
            content: "请帮我规划今天的阅读，最多10分钟",
          },
        ],
      },
      options: {
        validate: () => {
          validated++;
        },
        inspect: async (agent, job, ctx, seen) => {
          job.input.messageId = "user-message";
          assert.equal(
            (await agent.run(job, ctx)).guidance.steps[0].minutes,
            10,
          );
          assert.equal(validated, 1);
          assert.equal(seen.prompts.length, 2);
          assert.ok(seen.prompts[1].includes("intent_mismatch"));
        },
      },
    },
  );
  await agentCase(() => completed({ summary: "有效" }), {
    options: {
      validate: () => {
        throw new AgentError("source_unverified", { phase: "validation" });
      },
      inspect: async (agent, job, ctx, seen) => {
        await assert.rejects(
          agent.run(job, ctx),
          (e) => e.failure.code === "source_unverified",
        );
        assert.equal(seen.prompts.length, 1);
      },
    },
  });
});

test("repair diagnostics whitelist schema names and fixed codes, and teardown failure prevents a replacement", async () => {
  const feedback = repairFeedback(
    {
      code: "output_schema_invalid",
      message: "PRIVATE",
      issues: [
        {
          path: ["summary", "PRIVATE_FIELD", -1],
          code: "PRIVATE_CODE",
          received: "PRIVATE_TYPE",
          message: "PRIVATE",
          minimum: 1,
        },
      ],
    },
    outputContract("review"),
  );
  assert.deepEqual(feedback, {
    code: "output_schema_invalid",
    issues: [{ path: ["summary", "*", "*"], code: "custom", minimum: 1 }],
  });
  let calls = 0;
  await assert.rejects(
    runStructuredHarness({
      prompt: "original",
      contract: outputContract("review"),
      timeoutMs: 1000,
      errorClass: AgentError,
      createHarness: () => ({
        run: async () => {
          calls++;
          return completed({ summary: [] });
        },
        close: async () => {
          throw new Error("PRIVATE_CLEANUP");
        },
      }),
      decode: (result) => outputFromRun("review", result),
    }),
    (e) =>
      e.failure.code === "model_execution_failed" &&
      e.failure.phase === "cleanup" &&
      !JSON.stringify(e.failure).includes("PRIVATE"),
  );
  assert.equal(calls, 1);
});
