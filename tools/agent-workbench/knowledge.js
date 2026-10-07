import { createKnowledge } from "@earth-online/planning-rag";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { sourceSchema } from "./current/src/schemas.js";

export const labDataDir = fileURLToPath(new URL("./var/", import.meta.url));
let service;
export function getLabKnowledge(env = process.env) {
  if (env.RAG_ENABLED === "false") return null;
  return (service ??= createKnowledge({
    backend: "file",
    dataDir: resolve(labDataDir, "knowledge"),
    modelCacheDir: resolve(labDataDir, "models"),
    model: env.RAG_MODEL ?? "Xenova/bge-small-zh-v1.5",
    namespace: "workbench",
    sourceOrigin: `http://127.0.0.1:${Number(env.LAB_PORT || 3188)}`,
  }));
}
export async function closeLabKnowledge() {
  await service?.close();
  service = undefined;
}

const unavailable = (reason) => ({
  available: false,
  reason,
  chunks: [],
  sources: [],
  untrusted: true,
});
export function knowledgeSnapshot(result) {
  if (!result?.available)
    return {
      ...unavailable(
        [
          "disabled",
          "knowledge_not_ready",
          "knowledge_index_empty",
          "knowledge_retrieval_failed",
        ].includes(result?.reason)
          ? result.reason
          : "knowledge_unavailable",
      ),
      backend: "file",
    };
  const validSources = new Map();
  for (const value of (Array.isArray(result.sources)
    ? result.sources
    : []
  ).slice(0, 6)) {
    const source = sourceSchema.safeParse(value);
    if (source.success) validSources.set(source.data.url, source.data);
  }
  let remaining = 7200;
  const chunks = [];
  for (const value of (Array.isArray(result.chunks) ? result.chunks : []).slice(
    0,
    6,
  )) {
    const source = validSources.get(value?.url);
    if (
      !source ||
      typeof value.text !== "string" ||
      !value.text.trim() ||
      !remaining
    )
      continue;
    const text = value.text.slice(0, Math.min(1600, remaining));
    remaining -= text.length;
    chunks.push({
      id: String(value.id ?? "").slice(0, 120),
      documentId: String(value.documentId ?? "").slice(0, 120),
      title: source.title,
      url: source.url,
      text,
      score: Number.isFinite(value.score) ? value.score : 0,
      retrievedAt: source.retrievedAt,
    });
  }
  const urls = new Set(chunks.map((chunk) => chunk.url));
  const index = {
    name:
      typeof result.index?.name === "string"
        ? result.index.name.slice(0, 80)
        : "workbench",
    documentCount:
      Number.isSafeInteger(result.index?.documentCount) &&
      result.index.documentCount >= 0
        ? result.index.documentCount
        : 0,
    chunkCount:
      Number.isSafeInteger(result.index?.chunkCount) &&
      result.index.chunkCount >= 0
        ? result.index.chunkCount
        : 0,
  };
  return {
    available: true,
    backend: "file",
    untrusted: true,
    index,
    chunks,
    sources: [...validSources.values()].filter((source) =>
      urls.has(source.url),
    ),
    ...(chunks.length ? {} : { reason: "no_matches" }),
  };
}
export async function retrieveLabKnowledge(
  knowledge,
  query,
  userId,
  { timeoutMs = 20000 } = {},
) {
  if (!knowledge) return unavailable("disabled");
  if (!query?.trim()) return unavailable("no_query");
  let timer;
  const abort = new AbortController();
  try {
    return knowledgeSnapshot(
      await Promise.race([
        knowledge.retrieve(query.slice(0, 500), {
          userId,
          topK: 6,
          maxChars: 7200,
          signal: abort.signal,
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error("retrieval_timeout"));
          }, timeoutMs);
        }),
      ]),
    );
  } catch {
    return unavailable("knowledge_unavailable");
  } finally {
    clearTimeout(timer);
  }
}
export function retrievalSummary(snapshot) {
  return {
    available: !!snapshot?.available,
    backend: snapshot?.backend ?? null,
    reason: snapshot?.reason ?? null,
    chunkCount: snapshot?.chunks?.length ?? 0,
    hitCount: snapshot?.chunks?.length ?? 0,
    index: snapshot?.index ?? null,
    sources: snapshot?.sources ?? [],
    untrusted: true,
  };
}
