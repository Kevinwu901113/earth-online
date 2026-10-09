import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join } from "node:path";
import {
  initialState,
  applyCommand,
  settleJob,
  rules,
} from "../../src/domain.js";
import { commandSchema } from "../../src/schemas.js";

// Exercise the real UI and command contract without model credentials or a database.
// The in-memory HTTP boundary lasts across reloads; only auth and storage are fixtures.
const publicRoot = fileURLToPath(new URL("../../public/", import.meta.url));
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(
    new Date(),
  );
const shiftDay = (day, offset) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

async function mountTimeline(
  page,
  { goals = [], plans = [], chatOutput, chatDelay = 600 } = {},
) {
  let state = initialState();
  let version = 0;
  const commands = [];
  const errors = [];
  const jobs = [];
  const rememberJobs = (nextJobs) => {
    jobs.push(
      ...nextJobs.map((job) => ({
        ...job,
        status: "queued",
        createdAt: new Date().toISOString(),
      })),
    );
  };
  const finishJob = (job, output) => {
    state = settleJob(state, job, output).state;
    const stored = jobs.find((item) => item.id === job.id);
    if (stored) stored.status = "succeeded";
    version += 1;
  };
  page.on("pageerror", (error) => errors.push(error.message));
  for (const goal of goals) {
    const created = applyCommand(state, {
      type: "goal.create",
      title: goal.title,
      base: "可利用每天的空闲时间",
      minutes: goal.actions.reduce((sum, action) => sum + action.minutes, 0),
      criterion: "完成可检查的成果",
      requiresExternal: false,
      kind: goal.kind,
    });
    state = settleJob(created.state, created.jobs[0], {
      summary: "按事项完成今天的练习。",
      minutes: created.state.goals.at(-1).minutes,
      stat: 0,
      stages: [
        {
          name: "今天的小步骤",
          criterion: "完成可检查的成果",
          exercise: goal.actions[0].name,
          actions: goal.actions,
          steps: "按顺序完成这些小事。",
          challenge: "独立完成并留下成果",
        },
      ],
      sources: [],
    }).state;
    state = applyCommand(state, {
      type: "goal.confirm",
      id: created.result.goalId,
      draftId: created.jobs[0].id,
    }).state;
  }
  for (const { goalIndex, ...plan } of plans) {
    state = applyCommand(state, {
      type: "plan.create",
      goal: goalIndex == null ? null : state.goals[goalIndex].id,
      day: today(),
      stat: 0,
      ...plan,
    }).state;
  }
  await page.route("http://127.0.0.1:3101/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (pathname === "/api/auth/me")
      return json({
        id: "timeline-fixture-user",
        email: "timeline@example.invalid",
      });
    if (pathname === "/api/state") return json({ state, version, rules });
    if (pathname === "/api/jobs") return json(jobs);
    if (pathname === "/api/commands") {
      try {
        const payload = request.postDataJSON();
        if (payload.expectedVersion !== version)
          return json({ error: "数据已变化，请重试。" }, 409);
        const command = commandSchema.parse(payload.command);
        const outcome = applyCommand(state, command);
        state = outcome.state;
        version += 1;
        commands.push(command);
        rememberJobs(outcome.jobs);
        if (command.type === "chat.send" && chatOutput)
          setTimeout(() => finishJob(outcome.jobs[0], chatOutput), chatDelay);
        return json({ result: outcome.result, version });
      } catch (error) {
        return json({ error: error.message }, error.statusCode ?? 400);
      }
    }
    if (pathname.startsWith("/api/"))
      return json({ error: `Unexpected fixture request: ${pathname}` }, 404);
    const filename = pathname === "/" ? "index.html" : pathname.slice(1);
    if (filename.includes("..")) return route.fulfill({ status: 404 });
    try {
      return route.fulfill({
        contentType:
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
          }[extname(filename)] ?? "application/octet-stream",
        body: await readFile(join(publicRoot, filename)),
      });
    } catch {
      return route.fulfill({ status: 404 });
    }
  });
  await page.goto("/advanced.html");
  await expect(page.locator(".storage-status")).toContainText("已连接账号");
  await page.locator("[data-nav=quests]").click();
  return {
    get state() {
      return state;
    },
    commands,
    errors,
    // Simulate another client changing a task while the browser still has an old snapshot.
    transition(command) {
      const outcome = applyCommand(state, commandSchema.parse(command));
      state = outcome.state;
      version += 1;
      rememberJobs(outcome.jobs);
      return outcome;
    },
    settle(job, output) {
      finishJob(job, output);
    },
  };
}

