import { test as base, expect } from "@playwright/test";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

// An account isolates database state, but not the app's IP rate-limit window.
// Each browser case owns its app/worker lifecycle, with production limits intact.
export const test = base.extend({
  appServer: [
    async ({}, use) => {
      const child = fork(
        fileURLToPath(new URL("./server.js", import.meta.url)),
        [],
        {
          execArgv: [],
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      let output = "";
      const capture = (chunk) => {
        output = (output + chunk).slice(-4000);
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      try {
        await new Promise((resolve, reject) => {
          const finish = (error) => {
            clearTimeout(timer);
            child.off("message", message);
            child.off("exit", exited);
            child.off("error", failed);
            error ? reject(error) : resolve();
          };
          const message = (value) => {
            if (value?.type === "ready") finish();
          };
          const exited = (code) =>
            finish(new Error(`Test server exited (${code}): ${output}`));
          const failed = (error) => finish(error);
          const timer = setTimeout(
            () => finish(new Error(`Test server startup timeout: ${output}`)),
            30000,
          );
          child.on("message", message);
          child.once("exit", exited);
          child.once("error", failed);
        });
        await use();
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise((resolve) => {
            const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
            child.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
            child.kill("SIGTERM");
          });
        }
      }
    },
    { auto: true },
  ],
});
export { expect };
