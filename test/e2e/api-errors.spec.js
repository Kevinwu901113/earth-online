import { test, expect } from "./fixtures.js";

for (const response of [
  {
    name: "empty response",
    status: 200,
    body: "",
    type: "application/json",
    message: "服务未返回数据，请刷新重试。",
  },
  {
    name: "gateway HTML",
    status: 401,
    body: "<html>PRIVATE_GATEWAY_BODY</html>",
    type: "text/html",
    message: "服务返回了异常响应，请检查访问地址或重新登录后重试。",
  },
]) {
  test(`login handles ${response.name} and retains the form for retry`, async ({
    page,
  }) => {
    await page.route("**/api/auth/login", (route) =>
      route.fulfill({
        status: response.status,
        contentType: response.type,
        body: response.body,
      }),
    );
    await page.goto("/");
    await page
      .getByLabel("邮箱", { exact: true })
      .fill("error-test@example.invalid");
    await page.getByLabel("密码（至少 12 位）").fill("test-password-long");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.locator(".inline-error")).toHaveText(response.message);
    await expect(
      page.getByRole("button", { name: "登录", exact: true }),
    ).toBeEnabled();
    await expect(page.getByLabel("邮箱", { exact: true })).toHaveValue(
      "error-test@example.invalid",
    );
    await expect(page.locator("body")).not.toContainText(
      "PRIVATE_GATEWAY_BODY",
    );
  });
}