async function reloadQuests(page) {
  await page.reload();
  await expect(page.locator(".storage-status")).toContainText("已连接账号");
  await page.locator("[data-nav=quests]").click();
}

async function openBlockList(page) {
  const summary = page.locator("details.block-list:not([open]) > summary");
  if (await summary.count()) await summary.click();
}

test("daily blocks: add, switch days, edit, and delete persist across reload", async ({
  page,
}) => {
  const fixture = await mountTimeline(page);
  const date = today();
  await expect(page.locator("[data-timeline-day]")).toHaveValue(date);
  await page.getByRole("button", { name: "添加事件块", exact: true }).click();
  await page.getByLabel("行动", { exact: true }).fill("整理今天的笔记");
  await page.getByLabel("开始时间", { exact: true }).fill("10:00");
  await page.getByLabel("计划分钟", { exact: true }).fill("60");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".time-block")).toHaveCount(1);
  await expect(page.locator(".time-block")).toHaveAttribute(
    "data-minutes",
    "60",
  );
  const planId = fixture.state.plans[0].id;
  await page.getByRole("button", { name: "后一天", exact: true }).click();
  await expect(page.locator("[data-timeline-day]")).toHaveValue(
    shiftDay(date, 1),
  );
  await expect(page.locator(".time-block")).toHaveCount(0);
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await expect(page.locator(".time-block")).toHaveCount(1);
  await openBlockList(page);
  await page
    .locator(`[data-summary-id="${planId}"] [data-action=editPlan]`)
    .click();
  await page.getByLabel("计划分钟", { exact: true }).fill("90");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".time-block")).toHaveAttribute(
    "data-minutes",
    "90",
  );
  await reloadQuests(page);
  await expect(page.locator(".time-block")).toHaveAttribute(
    "data-minutes",
    "90",
  );
  await openBlockList(page);
  await page
    .locator(`[data-summary-id="${planId}"] [data-action=deletePlan]`)
    .click();
  await expect(page.locator(".time-block")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".storage-status")).toContainText("已连接账号");
  await page.locator("[data-nav=actions]").click();
  await expect(page.locator(".time-block")).toHaveCount(0);
  expect(fixture.state.plans[0].status).toBe("cancelled");
  expect(fixture.errors).toEqual([]);
});

