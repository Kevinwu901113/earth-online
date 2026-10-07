import { parseArgs } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { createKnowledge } from "./index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    backend: { type: "string" },
    namespace: { type: "string" },
    "data-dir": { type: "string" },
    "model-cache": { type: "string" },
    origin: { type: "string" },
    user: { type: "string" },
    url: { type: "string" },
    title: { type: "string" },
    tags: { type: "string" },
  },
});
const [command, argument] = positionals;
const namespace = values.namespace ?? "main";
const service = createKnowledge({
  namespace,
  backend: values.backend ?? process.env.RAG_BACKEND ?? "pgvector",
  databaseUrl: process.env.DATABASE_URL,
  dataDir: resolve(
    values["data-dir"] ?? process.env.RAG_DATA_DIR ?? "var/knowledge",
  ),
  model: process.env.RAG_MODEL,
  modelCacheDir: resolve(
    values["model-cache"] ?? process.env.RAG_MODEL_CACHE_DIR ?? "var/models",
  ),
  sourceOrigin:
    values.origin ??
    (namespace === "workbench"
      ? `http://127.0.0.1:${process.env.LAB_PORT ?? 3188}`
      : (process.env.APP_ORIGIN ?? "http://localhost:3000")),
});
try {
  if (command === "setup") console.log(JSON.stringify(await service.setup()));
  else if (command === "seed")
    console.log(JSON.stringify(await service.seedBuiltin()));
  else if (command === "status")
    console.log(
      JSON.stringify(await service.status({ userId: values.user ?? null })),
    );
  else if (command === "search" && argument) {
    const result = await service.retrieve(argument, {
      userId: values.user ?? null,
    });
    // Explicit search preview. Never print imported full documents or vectors.
    console.log(
      JSON.stringify(
        {
          ...result,
          chunks: result.chunks.map(({ id, title, url, score, text }) => ({
            id,
            title,
            url,
            score,
            excerpt: text.slice(0, 200),
          })),
        },
        null,
        2,
      ),
    );
    if (!result.available) process.exitCode = 1;
  } else if (command === "import" && argument) {
    const extension = extname(argument).toLowerCase();
    if (
      ![".json", ".md", ".txt"].includes(extension) ||
      (await stat(argument)).size > 2 * 1024 * 1024
    )
      throw new Error("knowledge_import_format");
    const content = await readFile(argument, "utf8");
    const raw =
      extension === ".json"
        ? JSON.parse(content)
        : {
            title:
              values.title ??
              content.match(/^#\s+(.+)$/m)?.[1] ??
              basename(argument, extension),
            content,
            url: values.url ?? null,
            tags: values.tags?.split(",").filter(Boolean) ?? [],
          };
    const docs = Array.isArray(raw) ? raw : [raw];
    if (docs.length > 200) throw new Error("knowledge_import_limit");
    const results = [];
    for (const doc of docs)
      results.push(
        await service.importDocument(doc, { ownerId: values.user ?? null }),
      );
    console.log(
      JSON.stringify({ imported: results.length, documents: results }),
    );
  } else if (command === "remove" && argument)
    console.log(
      JSON.stringify({
        removed: await service.deleteDocument(argument, {
          userId: values.user ?? null,
        }),
      }),
    );
  else {
    console.log(
      "npm run knowledge -- setup|seed|status|search '目标描述'|import 文件.md|remove 文档ID [--user 用户ID]",
    );
    process.exitCode = 1;
  }
} catch {
  console.error(
    "Knowledge command failed. Check the database/pgvector, model cache and document format; no credentials or private document values are logged.",
  );
  process.exitCode = 1;
} finally {
  await service.close();
}
