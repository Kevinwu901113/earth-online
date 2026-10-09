import { mkdir, readFile, open, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  compareIds,
  rankLexicalCandidates,
  candidateWindow,
  termPattern,
  isNameTerm,
  LEXICAL_SCAN_LIMIT,
  CANDIDATES_PER_DOCUMENT,
} from "./retrieval.js";

const visible = (doc, userId) => doc.ownerId === null || doc.ownerId === userId;
const cosine = (a, b) => {
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] ** 2;
    bb += b[i] ** 2;
  }
  return dot / Math.sqrt(aa * bb);
};

export class FileStore {
  constructor({ dataDir, namespace }) {
    this.dir = resolve(dataDir);
    this.path = join(this.dir, `${namespace}.json`);
    this.lock = join(this.dir, `${namespace}.lock`);
  }
  async read() {
    try {
      if ((await stat(this.path)).size > 64 * 1024 * 1024)
        throw new Error("knowledge_index_too_large");
      const data = JSON.parse(await readFile(this.path, "utf8"));
      if (data.schema !== 1 || !Array.isArray(data.documents))
        throw new Error("knowledge_index_invalid");
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return { schema: 1, documents: [] };
      throw error;
    }
  }
  async write(fn) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    let lock;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        lock = await open(this.lock, "wx", 0o600);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        await delay(100);
      }
    }
    if (!lock) throw new Error("knowledge_index_busy");
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const data = await this.read();
      const result = await fn(data);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(data));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
      return result;
    } finally {
      await rm(temporary, { force: true });
      await lock.close();
      await rm(this.lock, { force: true });
    }
  }
  async setup() {
    await this.write(() => {});
  }
  async upsert(doc) {
    return this.write((data) => {
      const existing = data.documents.find((d) => d.id === doc.id);
      if (existing && existing.ownerId !== doc.ownerId)
        throw new Error("knowledge_owner_mismatch");
      data.documents = data.documents.filter((d) => d.id !== doc.id);
      data.documents.push(doc);
    });
  }
  async remove(id, userId) {
    return this.write((data) => {
      const existing = data.documents.find((d) => d.id === id);
      if (!existing || existing.ownerId !== userId) return false;
      data.documents = data.documents.filter((d) => d.id !== id);
      return true;
    });
  }
  async get(id, userId) {
    const doc = (await this.read()).documents.find(
      (d) => d.id === id && visible(d, userId),
    );
    if (!doc) return null;
    const { chunks, ...metadata } = doc;
    return metadata;
  }
  async status(userId, modelKey) {
    const docs = (await this.read()).documents.filter((d) =>
      visible(d, userId),
    );
    return {
      documents: docs.length,
      chunks: docs
        .flatMap((d) => d.chunks)
        .filter((c) => c.modelKey === modelKey).length,
    };
  }
  async search(vector, userId, modelKey, limit) {
    const docs = (await this.read()).documents.filter((d) =>
      visible(d, userId),
    );
    return candidateWindow(
      docs
        .flatMap((doc) =>
          doc.chunks
            .filter((c) => c.modelKey === modelKey)
            .map((c) => ({
              ...c,
              ownerId: doc.ownerId,
              documentId: doc.id,
              title: doc.title,
              url: doc.url,
              tags: doc.tags,
              score: cosine(vector, c.vector),
            })),
        )
        .sort((a, b) => b.score - a.score || compareIds(a.id, b.id)),
      limit,
    );
  }
  async searchLexical(plan, userId, modelKey, limit) {
    if (!plan.terms.length) return [];
    const candidates = (await this.read()).documents
      .filter((doc) => visible(doc, userId))
      .flatMap((doc) =>
        doc.chunks
          .filter((chunk) => chunk.modelKey === modelKey)
          .map((chunk) => ({
            ...chunk,
            ownerId: doc.ownerId,
            documentId: doc.id,
            title: doc.title,
            url: doc.url,
            tags: doc.tags,
          })),
      );
    return rankLexicalCandidates(candidates, plan, limit);
  }
  async close() {}
}

