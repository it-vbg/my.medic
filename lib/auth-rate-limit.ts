import type { Pool, PoolClient } from "pg";
import { CabinetError } from "./cabinet.ts";
import { digest } from "./credentials.ts";
import { withTransaction } from "./postgres.ts";

const globalKey = digest("auth:global");
const subjectLimits = { signIn: 10, signUp: 5, confirmEmail: 5 } as const;

async function consume(client: PoolClient, key: Buffer, limit: number, seconds: number) {
  const { rows: [bucket] } = await client.query<{ attempts: number }>(`
    INSERT INTO medic.auth_rate_limits AS current (key_hash, attempts, expires_at)
    VALUES ($1, 1, statement_timestamp() + $3::integer * interval '1 second')
    ON CONFLICT (key_hash) DO UPDATE SET
      attempts = CASE WHEN current.expires_at <= statement_timestamp() THEN 1 ELSE current.attempts + 1 END,
      expires_at = CASE WHEN current.expires_at <= statement_timestamp() THEN excluded.expires_at ELSE current.expires_at END
    WHERE current.expires_at <= statement_timestamp() OR current.attempts < $2
    RETURNING attempts
  `, [key, limit, seconds]);
  if (!bucket) throw new CabinetError("Слишком много попыток. Попробуйте позже.", 429);
  return bucket.attempts;
}

export async function limitAuthAttempt(pool: Pool, action: keyof typeof subjectLimits, subject: string, clientAddress?: string) {
  await withTransaction(pool, async (client) => {
    // Check the fixed global key before allocating a counter for any client-provided identity.
    // A rejected client or subject rolls back the reservation, preserving capacity for other people.
    const globalAttempts = await consume(client, globalKey, 120, 60);
    await consume(client, digest("auth:client:" + (clientAddress ?? "shared")), 30, 5 * 60);
    await consume(client, digest("auth:" + action + ":" + subject), subjectLimits[action], 15 * 60);
    if (globalAttempts === 1) {
      await client.query("DELETE FROM medic.auth_rate_limits WHERE expires_at <= statement_timestamp()");
    }
  });
}
