import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createOriginPolicy } from "../src/request-origin.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const [action = "help", ...flags] = process.argv.slice(2);
const production = flags.includes("--production");
const native = flags.includes("--native");
const domain = flags.find((v) => v.startsWith("--domain="))?.slice(9);
const allowed = new Set(["--production", "--native"]);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed; check installation and the output above.`,
    );
  return result;
}
function domainValid(value) {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    value.includes(".") &&
    value
      .split(".")
      .every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part)) &&
    !/^\d+(\.\d+){3}$/.test(value) &&
    !value.endsWith(".localhost")
  );
}
async function settings() {
  const env = { ...parseEnv(await readFile(".env", "utf8")), ...process.env };
  const cfg = {
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: "3000",
    ...env,
  };
  if (
    !["development", "test", "production"].includes(cfg.NODE_ENV) ||
    !/^\d+$/.test(cfg.PORT) ||
    Number(cfg.PORT) < 1 ||
    Number(cfg.PORT) > 65535 ||
    !["true", "false"].includes(cfg.REGISTRATION_ENABLED)
  )
    throw new Error("Invalid NODE_ENV, PORT or REGISTRATION_ENABLED in .env.");
  for (const [key, protocols] of [
    ["APP_ORIGIN", ["http:", "https:"]],
    ["DATABASE_URL", ["postgres:", "postgresql:"]],
    ["REDIS_URL", ["redis:", "rediss:"]],
  ]) {
    try {
      if (!protocols.includes(new URL(cfg[key]).protocol)) throw new Error();
    } catch {
      throw new Error(`Invalid ${key} URL in .env.`);
    }
  }
  const prod = production || cfg.NODE_ENV === "production";
  createOriginPolicy(cfg.APP_ORIGIN, cfg.APP_PROXY_ORIGINS);
  if (!native && Number(cfg.PORT) !== 3000)
    throw new Error(
      "Compose uses PORT=3000 internally. Change the gateway/host mapping for a different external port.",
    );
  if (prod) {
    const origin = new URL(cfg.APP_ORIGIN);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== cfg.APP_ORIGIN ||
      !domainValid(origin.hostname)
    )
      throw new Error(
        "Production APP_ORIGIN must be an HTTPS origin with a public domain and no trailing slash/path.",
      );
    if (cfg.NODE_ENV !== "production")
      throw new Error("Set NODE_ENV=production so session cookies are secure.");
    if (!native) {
      if (
        !domainValid(env.APP_DOMAIN) ||
        cfg.APP_ORIGIN !== `https://${env.APP_DOMAIN}`
      )
        throw new Error(
          "APP_DOMAIN and APP_ORIGIN must describe the same HTTPS domain.",
        );
      if (!/^[a-f0-9]{32,}$/i.test(env.POSTGRES_PASSWORD || ""))
        throw new Error(
          "Set POSTGRES_PASSWORD to a random hexadecimal value of at least 32 characters.",
        );
    }
  }
  if (!cfg.DEEPSEEK_API_KEY)
    console.log(
      "AI credentials missing: accounts and records work; AI tasks will fail explicitly.",
    );
  return { env, cfg, prod };
}
function compose(env, prod, args, options = {}) {
  const files = prod
    ? ["-f", "compose.production.yaml"]
    : ["-f", "compose.yaml", "-f", "compose.app.yaml"];
  return run(
    "docker",
    [
      "compose",
      "--project-name",
      "earth-online",
      "--env-file",
      ".env",
      ...files,
      ...args,
    ],
    { env, ...options },
  );
}
async function backup(env, cfg, prod) {
  await mkdir("backups", { recursive: true, mode: 0o700 });
  await chmod("backups", 0o700);
  const path = resolve(
    "backups",
    `earth-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}.dump`,
  );
  const fd = openSync(path, "wx", 0o600);
  try {
    if (native) {
      const url = new URL(cfg.DATABASE_URL);
      run("pg_dump", ["--format=custom"], {
        env: {
          ...env,
          PGHOST: url.hostname,
          PGPORT: url.port || "5432",
          PGUSER: decodeURIComponent(url.username),
          PGPASSWORD: decodeURIComponent(url.password),
          PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
          ...(url.searchParams.has("sslmode")
            ? { PGSSLMODE: url.searchParams.get("sslmode") }
            : {}),
        },
        stdio: ["ignore", fd, "inherit"],
      });
    } else
      compose(
        env,
        prod,
        [
          "exec",
          "-T",
          "postgres",
          "pg_dump",
          "-U",
          "earth",
          "-d",
          "earth_online",
          "--format=custom",
        ],
        { stdio: ["ignore", fd, "inherit"] },
      );
  } catch (e) {
    await unlink(path);
    throw e;
  } finally {
    closeSync(fd);
  }
  console.log(`Backup saved: ${path}`);
}
function unit(role) {
  // systemd has its own quoting and percent expansion rules.
  const quote = (s) =>
    `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
  return `[Unit]\nDescription=Earth Online ${role}\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${root.replaceAll("%", "%%")}\nExecStart=${quote(process.execPath)} --env-file=${quote(join(root, ".env"))} ${quote(join(root, "src", role === "api" ? "server.js" : "worker.js"))}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`;
}
async function main() {
  for (const flag of flags)
    if (!allowed.has(flag) && !flag.startsWith("--domain="))
      throw new Error(`Unknown option: ${flag}`);
  if (action === "help") {
    console.log(
      `npm run deploy -- <command> [--production] [--native]\n\ninit [--domain=earth.example.com]  Create private .env; never overwrite\ncheck                             Validate configuration and dependencies\nup / down / status / logs         Manage the Compose stack\nbackup                            PostgreSQL custom-format backup\nupdate                            Backup, fast-forward source and restart\nnative-install                    Migrate and install Linux user services\n\nProduction Compose includes HTTPS. Native mode requires existing PostgreSQL, Redis and a reverse proxy. See docs/deployment.md.`,
    );
    return;
  }
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("Node.js 24+ is required.");
  if (action === "init") {
    if (production && !domainValid(domain))
      throw new Error(
        "Use --production --domain=your.public.domain (without https://).",
      );
    const password = randomBytes(24).toString("hex");
    let text = await readFile(".env.example", "utf8");
    text = text.replaceAll("local-development-only", password);
    text += `\n# Container database password; keep synchronized with DATABASE_URL for native mode.\nPOSTGRES_PASSWORD=${password}\n`;
    if (production) {
      text = text
        .replace("NODE_ENV=development", "NODE_ENV=production")
        .replace(
          "APP_ORIGIN=http://localhost:3000",
          `APP_ORIGIN=https://${domain}`,
        )
        .replace("REGISTRATION_ENABLED=true", "REGISTRATION_ENABLED=false");
      text += `APP_DOMAIN=${domain}\n`;
    }
    await writeFile(".env", text, { flag: "wx", mode: 0o600 });
    console.log(
      "Created .env. Fill in API credentials; production registration starts disabled. Existing databases require their existing password.",
    );
    return;
  }
  const { env, cfg, prod } = await settings();
  const system = (args) => run("systemctl", ["--user", ...args], { env });
  if (action === "validate") {
    console.log("Deployment configuration valid.");
  } else if (action === "check") {
    if (native) {
      const { makePool } = await import("../src/db.js");
      const { createClient } = await import("redis");
      const pool = makePool(cfg.DATABASE_URL);
      const cache = createClient({
        url: cfg.REDIS_URL,
        socket: { connectTimeout: 5000, reconnectStrategy: false },
      });
      cache.on("error", () => {});
      try {
        await pool.query({ text: "SELECT 1", query_timeout: 5000 });
        await cache.connect();
        await cache.ping();
      } catch {
        throw new Error(
          "Database/Redis check failed. Verify services, credentials and network access.",
        );
      } finally {
        if (cache.isOpen) cache.destroy();
        await pool.end();
      }
    } else {
      run("docker", ["compose", "version"], { env });
      run("docker", ["info", "--format", "{{.ServerVersion}}"], { env });
      compose(env, prod, ["config", "--quiet"]);
    }
    console.log(
      "Configuration and dependency checks passed. This does not verify DNS/TLS, worker execution or model quality.",
    );
  } else if (action === "backup") await backup(env, cfg, prod);
  else if (action === "native-install") {
    if (!native || process.platform !== "linux")
      throw new Error("native-install requires Linux and --native.");
    if (cfg.HOST !== "127.0.0.1")
      throw new Error(
        "Native reverse-proxy deployment requires HOST=127.0.0.1.",
      );
    await chmod(".env", 0o600);
    run(process.execPath, ["--env-file=.env", "src/migrate.js"], { env });
    const dir = join(homedir(), ".config", "systemd", "user");
    await mkdir(dir, { recursive: true });
    for (const role of ["api", "worker"])
      await writeFile(join(dir, `earth-${role}.service`), unit(role), {
        mode: 0o600,
      });
    system(["daemon-reload"]);
    system(["enable", "earth-api.service", "earth-worker.service"]);
    system(["restart", "earth-api.service", "earth-worker.service"]);
    console.log(
      "Services installed. Enable user lingering for startup after reboot/logout; configure Caddy separately. See docs/deployment.md.",
    );
  } else if (["up", "down", "status", "logs"].includes(action)) {
    if (native) {
      if (action === "logs")
        run(
          "journalctl",
          ["--user", "-u", "earth-api", "-u", "earth-worker", "-f"],
          { env },
        );
      else
        system([
          { up: "start", down: "stop", status: "status" }[action],
          "earth-api",
          "earth-worker",
        ]);
    } else {
      if (action === "up") {
        compose(env, prod, ["config", "--quiet"]);
        compose(env, prod, ["build"]);
        compose(env, prod, ["rm", "-s", "-f", "migrate"]);
        compose(env, prod, ["up", "-d", "--wait", "--wait-timeout", "180"]);
        console.log(
          `Started. Open ${cfg.APP_ORIGIN}. Check worker status and complete an AI task to verify the full pipeline.`,
        );
      } else
        compose(
          env,
          prod,
          {
            down: ["down"],
            status: ["ps", "-a"],
            logs: ["logs", "--tail", "100", "-f"],
          }[action],
        );
    }
  } else if (action === "update") {
    const dirty = run("git", ["status", "--porcelain"], {
      stdio: ["ignore", "pipe", "inherit"],
    }).stdout.toString();
    if (dirty.trim())
      throw new Error(
        "Commit or stash tracked/untracked source changes before update. .env and backups remain local.",
      );
    await backup(env, cfg, prod);
    run("git", ["pull", "--ff-only"]);
    if (native) {
      system(["stop", "earth-api", "earth-worker"]);
      run("npm", ["ci", "--omit=dev", "--ignore-scripts"], { env });
      run(process.execPath, ["--env-file=.env", "src/migrate.js"], { env });
      system(["start", "earth-api", "earth-worker"]);
    } else {
      compose(env, prod, ["build"]);
      compose(env, prod, ["stop", "api", "worker"]);
      compose(env, prod, ["rm", "-s", "-f", "migrate"]);
      compose(env, prod, ["up", "-d", "--wait", "--wait-timeout", "180"]);
    }
    console.log(
      "Update complete. Verify status and one real AI task. Backup is retained; schema rollback is manual.",
    );
  } else throw new Error(`Unknown command: ${action}`);
}
main().catch((error) => {
  console.error(
    error.code === "EEXIST"
      ? ".env already exists; left unchanged."
      : error.code === "ENOENT"
        ? "Missing file or executable. Run init first and install the required tools."
        : error.message,
  );
  process.exitCode = 1;
});
