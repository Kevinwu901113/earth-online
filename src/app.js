import Fastify from "fastify";
import { publicStandard } from "./standards.js";
import cookie from "@fastify/cookie";
import files from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { Auth } from "./auth.js";
import { Repository } from "./repository.js";
import { credentialsSchema, envelopeSchema, uuid } from "./schemas.js";
import { DomainError } from "./domain.js";
export async function buildApp({ pool, cache, config, logger = false }) {
  const app = Fastify({ logger, bodyLimit: 100000, trustProxy: false });
  const auth = new Auth(pool, config.SESSION_DAYS),
    repo = new Repository(pool, cache);
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.setErrorHandler((e, req, reply) => {
    if (e instanceof ZodError)
      return reply
        .code(400)
        .send({
          error: "输入格式无效",
          details: e.issues.map((i) => ({ path: i.path, message: i.message })),
        });
    const code = e.statusCode ?? 500;
    if (code >= 500)
      req.log.error({ code: e.code, name: e.name }, "Request failed");
    reply
      .code(code)
      .send({ error: code >= 500 ? "服务暂时不可用，请稍后重试" : e.message });
  });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin")
      .header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
    );
    if (req.url.startsWith("/api/")) {
      reply.header("Cache-Control", "no-store");
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        if (req.headers.origin !== config.APP_ORIGIN)
          throw new DomainError("请求来源不匹配", 403);
        if (req.headers["x-earth-client"] !== "web-v1")
          throw new DomainError("缺少请求校验标记", 403);
        if (!req.headers["content-type"]?.startsWith("application/json"))
          throw new DomainError("需要 JSON 请求", 415);
      }
      if (!req.url.startsWith("/api/auth/") && req.url !== "/api/health") {
        req.user = await auth.user(req.cookies.earth_session);
        if (!req.user) throw new DomainError("请先登录", 401);
      }
    }
  });
  const setSession = (reply, token) =>
    reply.setCookie("earth_session", token, {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: config.SESSION_DAYS * 86400,
    });
  for (const kind of ["register", "login"])
    app.post(
      `/api/auth/${kind}`,
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (req, reply) => {
        if (kind === "register" && config.REGISTRATION_ENABLED !== "true")
          throw new DomainError("当前未开放注册", 403);
        const { email, password } = credentialsSchema.parse(req.body);
        const token = await auth[kind](email, password);
        setSession(reply, token);
        return { ok: true };
      },
    );
  app.post("/api/auth/logout", async (req, reply) => {
    await auth.logout(req.cookies.earth_session);
    reply.clearCookie("earth_session", { path: "/" });
    return { ok: true };
  });
  app.get("/api/auth/me", async (req) => {
    const user = await auth.user(req.cookies.earth_session);
    if (!user) throw new DomainError("请先登录", 401);
    return user;
  });
  app.get("/api/health", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      await cache.ping();
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  app.get("/api/state", (req) => repo.state(req.user.id));
  app.post("/api/commands", async (req) => {
    const { expectedVersion, command } = envelopeSchema.parse(req.body);
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{12,100}$/.test(key))
      throw new DomainError("需要有效的重复请求标识", 400);
    return repo.command(req.user.id, key, expectedVersion, command);
  });
  app.get("/api/jobs", (req) => repo.jobs(req.user.id));
  app.get("/api/jobs/:id", (req) =>
    repo.job(req.user.id, uuid.parse(req.params.id)),
  );
  app.post("/api/jobs/:id/cancel", (req) =>
    repo.cancel(req.user.id, uuid.parse(req.params.id)),
  );
  app.get("/api/standards", async () => ({
    items: (
      await pool.query(
        "SELECT id,version,body FROM public_standards ORDER BY id,version",
      )
    ).rows.map(publicStandard),
  }));
  app.get("/api/growth", async (req) => ({
    items: (
      await pool.query(
        "SELECT source_id,kind,xp,attribute,rule_version,created_at FROM growth_ledger WHERE user_id=$1 ORDER BY created_at DESC",
        [req.user.id],
      )
    ).rows,
  }));
  app.get("/api/export", async (req, reply) => {
    reply.header(
      "Content-Disposition",
      'attachment; filename="earth-online-data.json"',
    );
    return {
      account: req.user,
      ...(await repo.state(req.user.id)),
      growth: (
        await pool.query("SELECT * FROM growth_ledger WHERE user_id=$1", [
          req.user.id,
        ])
      ).rows,
    };
  });
  await app.register(files, {
    root: fileURLToPath(new URL("../public/", import.meta.url)),
    index: "index.html",
  });
  return app;
}
