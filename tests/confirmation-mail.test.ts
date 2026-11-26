import assert from "node:assert/strict";
import { test } from "node:test";
import { sendConfirmationMail } from "../lib/confirmation-mail.ts";

test("misconfigured confirmation links and SMTP endpoints fail without exposing their values", async (t) => {
  const keys = ["APP_URL", "SMTP_URL", "SMTP_FROM"] as const;
  for (const key of keys) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  process.env.SMTP_URL = "smtp://127.0.0.1:1";
  process.env.SMTP_FROM = "my.medic <cabinet@example.test>";
  const send = () => sendConfirmationMail("recipient@example.test", "test-token");
  const configError = (field: string) => (error: unknown) => error instanceof Error
    && error.message.includes(field) && !error.message.includes("example.test") && !error.message.includes("test-token");
  for (const url of ["http://public.example.test", "http://127.0.0.1.example.test", "ftp://localhost",
    "https://example.test:synthetic-password@public.example.test"]) {
    process.env.APP_URL = url;
    await assert.rejects(send, configError("APP_URL"));
  }
  process.env.APP_URL = "https://public.example.test";
  process.env.SMTP_URL = "https://example.test";
  await assert.rejects(send, configError("SMTP_URL"));
  process.env.SMTP_URL = "smtp://127.0.0.1:1";
  delete process.env.SMTP_FROM;
  await assert.rejects(send, configError("SMTP_FROM"));
});
