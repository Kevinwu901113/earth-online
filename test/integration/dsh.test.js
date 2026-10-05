import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshAgent } from "../../src/agent.js";
import { config } from "../../src/config.js";
const routeOutput = {
  summary: "根据已有条件练习阅读",
  minutes: 30,
  stat: 0,
  sources: [],
  stages: [
    {
      name: "总结",
      criterion: "300字",
      exercise: "概括主旨",
      steps: "阅读后用自己的话总结",
      challenge: "独立提交文字",
      standardId: null,
      standardVersion: null,
    },
  ],
};
for (const scenario of [
  { kind: "chat", output: { reply: "已读取你的实际记录。", proposals: [] } },
  { kind: "route", output: routeOutput },
  {
    kind: "route",
    output: {
      ...routeOutput,
      stages: [{ ...routeOutput.stages[0], steps: ["array from model"] }],
    },
    invalid: true,
  },
])
  test(
    `real DSH contract and isolated tools: ${scenario.kind} ${scenario.invalid ? "invalid output" : "valid output"}`,
    { timeout: 60000 },
    async () => {
      let requests = 0,
        seenTools = [],
        sawToolResult = false,
        sawContract = false;
      const server = createServer(async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(404);
          res.end();
          return;
        }
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        requests++;
        sawContract ||=
          JSON.stringify(body.messages).includes("输出契约") &&
          JSON.stringify(body.messages).includes("maxLength");
        seenTools = body.tools?.map((t) => t.name) ?? [];
        sawToolResult ||= body.messages.some(
          (m) =>
            Array.isArray(m.content) &&
            m.content.some((c) => c.type === "tool_result"),
        );
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const emit = (v) =>
          res.write(`event: ${v.type}\ndata: ${JSON.stringify(v)}\n\n`);
        emit({
          type: "message_start",
          message: {
            id: "msg_test_" + requests,
            type: "message",
            role: "assistant",
            model: "deepseek-v4-flash",
            content: [],
            usage: { input_tokens: 10, output_tokens: 0 },
            stop_reason: null,
            stop_sequence: null,
          },
        });
        if (requests === 1) {
          emit({
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool_test",
              name: "earth_context",
              input: {},
            },
          });
          emit({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{}" },
          });
        } else {
          emit({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          });
          emit({
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: JSON.stringify(scenario.output),
            },
          });
        }
        emit({ type: "content_block_stop", index: 0 });
        emit({
          type: "message_delta",
          delta: {
            stop_reason: requests === 1 ? "tool_use" : "end_turn",
            stop_sequence: null,
          },
          usage: { output_tokens: 30 },
        });
        emit({ type: "message_stop" });
        res.end();
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const dir = await mkdtemp(join(tmpdir(), "earth-dsh-test-"));
      try {
        const cfg = config({
          DATABASE_URL: "unused",
          REDIS_URL: "unused",
          DATA_DIR: dir,
          DEEPSEEK_API_KEY: "fixture-only",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}/anthropic`,
          DSH_TIMEOUT_MS: 45000,
        });
        const pending = new DshAgent(cfg).run(
          {
            id: randomUUID(),
            user_id: randomUUID(),
            kind: scenario.kind,
            input: { messageId: randomUUID() },
          },
          {
            profile: { name: "Test" },
            goals: [],
            records: [],
            notes: [],
            messages: [],
            submissions: [],
            standards: [],
          },
        );
        if (scenario.invalid)
          await assert.rejects(pending, (e) => {
            assert.equal(e.failure.code, "output_schema_invalid");
            assert.equal(e.failure.issues[0].received, "array");
            return true;
          });
        else assert.deepEqual(await pending, scenario.output);
        assert.equal(sawContract, true);
        assert.equal(requests, 2);
        assert.equal(sawToolResult, true);
        assert.deepEqual(seenTools.sort(), [
          "earth_context",
          "earth_search",
          "earth_standards",
        ]);
      } finally {
        await new Promise((r) => server.close(r));
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
