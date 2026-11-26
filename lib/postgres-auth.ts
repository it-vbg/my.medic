import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { limitAuthAttempt } from "./auth-rate-limit.ts";
import { CabinetError, type Account, type CabinetStore } from "./cabinet.ts";
import { digest, newToken, normalizeEmail, passwordKey, type Session } from "./credentials.ts";
import { withTransaction } from "./postgres.ts";

type PostgresAuth = Pick<CabinetStore, "currentUser" | "signUp" | "signIn" | "signOut"> & {
  confirmEmail(token: string, password: string): Promise<void>;
};

type PasswordRecord = { password_salt: Buffer; password_hash: Buffer };
const confirmationError = "Не удалось подтвердить почту. Проверьте пароль или повторите регистрацию для получения новой ссылки.";

async function passwordMatches(password: string, record: PasswordRecord | undefined) {
  const key = await passwordKey(password, record?.password_salt ?? Buffer.alloc(16));
  return !!record && timingSafeEqual(key, record.password_hash);
}

function lockEmail(client: PoolClient, email: string) {
  // There may be several pending tokens, or no row for this address yet.
  return client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [email]);
}

async function startSession(client: PoolClient, accountId: string, previous: string | undefined) {
  const token = newToken();
  await client.query("DELETE FROM medic.sessions WHERE expires_at <= now() OR token_hash = $1",
    [previous ? digest(previous) : null]);
  await client.query("INSERT INTO medic.sessions (token_hash, account_id, expires_at) VALUES ($1, $2, now() + interval '30 days')",
    [digest(token), accountId]);
  return token;
}

export function createPostgresAuth(
  pool: Pool,
  session: Session,
  sendConfirmation: (email: string, token: string) => Promise<void>,
  clientAddress?: string,
): PostgresAuth {
  return {
    async currentUser() {
      const token = session.get();
      if (!token) return null;
      const { rows } = await pool.query<Account>(`
        SELECT a.id, a.name, a.email FROM medic.accounts a
        JOIN medic.sessions s ON s.account_id = a.id
        WHERE s.token_hash = $1 AND s.expires_at > now()
      `, [digest(token)]);
      return rows[0] ?? null;
    },

    async signUp(name, email, password) {
      const address = normalizeEmail(email);
      await limitAuthAttempt(pool, "signUp", address, clientAddress);
      const salt = randomBytes(16);
      const key = await passwordKey(password, salt);
      const token = newToken();
      const hash = digest(token);
      const reserved = await withTransaction(pool, async (client) => {
        await lockEmail(client, address);
        await client.query(`DELETE FROM medic.registrations WHERE expires_at <= statement_timestamp()
          AND created_at <= statement_timestamp() - interval '1 minute'`);
        const result = await client.query(`
          INSERT INTO medic.registrations (token_hash, name, email, password_salt, password_hash, created_at, expires_at)
          SELECT $1, $2, $3, $4, $5, statement_timestamp(), statement_timestamp() + interval '24 hours'
          WHERE NOT EXISTS (SELECT 1 FROM medic.registrations WHERE email = $3
                            AND created_at > statement_timestamp() - interval '1 minute')
        `, [hash, name.trim(), address, salt, key]);
        return result.rowCount === 1;
      });
      if (reserved) {
        try {
          await sendConfirmation(address, token);
        } catch {
          await pool.query("DELETE FROM medic.registrations WHERE token_hash = $1", [hash]);
          throw new CabinetError("Не удалось отправить письмо подтверждения. Попробуйте ещё раз.", 502);
        }
      }
      return { confirmationRequired: true };
    },

    async confirmEmail(token, password) {
      await limitAuthAttempt(pool, "confirmEmail", token, clientAddress);
      const hash = digest(token);
      const { rows: [registration] } = await pool.query<PasswordRecord & { email: string }>(`
        SELECT email, password_salt, password_hash FROM medic.registrations
        WHERE token_hash = $1 AND expires_at > now()
      `, [hash]);
      if (!registration || !await passwordMatches(password, registration)) throw new CabinetError(confirmationError);

      const sessionToken = await withTransaction(pool, async (client) => {
        await lockEmail(client, registration.email);
        const { rows: [user] } = await client.query<Pick<Account, "id" | "name">>(`
          INSERT INTO medic.accounts (name, email, password_salt, password_hash)
          SELECT name, email, password_salt, password_hash FROM medic.registrations
          WHERE token_hash = $1 AND password_hash = $2 AND expires_at > statement_timestamp()
          ON CONFLICT (email) DO NOTHING RETURNING id, name
        `, [hash, registration.password_hash]);
        if (!user) throw new CabinetError(confirmationError);
        // Invalidate every link while retaining the most recent delivery timestamp for its resend cooldown.
        await client.query(`UPDATE medic.registrations SET expires_at = statement_timestamp()
          WHERE email = $1 AND expires_at > statement_timestamp()`, [registration.email]);
        await client.query("INSERT INTO medic.cards (owner_id, name, kind) VALUES ($1, $2, 'self')", [user.id, user.name]);
        return startSession(client, user.id, session.get());
      });
      session.set(sessionToken);
    },

    async signIn(email, password) {
      const address = normalizeEmail(email);
      await limitAuthAttempt(pool, "signIn", address, clientAddress);
      const { rows: [account] } = await pool.query<PasswordRecord & { id: string }>(`
        SELECT id, password_salt, password_hash FROM medic.accounts WHERE email = $1
      `, [address]);
      if (!await passwordMatches(password, account)) throw new CabinetError("Неверная почта или пароль.", 401);
      const token = await withTransaction(pool, (client) => startSession(client, account.id, session.get()));
      session.set(token);
    },

    async signOut() {
      const token = session.get();
      if (token) await pool.query("DELETE FROM medic.sessions WHERE token_hash = $1", [digest(token)]);
      session.clear();
    },
  };
}
