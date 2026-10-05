import test from "node:test";
import assert from "node:assert/strict";
import {
  outputContract,
  outputInstruction,
  validateOutput,
  parseOutput,
  failureFor,
  AgentError,
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