test("dragging and keyboard resize change real duration and physical block height", async ({
  page,
}) => {
  const fixture = await mountTimeline(page, {
    plans: [{ name: "专注阅读", minutes: 60, time: "10:00" }],
  });
  const block = page.locator(".time-block");
  const handle = page.getByRole("slider", { name: "调整专注阅读的时长" });
  await expect(handle).toHaveAttribute("aria-valuenow", "60");
  const initial = await block.boundingBox();
  await handle.scrollIntoViewIfNeeded();
  const grip = await handle.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    grip.x + grip.width / 2,
    grip.y + grip.height / 2 + initial.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(handle).toHaveAttribute("aria-valuenow", "90");
  await expect(block).toHaveAttribute("data-minutes", "90");
  await expect
    .poll(async () => {
      const extended = await block.boundingBox();
      return extended ? extended.height / initial.height : 0;
    })
    .toBeCloseTo(1.5, 2);
  await handle.focus();
  await handle.press("ArrowUp");
  await expect(handle).toHaveAttribute("aria-valuenow", "95");
  await expect.poll(() => fixture.state.plans[0].minutes).toBe(95);
  await expect(block).not.toHaveClass(/resizing/);
  await handle.press("ArrowDown");
  await expect(handle).toHaveAttribute("aria-valuenow", "90");
  await expect.poll(() => fixture.state.plans[0].minutes).toBe(90);
  await expect(block).not.toHaveClass(/resizing/);
  await reloadQuests(page);
  await expect(block).toHaveAttribute("data-minutes", "90");
  expect(fixture.state.plans[0].minutes).toBe(90);
  expect(
    fixture.commands.every((command) => command.type === "plan.update"),
  ).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test("AI actions stay grouped under main and side quests, then become consecutive day blocks", async ({
  page,
}) => {
  const fixture = await mountTimeline(page, {
    goals: [
      {
        title: "写好一篇短文",
        kind: "main",
        actions: [
          { name: "列出三个要点", minutes: 15 },
          { name: "写成完整段落", minutes: 30 },
        ],
      },
      {
        title: "试一张新速写",
        kind: "side",
        actions: [{ name: "画一件身边的小物", minutes: 20 }],
      },
    ],
  });
  const main = page
    .locator(".quest-tile")
    .filter({ has: page.getByRole("heading", { name: "写好一篇短文" }) });
  const side = page
    .locator(".quest-tile")
    .filter({ has: page.getByRole("heading", { name: "试一张新速写" }) });
  await expect(main.locator(".task-kind")).toHaveText("主线任务");
  await expect(main.locator(".action-card")).toHaveCount(2);
  await expect(side.locator(".task-kind")).toHaveText("支线任务");
  await expect(side.locator(".action-card")).toHaveCount(1);
  await main.getByRole("button", { name: "安排这些时间块" }).click();
  await page.getByLabel("开始时间", { exact: true }).fill("09:00");
  await expect(page.locator(".schedule-preview-block")).toHaveCount(2);
  await page.getByRole("button", { name: "加入时间轴", exact: true }).click();
  await expect(page.locator(".time-block.main-block")).toHaveCount(2);
  expect(fixture.state.plans.map((plan) => [plan.time, plan.minutes])).toEqual([
    ["09:00", 15],
    ["09:15", 30],
  ]);
  const first = await page
    .locator(".time-block.main-block")
    .nth(0)
    .boundingBox();
  const second = await page
    .locator(".time-block.main-block")
    .nth(1)
    .boundingBox();
  expect(second.height / first.height).toBeCloseTo(2, 2);
  await side.getByRole("button", { name: "安排这些时间块" }).click();
  await page.getByLabel("开始时间", { exact: true }).fill("14:00");
  await page.getByRole("button", { name: "加入时间轴", exact: true }).click();
  await expect(page.locator(".time-block.side-block")).toHaveCount(1);
  await reloadQuests(page);
  await expect(page.locator(".time-block")).toHaveCount(3);
  expect(fixture.commands.map((command) => command.type)).toEqual([
    "plan.batch",
    "plan.batch",
  ]);
  expect(fixture.errors).toEqual([]);
});

test("overlapping edits retain the old time block and show a useful error", async ({
  page,
}) => {
  const fixture = await mountTimeline(page, {
    plans: [
      { name: "上午阅读", minutes: 30, time: "10:00" },
      { name: "接着写作", minutes: 30, time: "10:30" },
    ],
  });
  const first = fixture.state.plans[0];
  await openBlockList(page);
  await page
    .locator(`[data-summary-id="${first.id}"] [data-action=editPlan]`)
    .click();
  await page.getByLabel("计划分钟", { exact: true }).fill("60");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".inline-error")).toContainText("该时段已有安排");
  expect(fixture.state.plans[0].minutes).toBe(30);
  await page.getByRole("button", { name: "关闭详情" }).click();
  await expect(page.locator(`[data-plan-id="${first.id}"]`)).toHaveAttribute(
    "data-minutes",
    "30",
  );
  expect(fixture.errors).toEqual([]);
});

test("cancelled or empty schedule dates preserve the current day until a valid save", async ({
  page,
}) => {
  const fixture = await mountTimeline(page, {
    goals: [
      {
        title: "为明天安排阅读",
        kind: "main",
        actions: [{ name: "读一篇短文", minutes: 20 }],
      },
    ],
    plans: [{ name: "今天原有的安排", minutes: 30, time: "10:00" }],
  });
  const date = today();
  const tomorrow = shiftDay(date, 1);
  const arrange = page.getByRole("button", {
    name: "安排这些时间块",
    exact: true,
  });

  await arrange.click();
  await page.getByLabel("日期", { exact: true }).fill(tomorrow);
  await page.getByRole("button", { name: "关闭详情" }).click();
  await expect(page.locator("[data-timeline-day]")).toHaveValue(date);
  await expect(page.locator(".time-block")).toHaveCount(1);

  await arrange.click();
  await page.getByLabel("日期", { exact: true }).fill("");
  await page.getByRole("button", { name: "加入时间轴", exact: true }).click();
  await expect(page.locator(".overlay")).toBeVisible();
  expect(fixture.commands).toHaveLength(0);
  await page.getByRole("button", { name: "关闭详情" }).click();
  await expect(page.locator("[data-timeline-day]")).toHaveValue(date);
  await expect(page.locator(".time-block")).toHaveCount(1);

  await arrange.click();
  await page.getByLabel("日期", { exact: true }).fill(tomorrow);
  await page.getByRole("button", { name: "加入时间轴", exact: true }).click();
  await expect(page.locator("[data-timeline-day]")).toHaveValue(tomorrow);
  await expect(page.locator(".time-block")).toHaveCount(1);
  await expect(page.locator(".time-block")).toContainText("读一篇短文");
  expect(fixture.state.plans.at(-1).day).toBe(tomorrow);
  expect(fixture.errors).toEqual([]);
});

