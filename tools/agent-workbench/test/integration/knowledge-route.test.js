import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test(
  "workbench source route returns 404 for IDs outside the library contract",
  { timeout: 10000 },
  async () => {
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const child = spawn(process.execPath, ["server.js"], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: {
        PATH: process.env.PATH,
        LAB_PORT: String(port),
        NODE_ENV: "test",
        RAG_ENABLED: "true",
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      await new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(
          () => reject(new Error("workbench_start_timeout")),
          5000,
        );
        child.stdout.on("data", (data) => {
          output += data;
          if (output.includes('"lab.ready"')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("workbench_start_failed"));
        });
      });
      for (const id of ["_leading", "-leading", "a".repeat(101), "bad.id"]) {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/knowledge/${id}`,
        );
        assert.equal(response.status, 404, id);
        assert.equal((await response.json()).error.code, "not_found");
      }
    } finally {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
    }
  },
);
