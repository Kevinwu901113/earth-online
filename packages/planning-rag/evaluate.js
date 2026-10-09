// Offline, isolated retrieval regression benchmark; no .env, API key or real account.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledge } from "./index.js";
import { FileStore } from "./stores.js";
import { localEmbedding, DEFAULT_MODEL } from "./embedding.js";
import {
  evaluationDocuments,
  evaluationQueries,
  evaluationEmbedding,
} from "../../test/fixtures/planning-rag-eval.js";

const dataDir = await mkdtemp(join(tmpdir(), "earth-rag-eval-"));
const real = process.argv.includes("--real");
if (real) {
  const { env } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
}
const embedding = real ? localEmbedding() : evaluationEmbedding;
const knowledge = createKnowledge({ dataDir, embedding, autoSeed: false });
const store = new FileStore({ dataDir, namespace: "main" });
const samples = [];
function metrics(results) {
  const answerable = results.filter((row) => row.expected.length);
  const empty = results.filter((row) => !row.expected.length);
  const mean = (values) =>
    values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
  return {
    top1Accuracy: mean(
      answerable.map((row) => Number(row.expected.includes(row.retrieved[0]))),
    ),
    mrr: mean(
      answerable.map((row) => {
        const rank = row.retrieved.findIndex((id) => row.expected.includes(id));
        return rank < 0 ? 0 : 1 / (rank + 1);
      }),
    ),
    recallAt3: mean(
      answerable.map(
        (row) =>
          row.expected.filter((id) => row.retrieved.includes(id)).length /
          row.expected.length,
      ),
    ),
    noMatchAccuracy: mean(empty.map((row) => Number(!row.retrieved.length))),
  };
}
try {
  for (const doc of evaluationDocuments) await knowledge.importDocument(doc);
  for (const fixture of evaluationQueries) {
    const vector = await embedding.embed(fixture.query, { query: true });
    const baseline = await store.search(vector, null, embedding.key, 48);
    const hybrid = await knowledge.retrieve(fixture.query, { topK: 3 });
    samples.push({
      name: fixture.name,
      expected: fixture.expected,
      semantic: [...new Set(baseline.map((row) => row.documentId))].slice(0, 3),
      hybrid: [...new Set(hybrid.chunks.map((row) => row.documentId))].slice(
        0,
        3,
      ),
    });
  }
  const semantic = metrics(
    samples.map((row) => ({ expected: row.expected, retrieved: row.semantic })),
  );
  const hybrid = metrics(
    samples.map((row) => ({ expected: row.expected, retrieved: row.hybrid })),
  );
  console.log(
    JSON.stringify(
      {
        synthetic: !real,
        ...(real ? { model: DEFAULT_MODEL, offline: true } : {}),
        cases: samples.length,
        semantic,
        hybrid,
        samples,
      },
      null,
      2,
    ),
  );
  if (
    hybrid.top1Accuracy !== 1 ||
    hybrid.recallAt3 !== 1 ||
    hybrid.noMatchAccuracy !== 1
  )
    process.exitCode = 1;
} finally {
  await knowledge.close();
  await rm(dataDir, { recursive: true, force: true });
}
