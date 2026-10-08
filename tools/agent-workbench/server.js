import { createServer } from "node:http";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  contracts,
  inputSchema,
  parseGeneration,
  ContractError,
} from "./contract.js";
import { generate, agentConfig } from "./engine.js";
import { exampleInput } from "./fixtures.js";
import { AgentError } from "./current/src/agent-output.js";
import {
  messageSchema,
  workbenchContracts,
  parseResponse,
} from "./workbench-contract.js";
import {
  catalog,
  listConversations,
  getConversation,
  prepareMessage,
  runMessage,
} from "./workbench.js";
import { getLabKnowledge, closeLabKnowledge } from "./knowledge.js";
const port = Number(process.env.LAB_PORT || 3188),
  token = randomBytes(24).toString("hex");
const jobs = new Map();
let busy = false;
const cfg = agentConfig();
function publicError(e) {
  if (e instanceof ContractError) return { code: e.code, issues: e.issues };
  if (e instanceof AgentError) return e.failure;
  if (e.name === "ZodError")
    return {
      code: "invalid_input",
      issues: e.issues.map((i) => ({ path: i.path, code: i.code })),
    };
  if (
    [
      "fixture_input_mismatch",
      "body_too_large",
      "invalid_json",
      "busy",
      "not_found",
      "invalid_origin",
      "unauthorized",
    ].includes(e.code)
  )
    return { code: e.code };
  return { code: "internal_error" };
}
const fail = (code) => Object.assign(new Error(code), { code });
const json = (res, status, data) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
};
async function body(req) {
  let chunks = [],
    size = 0;
  for await (const b of req) {
    size += b.length;
    if (size > 65536) throw fail("body_too_large");
    chunks.push(b);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw fail("invalid_json");
  }
}
function verify(req) {
  const host = req.headers.host;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host))
    throw fail("invalid_origin");
  if (
    req.headers.origin &&
    !["http://127.0.0.1:" + port, "http://localhost:" + port].includes(
      req.headers.origin,
    )
  )
    throw fail("invalid_origin");
  if (req.method === "POST") {
    const t = Buffer.from(req.headers["x-lab-token"] || "");
    const expected = Buffer.from(token);
    if (t.length !== expected.length || !timingSafeEqual(t, expected))
      throw fail("unauthorized");
  }
}
const server = createServer(async (req, res) => {
  try {
    verify(req);
    const url = new URL(req.url, "http://127.0.0.1:" + port);
    if (req.method === "GET" && url.pathname === "/api/status")
      return json(res, 200, {
        liveConfigured: !!cfg.DEEPSEEK_API_KEY,
        model: cfg.DSH_MODEL,
        searchConfigured: !!cfg.EXA_API_KEY,
        busy,
        token,
        exampleInput,
      });
    if (req.method === "GET" && url.pathname === "/api/contracts")
      return json(res, 200, contracts());
    if (req.method === "GET" && url.pathname === "/api/workbench/contracts")
      return json(res, 200, workbenchContracts());
    if (req.method === "GET" && url.pathname === "/api/capabilities")
      return json(res, 200, catalog);
    if (req.method === "GET" && url.pathname === "/api/conversations")
      return json(res, 200, await listConversations());
    if (
      req.method === "GET" &&
      /^\/api\/knowledge\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(url.pathname)
    ) {
      const knowledge = getLabKnowledge();
      if (!knowledge) throw fail("not_found");
      let conversationId = url.searchParams.get("conversation");
      if (!conversationId && req.headers.referer) {
        try {
          const referer = new URL(req.headers.referer);
          if (
            ["http://127.0.0.1:" + port, "http://localhost:" + port].includes(
              referer.origin,
            )
          )
            conversationId = referer.searchParams.get("conversation");
        } catch {}
      }
      if (conversationId) await getConversation(conversationId);
      const document = await knowledge.getDocument(
        url.pathname.split("/").at(-1),
        { userId: conversationId ?? null },
      );
      if (!document) throw fail("not_found");
      return json(res, 200, {
        id: document.id,
        title: document.title,
        url: document.url ?? document.sourceUrl ?? null,
        text: document.text ?? document.content ?? "",
        updatedAt: document.updatedAt ?? null,
        untrusted: true,
      });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/conversations/"))
      return json(
        res,
        200,
        await getConversation(url.pathname.split("/").at(-1)),
      );
    if (req.method === "POST" && url.pathname === "/api/workbench/validate")
      return json(res, 200, parseResponse(await body(req)));
    if (req.method === "POST" && url.pathname === "/api/messages") {
      const input = messageSchema.parse(await body(req));
      if (busy) throw fail("busy");
      if (!cfg.DEEPSEEK_API_KEY)
        return json(res, 503, { error: { code: "model_unconfigured" } });
      busy = true;
      let conversation;
      try {
        conversation = await prepareMessage(input);
      } catch (e) {
        busy = false;
        throw e;
      }
      const id = randomUUID(),
        record = {
          id,
          status: "running",
          conversationId: conversation.id,
          startedAt: new Date().toISOString(),
        };
      while (jobs.size >= 20) jobs.delete(jobs.keys().next().value);
      jobs.set(id, record);
      void runMessage(conversation, {
        runId: id,
        onProgress: (p) => Object.assign(record, { progress: p }),
      })
        .then((result) =>
          Object.assign(record, { status: "completed", result }),
        )
        .catch((e) =>
          Object.assign(record, { status: "failed", error: publicError(e) }),
        )
        .finally(() => {
          busy = false;
          record.finishedAt = new Date().toISOString();
        });
      return json(res, 202, {
        id,
        conversationId: conversation.id,
        status: "running",
      });
    }
    if (req.method === "POST" && url.pathname === "/api/validate") {
      const v = await body(req);
      return json(
        res,
        200,
        parseGeneration(v.output, inputSchema.parse(v.input)),
      );
    }
    if (req.method === "POST" && url.pathname === "/api/jobs") {
      const input = inputSchema.parse(await body(req));
      if (busy) throw fail("busy");
      if (input.mode === "live" && !cfg.DEEPSEEK_API_KEY)
        return json(res, 503, { error: { code: "model_unconfigured" } });
      const id = randomUUID();
      while (jobs.size >= 20) jobs.delete(jobs.keys().next().value);
      const record = {
        id,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      jobs.set(id, record);
      busy = true;
      void generate(input)
        .then((result) =>
          Object.assign(record, { status: "completed", result }),
        )
        .catch((e) =>
          Object.assign(record, { status: "failed", error: publicError(e) }),
        )
        .finally(() => {
          busy = false;
          record.finishedAt = new Date().toISOString();
        });
      return json(res, 202, { id, status: "running" });
    }
    if (
      req.method === "GET" &&
      /^\/api\/jobs\/[a-f0-9-]{36}$/.test(url.pathname)
    ) {
      const job = jobs.get(url.pathname.split("/").at(-1));
      if (!job) throw fail("not_found");
      return json(res, 200, job);
    }
    const files = {
      "/": "public/index.html",
      "/v2-ui.js": "public/v2-ui.js",
      "/personal-tree-ui.js": "public/personal-tree-ui.js",
      "/tree-icons.js": "public/tree-icons.js",
      "/skill-icons.js": "public/skill-icons.js",
      "/icon-library.html": "public/icon-library.html",
      "/icon-library.js": "public/icon-library.js",
      "/icon-library.css": "public/icon-library.css",
      "/app.js": "public/app.js",
      "/style.css": "public/style.css",
    };
    if (req.method === "GET" && files[url.pathname]) {
      const file = files[url.pathname];
      const content = await readFile(new URL(file, import.meta.url));
      res.writeHead(200, {
        "Content-Type": file.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : file.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
      });
      return res.end(content);
    }
    throw fail("not_found");
  } catch (e) {
    json(
      res,
      e.code === "not_found"
        ? 404
        : e.code === "busy"
          ? 409
          : e.code === "unauthorized" || e.code === "invalid_origin"
            ? 403
            : e.code === "body_too_large"
              ? 413
              : 422,
      { error: publicError(e) },
    );
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(port, "127.0.0.1", () =>
  console.log(
    JSON.stringify({
      event: "lab.ready",
      host: "127.0.0.1",
      port,
      liveConfigured: !!cfg.DEEPSEEK_API_KEY,
      model: cfg.DSH_MODEL,
    }),
  ),
);
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () =>
    server.close(async () => {
      await closeLabKnowledge();
      process.exit(0);
    }),
  );
