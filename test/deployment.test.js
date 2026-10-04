import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
  stat,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "earth deployment "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  await copyFile(
    new URL("../scripts/deploy.js", import.meta.url),
    join(root, "scripts", "deploy.js"),
  );
  await copyFile(
    new URL("../.env.example", import.meta.url),
    join(root, ".env.example"),
  );
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !/^(NODE_ENV|APP_|DATABASE_URL|REDIS_URL|POSTGRES_PASSWORD|REGISTRATION_ENABLED|DEEPSEEK_|HOST$|PORT$)/.test(
          k,
        ),
    ),
  );
  function cli(args, extraEnv = {}) {
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts", "deploy.js"), ...args],
      { env: { ...cleanEnv, ...extraEnv }, encoding: "utf8" },
    );
    return { ...result, output: result.stdout + result.stderr };
  }
  return { root, cli };
}
test("initialization creates private random credentials without overwriting an existing deployment", async (t) => {
  const { root, cli } = await fixture(t);
  assert.equal(cli(["init"]).status, 0);
  const original = await readFile(join(root, ".env"), "utf8");
  const env = parseEnv(original);
  assert.match(env.POSTGRES_PASSWORD, /^[a-f0-9]{48}$/);
  assert.equal(new URL(env.DATABASE_URL).password, env.POSTGRES_PASSWORD);
  if (process.platform !== "win32")
    assert.equal((await stat(join(root, ".env"))).mode & 0o777, 0o600);
  assert.notEqual(cli(["init"]).status, 0);
  assert.equal(await readFile(join(root, ".env"), "utf8"), original);
  assert.equal(cli(["validate"]).status, 0);
});
test("production rejects unsafe origins and mismatched domains without exposing credentials", async (t) => {
  const { root, cli } = await fixture(t);
  assert.notEqual(
    cli(["init", "--production", "--domain=https://bad.example"]).status,
    0,
  );
  assert.equal(
    cli(["init", "--production", "--domain=earth.example.com"]).status,
    0,
  );
  const original = await readFile(join(root, ".env"), "utf8");
  const env = parseEnv(original);
  assert.equal(env.REGISTRATION_ENABLED, "false");
  assert.equal(cli(["validate", "--production"]).status, 0);
  for (const origin of [
    "http://earth.example.com",
    "https://other.example.com",
    "https://earth.example.com/path",
    "https://earth.example.com/",
  ]) {
    const result = cli(["validate", "--production"], { APP_ORIGIN: origin });
    assert.notEqual(result.status, 0);
    assert.ok(!result.output.includes(env.POSTGRES_PASSWORD));
  }
});
test("malformed database URLs fail without printing secrets", async (t) => {
  const { cli } = await fixture(t);
  cli(["init"]);
  const result = cli(["validate"], {
    DATABASE_URL: "http://private-password@example.com/db",
  });
  assert.notEqual(result.status, 0);
  assert.ok(!result.output.includes("private-password"));
});
test("failed native backups remove incomplete dumps and keep credentials out of arguments", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX executable fixture");
  const { root, cli } = await fixture(t);
  cli(["init"]);
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "pg_dump"),
    '#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = --format=custom ] && [ -n "$PGPASSWORD" ] || exit 99\nprintf partial\nexit 2\n',
    { mode: 0o700 },
  );
  const result = cli(["backup", "--native"], {
    PATH: `${bin}:${process.env.PATH}`,
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(await readdir(join(root, "backups")), []);
});
test("native service installation handles project paths with spaces and supervises both processes", async (t) => {
  if (process.platform !== "linux") return t.skip("Linux user services");
  const { root, cli } = await fixture(t);
  cli(["init", "--production", "--domain=earth.example.com"]);
  await mkdir(join(root, "src"));
  // No real database is mutated in this lifecycle test.
  await writeFile(
    join(root, "src", "migrate.js"),
    "console.log('fixture migration');",
  );
  const bin = join(root, "bin"),
    home = join(root, "user-home");
  await mkdir(bin);
  await writeFile(
    join(bin, "systemctl"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/calls"\n',
    { mode: 0o700 },
  );
  const result = cli(["native-install", "--native"], {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
  });
  assert.equal(result.status, 0, result.output);
  const calls = await readFile(join(home, "calls"), "utf8");
  assert.match(calls, /--user restart earth-api.service earth-worker.service/);
  for (const role of ["api", "worker"]) {
    const text = await readFile(
      join(home, ".config/systemd/user", `earth-${role}.service`),
      "utf8",
    );
    assert.ok(text.includes(`WorkingDirectory=${root}`));
    assert.ok(text.includes(`--env-file="${root}/.env"`));
    assert.match(text, /Restart=on-failure/);
    assert.match(text, /UMask=0077/);
    assert.ok(text.includes(role === "api" ? "server.js" : "worker.js"));
    const verified = spawnSync(
      "systemd-analyze",
      ["verify", join(home, ".config/systemd/user", `earth-${role}.service`)],
      { encoding: "utf8" },
    );
    if (verified.error?.code !== "ENOENT")
      assert.equal(verified.status, 0, verified.stderr);
  }
});
