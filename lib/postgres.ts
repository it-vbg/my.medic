import { Pool, type PoolClient } from "pg";

const runtime = globalThis as typeof globalThis & { myMedicPool?: Pool };

export function getPostgresPool(connectionString: string) {
  if (!runtime.myMedicPool) {
    const pool = new Pool({ connectionString, application_name: "my.medic", connectionTimeoutMillis: 5000 });
    pool.on("error", () => console.error("Lost an idle PostgreSQL connection"));
    runtime.myMedicPool = pool;
  }
  return runtime.myMedicPool;
}

export async function withTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}
