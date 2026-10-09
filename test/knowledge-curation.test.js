import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledge } from "../packages/planning-rag/index.js";

const documents = JSON.parse(
  await readFile(
    new URL(
      "../packages/planning-rag/knowledge/planning.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const audit = JSON.parse(
  await readFile(
    new URL(
      "../packages/planning-rag/knowledge/source-review.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const originalIds = [
  "goal-criteria-and-near-steps",
  "implementation-if-then-plan",
  "learning-retrieval-and-spacing",
  "progress-record-and-adjust",
  "habit-context-and-repetition",
  "clarify-needs-and-check-sources",
  "ielts-official-practice-entry",
  "anki-recall-tool-boundary",
];
const primaryHosts = new Set([
  "med.stanford.edu",
  "www.socmot.uni-konstanz.de",
  "www.psychologicalscience.org",
  "pubmed.ncbi.nlm.nih.gov",
  "onlinelibrary.wiley.com",
  "www.ala.org",
  "ielts.org",
  "docs.ankiweb.net",
  "lsc.cornell.edu",
  "owl.purdue.edu",
  "learnenglish.britishcouncil.org",
  "www.coe.int",
  "developer.mozilla.org",
  "docs.python.org",
  "git-scm.com",
  "reflection.ed.ac.uk",
  "sre.google",
]);
const scenarios = (doc) =>
  doc.content
    .split(/\n\n/)
    .filter((paragraph) => /^原创情景[一二]（不是研究结果）：/.test(paragraph));

test("curated seed preserves compatible documents and has varied actionable scenarios", () => {
  assert.ok(documents.length >= 26);
  assert.ok(documents.length - originalIds.length >= 18);
  assert.equal(new Set(documents.map((doc) => doc.id)).size, documents.length);
  for (const id of originalIds)
    assert.ok(
      documents.some((doc) => doc.id === id),
      id,
    );
  const allScenarios = [];
  for (const doc of documents) {
    assert.deepEqual(
      Object.keys(doc).sort(),
      ["content", "id", "tags", "title", "url"],
      doc.id,
    );
    assert.match(doc.id, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
    assert.ok(doc.title.length > 0 && doc.title.length <= 200, doc.id);
    assert.ok(doc.tags.length > 0 && doc.tags.length <= 12, doc.id);
    assert.equal(new Set(doc.tags).size, doc.tags.length, doc.id);
    assert.ok(
      doc.tags.every(
        (tag) => typeof tag === "string" && tag.trim() && tag.length <= 60,
      ),
      doc.id,
    );
    const url = new URL(doc.url);
    assert.equal(url.protocol, "https:", doc.id);
    assert.ok(primaryHosts.has(url.hostname), doc.id);
    assert.equal(url.username + url.password, "", doc.id);
    assert.ok(doc.content.length >= 600 && doc.content.length <= 1100, doc.id);
    assert.ok(
      doc.content.split(/\n\n/).every((paragraph) => paragraph.length <= 400),
      doc.id,
    );
    assert.match(doc.content, /方法与适用边界：/);
    assert.match(doc.content, /执行步骤（应用设计）：/);
    assert.match(doc.content, /核对与限制：/);
    assert.match(doc.content, /调度提示（应用设计）：/);
    const examples = scenarios(doc);
    assert.equal(examples.length, 2, doc.id);
    for (const example of examples) {
      assert.match(example, /用户/);
      assert.match(example, /\d+分钟/);
      assert.match(example, /安排/);
      assert.match(example, /成果/);
      assert.match(example, /复盘/);
      assert.match(
        example,
        /已有|现有|已取得|已确认|已得到|已写|已下载|已用|没有|未给|未确认|未核查|待确认|愿意提供|提供了|用户已在|用户写了/,
      );
      allScenarios.push(
        example.replace(/^原创情景[一二]（不是研究结果）：/, ""),
      );
    }
  }
  assert.ok(allScenarios.length >= 40);
  assert.equal(new Set(allScenarios).size, allScenarios.length);
  for (const category of [
    "目标拆解",
    "实施意图",
    "习惯",
    "复习",
    "写作",
    "英语",
    "编程",
    "时间管理",
    "项目",
    "复盘",
  ]) {
    assert.ok(
      documents.some((doc) => doc.tags.includes(category)),
      category,
    );
  }
});

test("each seed has a verified primary review and rejected candidates remain outside the index", () => {
  assert.equal(audit.schemaVersion, "earth.knowledge.review.v1");
  assert.match(audit.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
  const accepted = audit.sources.filter(
    (source) => source.decision === "accepted",
  );
  const rejected = audit.sources.filter(
    (source) => source.decision === "rejected",
  );
  assert.equal(accepted.length, documents.length);
  assert.ok(rejected.length >= 2 && rejected.length <= 4);
  assert.equal(audit.counts.accepted, accepted.length);
  assert.equal(audit.counts.rejected, rejected.length);
  assert.equal(
    audit.counts.originalScenarios,
    documents.reduce((count, doc) => count + scenarios(doc).length, 0),
  );
  assert.equal(
    new Set(accepted.map((source) => source.documentId)).size,
    accepted.length,
  );
  for (const doc of documents) {
    const source = accepted.find((entry) => entry.documentId === doc.id);
    assert.ok(source, doc.id);
    assert.equal(source.url, doc.url, doc.id);
    assert.equal(source.title, doc.title, doc.id);
    for (const key of [
      "publisher",
      "type",
      "whyUseful",
      "limits",
      "adaptation",
    ])
      assert.ok(source[key]?.trim(), `${doc.id}:${key}`);
    assert.match(source.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(
      ["web_read", "official_api_read"].includes(source.verification.method),
      doc.id,
    );
    assert.ok(source.verification.checkedSections.length > 0, doc.id);
    assert.equal(new URL(source.verification.readUrl).protocol, "https:");
    assert.notEqual(source.verification.scope, "unverified", doc.id);
  }
  for (const source of rejected) {
    assert.equal(source.documentId, null);
    assert.ok(source.limits.length > 20);
    assert.ok(!documents.some((doc) => doc.url === source.url));
  }
  const abstract = accepted.find(
    (source) => source.documentId === "progress-record-and-adjust",
  );
  assert.equal(abstract.verification.scope, "official_api_abstract");
  assert.equal(
    new URL(abstract.verification.readUrl).hostname,
    "eutils.ncbi.nlm.nih.gov",
  );
});

test("manual seed upgrades old shared content without overwriting private documents", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "earth-curation-"));
  const options = {
    backend: "file",
    dataDir,
    autoSeed: false,
    embedding: {
      key: "curation-fixture-512",
      async embed() {
        const vector = Array(512).fill(0);
        vector[0] = 1;
        return vector;
      },
    },
  };
  const kb = createKnowledge(options);
  let reloaded;
  try {
    await kb.setup();
    await kb.importDocument({
      ...documents[0],
      content: "旧种子版本，尚无新的原创案例。",
    });
    await kb.importDocument(
      {
        id: "personal-note",
        title: "个人学习笔记",
        content: "私人材料应在更新共享种子后继续保留。",
        tags: ["个人"],
      },
      { ownerId: "curation-user" },
    );
    const result = await kb.seedBuiltin();
    assert.equal(result.documents, documents.length);
    assert.equal(result.updated, documents.length);
    assert.equal(
      (await kb.getDocument(documents[0].id)).content,
      documents[0].content,
    );
    assert.equal(
      (await kb.getDocument("personal-note", { userId: "curation-user" }))
        .content,
      "私人材料应在更新共享种子后继续保留。",
    );
    assert.equal(await kb.getDocument("personal-note"), null);
    reloaded = createKnowledge(options);
    const unchanged = await reloaded.seedBuiltin();
    assert.equal(unchanged.updated, 0);
    assert.equal((await reloaded.status()).documents, documents.length);
    assert.equal(
      (await reloaded.status({ userId: "curation-user" })).documents,
      documents.length + 1,
    );
  } finally {
    await kb.close();
    await reloaded?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
