import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import {
  initialState,
  rules,
  applyCommand,
  expireState,
} from "../../src/domain.js";
import { userCommandSchema } from "../../src/schemas.js";

const goalId = "6f1c2b0e-3a77-4d0f-9a5e-1c2d3e4f5a6b";
function seeded() {
  const s = initialState();
  s.personalTree.nodes.push({
    id: "strength",
    name: "力量",
    description: "肌肉力量",
    icon: "strength",
    kind: "ability",
    parentId: "physical",
    prerequisites: [],
    baseline: { status: "unlit", basis: "unknown", quote: null },
    stat: 2,
    milestone: null,
  });
  s.goals.push({
    id: goalId,
    title: "三个月做到 10 个标准俯卧撑",
    base: "现在能做 3 个",
    minutes: 30,
    criterion: "连续完成 10 个标准俯卧撑",
    requiresExternal: false,
    kind: "main",
    status: "active",
    stage: 0,
    stages: [
      {
        name: "打底",
        criterion: "知道基线",
        exercise: "基线测试",
        actions: [],
        steps: "测试",
        challenge: "提交一周训练记录",
        standardId: null,
        standardVersion: null,
      },
    ],
    revision: 1,
    routeHistory: [],
    draft: null,
    createdAt: "2026-10-14T00:00:00Z",
    deletedAt: null,
  });
  const base = {
    skillIds: ["strength"],
    stat: 2,
    purpose: "先知道自己现在在哪。",
    resourceIds: [],
    readiness: "ready",
    materialQuestion: null,
  };
  s.skillPlans[goalId] = {
    updatedAt: "2026-10-14T00:10:00Z",
    resources: [],
    targetSkillIds: ["strength"],
    tasks: [
      {
        ...base,
        id: "baseline",
        name: "第一次基线测试",
        minutes: 25,
        actions: [
          { name: "热身 5 分钟", minutes: 5, detail: "开合跳" },
          { name: "测最大次数", minutes: 20, detail: "动作变形就停" },
        ],
        deliverable: {
          type: "log",
          prompt: "记下今天的数字",
          name: "基线记录",
          fields: [
            {
              key: "max_reps",
              label: "最多次数",
              kind: "number",
              unit: "个",
              required: true,
            },
            {
              key: "feel",
              label: "哪里吃力",
              kind: "text",
              unit: null,
              required: false,
            },
          ],
        },
      },
      {
        ...base,
        id: "plan",
        name: "写下一周训练安排",
        minutes: 10,
        actions: [{ name: "写安排", minutes: 10, detail: "每周三次" }],
        deliverable: {
          type: "text",
          prompt: "把一周安排贴在这里",
          name: "训练周计划",
          fields: [],
        },
      },
    ],
  };
  return expireState(s);
}

test("log and text deliveries validate inputs, settle and land in the inventory", async ({
  page,
}) => {
  let state = seeded(),
    version = 1;
  const errors = [],
    commands = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://quest.test/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === "/api/auth/me")
      return route.fulfill({ json: { id: "t", email: "t@example.invalid" } });
    if (path === "/api/state")
      return route.fulfill({
        json: { state: expireState(state), version, rules },
      });
    if (path === "/api/jobs") return route.fulfill({ json: [] });
    if (path === "/api/commands") {
      try {
        const body = req.postDataJSON();
        const cmd = userCommandSchema.parse(body.command);
        commands.push(cmd);
        const out = applyCommand(state, cmd);
        state = out.state;
        version++;
        return route.fulfill({ json: { result: out.result } });
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
  await page.goto("https://quest.test/");
  await expect(page.locator(".q-tracker")).toContainText("第一次基线测试");
  await page
    .locator(".q-tracker")
    .getByRole("button", { name: "接取任务" })
    .click();
  await expect(page.locator(".q-h1")).toHaveText("第一次基线测试");
  const objectives = page.locator("button.q-obj");
  for (let i = 0; i < 2; i++) {
    await objectives.nth(i).click();
    await expect(objectives.nth(i)).toHaveAttribute("aria-pressed", "true");
  }
  const submit = page.locator("form[data-form=deliver] [type=submit]");
  await expect(submit).toHaveText("填写「最多次数」后即可交付");
  await expect(submit).toBeDisabled();
  await page.getByLabel("最多次数").fill("6");
  await expect(submit).toBeEnabled();
  await page.getByLabel("哪里吃力").fill("最后两个手臂发抖");
  await page.screenshot({ path: "test-results/quest-log.png", fullPage: true });
  await submit.click();
  await expect(page.getByRole("heading", { name: "任务完成" })).toBeVisible();
  await expect(page.locator(".q-loot")).toContainText("基线记录");
  await expect(page.locator(".q-settle")).toContainText("写下一周训练安排");
  await page.screenshot({
    path: "test-results/quest-settle.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "查看下一个任务" }).click();
  await page.getByRole("button", { name: "接取任务", exact: true }).click();
  await objectives.first().click();
  await expect(submit).toHaveText("填写成果后即可交付");
  await page
    .locator("#q-content")
    .fill("周一 跪姿 3×8\n周三 标准 2×3\n周五 跪姿 3×10");
  // Typed text survives the periodic refresh.
  await page.waitForTimeout(4000);
  await expect(page.locator("#q-content")).toHaveValue(/周五/);
  await page.locator("form[data-form=deliver] [type=submit]").click();
  await expect(page.locator(".q-settle")).toContainText("挑战已解锁");

  await page.locator("[data-page=journal]").click();
  await expect(page.locator(".q-loot-item")).toHaveCount(2);
  await page.locator(".q-loot-item summary", { hasText: "基线记录" }).click();
  await expect(page.locator(".q-loot-item dd").first()).toHaveText("6 个");
  await page.locator("[data-page=tasks]").click();
  await expect(page.locator(".q-boss")).toContainText("阶段挑战已解锁");
  await page.screenshot({
    path: "test-results/quest-board.png",
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator(".q-row").first().click();
  await page.screenshot({
    path: "test-results/quest-dark.png",
    fullPage: true,
  });

  expect(commands.filter((c) => c.type === "quest.deliver")).toHaveLength(2);
  expect(state.skillProgress.strength.quests).toBe(2);
  expect(state.loot.map((l) => l.name)).toEqual(["基线记录", "训练周计划"]);
  expect(errors).toEqual([]);
});
