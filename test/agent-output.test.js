import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import {
  outputContract,
  outputInstruction,
  validateOutput,
  parseOutput,
  failureFor,
  AgentError,
  outputFromRun,
} from "../src/agent-output.js";

const route = {
  summary: "读后总结",
  minutes: 30,
  stat: 0,
  stages: [
    {
      name: "总结",
      criterion: "300字",
      exercise: "列要点",
      steps: "阅读\n总结",
      challenge: "独立总结",
    },
  ],
  sources: [],
};

test("model contract exposes runtime types, lengths, enums and strict objects for every job kind", () => {
  const schema = outputContract("route");
  assert.equal(schema.properties.stages.items.properties.steps.type, "string");
  assert.equal(schema.properties.stages.items.properties.steps.maxLength, 2000);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.minutes.maximum, 240);
  assert.equal(schema.properties.stages.maxItems, 8);
  for (const kind of ["route", "assessment", "chat", "review"])
    assert.ok(
      outputInstruction(kind).includes(JSON.stringify(outputContract(kind))),
    );
  assert.equal(validateOutput("route", route).stages[0].standardId, null);
});

test("only completed model turns may enter output validation or settlement", () => {
  const run = (reason, finalResponse = '{"summary":"ok"}') => ({
    finalResponse,
    events: [
      {
        type: "assistant/message",
        data: {
          usage: { outputTokens: 6000 },
          message: {
            content: [{ type: "reasoning", text: "private-reasoning" }],
          },
        },
      },
      {
        type: "turn/end",
        data: { reason: { kind: reason, error: { message: "sk-secret" } } },
      },
    ],
  });
  for (const reason of [
    "max-tokens",
    "error",
    "aborted",
    "blocked",
    "private-reason",
  ])
    for (const body of [
      "",
      '{"summary":"valid but unfinished"}',
      '{"summary":',
    ])
      assert.throws(
        () => outputFromRun("review", run(reason, body)),
        (e) => {
          assert.equal(
            e.failure.code,
            reason === "max-tokens"
              ? "model_output_limit"
              : "model_execution_failed",
          );
          assert.equal(e.failure.phase, "completion");
          assert.equal(e.failure.execution.outputTokens, 6000);
          assert.ok(!JSON.stringify(e.failure).includes("private"));
          assert.ok(!JSON.stringify(e.failure).includes("secret"));
          return true;
        },
      );
  assert.deepEqual(outputFromRun("review", run("completed")), {
    summary: "ok",
  });
  assert.throws(
    () => outputFromRun("review", run("completed", "  ")),
    (e) => e.failure.code === "model_output_empty",
  );
  assert.throws(
    () =>
      outputFromRun("review", {
        finalResponse: '{"summary":"ok"}',
        events: [],
      }),
    AgentError,
  );
  const earlierFailure = run("max-tokens");
  earlierFailure.events.push({
    type: "turn/end",
    data: { reason: { kind: "completed" } },
  });
  assert.throws(
    () => outputFromRun("review", earlierFailure),
    (e) => e.failure.code === "model_output_limit",
  );
});

test("generation limits are explicit, bounded, and safely diagnosable", () => {
  const base = { DATABASE_URL: "unused", REDIS_URL: "unused" };
  const defaults = config(base);
  assert.equal(defaults.DSH_MAX_TOKENS, 16384);
  assert.equal(defaults.DSH_REASONING_EFFORT, "high");
  for (const invalid of [0, -1, 32769, "bad"])
    assert.throws(() => config({ ...base, DSH_MAX_TOKENS: invalid }));
  assert.throws(() => config({ ...base, DSH_REASONING_EFFORT: "unknown" }));
  assert.throws(
    () =>
      outputFromRun(
        "assessment",
        {
          finalResponse: "",
          events: [
            { type: "turn/end", data: { reason: { kind: "max-tokens" } } },
          ],
        },
        { maxTokens: 16384, reasoningEffort: "high" },
      ),
    (e) => {
      assert.equal(e.failure.execution.maxTokens, 16384);
      assert.equal(e.failure.execution.reasoningEffort, "high");
      return true;
    },
  );
});

test("JSON syntax diagnostics distinguish incompleteness and escaping without retaining content", () => {
  for (const [raw, category] of [
    ['{"summary":"private unfinished', "unexpected_end"],
    ['{"summary":"private\nnewline"}', "unescaped_control"],
    ['{"summary":"private\\q"}', "invalid_escape"],
    ['{"summary":true,}', "invalid_syntax"],
    ['private escape text at position 99999', "invalid_syntax"],
  ])
    assert.throws(
      () => parseOutput(raw),
      (e) => {
        assert.equal(e.failure.json.category, category);
        assert.equal(e.failure.json.characters, raw.length);
        assert.ok(!JSON.stringify(e.failure).includes("private"));
        return true;
      },
    );
});

test("array steps reproduces the live failure without coercion or losing field diagnostics", () => {
  const value = structuredClone(route);
  value.stages[0].steps = ["private-model-content"];
  assert.throws(
    () => validateOutput("route", value),
    (e) => {
      assert.deepEqual(e.failure.issues, [
        {
          path: ["stages", 0, "steps"],
          code: "invalid_type",
          received: "array",
          expected: "string",
          length: 1,
        },
      ]);
      assert.equal(e.failure.contract, "route-v1");
      assert.ok(!JSON.stringify(e).includes("private-model-content"));
      return true;
    },
  );
});

test("diagnostics never contain unknown keys, text, raw JSON errors or provider details", () => {
  const value = {
    ...route,
    secretApiKey: "sk-private",
    summary: "private".repeat(400),
  };
  let failure;
  try {
    validateOutput("route", value);
  } catch (e) {
    failure = failureFor(e);
  }
  const encoded = JSON.stringify(failure);
  assert.ok(!encoded.includes("secretApiKey"));
  assert.ok(!encoded.includes("private"));
  assert.equal(failure.issues.find((i) => i.code === "too_big").maximum, 2000);
  assert.throws(
    () => parseOutput('{"secret":"sk-private"'),
    (e) => {
      assert.equal(e.failure.code, "output_json_invalid");
      assert.ok(!JSON.stringify(e).includes("sk-private"));
      return true;
    },
  );
  assert.equal(
    failureFor(new Error("secret-provider-response")).code,
    "internal_error",
  );
  assert.ok(
    !JSON.stringify(failureFor(new Error("secret-provider-response"))).includes(
      "secret-provider",
    ),
  );
  assert.deepEqual(parseOutput('```json\n{"summary":"ok"}\n```'), {
    summary: "ok",
  });
});

test("all output boundaries stay strict, including review, quotes and proposal limits", () => {
  for (const [kind, value] of [
    ["review", { summary: ["text"] }],
    ["chat", { reply: "ok", proposals: [], extra: "private" }],
    [
      "assessment",
      {
        outcome: "success",
        feedback: "ok",
        quotes: [],
        evidenceType: "text",
        standardId: null,
        standardVersion: null,
      },
    ],
  ])
    assert.throws(() => validateOutput(kind, value), AgentError);
});