export class PgStore {
  constructor({ databaseUrl, namespace }) {
    this.databaseUrl = databaseUrl;
    this.namespace = namespace;
  }
  async connection() {
    if (!this.pool) {
      const { default: pg } = await import("pg");
      this.pool = new pg.Pool({
        connectionString: this.databaseUrl,
        max: 2,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
      });
      this.pool.on("error", () => {});
    }
    return this.pool;
  }
  async setup() {
    const pool = await this.connection();
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS earth_knowledge_documents (
        namespace text NOT NULL, id text NOT NULL, owner_id text,
        title text NOT NULL, url text, content text NOT NULL, tags jsonb NOT NULL,
        content_hash text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (namespace,id)
      );
      CREATE TABLE IF NOT EXISTS earth_knowledge_chunks (
        namespace text NOT NULL, document_id text NOT NULL, ordinal integer NOT NULL,
        content text NOT NULL, model_key text NOT NULL, embedding vector(512) NOT NULL,
        PRIMARY KEY(namespace,document_id,ordinal),
        FOREIGN KEY(namespace,document_id) REFERENCES earth_knowledge_documents(namespace,id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS earth_knowledge_scope ON earth_knowledge_documents(namespace,owner_id);
      CREATE INDEX IF NOT EXISTS earth_knowledge_embedding ON earth_knowledge_chunks USING hnsw(embedding vector_cosine_ops);
    `);
  }
  async upsert(doc) {
    const c = await (await this.connection()).connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        this.namespace + ":" + doc.id,
      ]);
      const old = await c.query(
        "SELECT owner_id FROM earth_knowledge_documents WHERE namespace=$1 AND id=$2 FOR UPDATE",
        [this.namespace, doc.id],
      );
      if (old.rows.length && old.rows[0].owner_id !== doc.ownerId)
        throw new Error("knowledge_owner_mismatch");
      await c.query(
        `INSERT INTO earth_knowledge_documents(namespace,id,owner_id,title,url,content,tags,content_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(namespace,id) DO UPDATE
        SET title=excluded.title,url=excluded.url,content=excluded.content,tags=excluded.tags,content_hash=excluded.content_hash,updated_at=now()`,
        [
          this.namespace,
          doc.id,
          doc.ownerId,
          doc.title,
          doc.url,
          doc.content,
          JSON.stringify(doc.tags),
          doc.contentHash,
        ],
      );
      await c.query(
        "DELETE FROM earth_knowledge_chunks WHERE namespace=$1 AND document_id=$2",
        [this.namespace, doc.id],
      );
      for (const [ordinal, chunk] of doc.chunks.entries())
        await c.query(
          "INSERT INTO earth_knowledge_chunks(namespace,document_id,ordinal,content,model_key,embedding) VALUES($1,$2,$3,$4,$5,$6::vector)",
          [
            this.namespace,
            doc.id,
            ordinal,
            chunk.text,
            chunk.modelKey,
            JSON.stringify(chunk.vector),
          ],
        );
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
  async remove(id, userId) {
    return (
      (
        await (
          await this.connection()
        ).query(
          "DELETE FROM earth_knowledge_documents WHERE namespace=$1 AND id=$2 AND owner_id IS NOT DISTINCT FROM $3 RETURNING id",
          [this.namespace, id, userId],
        )
      ).rowCount === 1
    );
  }
  async get(id, userId) {
    const row = (
      await (
        await this.connection()
      ).query(
        `SELECT id,owner_id AS "ownerId",title,url,content,tags,content_hash AS "contentHash",updated_at AS "updatedAt"
      FROM earth_knowledge_documents WHERE namespace=$1 AND id=$2 AND (owner_id IS NULL OR owner_id=$3)`,
        [this.namespace, id, userId],
      )
    ).rows[0];
    return row ?? null;
  }
  async status(userId, modelKey) {
    const pool = await this.connection();
    const row = (
      await pool.query(
        `SELECT count(DISTINCT d.id)::int AS documents,count(c.ordinal)::int AS chunks
      FROM earth_knowledge_documents d LEFT JOIN earth_knowledge_chunks c
      ON c.namespace=d.namespace AND c.document_id=d.id AND c.model_key=$3
      WHERE d.namespace=$1 AND (d.owner_id IS NULL OR d.owner_id=$2)`,
        [this.namespace, userId, modelKey],
      )
    ).rows[0];
    return row;
  }
  async search(vector, userId, modelKey, limit) {
    const rows = (
      await (
        await this.connection()
      ).query(
        `WITH scoped AS MATERIALIZED (
          SELECT c.document_id AS "documentId",c.ordinal,c.content AS text,c.embedding,d.title,d.url,d.tags,d.owner_id AS "ownerId"
          FROM earth_knowledge_chunks c JOIN earth_knowledge_documents d ON d.namespace=c.namespace AND d.id=c.document_id
          WHERE c.namespace=$1 AND (d.owner_id IS NULL OR d.owner_id=$2) AND c.model_key=$4
        ), ranked AS (
          SELECT *,row_number() OVER (PARTITION BY "documentId" ORDER BY embedding <=> $3::vector,ordinal::text COLLATE "C") AS document_rank FROM scoped
        ) SELECT *,1-(embedding <=> $3::vector) AS score FROM ranked WHERE document_rank<=$6
        ORDER BY embedding <=> $3::vector,("documentId" || ':' || ordinal::text) COLLATE "C" LIMIT $5`,
        [
          this.namespace,
          userId,
          JSON.stringify(vector),
          modelKey,
          limit,
          CANDIDATES_PER_DOCUMENT,
        ],
      )
    ).rows;
    return rows.map(({ embedding: _vector, ...r }) => ({
      ...r,
      id: `${r.documentId}:${r.ordinal}`,
    }));
  }
  async searchLexical(plan, userId, modelKey, limit) {
    if (!plan.terms.length) return [];
    // Native PostgreSQL regexes work for Chinese without a tokenizer extension.
    // Scoping is materialized first; neither rank nor candidate limits see another owner.
    const rows = (
      await (
        await this.connection()
      ).query(
        `
      WITH scoped AS MATERIALIZED (
        SELECT c.document_id AS "documentId",c.ordinal,c.content AS text,d.title,d.url,d.tags,d.owner_id AS "ownerId",
          lower(normalize(d.title,NFKC)) AS title_text,
          lower(normalize(COALESCE((SELECT string_agg(t.tag,' ') FROM jsonb_array_elements_text(d.tags) AS t(tag)),''),NFKC)) AS tag_text,
          lower(normalize(c.content,NFKC)) AS body_text
        FROM earth_knowledge_chunks c JOIN earth_knowledge_documents d ON d.namespace=c.namespace AND d.id=c.document_id
        WHERE c.namespace=$1 AND (d.owner_id IS NULL OR d.owner_id=$2) AND c.model_key=$3
      ), weighted AS (
        SELECT *, (SELECT sum(4 * (title_text ~ pattern)::int + 3 * (tag_text ~ pattern)::int + (body_text ~ pattern)::int)
          FROM unnest($4::text[]) AS p(pattern)) AS lexical_score FROM scoped
      ), eligible AS (
        SELECT * FROM weighted WHERE lexical_score>0 AND (
          EXISTS(SELECT 1 FROM unnest($8::text[]) AS p(pattern) WHERE title_text ~ pattern OR tag_text ~ pattern)
          OR EXISTS(SELECT 1 FROM jsonb_array_elements($6::jsonb) AS g(terms) WHERE
            (SELECT count(*) FROM jsonb_array_elements_text(g.terms) AS p(pattern) WHERE title_text ~ pattern OR tag_text ~ pattern OR body_text ~ pattern)::float / jsonb_array_length(g.terms) >= 0.34)
        )
      ), ranked AS (
        SELECT *,row_number() OVER (PARTITION BY "documentId" ORDER BY lexical_score DESC,ordinal::text COLLATE "C") AS document_rank FROM eligible
      ) SELECT "documentId",ordinal,text,title,url,tags,"ownerId" FROM ranked WHERE document_rank<=$7
      ORDER BY lexical_score DESC,("documentId" || ':' || ordinal::text) COLLATE "C" LIMIT $5`,
        [
          this.namespace,
          userId,
          modelKey,
          plan.terms.map(termPattern),
          LEXICAL_SCAN_LIMIT,
          JSON.stringify(plan.groups.map((group) => group.map(termPattern))),
          CANDIDATES_PER_DOCUMENT,
          plan.terms.filter(isNameTerm).map(termPattern),
        ],
      )
    ).rows;
    return rankLexicalCandidates(
      rows.map((r) => ({ ...r, id: `${r.documentId}:${r.ordinal}` })),
      plan,
      limit,
    );
  }
  async close() {
    await this.pool?.end();
  }
}
