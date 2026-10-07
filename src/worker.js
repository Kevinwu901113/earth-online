import { createClient } from "redis";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { config as getConfig } from "./config.js";
import { makePool } from "./db.js";
import { Repository } from "./repository.js";
import { DshAgent } from "./agent.js";
import { failureFor } from "./agent-output.js";
import { DomainError } from "./domain.js";
import { createKnowledge } from "@earth-online/planning-rag";
import { planningQuery, retrieveKnowledge } from "./planning-context.js";
export async function runOne(
  repo,
  agent,
  timeoutMs = 120000,
  signal,
  knowledge,
) {
  signal?.throwIfAborted();
  await repo.expire();
  const job = await repo.claim(timeoutMs);
  if (!job) return false;
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) abort.abort();
  const watcher = setInterval(async () => {
    try {
      const current = await repo.job(job.user_id, job.id);
      if (current.status === "cancelled" || current.status === "failed")
        abort.abort();
    } catch {
      abort.abort();
    }
  }, 1000);
  try {
    const context = await repo.context(job.user_id, job);
    context.standards = (
      await repo.pool.query("SELECT id,version,body FROM public_standards")
    ).rows;
    if (["route", "chat"].includes(job.kind))
      context.knowledge = await retrieveKnowledge(
        knowledge,
        planningQuery(job, context),
        job.user_id,
        { signal: abort.signal },
      );
    const out = await agent.run(job, context, abort.signal);
    await repo.finish(job, out);
  } catch (e) {
    const failure =
      e instanceof DomainError
        ? { code: "domain_rejected", phase: "settlement", message: e.message }
        : failureFor(e);
    const failed = await repo.fail(job, failure);
    if (failed)
      console.error(
        JSON.stringify({
          event: "agent.failure",
          jobId: job.id,
          kind: job.kind,
          ...failure,
        }),
      );
  } finally {
    clearInterval(watcher);
    signal?.removeEventListener("abort", onAbort);
  }
  return true;
}
async function main() {
  const cfg = getConfig(),
    pool = makePool(cfg.DATABASE_URL),
    cache = createClient({ url: cfg.REDIS_URL, disableOfflineQueue: true });
  cache.on("error", () => console.error("Redis unavailable"));
  await cache.connect();
  const repo = new Repository(pool, cache),
    agent = new DshAgent(cfg),
    knowledge =
      cfg.RAG_ENABLED === "true"
        ? createKnowledge({
            backend: cfg.RAG_BACKEND,
            databaseUrl: cfg.DATABASE_URL,
            dataDir: cfg.RAG_DATA_DIR,
            model: cfg.RAG_MODEL,
            modelCacheDir: cfg.RAG_MODEL_CACHE_DIR,
            namespace: "main",
            sourceOrigin: cfg.APP_ORIGIN,
          })
        : null,
    stop = new AbortController();
  for (const sig of ["SIGTERM", "SIGINT"])
    process.once(sig, () => stop.abort());
  try {
    while (!stop.signal.aborted) {
      try {
        const worked = await runOne(
          repo,
          agent,
          cfg.DSH_TIMEOUT_MS,
          stop.signal,
          knowledge,
        );
        if (!worked) await delay(500, undefined, { signal: stop.signal });
      } catch (e) {
        if (stop.signal.aborted) break;
        console.error("Worker iteration failed");
        await delay(1500);
      }
    }
  } finally {
    await knowledge?.close();
    await cache.close();
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
