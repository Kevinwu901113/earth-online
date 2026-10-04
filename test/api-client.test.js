import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(
  new URL("../public/api-client.js", import.meta.url),
  "utf8",
);
function client(fetch) {
  const window = {};
  runInNewContext(source, { window, fetch });
  return window.earthApi.request;
}
test("client preserves same-origin credentials and retry idempotency keys", async () => {
  let called;
  const request = client(async (...args) => {
    called = args;
    return new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    });
  });
  const data = await request("/commands", {
    method: "POST",
    body: { expectedVersion: 2 },
    key: "stable-retry-key",
  });
  assert.equal(data.ok, true);
  assert.equal(called[0], "/api/commands");
  assert.equal(called[1].credentials, "same-origin");
  assert.equal(called[1].headers["Idempotency-Key"], "stable-retry-key");
  assert.equal(called[1].headers["x-earth-client"], "web-v1");
  assert.equal(JSON.parse(called[1].body).expectedVersion, 2);
});
test("server JSON errors preserve their status and message", async () => {
  const request = client(
    async () => new Response('{"error":"请求来源不匹配"}', { status: 403 }),
  );
  await assert.rejects(
    request("/auth/login"),
    (e) =>
      e.status === 403 &&
      e.code === "HTTP_ERROR" &&
      e.message === "请求来源不匹配",
  );
});
test("empty, HTML and malformed responses produce actionable errors rather than JSON exceptions", async () => {
  for (const [body, status, code] of [
    ["", 200, "EMPTY_RESPONSE"],
    [" ", 502, "EMPTY_RESPONSE"],
    ["<html>PRIVATE_GATEWAY_BODY</html>", 401, "INVALID_RESPONSE"],
    ['{"unfinished":', 200, "INVALID_RESPONSE"],
    ["null", 200, "INVALID_RESPONSE"],
  ]) {
    const request = client(async () => new Response(body, { status }));
    await assert.rejects(
      request("/state"),
      (e) =>
        e.status === status &&
        e.code === code &&
        !e.message.includes("PRIVATE_GATEWAY_BODY") &&
        !e.message.includes("Unexpected"),
    );
  }
});
test("network failure and interrupted response are distinguished without leaking raw errors", async () => {
  const request = client(async () => {
    throw new Error("PRIVATE_NETWORK_ERROR");
  });
  await assert.rejects(
    request("/state"),
    (e) =>
      e.status === 0 &&
      e.code === "NETWORK_ERROR" &&
      !e.message.includes("PRIVATE_NETWORK_ERROR"),
  );
  const interrupted = client(async () => ({
    status: 200,
    text: async () => {
      throw new Error("interrupted");
    },
  }));
  await assert.rejects(
    interrupted("/state"),
    (e) => e.status === 200 && e.code === "RESPONSE_INTERRUPTED",
  );
});
