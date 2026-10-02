// Test-only server: real HTTP, Postgres, Redis and worker; deterministic model fixture.
// This entrypoint is never copied into the production image.
import { setTimeout as delay } from "node:timers/promises";
import { makePool, migrate } from "../../src/db.js";
import { config } from "../../src/config.js";
import { buildApp } from "../../src/app.js";
import { Repository } from "../../src/repository.js";
import { createClient } from "redis";
import { runOne } from "../../src/worker.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Requires isolated *_test database");
const pool = makePool(url),
  cache = createClient({
    url: process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379",
  });
cache.on("error", () => {});
await cache.connect();
await migrate(pool);
const cfg = config({
    DATABASE_URL: url,
    REDIS_URL: "unused",
    APP_ORIGIN: "http://127.0.0.1:3101",
    NODE_ENV: "test",
  }),
  app = await buildApp({ pool, cache, config: cfg }),
  repo = new Repository(pool, cache);
const agent = {
  run: async (job) => {
    if (job.kind === "route")
      return {
        summary: "测试路线：写出要点，再独立形成段落。",
        minutes: 20,
        stat: 0,
        stages: [
          {
            name: "完成一段介绍",
            criterion: "包含背景、经历和目标",
            exercise: "写三个要点",
            steps: "先用自己的话写出背景、经历和目标。",
            challenge: "独立写完整段落",
            standardId: null,
            standardVersion: null,
          },
        ],
        sources: [],
      };
    if (job.kind === "assessment")
      return {
        outcome: "passed",
        feedback: "提交中包含三个具体要点。",
        quotes: ["I study design."],
        evidenceType: "text",
        standardId: null,
        standardVersion: null,
      };
    if (job.kind === "chat")
      return {
        reply: "我看到你的真实记录。可以先留一点休息时间。",
        proposals: [],
      };
    return { summary: "今天有一条真实投入记录。没有新增能力认证。" };
  },
};
await app.listen({ port: 3101, host: "127.0.0.1" });
let stopped = false;
process.once("SIGTERM", () => {
  stopped = true;
});
process.once("SIGINT", () => {
  stopped = true;
});
while (!stopped) {
  await runOne(repo, agent);
  await delay(100);
}
await app.close();
await cache.close();
await pool.end();
