import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const localData = join(tmpdir(), "my-medic-browser-" + randomUUID());
const baseURL = "http://127.0.0.1:3187";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.ts",
  workers: 1,
  timeout: 45_000,
  reporter: "list",
  metadata: { localData },
  globalTeardown: "./tests/browser/cleanup.ts",
  use: {
    baseURL, browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
    viewport: { width: 1366, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3187",
    url: baseURL,
    reuseExistingServer: false,
    env: { NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "", MY_MEDIC_DATA_DIR: localData },
  },
});
