import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
export type TestDatabase = { url: string; client: Client };

function maintenanceUrl() {
  let url: URL;
  try { url = new URL(process.env.TEST_DATABASE_URL ?? ""); }
  catch { throw new Error("Set TEST_DATABASE_URL to a local PostgreSQL URL ending in /postgres."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
    || url.pathname !== "/postgres" || url.hash
    || [...url.searchParams.keys()].some(key => key !== "sslmode")) {
    throw new Error("TEST_DATABASE_URL must use loopback and /postgres. Only the sslmode query option is supported.");
  }
  return url;
}

export async function withTestDatabase(run: (database: TestDatabase) => Promise<void>) {
  const url = maintenanceUrl();
  const name = "my_medic_e2e_" + randomUUID().replaceAll("-", "");
  if (!/^my_medic_e2e_[a-f0-9]{32}$/.test(name)) throw new Error("Invalid temporary database name");
  const identifier = '"' + name + '"';
  const admin = new Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  await admin.connect();
  try {
    await admin.query("CREATE DATABASE " + identifier + " TEMPLATE template0");
    try {
      url.pathname = "/" + name;
      await promisify(execFile)(process.execPath, ["scripts/migrate.mjs"], {
        cwd: projectRoot, env: { ...process.env, DATABASE_URL: url.href }, windowsHide: true,
      });
      const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
      await client.connect();
      try { await run({ url: url.href, client }); }
      finally { await client.end(); }
    } finally {
      await admin.query("DROP DATABASE " + identifier + " WITH (FORCE)");
    }
  } finally { await admin.end(); }
}
