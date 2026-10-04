import test from "node:test";
import assert from "node:assert/strict";
import {
  createOriginPolicy,
  browserOriginAllowed,
} from "../src/request-origin.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/app.js";

const external = "https://sturdy-lamp-jq66rpvg79wfpgvg-3000.app.github.dev";
const rewritten = "https://localhost:3000";
const validHeaders = {
  origin: rewritten,
  referer: `${external}/`,
  "sec-fetch-site": "same-origin",
};

test("proxy rewriting is opt-in and exact public Origin continues to work", () => {
  const policy = createOriginPolicy(external);
  assert.equal(browserOriginAllowed({ origin: external }, policy), true);
  assert.equal(browserOriginAllowed(validHeaders, policy), false);
  assert.equal(
    browserOriginAllowed(
      { origin: external, "sec-fetch-site": "cross-site" },
      policy,
    ),
    false,
  );
});
test("observed HTTPS localhost rewrite requires both canonical Referer and same-origin metadata", () => {
  const policy = createOriginPolicy(external, rewritten);
  assert.equal(browserOriginAllowed(validHeaders, policy), true);
  for (const changed of [
    { origin: "http://localhost:3000" },
    { origin: "https://localhost:3001" },
    { origin: "null" },
    { origin: undefined },
    { referer: undefined },
    { referer: "not-a-url" },
    { referer: "https://attacker.invalid/" },
    { referer: `${external}.attacker.invalid/` },
    { referer: "https://user:password@" + new URL(external).host },
    { "sec-fetch-site": undefined },
    { "sec-fetch-site": "same-site" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "none" },
  ])
    assert.equal(
      browserOriginAllowed({ ...validHeaders, ...changed }, policy),
      false,
      JSON.stringify(changed),
    );
  assert.equal(
    browserOriginAllowed(
      {
        origin: rewritten,
        host: new URL(external).host,
        "x-forwarded-host": new URL(external).host,
        "x-forwarded-proto": "https",
      },
      policy,
    ),
    false,
  );
});
test("configuration rejects wildcard, remote aliases and malformed origins", () => {
  for (const aliases of [
    "*",
    "https://attacker.invalid",
    `${rewritten}/`,
    `${rewritten},`,
    "https://localhost:3000/path",
    "https://user@localhost:3000",
  ]) {
    assert.throws(() => createOriginPolicy(external, aliases));
    assert.throws(() =>
      config({
        DATABASE_URL: "unused",
        REDIS_URL: "unused",
        APP_ORIGIN: external,
        APP_PROXY_ORIGINS: aliases,
      }),
    );
  }
  assert.throws(() =>
    createOriginPolicy("http://earth.example.com", rewritten),
  );
  assert.throws(() => createOriginPolicy("https://localhost:3000", rewritten));
  assert.throws(() => createOriginPolicy(`${external}/`));
});

test("real API hooks accept constrained proxy requests and still reject cross-site writes", async () => {
  const cfg = config({
    DATABASE_URL: "unused",
    REDIS_URL: "unused",
    APP_ORIGIN: external,
    APP_PROXY_ORIGINS: rewritten,
    NODE_ENV: "production",
    REGISTRATION_ENABLED: "false",
  });
  const app = await buildApp({
    pool: {
      query() {
        throw new Error("Database must not be called");
      },
    },
    cache: {},
    config: cfg,
  });
  try {
    const headers = {
      ...validHeaders,
      "x-earth-client": "web-v1",
      "content-type": "application/json",
    };
    const request = (overrides) =>
      app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { ...headers, ...overrides },
        payload: {},
      });
    const allowed = await request({});
    assert.equal(allowed.json().error, "当前未开放注册"); // reached the real handler
    for (const overrides of [
      { referer: "https://attacker.invalid/" },
      { "sec-fetch-site": "cross-site" },
      { origin: "https://attacker.invalid" },
    ]) {
      const denied = await request(overrides);
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().error, "请求来源不匹配");
    }
    const missingMarker = await request({ "x-earth-client": "invalid" });
    assert.equal(missingMarker.statusCode, 403);
    assert.equal(missingMarker.json().error, "缺少请求校验标记");
    const wrongType = await request({ "content-type": "text/plain" });
    assert.equal(wrongType.statusCode, 415);
  } finally {
    await app.close();
  }
});