for (const mode of ["paused", "replanned", "completed"]) {
  test(`${mode} tasks keep old blocks visible without edit handles and allow removal`, async ({
    page,
  }) => {
    const fixture = await mountTimeline(page, {
      goals: [
        {
          title: "有历史安排的任务",
          kind: "main",
          actions: [{ name: "完成一个小步骤", minutes: 20 }],
        },
      ],
      plans: [
        { goalIndex: 0, name: "已经安排的小步骤", minutes: 20, time: "10:00" },
      ],
    });
    const goal = fixture.state.goals[0];
    const plan = fixture.state.plans[0];
    await expect(page.locator(`[data-resize-id="${plan.id}"]`)).toHaveCount(1);
    let reason;
    if (mode === "paused") {
      fixture.transition({
        type: "goal.status",
        id: goal.id,
        status: "paused",
      });
      reason = "恢复任务后可编辑";
    } else if (mode === "replanned") {
      const changed = fixture.transition({
        type: "goal.adjust",
        id: goal.id,
        reason: "换一个练习顺序",
        minutes: 20,
      });
      fixture.settle(changed.jobs[0], {
        summary: "调整练习顺序。",
        minutes: 20,
        stat: 0,
        stages: goal.stages,
        sources: [],
      });
      fixture.transition({
        type: "goal.confirm",
        id: goal.id,
        draftId: changed.jobs[0].id,
      });
      expect(fixture.state.goals[0].revision).toBeGreaterThan(plan.revision);
      reason = "路线已变化，请重新安排";
    } else {
      const submitted = fixture.transition({
        type: "submission.create",
        goal: goal.id,
        kind: "challenge",
        content: "完成可检查的成果。",
        helpUsed: false,
      });
      fixture.settle(submitted.jobs[0], {
        outcome: "passed",
        feedback: "成果中包含需要的内容。",
        quotes: ["可检查的成果"],
        evidenceType: "text",
        standardId: null,
        standardVersion: null,
      });
      expect(fixture.state.goals[0].status).toBe("completed");
      reason = "任务已结束，这个安排可移除";
    }
    await reloadQuests(page);
    await openBlockList(page);
    const block = page.locator(`[data-plan-id="${plan.id}"]`);
    const summary = page.locator(`[data-summary-id="${plan.id}"]`);
    await expect(block).toBeVisible();
    await expect(block.locator("[data-resize-id]")).toHaveCount(0);
    await expect(block.locator("[data-action=editPlan]")).toHaveCount(0);
    await expect(summary.locator("[data-action=editPlan]")).toHaveCount(0);
    await expect(summary.locator("[data-action=record]")).toHaveCount(0);
    await expect(summary).toContainText(reason);
    await summary
      .getByRole("button", { name: "删除事件块", exact: true })
      .click();
    await expect(block).toHaveCount(0);
    expect(fixture.state.plans[0].status).toBe("cancelled");
    expect(fixture.errors).toEqual([]);
  });
}

