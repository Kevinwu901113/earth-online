import { test, expect } from "./fixtures.js";
import { randomUUID } from "node:crypto";
import { makePool } from "../../src/db.js";

test("route failure and retry stay visible on the goal and its open detail view", async ({
  page,
}) => {
  const email = randomUUID() + "@route.test.invalid";
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "还没有账号？注册" }).click();
    await page.getByLabel("邮箱", { exact: true }).fill(email);
    await page.getByLabel("密码（至少 12 位）").fill("route-test-password");
    await page.getByRole("button", { name: "注册", exact: true }).click();
    await expect(page.locator(".overlay")).toBeHidden();
    await page.locator("[data-nav=quests]").click();
    await page.getByRole("button", { name: "开启新主线" }).click();
    await page.getByLabel("想完成什么").fill("校验失败后重试");
    await page
      .getByLabel("现在的基础与条件（不了解可以写未知）")
      .fill("初学者");
    await page
      .getByLabel("怎样才算完成？留下什么可判断的成果？")
      .fill("写出三个要点");
    await page.getByRole("button", { name: "生成路线草案" }).click();
    await page.getByRole("button", { name: "查看目标", exact: true }).click();
    const detail = page.locator(".sheet-content");
    await expect(detail.locator(".planning-status")).toContainText(
      /排队|正在生成/,
    );
    await expect(
      detail.getByRole("button", { name: "取消本次规划" }),
    ).toBeVisible();
    await expect(detail.locator(".planning-status")).toContainText(
      "路线规划失败",
      { timeout: 10000 },
    );
    await expect(detail.locator(".planning-status")).toContainText(
      "内容格式不符合要求",
    );
    await expect(detail.locator(".planning-status")).not.toContainText(
      "检查模型服务",
    );
    await page.getByRole("button", { name: "关闭详情" }).click();
    await expect(page.locator(".quest-tag")).toHaveText("路线规划失败");
    await page.reload();
    await page.locator("[data-nav=quests]").click();
    await expect(page.locator(".planning-status")).toContainText(
      "路线规划失败",
    );
    await page.getByRole("button", { name: "重试规划", exact: true }).click();
    await page.getByLabel("每天可用分钟").fill("20");
    await page.getByRole("button", { name: "生成新草案" }).click();
    await expect(detail.locator(".planning-status")).toContainText(
      /排队|正在生成/,
    );
    await expect(detail).not.toContainText("内容格式不符合要求");
    await expect(
      detail.getByRole("button", { name: "确认这条路线" }),
    ).toBeVisible({ timeout: 10000 });
    await detail.getByRole("button", { name: "确认这条路线" }).click();
    await expect(
      detail.getByRole("button", { name: "安排练习", exact: true }),
    ).toBeVisible();
    await expect(detail.locator(".status")).toContainText("路线版本 1");
  } finally {
    const pool = makePool(process.env.TEST_DATABASE_URL);
    await pool.query("DELETE FROM users WHERE email=$1", [email]);
    await pool.end();
  }
});
