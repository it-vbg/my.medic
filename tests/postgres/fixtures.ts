import { test as base } from "@playwright/test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { origin } from "../../playwright.postgres.config";
import { projectRoot, type TestDatabase, withTestDatabase } from "./database";

export type Mailbox = { url: string; messages: Map<string, string> };
type Worker = { database: TestDatabase; mailbox: Mailbox; application: void };

export const test = base.extend<{}, Worker>({
  database: [async ({}, use) => {
    await withTestDatabase(use);
  }, { scope: "worker" }],

  mailbox: [async ({}, use) => {
    const messages = new Map<string, string>();
    const smtp = new SMTPServer({
      disabledCommands: ["AUTH", "STARTTLS"],
      onData(stream, session, done) {
        simpleParser(stream).then(mail => {
          for (const recipient of session.envelope.rcptTo) messages.set(recipient.address, mail.text ?? "");
          done();
        }, done);
      },
    });
    await new Promise<void>((resolve, reject) => {
      smtp.once("error", reject);
      smtp.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = smtp.server.address();
      if (!address || typeof address === "string") throw new Error("SMTP must listen on a loopback TCP port");
      await use({ url: "smtp://127.0.0.1:" + address.port, messages });
    } finally { await new Promise<void>(resolve => smtp.close(resolve)); }
  }, { scope: "worker" }],

  application: [async ({ database, mailbox }, use, worker) => {
    const url = new URL(origin);
    const child = spawn(process.execPath, [
      "node_modules/next/dist/bin/next", "start", "--hostname", url.hostname, "--port", url.port,
    ], {
      cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env, NODE_ENV: "production", MY_MEDIC_STORAGE: "postgres", DATABASE_URL: database.url, APP_URL: origin,
        SMTP_URL: mailbox.url, SMTP_FROM: "cabinet@example.test",
        MY_MEDIC_DATA_DIR: join(worker.project.outputDir, "sqlite-fallback"),
      },
    });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    const lines = createInterface({ input: child.stdout });
    // Only the child that bound this port can report ready. An unrelated listener must never receive test data.
    const ready = new Promise<void>((resolve, reject) => {
      lines.on("line", line => { if (line.includes("Ready in")) resolve(); });
      child.once("error", reject);
      child.once("close", code => reject(new Error("Next.js exited before becoming ready (code " + code + "). Run npm run build first.")));
    });
    const startupLimit = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      await ready;
      clearTimeout(startupLimit);
      await use();
    } finally {
      clearTimeout(startupLimit);
      child.kill();
      const shutdownLimit = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await closed; }
      finally { clearTimeout(shutdownLimit); lines.close(); }
    }
  }, { scope: "worker", auto: true }],
});
