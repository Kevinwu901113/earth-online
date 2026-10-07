import { sourceSchema } from "./schemas.js";

const maxChars = 7200;
const topK = 6;
const unavailable = (reason) => ({
  available: false,
  reason,
  chunks: [],
  sources: [],
  untrusted: true,
});

export function planningQuery(job, context) {
  if (job.kind === "route") {
    const goal = context.goals?.find(
      (g) => g.id === job.input.goalId && !g.deletedAt,
    );
    return goal
      ? [goal.title, goal.base, goal.criterion, job.input.reason]
          .filter(Boolean)
          .join("\n")
          .slice(0, 500)
      : "";
  }
  if (job.kind === "chat")
    return (
      context.messages?.find(
        (m) => m.id === job.input.messageId && m.role === "user",
      )?.content ?? ""
    ).slice(0, 500);
  return "";
}

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
      backend: ["file", "pgvector"].includes(result?.backend)
        ? result.backend
        : null,
    };
  const validSources = new Map();
  for (const value of (Array.isArray(result.sources)
    ? result.sources
    : []
  ).slice(0, topK)) {
    const source = sourceSchema.safeParse(value);
    if (source.success) validSources.set(source.data.url, source.data);
  }
  let remaining = maxChars;
  const chunks = [];
  for (const value of (Array.isArray(result.chunks) ? result.chunks : []).slice(
    0,
    topK,
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
        : "main",
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
    backend: result.backend === "pgvector" ? "pgvector" : "file",
    untrusted: true,
    index,
    chunks,
    sources: [...validSources.values()].filter((source) =>
      urls.has(source.url),
    ),
    ...(chunks.length ? {} : { reason: "no_matches" }),
  };
}

export async function retrieveKnowledge(
  service,
  query,
  userId,
  { signal, timeoutMs = 20000 } = {},
) {
  signal?.throwIfAborted();
  if (!service) return unavailable("disabled");
  if (!query?.trim()) return unavailable("no_query");
  const retrievalAbort = new AbortController();
  let timer, onAbort;
  try {
    const interrupted = new Promise((_, reject) => {
      timer = setTimeout(() => {
        retrievalAbort.abort();
        reject(new Error("retrieval_timeout"));
      }, timeoutMs);
      onAbort = () => {
        retrievalAbort.abort();
        reject(signal.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const result = await Promise.race([
      service.retrieve(query.slice(0, 500), {
        userId,
        topK,
        maxChars,
        signal: retrievalAbort.signal,
      }),
      interrupted,
    ]);
    signal?.throwIfAborted();
    return knowledgeSnapshot(result);
  } catch {
    signal?.throwIfAborted();
    return unavailable("knowledge_unavailable");
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
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