test("dragging a whole event snaps its start time, preserves duration, and still allows click editing", async ({
  page,
}) => {
  const fixture = await mountTimeline(page, {
    plans: [{ name: "移动这一段阅读", minutes: 30, time: "10:00" }],
  });
  const id = fixture.state.plans[0].id;
  const block = page.locator(`[data-plan-id="${id}"]`);
  const body = page.locator(`[data-move-id="${id}"]`);
  await body.scrollIntoViewIfNeeded();
  const initial = await block.boundingBox();
  const grip = await body.boundingBox();
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + (initial.height * 26) / 30, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => fixture.state.plans[0].time).toBe("10:25");
  await expect(block).not.toHaveClass(/moving/);
  await expect(page.locator(".overlay")).toBeHidden();
  expect(fixture.state.plans[0].minutes).toBe(30);
  expect((await block.boundingBox()).height).toBeCloseTo(initial.height, 2);

  await body.focus();
  await body.press("ArrowDown");
  await expect.poll(() => fixture.state.plans[0].time).toBe("10:30");
  await expect(block).not.toHaveClass(/moving/);
  await body.press("Shift+ArrowUp");
  await expect.poll(() => fixture.state.plans[0].time).toBe("10:15");
  expect(fixture.state.plans[0].minutes).toBe(30);
  await reloadQuests(page);
  await expect(body).toHaveAttribute("aria-label", /10:15.*10:45/);
  await body.click();
  await expect(page.getByLabel("开始时间", { exact: true })).toHaveValue(
    "10:15",
  );
  await expect(page.getByLabel("计划分钟", { exact: true })).toHaveValue("30");
  expect(fixture.errors).toEqual([]);
});

test("moving into another event visibly rejects the overlap and restores its original time", async ({
  page,
}) => {
  const fixture = await mountTimeline(page, {
    plans: [
      { name: "需要移动的阅读", minutes: 30, time: "10:00" },
      { name: "不能覆盖的写作", minutes: 30, time: "11:00" },
    ],
  });
  const id = fixture.state.plans[0].id;
  const block = page.locator(`[data-plan-id="${id}"]`);
  const body = page.locator(`[data-move-id="${id}"]`);
  await body.scrollIntoViewIfNeeded();
  const initial = await block.boundingBox();
  const top = await block.evaluate((element) => element.style.top);
  const grip = await body.boundingBox();
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + initial.height * 2, { steps: 8 });
  await expect(block).toHaveClass(/move-conflict/);
  await page.mouse.up();
  await expect(block).not.toHaveClass(/moving/);
  await expect(block).toHaveCSS("top", top);
  await expect(page.locator(".overlay")).toBeHidden();
  expect(fixture.state.plans.map((plan) => [plan.time, plan.minutes])).toEqual([
    ["10:00", 30],
    ["11:00", 30],
  ]);
  await reloadQuests(page);
  await expect(body).toHaveAttribute("aria-label", /10:00.*10:30/);
  expect(fixture.errors).toEqual([]);
});

test("completed tasks can be deleted and restored without losing completion or historical evidence", async ({
  page,
}) => {
  const fixture = await mountTimeline(page, {
    goals: [
      {
        title: "已经完成的主线",
        kind: "main",
        actions: [{ name: "写出完成成果", minutes: 20 }],
      },
      {
        title: "独立存在的支线",
        kind: "side",
        actions: [{ name: "随手画一张速写", minutes: 20 }],
      },
    ],
    plans: [
      { goalIndex: 0, name: "主线旧安排", minutes: 20, time: "10:00" },
      { goalIndex: 1, name: "支线原有安排", minutes: 20, time: "14:00" },
    ],
  });
  const goal = fixture.state.goals[0];
  fixture.transition({
    type: "action.record",
    plan: null,
    goal: goal.id,
    name: "留下主线投入",
    minutes: 20,
    day: today(),
    stat: 0,
    note: "完成一个小步骤",
    completion: "done",
  });
  const submitted = fixture.transition({
    type: "submission.create",
    goal: goal.id,
    kind: "challenge",
    content: "完成可检查的成果。",
    helpUsed: false,
  });
  fixture.settle(submitted.jobs[0], {
    outcome: "passed",
    feedback: "成果中包含需要的内容。",
    quotes: ["可检查的成果"],
    evidenceType: "text",
    standardId: null,
    standardVersion: null,
  });
  const history = structuredClone({
    records: fixture.state.records,
    submissions: fixture.state.submissions,
    levelXp: fixture.state.levelXp,
    revision: fixture.state.goals[0].revision,
    stage: fixture.state.goals[0].stage,
  });
  await reloadQuests(page);
  const tile = page.locator(`.quest-tile[data-goal-id="${goal.id}"]`);
  await expect(tile.locator(".quest-tag")).toHaveText("已完成");
  await tile.getByRole("button", { name: "删除任务", exact: true }).click();
  await expect(tile).toHaveCount(0);
  expect(fixture.state.goals[0].status).toBe("completed");
  expect(fixture.state.goals[0].deletedAt).toBeTruthy();
  expect(fixture.state.plans[0].status).toBe("cancelled");
  expect(fixture.state.plans[1].status).toBe("planned");
  await reloadQuests(page);
  await page.locator(".deleted-goals > summary").click();
  await page.locator(`[data-action=restoreGoal][data-id="${goal.id}"]`).click();
  await expect(tile.locator(".quest-tag")).toHaveText("已完成");
  await expect(
    tile.getByRole("button", { name: "安排这些时间块" }),
  ).toHaveCount(0);
  expect(fixture.state.goals[0].deletedAt).toBeNull();
  expect(fixture.state.plans[0].status).toBe("cancelled");
  expect({
    records: fixture.state.records,
    submissions: fixture.state.submissions,
    levelXp: fixture.state.levelXp,
    revision: fixture.state.goals[0].revision,
    stage: fixture.state.goals[0].stage,
  }).toEqual(history);
  await expect(page.locator(".time-block.side-block")).toHaveCount(1);
  await reloadQuests(page);
  await expect(tile.locator(".quest-tag")).toHaveText("已完成");
  expect(fixture.errors).toEqual([]);
});

