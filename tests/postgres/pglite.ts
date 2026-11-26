import { readFile, readdir } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";

export async function migrateTestDatabase(database: PGlite) {
  const directory = new URL("../../db/migrations/", import.meta.url);
  const files = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  await database.exec("CREATE SCHEMA medic");
  for (const name of files) await database.exec(await readFile(new URL(name, directory), "utf8"));
}
