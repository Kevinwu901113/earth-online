import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
async function walk(dir) {
  for (const f of await readdir(dir, { withFileTypes: true })) {
    const p = dir + "/" + f.name;
    if (f.isDirectory()) await walk(p);
    else if (p.endsWith(".js")) {
      const r = spawnSync(process.execPath, ["--check", p], {
        stdio: "inherit",
      });
      if (r.status) process.exit(r.status);
    }
  }
}
for (const d of ["src", "dsh", "scripts", "test", "packages/planning-rag"])
  await walk(d);
for (const p of [
  "public/app.js",
  "public/character.js",
  "public/api-client.js",
]) {
  const r = spawnSync(process.execPath, ["--check", p], { stdio: "inherit" });
  if (r.status) process.exit(r.status);
}
