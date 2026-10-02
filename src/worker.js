import { createClient } from "redis";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { config as getConfig } from "./config.js";
import { makePool } from "./db.js";
import { Repository } from "./repository.js";
import { DshAgent } from "./agent.js";
export async function runOne(repo, agent, timeoutMs = 120000, signal) {
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
    const out = await agent.run(job, context, abort.signal);
    await repo.finish(job, out);
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "agent.failure",
        jobId: job.id,
        kind: job.kind,
        error: e.name,
        code: e.code ?? null,
      }),
    );
    const message = e.message?.includes("凭据")
      ? "模型服务尚未配置；内容已保存。"
      : e.message?.includes("超时")
        ? "模型执行超时；内容已保存，可重试。"
        : "生成或评估未完成；内容已保存，请检查模型服务后重试。";
    await repo.fail(job, message);
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
        );
        if (!worked) await delay(500, undefined, { signal: stop.signal });
      } catch (e) {
        if (stop.signal.aborted) break;
        console.error("Worker iteration failed");
        await delay(1500);
      }
    }
  } finally {
    await cache.close();
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
