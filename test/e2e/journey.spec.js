import { test, expect } from "./fixtures.js";
import { randomUUID } from "node:crypto";
import { makePool } from "../../src/db.js";
test("mobile: register → plan → confirm → record → evidence → persisted memory", async ({
  page,
}) => {
  const email = randomUUID() + "@browser.test.invalid",
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "还没有账号？注册" }).click();
    await page.getByLabel("邮箱", { exact: true }).fill(email);
    await page.getByLabel("密码（至少 12 位）").fill("browser-test-password");
    await page.getByRole("button", { name: "注册", exact: true }).click();
    await expect(page.locator(".overlay")).toBeHidden();
    await page.locator("[data-nav=quests]").click();
    await page.getByRole("button", { name: "开启新主线" }).click();
    await page.getByLabel("想完成什么").fill("评估失败后重试");
    await page
      .getByLabel("现在的基础与条件（不了解可以写未知）")
      .fill("初学者");
    await page.getByLabel("每天能投入的分钟数").fill("20");
    await page
      .getByLabel("怎样才算完成？留下什么可判断的成果？")
      .fill("有背景、经历和目标");
    await page.getByRole("button", { name: "生成路线草案" }).click();
    await expect(
      page.getByRole("button", { name: "查看路线草案" }),
    ).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "查看路线草案" }).click();
    await page.getByRole("button", { name: "确认这条路线" }).click();
    await expect(
      page.getByRole("button", { name: "安排练习", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "安排练习", exact: true }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator(".overlay")).toBeHidden();
    await page.locator("[data-nav=actions]").click();
    await page.getByRole("button", { name: "留下记录", exact: true }).click();
    await page
      .getByLabel("留下过程、收获或遇到的问题（也可以写无）")
      .fill("完成了三个要点");
    // The server commits, but the client loses the response. Retrying must not duplicate XP.
    await page.route(
      "**/api/commands",
      async (route) => {
        await route.fetch();
        await route.abort("failed");
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator(".inline-error")).not.toBeEmpty();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("+4 XP", { exact: false })).toBeVisible();
    const snapshot = await (await page.request.get("/api/state")).json();
    expect(snapshot.state.records).toHaveLength(1);
    expect(snapshot.state.levelXp).toBe(4);
    await page.locator("[data-nav=quests]").click();
    await page.getByRole("button", { name: "查看目标", exact: true }).click();
    await page.getByRole("button", { name: "提交成果", exact: true }).click();
    await page.getByLabel("用途").selectOption("challenge");
    await page
      .getByLabel("粘贴文字成果与必要说明")
      .fill("I study design. I built a chair. I want to learn more.");
    await page.getByRole("button", { name: "提交评估", exact: true }).click();
    await page.getByRole("button", { name: "查看目标", exact: true }).click();
    await expect(page.locator(".assessment-error")).toContainText(
      "达到本次生成上限",
      { timeout: 10000 },
    );
    await page.reload();
    await page.locator("[data-nav=quests]").click();
    await page.getByRole("button", { name: "查看目标", exact: true }).click();
    await expect(page.locator(".assessment-error")).toContainText(
      "达到本次生成上限",
    );
    const failed = await (await page.request.get("/api/state")).json();
    expect(failed.state.goals[0].stage).toBe(0);
    expect(failed.state.levelXp).toBe(4);
    expect(failed.state.submissions[0].content).toBe(
      "I study design. I built a chair. I want to learn more.",
    );
    await page.getByRole("button", { name: "重试评估", exact: true }).click();
    await expect(page.locator(".assessment-error")).toHaveCount(0);
    await expect(page.locator(".sheet-content .status")).toContainText(
      "已完成",
      { timeout: 10000 },
    );
    await expect(
      page.locator(".sheet-content").getByText("当前阶段", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.locator(".sheet-content").getByText("已通过", { exact: true }),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "关闭详情" }).click();
    await expect(page.locator(".quest-tag")).toHaveText("已完成", {
      timeout: 10000,
    });
    await page.reload();
    await page.locator("[data-nav=memory]").click();
    await expect(
      page.getByText("提交中包含三个具体要点。", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "修正记忆" }).first().click();
    await page.getByLabel("修正后的内容").fill("我已检查这份文字反馈。");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(
      page.getByText("我已检查这份文字反馈。", { exact: true }),
    ).toBeVisible();
    await page.locator(".guide-bar").click();
    await page.getByLabel("说说你的想法").fill("下一步呢？");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText("下一步呢？", { exact: true })).toBeVisible();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "刷新对话", exact: true }).click();
    await expect(
      page.getByText("我看到你的真实记录。可以先留一点休息时间。", {
        exact: true,
      }),
    ).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "关闭详情" }).click();
    await page.locator("[data-nav=self]").click();
    await page.screenshot({
      path: "test-results/mobile-character.png",
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: "test-results/desktop-character.png",
      fullPage: true,
      animations: "disabled",
    });
    expect(errors).toEqual([]);
  } finally {
    const pool = makePool(process.env.TEST_DATABASE_URL);
    await pool.query("DELETE FROM users WHERE email=$1", [email]);
    await pool.end();
  }
});
