import test from "node:test";
import assert from "node:assert/strict";
import {
  planningQuery,
  knowledgeSnapshot,
  retrieveKnowledge,
  retrievalSummary,
} from "../src/planning-context.js";
import {
  verifiedSources,
  validateOutput,
  AgentError,
} from "../src/agent-output.js";
import { runOne } from "../src/worker.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { hash } from "../src/repository.js";

const source = {
  title: "真实学习资料",
  url: "https://example.org/learning",
  note: "知识库规划参考",
  retrievedAt: "2026-10-07T00:00:00.000Z",
};
const result = () => ({
  available: true,
  backend: "pgvector",
  index: { name: "main", documentCount: 1, chunkCount: 1 },
  sources: [source],
  chunks: [
    {
      id: "chunk-1",
      documentId: "doc-1",
      title: source.title,
      url: source.url,
      text: "阅读后写出三条要点。",
      score: 0.7,
      retrievedAt: source.retrievedAt,
    },
  ],
});

test("planning retrieval uses the requested goal or user message, never task identifiers or assessment evidence", () => {
  const context = {
    goals: [
      {
        id: "goal-id",
        title: "练习阅读",
        base: "能读简单文章",
        criterion: "独立总结",
      },
    ],
    messages: [
      { id: "old", role: "user", content: "旧问题" },
      { id: "message-id", role: "user", content: "想写出清楚的总结" },
      { id: "last", role: "assistant", content: "模型回复" },
    ],
  };
  assert.equal(
    planningQuery({ kind: "route", input: { goalId: "goal-id" } }, context),
    "练习阅读\n能读简单文章\n独立总结",
  );
  assert.equal(
    planningQuery(
      { kind: "chat", input: { messageId: "message-id" } },
      context,
    ),
    "想写出清楚的总结",
  );
  assert.equal(
    planningQuery(
      { kind: "assessment", input: { submissionId: "id" } },
      context,
    ),
    "",
  );
  context.goals[0].deletedAt = "2026-10-07";
  assert.equal(
    planningQuery({ kind: "route", input: { goalId: "goal-id" } }, context),
    "",
  );
});

test("retrieved context is bounded and admits citations only for actual returned chunks", () => {
  const raw = result();
  raw.sources.push({ ...source, url: "https://example.org/unused" });
  raw.chunks = Array.from({ length: 20 }, (_, i) => ({
    ...raw.chunks[0],
    id: String(i),
    text: "文".repeat(10000),
    arbitrary: "do not preserve",
  }));
  const snapshot = knowledgeSnapshot(raw);
  assert.ok(snapshot.chunks.length <= 6);
  assert.ok(
    snapshot.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) <= 7200,
  );
  assert.deepEqual(snapshot.sources, [source]);
  assert.equal(snapshot.untrusted, true);
  assert.ok(!JSON.stringify(snapshot).includes("arbitrary"));
  const summary = retrievalSummary(snapshot);
  assert.equal(summary.hitCount, snapshot.chunks.length);
  assert.deepEqual(summary.index, raw.index);
  assert.ok(!JSON.stringify(summary).includes("text"));
  assert.equal(
    knowledgeSnapshot({
      ...result(),
      sources: [{ ...source, url: "javascript:alert(1)" }],
    }).chunks.length,
    0,
  );
});

