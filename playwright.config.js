import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:3101",
    viewport: { width: 390, height: 844 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node test/e2e/server.js",
    port: 3101,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
