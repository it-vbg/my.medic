import { defineConfig } from "@playwright/test";

export const origin = "http://127.0.0.1:3197";

export default defineConfig({
  testDir: "./tests/postgres",
  testMatch: "**/*.spec.ts",
  outputDir: "./test-results/postgres",
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  use: {
    baseURL: origin,
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
  },
});
