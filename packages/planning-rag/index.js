import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  localEmbedding,
  validVector,
  DEFAULT_MODEL,
  DIMENSIONS,
} from "./embedding.js";
import { FileStore, PgStore } from "./stores.js";
import {
  buildQueryPlan,
  CANDIDATE_LIMIT,
  MIN_SEMANTIC_SCORE,
  fuseCandidates,
  diverseCandidates,
  matchedExcerpt,
  rankLexicalCandidates,
} from "./retrieval.js";
export { DEFAULT_MODEL, DIMENSIONS };

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const owner = id.nullable();
const documentSchema = z
  .object({
    id: id.optional(),
    title: z.string().trim().min(1).max(200),
    url: z
      .url()
      .refine((value) => {
        const u = new URL(value);
        return (
          ["https:", "http:"].includes(u.protocol) && !u.username && !u.password
        );
      })
      .nullable()
      .optional(),
    content: z.string().trim().min(1).max(100000),
    tags: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
  })
  .strict();

export function chunkText(text, size = 400, overlap = 50) {
  const chars = Array.from(text.replace(/\r\n?/g, "\n").trim());
  const chunks = [];
  for (let start = 0; start < chars.length; start += size - overlap) {
    const chunk = chars
      .slice(start, start + size)
      .join("")
      .trim();
    if (chunk) chunks.push(chunk);
    if (start + size >= chars.length) break;
  }
  return chunks;
}
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createKnowledge(options = {}) {
  const backend = options.backend ?? "file";
  if (!["file", "pgvector"].includes(backend))
    throw new Error("knowledge_backend_invalid");
  const namespace = id.parse(options.namespace ?? "main");
  const base = new URL(options.sourceOrigin ?? "http://localhost:3000");
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password
  )
    throw new Error("knowledge_origin_invalid");
  const sourceOrigin = base.origin;
  const embedding = options.embedding ?? localEmbedding(options);
  const modelKey = embedding.key;
  if (typeof modelKey !== "string" || !modelKey)
    throw new Error("knowledge_model_invalid");
  const store =
    options.store ??
    (backend === "file"
      ? new FileStore({
          dataDir: options.dataDir ?? "var/knowledge",
          namespace,
        })
      : new PgStore({ databaseUrl: options.databaseUrl, namespace }));
  let seeding;
  const sourceUrl = (doc) =>
    doc.url ??
    `${sourceOrigin}/api/knowledge/${encodeURIComponent(doc.id)}${namespace === "workbench" && doc.ownerId ? "?conversation=" + encodeURIComponent(doc.ownerId) : ""}`;

  const service = {
    async setup() {
      await store.setup();
      return service.status();
    },
    async importDocument(raw, { ownerId = null } = {}) {
      const doc = documentSchema.parse(raw);
      ownerId = owner.parse(ownerId);
      doc.id ??= randomUUID();
      doc.url ??= null;
      const contentHash = digest({ ...doc, ownerId, modelKey });
      const previous = await store.get(doc.id, ownerId);
      if (previous && previous.ownerId !== ownerId)
        throw new Error("knowledge_owner_mismatch");
      if (previous?.contentHash === contentHash)
        return { id: doc.id, unchanged: true };
      const chunks = [];
      for (const [ordinal, text] of chunkText(doc.content).entries()) {
        const vector = await embedding.embed(
          `${doc.title.slice(0, 60)}\n${doc.tags.join(" ").slice(0, 60)}\n${text}`,
        );
        if (!validVector(vector))
          throw new Error("knowledge_embedding_invalid");
        chunks.push({ id: `${doc.id}:${ordinal}`, text, vector, modelKey });
      }
      await store.upsert({
        ...doc,
        ownerId,
        contentHash,
        chunks,
        updatedAt: new Date().toISOString(),
      });
      return { id: doc.id, chunks: chunks.length, unchanged: false };
    },
    async seedBuiltin() {
      if (!seeding) {
        seeding = (async () => {
          const docs = JSON.parse(
            await readFile(
              new URL("./knowledge/planning.json", import.meta.url),
              "utf8",
            ),
          );
          const results = [];
          for (const doc of docs)
            results.push(await service.importDocument(doc));
          return {
            documents: results.length,
            updated: results.filter((r) => !r.unchanged).length,
          };
        })();
        seeding.catch(() => {
          seeding = undefined;
        });
      }
      return seeding;
    },
    async status({ userId = null } = {}) {
      owner.parse(userId);
      try {
        const counts = await store.status(userId, modelKey);
        return {
          available: true,
          backend,
          namespace,
          model: options.model ?? DEFAULT_MODEL,
          dimensions: DIMENSIONS,
          ...counts,
        };
      } catch {
        return {
          available: false,
          backend,
          namespace,
          reason: "knowledge_not_ready",
          documents: 0,
          chunks: 0,
        };
      }
    },
    async getDocument(documentId, { userId = null } = {}) {
      id.parse(documentId);
      owner.parse(userId);
      const doc = await store.get(documentId, userId);
      if (!doc) return null;
      const { ownerId, contentHash, ...publicDoc } = doc;
      return { ...publicDoc, url: sourceUrl(doc) };
    },
    async deleteDocument(documentId, { userId = null } = {}) {
      id.parse(documentId);
      owner.parse(userId);
      return store.remove(documentId, userId);
    },
    async retrieve(
      query,
      {
        userId = null,
        topK = 6,
        maxChars = 7200,
        signal,
        queryVariants = [],
      } = {},
    ) {
      query = z.string().trim().min(1).max(500).parse(query);
      owner.parse(userId);
      topK = z.number().int().min(1).max(8).parse(topK);
      maxChars = z.number().int().min(100).max(10000).parse(maxChars);
      queryVariants = z
        .array(z.string().trim().min(1).max(500))
        .max(2)
        .parse(queryVariants);
      signal?.throwIfAborted();
      try {
        let status = await service.status({ userId });
        if (!status.available)
          return { ...status, query, chunks: [], sources: [] };
        if (!status.documents && options.autoSeed !== false) {
          await service.seedBuiltin();
          status = await service.status({ userId });
        }
        if (!status.chunks)
          return {
            ...status,
            query,
            reason: "knowledge_index_empty",
            chunks: [],
            sources: [],
          };
        const plan = buildQueryPlan(query, queryVariants);
        const [semanticResult, lexicalResult] = await Promise.allSettled([
          (async () => {
            const vector = await embedding.embed(query, { query: true });
            if (!validVector(vector))
              throw new Error("knowledge_embedding_invalid");
            signal?.throwIfAborted();
            return store.search(vector, userId, modelKey, CANDIDATE_LIMIT);
          })(),
          store.searchLexical
            ? store.searchLexical(plan, userId, modelKey, CANDIDATE_LIMIT)
            : Promise.resolve(null),
        ]);
        signal?.throwIfAborted();
        const semantic =
          semanticResult.status === "fulfilled" ? semanticResult.value : [];
        const lexical =
          lexicalResult.status === "fulfilled" && lexicalResult.value !== null
            ? lexicalResult.value
            : rankLexicalCandidates(semantic, plan);
        if (
          semanticResult.status === "rejected" &&
          lexicalResult.status === "rejected"
        )
          throw new Error("knowledge_candidates_unavailable");
        if (semanticResult.status === "rejected" && !lexical.length)
          throw new Error("knowledge_embedding_unavailable");
        const candidates = diverseCandidates(
          fuseCandidates(semantic, lexical, plan),
        );
        const chunks = [],
          perDoc = new Map();
        let characters = 0;
        const retrievedAt = new Date().toISOString();
        for (const candidate of candidates) {
          if ((perDoc.get(candidate.documentId) ?? 0) >= 2) continue;
          const remaining = maxChars - characters;
          if (remaining < 1 || chunks.length >= topK) break;
          const text = matchedExcerpt(candidate, Math.min(400, remaining));
          if (!text) continue;
          const url = sourceUrl({
            id: candidate.documentId,
            url: candidate.url,
            ownerId: candidate.ownerId,
          });
          chunks.push({
            id: candidate.id,
            documentId: candidate.documentId,
            title: candidate.title,
            url,
            text,
            // Preserve cosine score for consumers; fusionScore controls hybrid ranking.
            score: candidate.semanticScore ?? 0,
            fusionScore: candidate.fusionScore,
            lexicalScore: candidate.lexical.score,
            matchedBy: candidate.matchedBy,
            matchedTerms: candidate.lexical.matchedTerms,
            retrievedAt,
          });
          perDoc.set(
            candidate.documentId,
            (perDoc.get(candidate.documentId) ?? 0) + 1,
          );
          characters += text.length;
        }
        const sources = [
          ...new Map(
            chunks.map((c) => [
              c.url,
              {
                title: c.title,
                url: c.url,
                note: "知识库中的规划参考；请结合用户实际情况使用。",
                retrievedAt,
              },
            ]),
          ).values(),
        ];
        return {
          available: true,
          backend,
          namespace,
          query,
          untrusted: true,
          model: options.model ?? DEFAULT_MODEL,
          chunks,
          sources,
          ...(chunks.length ? {} : { reason: "no_matches" }),
          retrieval: {
            method: "hybrid-rrf",
            semanticAvailable: semanticResult.status === "fulfilled",
            lexicalAvailable:
              lexicalResult.status === "fulfilled" &&
              lexicalResult.value !== null,
            semanticCandidates: semantic.length,
            lexicalCandidates: lexical.length,
            queryVariants: queryVariants.length,
            minSemanticScore: MIN_SEMANTIC_SCORE,
          },
          index: {
            name: namespace,
            documentCount: status.documents,
            chunkCount: status.chunks,
          },
        };
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        return {
          available: false,
          backend,
          namespace,
          query,
          reason: "knowledge_retrieval_failed",
          chunks: [],
          sources: [],
        };
      }
    },
    async close() {
      await store.close();
    },
  };
  return service;
}
