import { skillFixture } from "../skill-fixture.js";
// Test-only server: real HTTP, Postgres, Redis and worker; deterministic model fixture.
// This entrypoint is never copied into the production image.
import { setTimeout as delay } from "node:timers/promises";
import { makePool, migrate } from "../../src/db.js";
import { config } from "../../src/config.js";
import { buildApp } from "../../src/app.js";
import { Repository } from "../../src/repository.js";
import { createClient } from "redis";
import { runOne } from "../../src/worker.js";
import { outputFromRun } from "../../src/agent-output.js";
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
const limitedSubmissions = new Set();
const agent = {
  run: async (job, context) => {
    if (job.kind === "skills") return skillFixture(job, context);
    if (job.kind === "route" && context.goals[0]?.title === "删除规划中的任务")
      await delay(800);
    if (job.kind === "route" && context.goals[0]?.title === "校验失败后重试") {
      await delay(1800);
      if (job.input.reason === "首次规划")
        return {
          summary: "失败夹具",
          minutes: 20,
          stat: 0,
          stages: [
            {
              name: "阶段",
              criterion: "标准",
              exercise: "练习",
              steps: ["不符合契约"],
              challenge: "挑战",
            },
          ],
          sources: [],
        };
    }
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
            actions: [
              { name: "列出三个要点", minutes: 5 },
              { name: "写成完整段落", minutes: 15 },
            ],
            steps: "先用自己的话写出背景、经历和目标。",
            challenge: "独立写完整段落",
            standardId: null,
            standardVersion: null,
          },
        ],
        sources: [],
      };
    if (job.kind === "assessment") {
      if (context.goals[0]?.title === "评估失败后重试") {
        await delay(1200);
        if (!limitedSubmissions.has(job.input.submissionId)) {
          limitedSubmissions.add(job.input.submissionId);
          return outputFromRun("assessment", {
            finalResponse: "",
            events: [
              { type: "turn/end", data: { reason: { kind: "max-tokens" } } },
            ],
          });
        }
      }
      return {
        outcome: "passed",
        feedback: "提交中包含三个具体要点。",
        quotes: ["I study design."],
        evidenceType: "text",
        standardId: null,
        standardVersion: null,
      };
    }
    if (job.kind === "chat") {
      await delay(600);
      const goal = context.goals.find(
        (g) => !g.deletedAt && g.status === "active",
      );
      const blocks = goal?.stages[goal.stage]?.actions?.length
        ? goal.stages[goal.stage].actions
        : [
            { name: "列出三个要点", minutes: 5 },
            { name: "写成完整段落", minutes: 15 },
          ];
      const command = goal
        ? {
            type: "plan.batch",
            goal: goal.id,
            stage: goal.stage,
            revision: goal.revision,
            day: new Intl.DateTimeFormat("en-CA", {
              timeZone: "Asia/Shanghai",
            }).format(new Date()),
            time: "16:00",
            blocks,
          }
        : {
            type: "goal.create",
            kind: "side",
            title: "完成一篇短文",
            base: "从三个要点开始",
            minutes: 20,
            criterion: "写出包含三个要点的完整段落",
            requiresExternal: false,
          };
      return {
        reply: "我看到你的真实记录。可以先留一点休息时间。",
        guidance: {
          title: "把今天拆成两小步",
          summary: "先完成要点，再写完整段落。",
          steps: blocks.slice(0, 6).map((block) => ({
            title: block.name,
            minutes: block.minutes,
            kind: goal?.kind ?? "side",
          })),
        },
        proposals: [{ label: "安排这几个小步骤", command }],
      };
    }
    return { summary: "今天有一条真实投入记录。没有新增能力认证。" };
  },
};
await app.listen({ port: 3101, host: "127.0.0.1" });
process.send?.({ type: "ready" });
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
