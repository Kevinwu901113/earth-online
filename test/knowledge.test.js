import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledge, chunkText } from "../packages/planning-rag/index.js";

const fixtureEmbedding = {
  key: "fixture-semantic-512",
  async embed(text) {
    const vector = Array(512).fill(0);
    vector[/学习|阅读|单词/.test(text) ? 0 : 1] = 1;
    return vector;
  },
};
async function fixture(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "earth-knowledge-"));
  const options = {
    dataDir,
    embedding: fixtureEmbedding,
    autoSeed: false,
    sourceOrigin: "http://localhost:3000",
  };
  const kb = createKnowledge(options);
  try {
    await fn(kb, options);
  } finally {
    await kb.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
const doc = (id, content = "学习阅读，每天复习单词。") => ({
  id,
  title: id,
  content,
  tags: ["目标"],
  url: "https://example.org/" + id,
});

test("semantic index persists, bounds chunks and emits only real indexed sources", () =>
  fixture(async (kb, options) => {
    await kb.setup();
    const large = doc("reading", "学习阅读，每天复习单词。".repeat(100));
    assert.equal((await kb.importDocument(large)).unchanged, false);
    assert.equal((await kb.importDocument(large)).unchanged, true);
    await kb.importDocument(doc("exercise", "身体锻炼，运动热身。"));
    const out = await createKnowledge(options).retrieve("学习单词", {
      topK: 3,
      maxChars: 500,
    });
    assert.equal(out.available, true);
    assert.equal(out.chunks[0].documentId, "reading");
    assert.ok(out.chunks.length <= 3);
    assert.ok(out.chunks.reduce((n, c) => n + c.text.length, 0) <= 500);
    assert.ok(out.chunks.filter((c) => c.documentId === "reading").length <= 2);
    assert.equal(out.sources[0].url, "https://example.org/reading");
    assert.ok(!JSON.stringify(out).includes('"vector"'));
    assert.equal(
      (await stat(join(options.dataDir, "main.json"))).mode & 0o777,
      0o600,
    );
  }));

test("retrieval and document URLs isolate owners and independent namespaces", () =>
  fixture(async (kb, options) => {
    await kb.importDocument(doc("shared"));
    await kb.importDocument(
      { ...doc("alice-secret"), url: null },
      { ownerId: "alice" },
    );
    await kb.importDocument(doc("bob-secret"), { ownerId: "bob" });
    const out = await kb.retrieve("学习单词", { userId: "alice" });
    assert.ok(out.chunks.some((c) => c.documentId === "alice-secret"));
    assert.ok(out.chunks.some((c) => c.documentId === "shared"));
    assert.ok(out.chunks.every((c) => c.documentId !== "bob-secret"));
    assert.equal(await kb.getDocument("alice-secret", { userId: "bob" }), null);
    const own = await kb.getDocument("alice-secret", { userId: "alice" });
    assert.equal(own.url, "http://localhost:3000/api/knowledge/alice-secret");
    assert.equal(own.ownerId, undefined);
    assert.equal(own.chunks, undefined);
    assert.equal(await kb.deleteDocument("shared", { userId: "alice" }), false);
    await assert.rejects(() =>
      kb.importDocument(doc("alice-secret"), { ownerId: "bob" }),
    );
    const lab = createKnowledge({ ...options, namespace: "workbench" });
    assert.equal((await lab.status()).documents, 0);
    await lab.importDocument(
      { ...doc("own-lab"), url: null },
      { ownerId: "conversation-a" },
    );
    assert.equal(
      (await lab.getDocument("own-lab", { userId: "conversation-a" })).url,
      "http://localhost:3000/api/knowledge/own-lab?conversation=conversation-a",
    );
    assert.equal((await kb.status()).documents, 1);
  }));

test("model keys prevent mixed embedding spaces and concurrent file imports preserve both documents", () =>
  fixture(async (kb, options) => {
    await Promise.all([
      kb.importDocument(doc("one")),
      kb.importDocument(doc("two")),
    ]);
    assert.equal((await kb.status()).documents, 2);
    const changed = createKnowledge({
      ...options,
      embedding: { ...fixtureEmbedding, key: "another-model" },
    });
    assert.equal(
      (await changed.retrieve("学习单词")).reason,
      "knowledge_index_empty",
    );
    await changed.importDocument(doc("one"));
    const output = await changed.retrieve("学习单词");
    assert.deepEqual(
      output.chunks.map((c) => c.documentId),
      ["one"],
    );
  }));

test("retrieval reports storage errors without secrets, and rejects unbounded inputs", async () => {
  const kb = createKnowledge({
    embedding: fixtureEmbedding,
    store: {
      status: async () => {
        throw new Error("postgres://secret:password@example.test/private");
      },
      close: async () => {},
    },
  });
  const output = await kb.retrieve("目标规划");
  assert.equal(output.available, false);
  assert.ok(!JSON.stringify(output).includes("password"));
  await assert.rejects(() => kb.retrieve("文".repeat(501)));
  await assert.rejects(() => kb.retrieve("目标", { topK: 999 }));
  await assert.rejects(() =>
    kb.importDocument({ ...doc("unsafe"), url: "file:///etc/passwd" }),
  );
  assert.ok(chunkText("😀".repeat(500)).every((s) => !s.includes("\ufffd")));
});
