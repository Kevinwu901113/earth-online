import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { initialState, rules } from "../../src/domain.js";
test.use({ channel: process.platform === "win32" ? "msedge" : undefined });
test("personal tree switches branches, retains expansion and supports wheel zoom on mobile and desktop", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const state = initialState();
  await page.route("http://skill-tree.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me")
      return route.fulfill({
        json: { id: "test", email: "test@example.invalid" },
      });
    if (path === "/api/state")
      return route.fulfill({ json: { state, version: 0, rules } });
    if (path === "/api/jobs") return route.fulfill({ json: [] });
    const file = resolve("public", "." + (path === "/" ? "/index.html" : path));
    if (!file.startsWith(resolve("public"))) return route.abort();
    try {
      await route.fulfill({
        body: await readFile(file),
        contentType:
          {
            ".js": "text/javascript",
            ".css": "text/css",
            ".html": "text/html",
            ".woff2": "font/woff2",
          }[extname(file)] ?? "application/octet-stream",
      });
    } catch {
      await route.fulfill({ status: 404, body: "" });
    }
  });
  await page.goto("http://skill-tree.test/");
  await page.locator('[data-page="growth"]').click();
  await expect(
    page.getByRole("button", { name: "身心", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "身心", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "体能", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "身心", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "体能", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "认知", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "体能", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "语言", exact: true }),
  ).toBeVisible();
  const node = page.getByRole("button", { name: "认知", exact: true }),
    before = await node.boundingBox();
  await page.locator(".tree-viewport").hover();
  await page.mouse.wheel(0, 160);
  await expect
    .poll(async () => Math.round((await node.boundingBox()).width))
    .not.toBe(Math.round(before.width));
  await page.screenshot({
    path: "test-results/skill-tree-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1200, height: 900 });
  await expect(node).toBeVisible();
  await page.screenshot({
    path: "test-results/skill-tree-desktop.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
