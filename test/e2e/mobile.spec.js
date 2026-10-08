import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import {
  initialState,
  rules,
  applyCommand,
  settleJob,
} from "../../src/domain.js";
import { commandSchema } from "../../src/schemas.js";
import { skillFixture } from "../skill-fixture.js";
import { skillGoalId } from "../../src/skill-tree/generation.js";
test.use({ channel: process.platform === "win32" ? "msedge" : undefined });

test("mobile shell: real command contracts, clarification, route confirmation, skills, recording and reload", async ({
  page,
}) => {
  let state = initialState(),
    version = 0,
    chatRound = 0;
  const jobs = [],
    errors = [],
    responses = new Map(),
    commands = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const finish = (job) => {
    let out;
    if (job.kind === "chat")
      out =
        ++chatRound === 1
          ? {
              reply: "先了解你想用英语做什么。",
              questions: [
                {
                  question: "这次主要想用英语做什么？",
                  options: ["旅行交流", "工作沟通", "考试备考"],
                },
              ],
              guidance: null,
              proposals: [],
            }
          : {
              reply: "先从日常短句开始。",
              questions: [],
              guidance: null,
              proposals: [
                {
                  label: "旅行英语",
                  command: {
                    type: "goal.create",
                    title: "旅行英语",
                    base: "初学者，每天20分钟",
                    minutes: 20,
                    criterion: "能完成旅行场景交流",
                    requiresExternal: false,
                    kind: "main",
                  },
                },
              ],
            };
    if (job.kind === "route")
      out = {
        summary: "先理解短句，再练习场景交流。",
        minutes: 20,
        stat: 0,
        stages: [
          {
            name: "常用表达",
            criterion: "表达自己的意思",
            exercise: "练习自我介绍",
            actions: [{ name: "跟读短句", minutes: 20 }],
            steps: "先听再说",
            challenge: "独立介绍自己",
          },
        ],
        sources: [],
      };
    if (job.kind === "skills") {
      const g = state.goals.find((g) => g.id === job.input.goalId);
      out = skillFixture(job, {
        goals: [g],
        personalTree: state.personalTree,
        skillGoalId: skillGoalId(g.id),
      });
    }
    state = settleJob(state, job, out).state;
    version++;
    jobs.find((j) => j.id === job.id).status = "succeeded";
  };
  await page.route("https://mobile.test/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === "/api/auth/me")
      return route.fulfill({
        json: { id: "test", email: "test@example.invalid" },
      });
    if (path === "/api/state")
      return route.fulfill({ json: { state, version, rules } });
    if (path === "/api/jobs")
      return route.fulfill({ json: [...jobs].reverse() });
    if (path === "/api/commands") {
      const key = req.headers()["idempotency-key"];
      if (!/^[a-zA-Z0-9_-]{12,100}$/.test(key))
        return route.fulfill({ status: 400, json: { error: "Invalid key" } });
      if (responses.has(key))
        return route.fulfill({ json: responses.get(key) });
      try {
        const body = req.postDataJSON();
        if (body.expectedVersion !== version)
          return route.fulfill({
            status: 409,
            json: { error: "Version conflict" },
          });
        const cmd = commandSchema.parse(body.command);
        commands.push(cmd);
        const result = applyCommand(state, cmd);
        state = result.state;
        version++;
        for (const job of result.jobs) {
          jobs.push({ ...job, status: "running" });
          setTimeout(() => finish(job), 120);
        }
        const response = { result: result.result };
        responses.set(key, response);
        return route.fulfill({ json: response });
      } catch (e) {
        return route.fulfill({ status: 400, json: { error: e.message } });
      }
    }
    const file = resolve("public", "." + (path === "/" ? "/index.html" : path));
    try {
      return route.fulfill({
        body: await readFile(file),
        contentType:
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
          }[extname(file)] || "application/octet-stream",
      });
    } catch {
      return route.fulfill({ status: 404, body: "" });
    }
  });
  await page.goto("https://mobile.test/");
  await expect(page.locator("h1")).toHaveText("未完待续的我");
  await page.getByRole("button", { name: "添加新目标" }).click();
  await page.getByRole("button", { name: "关闭目标输入" }).click();
  await expect(page.locator(".eg-overlay")).toBeHidden();
  await page.getByRole("button", { name: "添加新目标" }).click();
  await page.locator("#goal-input").fill("我想学英语");
  await page.getByRole("button", { name: "开始", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "旅行交流", exact: true }),
  ).toBeVisible({ timeout: 12000 });
  await page.getByRole("button", { name: "旅行交流", exact: true }).click();
  await page.locator("#answer-0").fill("初学者，每天20分钟");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect(page.getByRole("button", { name: "按此生成路线" })).toBeVisible({
    timeout: 12000,
  });
  await page.getByRole("button", { name: "按此生成路线" }).click();
  await expect(
    page.getByRole("button", { name: "确认路线并加入" }),
  ).toBeVisible({ timeout: 12000 });
  await page.getByRole("button", { name: "关闭目标输入" }).click();
  await page.locator("[data-page=tasks]").click();
  await page.locator("[data-tab=goals]").click();
  await page.locator("[data-goal]").first().click();
  await page.getByRole("button", { name: "查看路线并确认" }).click();
  await page.getByRole("button", { name: "确认路线并加入" }).click();
  await expect(page.locator(".eg-overlay")).toBeHidden();
  await expect(page.locator("[data-task]").first()).toBeVisible({
    timeout: 12000,
  });
  await page.locator("[data-task]").first().click();
  await expect(page.locator(".eg-steps li").first()).toBeVisible();
  await page.screenshot({
    path: "test-results/mobile-task.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "我完成了", exact: true }).click();
  await expect(
    page.getByText("今天的投入已记录，经验以服务器记录为准。"),
  ).toBeVisible();
  expect(commands.filter((c) => c.type === "action.record")).toHaveLength(1);
  expect(state.records).toHaveLength(1);
  expect(state.levelXp).toBeGreaterThan(0);
  await page.reload();
  await page.locator("[data-page=journal]").click();
  await expect(page.locator(".eg-log")).toHaveCount(1);
  await page.locator("[data-page=growth]").click();
  await page.getByRole("button", { name: "认知", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "学习方法", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/mobile-growth.png",
    fullPage: true,
  });
  await page.locator("[data-page=home]").click();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.screenshot({
    path: "test-results/mobile-home.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "添加新目标" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".eg-overlay")).toBeHidden();
  expect(errors).toEqual([]);
});
