import test from "node:test";
import assert from "node:assert/strict";
import { generate, agentConfig } from "../engine.js";
import { runMessage } from "../workbench.js";
import { fixture, exampleInput } from "../fixtures.js";
import { labDataDir, retrieveLabKnowledge } from "../knowledge.js";

const source = {
  title: "真实学习资料",
  url: "https://example.org/learning",
  note: "规划参考",
  retrievedAt: "2026-10-07T00:00:00.000Z",
};
const snapshot = () => ({
  available: true,
  backend: "file",
  index: { name: "workbench", documentCount: 1, chunkCount: 1 },
  sources: [source],
  chunks: [
    {
      id: "chunk-1",
      documentId: "doc-1",
      url: source.url,
      title: source.title,
      text: "阅读后写出三个要点。",
      score: 0.8,
      retrievedAt: source.retrievedAt,
    },
  ],
});
const response = () => ({
  schemaVersion: "earth.agent.v1",
  status: "draft",
  reply: "已规划",
  questions: [],
  understanding: { objective: "英语", knownFacts: [], unknowns: [] },
  plan: fixture(exampleInput),
});

test("workbench config cannot select production storage or credentials", () => {
  const cfg = agentConfig({
    DATABASE_URL: "must-not-use-production-db",
    REDIS_URL: "must-not-use-production-cache",
    DATA_DIR: "/production-data",
    RAG_BACKEND: "pgvector",
  });
  assert.equal(cfg.DATABASE_URL, "unused-in-lab");
  assert.equal(cfg.REDIS_URL, "unused-in-lab");
  assert.equal(cfg.DATA_DIR, labDataDir);
  assert.match(labDataDir, /tools\/agent-workbench\/var\/$/);
});

test("live generation receives bounded RAG while result exposes only metadata and sources", async () => {
  let received, seen;
  const knowledge = {
    retrieve: async (query, options) => {
      received = { query, options };
      return snapshot();
    },
  };
  const result = await generate(
    { ...exampleInput, mode: "live" },
    {
      knowledge,
      agent: {
        run: async (job, context) => {
          seen = { job, context };
          return fixture(exampleInput);
        },
      },
    },
  );
  assert.ok(received.query.includes(exampleInput.goal.title));
  assert.equal(received.options.userId, null);
  assert.equal(seen.context.knowledge.untrusted, true);
  assert.deepEqual(result.retrieval.sources, [source]);
  assert.equal(result.retrieval.hitCount, 1);
  assert.ok(!JSON.stringify(result.retrieval).includes("阅读后写出三个要点"));
  const fixtureResult = await generate(exampleInput, {
    knowledge: {
      retrieve: async () => assert.fail("fixture must not use live retrieval"),
    },
  });
  assert.equal(fixtureResult.retrieval.available, false);
  assert.equal(fixtureResult.retrieval.reason, "fixture_mode");
});

test("conversation retrieval uses its owner, stays stable across retries and follows plugin selection", async () => {
  const conversation = {
    id: "conversation-owner",
    title: "英语",
    revision: 0,
    plan: null,
    messages: [{ role: "user", content: "想学英语" }],
    capabilities: { plugins: ["earth-tools"], skills: [] },
  };
  let retrievalCalls = 0,
    modelCalls = 0;
  const knowledge = {
    retrieve: async (query, options) => {
      retrievalCalls++;
      assert.ok(query.includes("想学英语"));
      assert.equal(options.userId, conversation.id);
      return snapshot();
    },
  };
  const result = await runMessage(conversation, {
    knowledge,
    persist: async () => {},
    agent: {
      run: async (_job, context) => {
        assert.deepEqual(context.knowledge.sources, [source]);
        if (++modelCalls === 1) throw { failure: { code: "model_timeout" } };
        return response();
      },
    },
  });
  assert.equal(retrievalCalls, 1);
  assert.equal(modelCalls, 2);
  assert.equal(result.result.retrieval.chunkCount, 1);
  const disabled = {
    ...conversation,
    messages: [{ role: "user", content: "想学英语" }],
    capabilities: { plugins: [], skills: [] },
  };
  await runMessage(disabled, {
    knowledge: {
      retrieve: async () => assert.fail("unmounted plugin cannot retrieve"),
    },
    persist: async () => {},
    agent: {
      run: async (_job, context) => {
        assert.equal(context.knowledge.available, false);
        return response();
      },
    },
  });
});

test("unavailable workbench retrieval is explicit and does not expose provider details", async () => {
  const value = await retrieveLabKnowledge(
    {
      retrieve: async () => {
        throw new Error("private-provider-detail");
      },
    },
    "目标",
    "conversation-owner",
  );
  assert.equal(value.available, false);
  assert.equal(value.reason, "knowledge_unavailable");
  assert.ok(!JSON.stringify(value).includes("private"));
});
