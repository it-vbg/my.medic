import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DATABASE_URL before running migrations.");
const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
const directory = new URL("../db/migrations/", import.meta.url);

try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(601173285, 1)");
    await client.query("CREATE SCHEMA IF NOT EXISTS medic");
    await client.query(`CREATE TABLE IF NOT EXISTS medic.schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = new Map((await client.query("SELECT version, checksum FROM medic.schema_migrations")).rows
      .map(row => [row.version, row.checksum]));
    const files = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
    if (!files.length || [...applied.keys()].some(version => !files.includes(version))) {
      throw new Error("The migration files do not match this database.");
    }
    for (const filename of files) {
      const sql = (await readFile(new URL(filename, directory), "utf8")).replace(/\r\n/g, "\n");
      const checksum = createHash("sha256").update(sql).digest("hex");
      if (applied.has(filename)) {
        if (applied.get(filename) !== checksum) throw new Error("A previously applied migration changed: " + filename);
        continue;
      }
      await client.query(sql);
      await client.query("INSERT INTO medic.schema_migrations(version, checksum) VALUES ($1, $2)", [filename, checksum]);
      console.log("Applied", filename);
    }
    await client.query("COMMIT");
    console.log("PostgreSQL schema is up to date.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
} finally { await pool.end(); }
