import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createKnowledge } from "../../packages/planning-rag/index.js";
import { PgStore } from "../../packages/planning-rag/stores.js";
import { buildQueryPlan } from "../../packages/planning-rag/retrieval.js";
import { axis } from "../fixtures/planning-rag-eval.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const embedding = {
  key: "integration-lexical-512",
  embed: async (_text, { query = false } = {}) => axis(query ? 1 : 0),
};
const document = (id, title, content = title, tags = []) => ({
  id,
  title,
  content,
  tags,
  url: null,
});
async function fixture(fn) {
  // Never fall back to DATABASE_URL or an application's .env.
  assert.ok(
    new URL(databaseUrl).pathname.endsWith("_test"),
    "Use a dedicated *_test database",
  );
  const namespace = "hybrid-test-" + randomUUID();
  const otherNamespace = namespace + "-other";
  const cleanup = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  const dataDir = await mkdtemp(join(tmpdir(), "earth-pg-hybrid-"));
  const postgres = createKnowledge({
    backend: "pgvector",
    databaseUrl,
    namespace,
    embedding,
    autoSeed: false,
  });
  const other = createKnowledge({
    backend: "pgvector",
    databaseUrl,
    namespace: otherNamespace,
    embedding,
    autoSeed: false,
  });
  const file = createKnowledge({
    backend: "file",
    dataDir,
    namespace,
    embedding,
    autoSeed: false,
  });
  try {
    await postgres.setup();
    await fn({ postgres, file, other, namespace, cleanup });
  } finally {
    try {
      await cleanup.query(
        "DELETE FROM earth_knowledge_documents WHERE namespace=ANY($1::text[])",
        [[namespace, otherNamespace]],
      );
    } finally {
      await Promise.allSettled([postgres.close(), file.close(), other.close()]);
      await cleanup.end();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

test(
  "real PG16-compatible hybrid matches file results for Unicode, title/tag weighting and literal regex keywords",
  { skip: !databaseUrl },
  () =>
    fixture(async ({ postgres, file, namespace }) => {
      const docs = [
        document("unicode", "Ｐｙｔｈｏｎ 阅读", "Python 参数和返回值。", [
          "阅读",
        ]),
        document("decoy", "Pythonic 或 snakeXcase", "没有实际匹配。"),
        document("underscore", "snake_case", "snake_case 是代码命名格式。"),
        document("literal", "token_%_literal", "token_%_literal 只用于测试。"),
        document("tagged", "活动准备", "先选一小段容易完成的活动。", ["面试"]),
        document("evidence", "阅读理解与证据", "从文章定位支持答案的证据。"),
      ];
      for (const doc of docs) {
        await postgres.importDocument(doc);
        await file.importDocument(doc);
      }
      for (const query of [
        "ＰＹＴＨＯＮ",
        "阅读",
        "snake_case",
        "token_%_literal",
        "面试",
      ]) {
        const actual = await postgres.retrieve(query);
        const expected = await file.retrieve(query);
        assert.equal(actual.available, true);
        assert.deepEqual(
          actual.chunks.map((c) => [c.documentId, c.text, c.lexicalScore]),
          expected.chunks.map((c) => [c.documentId, c.text, c.lexicalScore]),
        );
        assert.ok(actual.chunks.length > 0, query);
        assert.ok(actual.chunks.every((c) => c.documentId !== "decoy"));
      }
      const unrelated = "地球磁场反转的地质证据与熔岩样品年代测定原理是什么？";
      assert.deepEqual((await postgres.retrieve(unrelated)).chunks, []);
      assert.deepEqual((await file.retrieve(unrelated)).chunks, []);
      const store = new PgStore({ databaseUrl, namespace });
      try {
        // SQL uses regex parameters, not LIKE: '%' and '_' must be literal.
        const plan = {
          terms: ["token_%_literal"],
          groups: [["token_%_literal"]],
        };
        assert.deepEqual(
          (await store.searchLexical(plan, null, embedding.key, 48)).map(
            (c) => c.documentId,
          ),
          ["literal"],
        );
        assert.deepEqual(
          await store.searchLexical(
            buildQueryPlan("private' OR 1=1 --"),
            null,
            embedding.key,
            48,
          ),
          [],
        );
      } finally {
        await store.close();
      }
    }),
);

test(
  "real PostgreSQL hybrid retrieval scopes owners and namespaces before either ranking",
  { skip: !databaseUrl },
  () =>
    fixture(async ({ postgres, other }) => {
      await postgres.importDocument(
        document("public", "检索资料", "公共阅读资料。"),
      );
      await postgres.importDocument(
        document("alice", "检索资料", "private marker ALICE_ONLY"),
        { ownerId: "alice" },
      );
      await postgres.importDocument(
        document("bob", "检索资料", "private marker BOB_ONLY"),
        { ownerId: "bob" },
      );
      await other.importDocument(
        document("foreign", "检索资料", "private marker OTHER_NAMESPACE"),
      );
      const own = await postgres.retrieve("private marker", {
        userId: "alice",
      });
      assert.deepEqual(
        own.chunks.map((c) => c.documentId),
        ["alice"],
      );
      assert.ok(!JSON.stringify(own).includes("BOB_ONLY"));
      assert.ok(!JSON.stringify(own).includes("OTHER_NAMESPACE"));
      assert.deepEqual((await postgres.retrieve("private marker")).chunks, []);
      assert.equal(
        await postgres.getDocument("bob", { userId: "alice" }),
        null,
      );
      assert.equal(
        await postgres.getDocument("foreign", { userId: "alice" }),
        null,
      );
    }),
);

test(
  "real PostgreSQL keeps document diversity and exact budgets, and aborted retrieval permits pool close",
  { skip: !databaseUrl },
  () =>
    fixture(async ({ postgres, file, namespace }) => {
      for (const doc of [
        document("aa-long", "阅读", "阅读时写出要点。".repeat(5000)),
        document("bb", "阅读", "阅读后回忆。"),
        document("cc", "阅读", "阅读时提出问题。"),
      ]) {
        await postgres.importDocument(doc);
        await file.importDocument(doc);
      }
      const actual = await postgres.retrieve("阅读", {
        topK: 3,
        maxChars: 600,
      });
      const expected = await file.retrieve("阅读", { topK: 3, maxChars: 600 });
      assert.deepEqual(
        actual.chunks.map((c) => c.id),
        expected.chunks.map((c) => c.id),
      );
      assert.equal(new Set(actual.chunks.map((c) => c.documentId)).size, 3);
      assert.ok(actual.chunks.reduce((n, c) => n + c.text.length, 0) <= 600);
      const interrupted = createKnowledge({
        backend: "pgvector",
        databaseUrl,
        namespace,
        autoSeed: false,
        embedding: {
          ...embedding,
          embed: async (...args) => {
            await new Promise((r) => setTimeout(r, 40));
            return embedding.embed(...args);
          },
        },
      });
      const abort = new AbortController();
      const request = interrupted.retrieve("阅读", { signal: abort.signal });
      setTimeout(() => abort.abort(), 10);
      await assert.rejects(request, (error) => error.name === "AbortError");
      await interrupted.close();
      assert.deepEqual((await postgres.retrieve("火星矿石开采")).chunks, []);
    }),
);