test("visual AI guidance explains actions while scheduling requires proposal confirmation", async ({
  page,
}) => {
  const fixture = await mountTimeline(page, {
    goals: [
      {
        title: "从要点写成短文",
        kind: "main",
        actions: [
          { name: "列出三个要点", minutes: 5 },
          { name: "写成完整段落", minutes: 15 },
        ],
      },
    ],
  });
  const goal = fixture.state.goals[0];
  const scheduledDay = shiftDay(today(), 1);
  const chat = fixture.transition({
    type: "chat.send",
    content: "把今天的安排变成可执行的小步骤",
  });
  fixture.settle(chat.jobs[0], {
    reply: "可以先安排两小步。外部学习资源检索服务不可用，故资料存在缺口。",
    guidance: {
      title: "把今天拆成两小步",
      summary: "先完成要点，再写完整段落。知识库检索不等于能力评估。",
      steps: [
        {
          title: "列出三个要点",
          minutes: 5,
          kind: "main",
          detail:
            "背景、经历、目标各一句。未检索到公开认证标准（标准位留空）。",
        },
        {
          title: "写成完整段落",
          minutes: 15,
          kind: "main",
          detail: "把三个要点串联起来。",
        },
      ],
    },
    proposals: [
      {
        label: "把这两步放到上午",
        command: {
          type: "plan.batch",
          goal: goal.id,
          stage: goal.stage,
          revision: goal.revision,
          day: scheduledDay,
          time: "09:00",
          blocks: goal.stages[goal.stage].actions,
        },
      },
    ],
  });
  await reloadQuests(page);
  await page.locator(".guide-bar").click();
  await expect(page.locator(".chat-guidance .guidance-step")).toHaveCount(2);
  await expect(page.locator(".chat-guidance")).toContainText("列出三个要点");
  await expect(page.locator(".chat-guidance")).toContainText(
    "先完成要点，再写完整段落。",
  );
  await expect(page.locator(".sheet-content")).not.toContainText(
    /外部学习资源检索服务|资料存在缺口|标准位留空|知识库检索不等于/,
  );
  expect(fixture.state.messages.at(-1).content).toContain("检索服务不可用");
  const draft = page.getByLabel("说说你的目标、时间和目前的情况", {
    exact: true,
  });
  await draft.fill("未发送的补充");
  expect(fixture.state.plans).toHaveLength(0);
  await page
    .locator('.chat-proposal[data-proposal-type="plan.batch"]')
    .getByRole("button", { name: "放入任务日志", exact: true })
    .click();
  expect(fixture.state.plans).toHaveLength(0);
  await expect(page.locator(".sheet-content")).toContainText("写成完整段落");
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
  await expect(draft).toHaveValue("未发送的补充");
  await page
    .locator('.chat-proposal[data-proposal-type="plan.batch"]')
    .getByRole("button", { name: "放入任务日志", exact: true })
    .click();
  await page
    .getByRole("button", { name: "确认加入时间轴", exact: true })
    .click();
  await expect.poll(() => fixture.state.plans.length).toBe(2);
  await expect(draft).toHaveValue("未发送的补充");
  await expect(page.locator(".chat-proposal-status")).toContainText(
    "已加入时间轴",
  );
  await page.getByRole("button", { name: "查看这一天", exact: true }).click();
  await expect(page.locator("[data-timeline-day]")).toHaveValue(scheduledDay);
  await expect(page.locator(".time-block.main-block")).toHaveCount(2);
  expect(fixture.state.plans.map((plan) => [plan.time, plan.minutes])).toEqual([
    ["09:00", 5],
    ["09:05", 15],
  ]);
  expect(fixture.errors).toEqual([]);
});

