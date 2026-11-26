import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { NewDocument } from "../../lib/cabinet.ts";
import { createPostgresCards } from "../../lib/postgres-cards.ts";

export async function cardUser(pool: Pool, name: string, email: string) {
  const account = await pool.query<{ id: string }>(
    "INSERT INTO medic.accounts(name, email, password_salt, password_hash) VALUES ($1,$2,$3,$4) RETURNING id",
    [name, email, Buffer.alloc(16), Buffer.alloc(64)],
  );
  const token = randomUUID();
  const tokenHash = createHash("sha256").update(token).digest();
  await pool.query("INSERT INTO medic.sessions(token_hash, account_id, expires_at) VALUES ($1,$2,now() + interval '1 day')",
    [tokenHash, account.rows[0].id]);
  const self = await pool.query<{ id: string }>(
    "INSERT INTO medic.cards(owner_id, kind, name) VALUES ($1,'self',$2) RETURNING id", [account.rows[0].id, name],
  );
  const store = createPostgresCards(pool, { get: () => token, set() {}, clear() {} });
  return { store, email, tokenHash, self: self.rows[0].id };
}

export const pdf: NewDocument = {
  title: "Анализ крови", category: "analysis", examDate: "2026-11-20", filename: "анализ.pdf", mime: "application/pdf",
  bytes: Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff),
};