test("retrieval is user scoped, bounded and safely degrades on unavailable services", async () => {
  let received;
  const service = {
    retrieve: async (query, options) => {
      received = { query, options };
      return result();
    },
  };
  assert.equal(
    (await retrieveKnowledge(service, "目标".repeat(400), "user-one")).chunks
      .length,
    1,
  );
  assert.equal(received.query.length, 500);
  assert.equal(received.options.userId, "user-one");
  assert.equal(received.options.topK, 6);
  assert.equal(received.options.maxChars, 7200);
  assert.equal(
    (await retrieveKnowledge(null, "目标", "user-one")).reason,
    "disabled",
  );
  const failed = await retrieveKnowledge(
    {
      retrieve: async () => {
        throw new Error("private-provider-detail");
      },
    },
    "目标",
    "user-one",
  );
  assert.equal(failed.reason, "knowledge_unavailable");
  assert.ok(!JSON.stringify(failed).includes("private"));
  const timed = await retrieveKnowledge(
    { retrieve: () => new Promise(() => {}) },
    "目标",
    "user-one",
    { timeoutMs: 5 },
  );
  assert.equal(timed.available, false);
  const abort = new AbortController();
  const pending = retrieveKnowledge(
    { retrieve: () => new Promise(() => {}) },
    "目标",
    "user-one",
    { signal: abort.signal },
  );
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("guidance citations survive display projection but remain source verified", () => {
  const guidance = {
    title: "阅读练习",
    summary: "先做一小步。",
    steps: [{ title: "读一段", minutes: 10, kind: "main" }],
    sources: [
      {
        ...source,
        title: "模型自行命名",
        retrievedAt: "2020-01-01T00:00:00.000Z",
      },
    ],
  };
  const out = validateOutput("chat", {
    reply: "可以试试。",
    guidance: { ...guidance, explanation: "额外说明" },
  });
  assert.deepEqual(out.guidance.sources, guidance.sources);
  assert.deepEqual(verifiedSources(out.guidance.sources, [source]), [source]);
  assert.throws(
    () =>
      verifiedSources(
        [{ ...source, url: "https://example.org/forged" }],
        [source],
      ),
    AgentError,
  );
  const noTimestamp = { ...source };
  delete noTimestamp.retrievedAt;
  assert.equal(
    verifiedSources(guidance.sources, [noTimestamp])[0].retrievedAt,
    undefined,
  );
  assert.throws(
    () =>
      validateOutput("chat", {
        reply: "建议",
        guidance: {
          ...guidance,
          sources: [{ ...source, url: "javascript:alert(1)" }],
        },
      }),
    AgentError,
  );
});

test("worker injects only current-account planning retrieval and excludes assessment", async () => {
  const goal = {
    id: "goal-id",
    title: "阅读",
    base: "初学",
    criterion: "总结",
  };
  let seen,
    retrievalCalls = 0,
    finishCalls = 0;
  const knowledge = {
    retrieve: async (_query, options) => {
      retrievalCalls++;
      assert.equal(options.userId, "user-one");
      return result();
    },
  };
  const repo = {
    expire: async () => {},
    claim: async () => ({
      id: "job-id",
      user_id: "user-one",
      kind: "route",
      input: { goalId: goal.id },
    }),
    context: async () => ({ goals: [goal] }),
    pool: { query: async () => ({ rows: [] }) },
    finish: async () => {
      finishCalls++;
    },
    fail: async () => {
      assert.fail("unexpected worker failure");
    },
  };
  await runOne(
    repo,
    {
      run: async (_job, context) => {
        seen = context;
        return {};
      },
    },
    120000,
    undefined,
    knowledge,
  );
  assert.equal(seen.knowledge.sources[0].url, source.url);
  assert.equal(retrievalCalls, 1);
  repo.claim = async () => ({
    id: "assessment-job",
    user_id: "user-one",
    kind: "assessment",
    input: {},
  });
  await runOne(
    repo,
    {
      run: async (_job, context) => {
        seen = context;
        return {};
      },
    },
    120000,
    undefined,
    knowledge,
  );
  assert.equal(seen.knowledge, undefined);
  assert.equal(retrievalCalls, 1);
  assert.equal(finishCalls, 2);
});

test("knowledge source endpoint requires login and passes the current account to document lookup", async () => {
  const lookups = [];
  const pool = {
    query: async (_sql, params) => ({
      rows:
        params[0] === hash("owned-session")
          ? [{ id: "user-one", email: "one@example.invalid" }]
          : [{ id: "user-two", email: "two@example.invalid" }],
    }),
  };
  const knowledge = {
    getDocument: async (id, { userId }) => {
      lookups.push({ id, userId });
      return userId === "user-one"
        ? {
            id,
            title: "私人资料",
            content: "只属于本账号的正文",
            ownerId: userId,
            vectors: [1, 2],
          }
        : null;
    },
    close: async () => {},
  };
  const app = await buildApp({
    pool,
    cache: {},
    config: config({
      DATABASE_URL: "unused",
      REDIS_URL: "unused",
      RAG_ENABLED: "false",
    }),
    knowledge,
  });
  try {
    assert.equal(
      (await app.inject({ url: "/api/knowledge/doc-1" })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/knowledge/doc-1",
          headers: { cookie: "earth_session=other-session" },
        })
      ).statusCode,
      404,
    );
    const own = await app.inject({
      url: "/api/knowledge/doc-1",
      headers: { cookie: "earth_session=owned-session" },
    });
    assert.equal(own.statusCode, 200);
    assert.equal(own.json().text, "只属于本账号的正文");
    assert.equal(own.json().ownerId, undefined);
    assert.equal(own.json().vectors, undefined);
    assert.equal(own.headers["cache-control"], "no-store");
    for (const invalidId of ["_leading", "-leading", "a".repeat(101), "bad.id"])
      assert.equal(
        (
          await app.inject({
            url: `/api/knowledge/${invalidId}`,
            headers: { cookie: "earth_session=owned-session" },
          })
        ).statusCode,
        404,
        invalidId,
      );
    assert.deepEqual(lookups, [
      { id: "doc-1", userId: "user-two" },
      { id: "doc-1", userId: "user-one" },
    ]);
  } finally {
    await app.close();
  }
});