test("quickly switching from moving to resizing commits the move before changing duration", async ({
  page,
}) => {
  const fixture = await mountTimeline(page, {
    plans: [{ name: "避免移动和调整互相覆盖", minutes: 30, time: "10:00" }],
  });
  const id = fixture.state.plans[0].id;
  const body = page.locator(`[data-move-id="${id}"]`);
  const handle = page.locator(`[data-resize-id="${id}"]`);
  await body.focus();
  await body.press("ArrowDown");
  await body.press("Tab");
  await expect(handle).toBeFocused();
  await handle.press("ArrowUp");
  await expect.poll(() => fixture.state.plans[0].time).toBe("10:05");
  await expect(page.locator(`[data-plan-id="${id}"]`)).not.toHaveClass(
    /moving/,
  );
  expect(fixture.state.plans[0].minutes).toBe(30);
  expect(
    fixture.commands.filter((command) => command.type === "plan.update"),
  ).toHaveLength(1);
  await handle.focus();
  await handle.press("ArrowUp");
  await expect.poll(() => fixture.state.plans[0].minutes).toBe(35);
  expect(fixture.state.plans[0].time).toBe("10:05");
  expect(fixture.errors).toEqual([]);
});

test("a concurrent edit during drag is refreshed without overwriting the other client's change", async ({
  page,
}) => {
  const fixture = await mountTimeline(page, {
    plans: [{ name: "拖动之前的名称", minutes: 30, time: "10:00" }],
  });
  const plan = fixture.state.plans[0];
  const body = page.locator(`[data-move-id="${plan.id}"]`);
  const block = page.locator(`[data-plan-id="${plan.id}"]`);
  await body.scrollIntoViewIfNeeded();
  const grip = await body.boundingBox();
  const initial = await block.boundingBox();
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + initial.height, { steps: 8 });
  fixture.transition({
    type: "plan.update",
    id: plan.id,
    name: "另一页面改好的名称",
    minutes: plan.minutes,
    day: plan.day,
    time: plan.time,
  });
  await page.mouse.up();
  await expect(body).toHaveAttribute(
    "aria-label",
    /另一页面改好的名称.*10:00.*10:30/,
  );
  expect(fixture.state.plans[0].name).toBe("另一页面改好的名称");
  expect(fixture.state.plans[0].time).toBe("10:00");
  expect(fixture.state.plans[0].minutes).toBe(30);
  expect(fixture.commands).toHaveLength(0);
  await expect(page.locator(".overlay")).toBeHidden();
  expect(fixture.errors).toEqual([]);
});

test("the arriving visual AI reply preserves a new draft typed while the assistant is working", async ({
  page,
}) => {
  const fixture = await mountTimeline(page, {
    chatOutput: {
      reply: "从两件小事开始就好。",
      guidance: {
        title: "给今天留两小步",
        summary: "安排一个短任务，再留休息时间。",
        steps: [
          { title: "读一篇短文", minutes: 15, kind: "side" },
          { title: "休息一下", minutes: 5, kind: "free" },
        ],
      },
      proposals: [],
    },
  });
  await page.locator(".guide-bar").click();
  const input = page.getByLabel("说说你的目标、时间和目前的情况", {
    exact: true,
  });
  await input.fill("我每天有二十分钟，想开始阅读");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".chat-processing")).toContainText(
    "正在整理下一步",
  );
  await input.fill("补充：我还希望留出休息时间");
  await expect(page.locator(".chat-guidance .guidance-step")).toHaveCount(2, {
    timeout: 10000,
  });
  await expect(input).toHaveValue("补充：我还希望留出休息时间");
  await expect(input).toBeFocused();
  await expect(page.locator(".chat-processing")).toHaveCount(0);
  expect(
    fixture.state.messages.filter((message) => message.role === "user"),
  ).toHaveLength(1);
  expect(fixture.state.plans).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});
