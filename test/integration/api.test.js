import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { makePool, migrate } from "../../src/db.js";
import { config } from "../../src/config.js";
import { buildApp } from "../../src/app.js";
import { Repository } from "../../src/repository.js";
import { runOne } from "../../src/worker.js";
const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must name a disposable *_test database");
test(
  "PostgreSQL/Redis API: account isolation, durable commands, agent lifecycle and recovery",
  { skip: !url, timeout: 30000 },
  async () => {
    const pool = makePool(url),
      cache = createClient({
        url: process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379",
        disableOfflineQueue: true,
      });
    cache.on("error", () => {});
    await cache.connect();
    await migrate(pool);
    const cfg = config({
        DATABASE_URL: url,
        REDIS_URL: "unused",
        NODE_ENV: "test",
      }),
      app = await buildApp({ pool, cache, config: cfg });
    const repo = new Repository(pool, cache);
    let users = [],
      standardIds = [];
    const headers = {
      origin: cfg.APP_ORIGIN,
      "x-earth-client": "web-v1",
      "content-type": "application/json",
    };
    const req = (method, path, body, cookie, key) =>
      app.inject({
        method,
        url: "/api" + path,
        headers: {
          ...headers,
          ...(cookie ? { cookie } : {}),
          ...(key ? { "idempotency-key": key } : {}),
        },
        ...(body === undefined ? {} : { payload: body }),
      });
    async function account() {
      const email = randomUUID() + "@test.invalid";
      const r = await req("POST", "/auth/register", {
        email,
        password: "test-password-strong",
      });
      assert.equal(r.statusCode, 200, r.body);
      const cookie = r.cookies[0].name + "=" + r.cookies[0].value;
      const me = (await req("GET", "/auth/me", undefined, cookie)).json();
      users.push(me.id);
      return { cookie, id: me.id };
    }
    try {
      const a = await account(),
        b = await account();
      assert.equal((await req("GET", "/state")).statusCode, 401);
      const csrf = await app.inject({
        method: "POST",
        url: "/api/commands",
        headers: {
          ...headers,
          origin: "https://other.invalid",
          cookie: a.cookie,
        },
        payload: {},
      });
      assert.equal(csrf.statusCode, 403);
      const cmd = {
          type: "action.record",
          plan: null,
          goal: null,
          name: "阅读",
          minutes: 20,
          day: new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Shanghai",
          }).format(new Date()),
          stat: 0,
          note: "第一章",
          completion: "done",
        },
        key = randomUUID();
      const responses = await Promise.all([
        req(
          "POST",
          "/commands",
          { expectedVersion: 0, command: cmd },
          a.cookie,
          key,
        ),
        req(
          "POST",
          "/commands",
          { expectedVersion: 0, command: cmd },
          a.cookie,
          key,
        ),
      ]);
      for (const r of responses) assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(responses[0].json(), responses[1].json());
      assert.equal(
        (await req("GET", "/growth", undefined, a.cookie)).json().items.length,
        1,
      );
      assert.equal(
        (await req("GET", "/state", undefined, b.cookie)).json().state.records
          .length,
        0,
      );
      assert.equal(
        (
          await req(
            "POST",
            "/commands",
            { expectedVersion: 1, command: { ...cmd, name: "different" } },
            a.cookie,
            key,
          )
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await req(
            "POST",
            "/commands",
            { expectedVersion: 0, command: cmd },
            a.cookie,
            randomUUID(),
          )
        ).statusCode,
        409,
      );
      async function command(c) {
        const snapshot = (
          await req("GET", "/state", undefined, a.cookie)
        ).json();
        const r = await req(
          "POST",
          "/commands",
          { expectedVersion: snapshot.version, command: c },
          a.cookie,
          randomUUID(),
        );
        assert.equal(r.statusCode, 200, r.body);
        return r.json().result;
      }
      const created = await command({
        type: "goal.create",
        title: "写介绍",
        base: "初学者",
        minutes: 20,
        criterion: "写出背景、经历和目标",
        requiresExternal: false,
      });
      assert.equal(
        (await req("GET", "/jobs/" + created.jobId, undefined, b.cookie))
          .statusCode,
        404,
      );
      const route = {
        summary: "从要点到段落",
        minutes: 20,
        stat: 0,
        stages: [
          {
            name: "完整介绍",
            criterion: "有三个要点",
            exercise: "写段落",
            steps: "列要点再串联",
            challenge: "独立写段落",
            standardId: null,
            standardVersion: null,
          },
        ],
        sources: [],
      };
      await runOne(repo, { run: async () => route });
      let snapshot = await repo.state(a.id);
      assert.equal(snapshot.state.goals[0].status, "draft");
      assert.ok(snapshot.state.goals[0].draft);
      await command({
        type: "goal.confirm",
        id: created.goalId,
        draftId: created.jobId,
      });
      const submitted = await command({
        type: "submission.create",
        goal: created.goalId,
        kind: "challenge",
        content: "I study design. I built a chair. I want to learn more.",
        helpUsed: false,
      });
      await runOne(repo, {
        run: async () => {
          throw new Error("provider failed");
        },
      });
      snapshot = await repo.state(a.id);
      assert.equal(snapshot.state.submissions[0].status, "error");
      assert.ok(snapshot.state.submissions[0].content);
      await command({ type: "submission.retry", id: submitted.submissionId });
      await runOne(repo, {
        run: async () => ({
          outcome: "passed",
          feedback: "包含三个要点",
          quotes: ["I study design."],
          evidenceType: "text",
          standardId: null,
          standardVersion: null,
        }),
      });
      assert.equal((await repo.state(a.id)).state.goals[0].status, "completed");
      const interrupted = await command({
        type: "review.create",
        day: cmd.day,
      });
      const running = await repo.claim(1000);
      assert.equal(running.id, interrupted.jobId);
      await pool.query(
        "UPDATE agent_jobs SET lease_until=now()-interval '1 minute' WHERE id=$1",
        [running.id],
      );
      await repo.expire();
      assert.equal((await repo.job(a.id, running.id)).status, "failed");
      assert.equal(
        await repo.finish(running, { summary: "late output" }),
        false,
      );
      const cancelled = await command({ type: "chat.send", content: "hello" });
      await repo.cancel(a.id, cancelled.jobId);
      assert.equal((await repo.job(a.id, cancelled.jobId)).status, "cancelled");
      const cached = await repo.context(a.id);
      assert.equal(cached.profile.name, "未完待续的我");
      const before = (await repo.state(a.id)).version;
      await command({
        type: "profile.update",
        name: "新的名字",
        daily: 30,
        timezone: "Asia/Shanghai",
        preferences: "无",
      });
      assert.ok((await repo.state(a.id)).version > before);
      assert.equal((await repo.context(a.id)).profile.name, "新的名字");
      const standardId = "test-" + randomUUID();
      standardIds.push(standardId);
      await pool.query(
        "INSERT INTO public_standards(id,version,body) VALUES($1,1,$2)",
        [
          standardId,
          {
            name: "Test",
            criteria: "Fixed",
            questions: [
              {
                id: "q1",
                prompt: "2+2",
                choices: [
                  { id: "a", text: "3" },
                  { id: "b", text: "4" },
                ],
                correctChoice: "b",
                explanation: "2+2=4",
              },
            ],
          },
        ],
      );
      const standards = (
        await req("GET", "/standards", undefined, a.cookie)
      ).json().items;
      const visible = standards.find((s) => s.id === standardId);
      assert.equal(visible.body.questions[0].correctChoice, undefined);
      assert.equal(visible.body.questions[0].explanation, undefined);
      const graded = await command({
        type: "practice.grade",
        standardId,
        standardVersion: 1,
        questionId: "q1",
        choiceId: "b",
      });
      assert.equal(graded.correct, true);
      const html = await app.inject("/");
      assert.equal(html.statusCode, 200);
      assert.ok(
        html.headers["content-security-policy"].includes("script-src 'self'"),
      );
      assert.ok(!html.body.includes("earth-journey-demo-v1"));
      await req("POST", "/auth/logout", {}, a.cookie);
      assert.equal(
        (await req("GET", "/state", undefined, a.cookie)).statusCode,
        401,
      );
    } finally {
      for (const id of standardIds)
        await pool.query("DELETE FROM public_standards WHERE id=$1", [id]);
      for (const uid of users)
        await pool.query("DELETE FROM users WHERE id=$1", [uid]);
      await app.close();
      await cache.close();
      await pool.end();
    }
  },
);
