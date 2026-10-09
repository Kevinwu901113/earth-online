import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledge } from "../packages/planning-rag/index.js";
import { FileStore } from "../packages/planning-rag/stores.js";
import {
  axis,
  evaluationDocuments,
  evaluationQueries,
  evaluationEmbedding,
} from "./fixtures/planning-rag-eval.js";

async function withKnowledge(fn, embedding = evaluationEmbedding) {
  const dataDir = await mkdtemp(join(tmpdir(), "earth-hybrid-"));
  const options = { dataDir, embedding, autoSeed: false };
  const kb = createKnowledge(options);
  try {
    await fn(kb, options);
  } finally {
    await kb.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
const document = (id, title, content = title, tags = []) => ({
  id,
  title,
  content,
  tags,
  url: null,
});

test("one weak title word does not rescue an unrelated multi-term query", () =>
  withKnowledge(async (_kb, options) => {
    const embedding = {
      key: "weak-title-512",
      embed: async (_text, { query = false } = {}) => axis(query ? 1 : 0),
    };
    const kb = createKnowledge({ ...options, embedding });
    await kb.importDocument(
      document("reading", "阅读理解与证据", "从文章定位支持答案的证据。"),
    );
    const result = await kb.retrieve(
      "地球磁场反转的地质证据与熔岩样品年代测定原理是什么？",
    );
    assert.equal(result.available, true);
    assert.equal(result.reason, "no_matches");
    assert.deepEqual(result.chunks, []);
    assert.deepEqual(result.sources, []);
    assert.equal(
      (await kb.retrieve("阅读证据")).chunks[0].documentId,
      "reading",
    );
  }));

test("hybrid retrieves exact Chinese and English topics despite misleading semantic ranking", () =>
  withKnowledge(async (kb) => {
    for (const doc of evaluationDocuments) await kb.importDocument(doc);
    for (const fixture of evaluationQueries) {
      const result = await kb.retrieve(fixture.query, { topK: 3 });
      assert.equal(result.available, true);
      if (fixture.expected.length)
        assert.ok(
          fixture.expected.includes(result.chunks[0].documentId),
          fixture.name,
        );
      else {
        assert.equal(result.reason, "no_matches");
        assert.deepEqual(result.chunks, []);
        assert.deepEqual(result.sources, []);
      }
      assert.equal(result.retrieval.method, "hybrid-rrf");
      assert.ok(!JSON.stringify(result).includes('"vector"'));
      for (const chunk of result.chunks) {
        assert.ok(Number.isFinite(chunk.score));
        assert.ok(chunk.fusionScore > 0);
        assert.ok(result.sources.some((source) => source.url === chunk.url));
        assert.ok(
          evaluationDocuments
            .find((doc) => doc.id === chunk.documentId)
            .content.includes(chunk.text),
        );
      }
    }
  }));

test("lexical candidate window rescues a named tool outside the semantic top 48", () =>
  withKnowledge(async (kb, options) => {
    const broad = {
      key: "window-512",
      embed: async (text, { query = false } = {}) =>
        query || text.startsWith("普通") ? axis(0) : axis(1),
    };
    const service = createKnowledge({ ...options, embedding: broad });
    for (let i = 0; i < 55; i++)
      await service.importDocument(
        document(
          "noise-" + String(i).padStart(3, "0"),
          "普通计划",
          "把事项分成步骤。",
        ),
      );
    await service.importDocument(
      document("named-tool", "Anki 复习", "使用 Anki 制作问题卡片。"),
    );
    const baseline = await new FileStore({
      dataDir: options.dataDir,
      namespace: "main",
    }).search(axis(0), null, broad.key, 48);
    assert.ok(baseline.every((chunk) => chunk.documentId !== "named-tool"));
    const result = await service.retrieve("Anki");
    assert.equal(result.chunks[0].documentId, "named-tool");
    assert.deepEqual(result.chunks[0].matchedBy, ["lexical"]);
    assert.equal(result.chunks[0].score, 0);
  }));

test("candidate diversity survives a long document monopolizing both rankings", () =>
  withKnowledge(async (kb) => {
    await kb.importDocument(
      document("aa-long", "阅读", "阅读时写下段落要点。".repeat(5000)),
    );
    await kb.importDocument(
      document("bb-short", "阅读", "阅读后用自己的话回忆内容。"),
    );
    await kb.importDocument(
      document("cc-short", "阅读", "阅读时先提出一个问题。"),
    );
    const result = await kb.retrieve("阅读", { topK: 4 });
    assert.equal(
      new Set(result.chunks.slice(0, 3).map((chunk) => chunk.documentId)).size,
      3,
    );
    assert.ok(
      result.chunks.filter((chunk) => chunk.documentId === "aa-long").length <=
        2,
    );
  }));

test("lexical candidates isolate private owners, anonymous readers and namespaces", () =>
  withKnowledge(async (kb, options) => {
    const embedding = {
      key: "lexical-owners-512",
      embed: async (_text, { query = false } = {}) => axis(query ? 1 : 0),
    };
    const main = createKnowledge({ ...options, embedding });
    await main.importDocument(
      document("alice-doc", "private marker", "Alice private marker 内容"),
      { ownerId: "alice" },
    );
    await main.importDocument(
      document("bob-doc", "private marker", "Bob private marker 内容"),
      { ownerId: "bob" },
    );
    const lab = createKnowledge({
      ...options,
      embedding,
      namespace: "workbench",
    });
    await lab.importDocument(document("lab-doc", "private marker"), {
      ownerId: "alice",
    });
    assert.deepEqual(
      (await main.retrieve("private marker", { userId: "alice" })).chunks.map(
        (chunk) => chunk.documentId,
      ),
      ["alice-doc"],
    );
    assert.deepEqual(
      (await main.retrieve("private marker", { userId: "bob" })).chunks.map(
        (chunk) => chunk.documentId,
      ),
      ["bob-doc"],
    );
    assert.deepEqual((await main.retrieve("private marker")).chunks, []);
    const labResult = await lab.retrieve("private marker", { userId: "alice" });
    assert.equal(labResult.chunks[0].documentId, "lab-doc");
    assert.ok(labResult.sources[0].url.endsWith("?conversation=alice"));
  }));

test("variants add an independent lexical intent without extra embedding calls", () =>
  withKnowledge(async (kb, options) => {
    let calls = 0;
    const embedding = {
      ...evaluationEmbedding,
      embed: async (...args) => {
        calls++;
        return evaluationEmbedding.embed(...args);
      },
    };
    const service = createKnowledge({ ...options, embedding });
    for (const doc of evaluationDocuments) await service.importDocument(doc);
    calls = 0;
    const result = await service.retrieve("Anki", {
      queryVariants: ["Python"],
      topK: 3,
    });
    assert.equal(calls, 1);
    assert.ok(result.chunks.some((chunk) => chunk.documentId === "anki"));
    assert.ok(result.chunks.some((chunk) => chunk.documentId === "python"));
    assert.equal(result.retrieval.queryVariants, 1);
    await assert.rejects(() =>
      service.retrieve("Anki", { queryVariants: ["a", "b", "c"] }),
    );
  }));

test("small character budget selects the matching original span without splitting Unicode", () =>
  withKnowledge(async (kb) => {
    const content =
      "😀".repeat(100) +
      "背景说明。".repeat(30) +
      "Anki 间隔复习的关键是主动回忆。";
    await kb.importDocument(document("late-match", "记忆材料", content));
    const result = await kb.retrieve("Anki", { maxChars: 100 });
    assert.ok(result.chunks[0].text.includes("Anki"));
    assert.ok(content.includes(result.chunks[0].text));
    assert.ok(
      result.chunks.reduce((count, chunk) => count + chunk.text.length, 0) <=
        100,
    );
    assert.ok(
      result.chunks.every(
        (chunk) => !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(chunk.text),
      ),
    );
  }));

test("lexical retrieval remains useful when query embedding fails, with explicit degraded metadata", () =>
  withKnowledge(async (kb, options) => {
    const embedding = {
      key: "offline-512",
      embed: async (_text, { query = false } = {}) => {
        if (query) throw new Error("private provider configuration");
        return axis(0);
      },
    };
    const service = createKnowledge({ ...options, embedding });
    await service.importDocument(
      document("python", "Python 函数", "写一个带参数和返回值的函数。"),
    );
    const result = await service.retrieve("Python");
    assert.equal(result.available, true);
    assert.equal(result.retrieval.semanticAvailable, false);
    assert.equal(result.chunks[0].documentId, "python");
    assert.ok(!JSON.stringify(result).includes("provider"));
    assert.equal((await service.retrieve("火星矿石开采")).available, false);
  }));

test("semantic paraphrases can match without lexical overlap, but cannot fill six unrelated slots", () =>
  withKnowledge(async (kb, options) => {
    const embedding = {
      key: "paraphrase-512",
      embed: async (text, { query = false } = {}) =>
        query || text.startsWith("复习") ? axis(0) : axis(1),
    };
    const service = createKnowledge({ ...options, embedding });
    for (let i = 0; i < 5; i++)
      await service.importDocument(
        document("related-" + i, "复习安排", "隔一段时间回忆，逐渐延长间隔。"),
      );
    await service.importDocument(
      document("unrelated", "旅行材料", "收拾背包。"),
    );
    const result = await service.retrieve("隔多久再次测验", { topK: 6 });
    assert.equal(result.chunks.length, 2);
    assert.ok(
      result.chunks.every(
        (chunk) =>
          chunk.matchedBy.includes("semantic") && chunk.lexicalScore === 0,
      ),
    );
  }));
