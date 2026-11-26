import type { Pool, PoolClient } from "pg";
import { CabinetError, type Account, type CabinetStore, type Card, type Grant, type MedicalDocument } from "./cabinet.ts";
import { digest, newToken, type Session } from "./credentials.ts";
import { emailField, fileLimit, textField } from "./input.ts";
import { withTransaction } from "./postgres.ts";

type CardStore = Pick<CabinetStore,
  "listCards" | "addChild" | "listGrants" | "invite" | "accept" | "revoke" | "documents" | "upload" | "file">;
type Actor = Pick<Account, "id" | "email">;

function uuid(value: string, missing: string) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(value)) throw new CabinetError(missing, 404);
  return value;
}

// Hold a shared lock on the actual grant for the duration of a document operation.
// A concurrent revocation either finishes first or waits until this transaction ends.
const cardAccess = `c.owner_id = $2 OR EXISTS (
  SELECT 1 FROM medic.card_grants g WHERE g.card_id = c.id AND g.recipient_id = $2 FOR SHARE
)`;

async function requireCard(client: PoolClient, cardId: string, actorId: string, ownerOnly = false) {
  const card = await client.query<{ isOwner: boolean }>(`
    SELECT c.owner_id = $2 AS "isOwner" FROM medic.cards c
    WHERE c.id = $1 AND (${cardAccess}) FOR SHARE OF c
  `, [uuid(cardId, "Карта недоступна."), actorId]);
  if (!card.rows.length) throw new CabinetError("Карта недоступна.", 404);
  if (ownerOnly && !card.rows[0].isOwner) throw new CabinetError("Доступом управляет владелец карты.", 403);
}

const documentColumns = `
  d.id, d.card_id AS "cardId", d.title, d.category, to_char(d.exam_date, 'YYYY-MM-DD') AS "examDate",
  d.filename, d.mime, d.size, to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`;

export function createPostgresCards(pool: Pool, session: Session): CardStore {
  async function asUser<T>(operation: (client: PoolClient, actor: Actor) => Promise<T>): Promise<T> {
    const token = session.get();
    if (!token) throw new CabinetError("Войдите в кабинет.", 401);
    return withTransaction(pool, async (client) => {
      const actor = await client.query<Actor>(`
        SELECT a.id, a.email FROM medic.sessions s JOIN medic.accounts a ON a.id = s.account_id
        WHERE s.token_hash = $1 AND s.expires_at > clock_timestamp() FOR SHARE OF s
      `, [digest(token)]);
      if (!actor.rows.length) throw new CabinetError("Войдите в кабинет.", 401);
      return operation(client, actor.rows[0]);
    });
  }

  return {
    listCards() {
      return asUser(async (client, actor) => (await client.query<Card>(`
        SELECT id, name, relation, "isOwner" FROM (
          SELECT id, name, kind AS relation, true AS "isOwner", created_at
          FROM medic.cards WHERE owner_id = $1
          UNION ALL
          SELECT c.id, c.name, CASE c.kind WHEN 'self' THEN 'spouse' ELSE 'child' END, false, c.created_at
          FROM medic.card_grants g JOIN medic.cards c ON c.id = g.card_id WHERE g.recipient_id = $1
        ) visible
        ORDER BY (relation = 'self') DESC, "isOwner" DESC, created_at, id
      `, [actor.id])).rows);
    },

    addChild(name) {
      return asUser(async (client, actor) => {
        const child = await client.query<{ id: string }>(`
          INSERT INTO medic.cards(owner_id, kind, name) VALUES ($1, 'child', $2) RETURNING id
        `, [actor.id, textField(name, "Имя ребёнка", 100)]);
        return child.rows[0].id;
      });
    },

    listGrants(cardId) {
      return asUser(async (client, actor) => {
        await requireCard(client, cardId, actor.id, true);
        return (await client.query<Grant>(`
          SELECT id, email, CASE WHEN recipient_id IS NULL THEN 'pending' ELSE 'active' END AS status
          FROM medic.card_grants
          WHERE card_id = $1 AND (recipient_id IS NOT NULL OR expires_at > statement_timestamp()) ORDER BY email
        `, [cardId])).rows;
      });
    },

    invite(cardId, email) {
      return asUser(async (client, actor) => {
        await requireCard(client, cardId, actor.id, true);
        const recipient = emailField(email);
        if (recipient === actor.email) throw new CabinetError("Вы уже владелец этой карты.");
        const code = newToken();
        const grant = await client.query(`
          INSERT INTO medic.card_grants AS g (card_id, email, code_hash, expires_at)
          VALUES ($1, $2, $3, clock_timestamp() + interval '7 days')
          ON CONFLICT (card_id, email) DO UPDATE
          SET id = EXCLUDED.id, code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at
          WHERE g.recipient_id IS NULL AND g.expires_at <= clock_timestamp()
        `, [cardId, recipient, digest(code)]);
        if (!grant.rowCount) throw new CabinetError("Для этого адреса уже есть приглашение или доступ.", 409);
        return code;
      });
    },

    accept(code) {
      return asUser(async (client, actor) => {
        const grant = await client.query<{ card_id: string }>(`
          UPDATE medic.card_grants SET recipient_id = $1, code_hash = NULL, expires_at = NULL
          WHERE email = $2 AND code_hash = $3 AND recipient_id IS NULL AND expires_at > clock_timestamp()
          RETURNING card_id
        `, [actor.id, actor.email, digest(code.trim())]);
        if (!grant.rows.length) throw new CabinetError("Приглашение недоступно для этого аккаунта.");
        return grant.rows[0].card_id;
      });
    },

    revoke(cardId, grantId) {
      return asUser(async (client, actor) => {
        await requireCard(client, cardId, actor.id, true);
        const grant = await client.query("DELETE FROM medic.card_grants WHERE card_id = $1 AND id = $2",
          [cardId, uuid(grantId, "Доступ не найден.")]);
        if (!grant.rowCount) throw new CabinetError("Доступ не найден.", 404);
      });
    },

    documents(cardId) {
      return asUser(async (client, actor) => {
        await requireCard(client, cardId, actor.id);
        return (await client.query<MedicalDocument>(`
          SELECT ${documentColumns} FROM medic.documents d WHERE d.card_id = $1 ORDER BY d.exam_date DESC, d.created_at DESC, d.id
        `, [cardId])).rows;
      });
    },

    upload(cardId, input) {
      return asUser(async (client, actor) => {
        await requireCard(client, cardId, actor.id);
        if (!input.bytes.byteLength) throw new CabinetError("Выберите непустой файл.");
        if (input.bytes.byteLength > fileLimit) throw new CabinetError("Максимальный размер файла — 12 МБ.", 413);
        const doc = await client.query<{ id: string }>(`
          INSERT INTO medic.documents(card_id, title, category, exam_date, filename, mime, bytes)
          VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
        `, [cardId, input.title, input.category, input.examDate, input.filename, input.mime, input.bytes]);
        return doc.rows[0].id;
      });
    },

    file(id) {
      return asUser(async (client, actor) => {
        const file = await client.query<MedicalDocument & { bytes: Buffer }>(`
          SELECT ${documentColumns}, d.bytes FROM medic.documents d JOIN medic.cards c ON c.id = d.card_id
          WHERE d.id = $1 AND (${cardAccess}) FOR SHARE OF c
        `, [uuid(id, "Документ недоступен."), actor.id]);
        if (!file.rows.length) throw new CabinetError("Документ недоступен.", 404);
        const { bytes, ...record } = file.rows[0];
        return { record, bytes };
      });
    },
  };
}
