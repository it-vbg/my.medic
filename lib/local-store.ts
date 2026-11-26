import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  CabinetError, type Account, type CabinetStore, type Card, type Grant, type MedicalDocument,
} from "./cabinet.ts";
import { digest, newToken, normalizeEmail, passwordKey, type Session } from "./credentials.ts";
import { localDatabase } from "./local-database.ts";

type UserOperation<T> = (db: DatabaseSync, user: Account) => T;

const day = 24 * 60 * 60 * 1000;
const sessionLifetime = 30 * day;
const inviteLifetime = 7 * day;

function accountForSession(db: DatabaseSync, token: string | undefined): Account | null {
  if (!token) return null;
  const row = db.prepare(`
    SELECT a.id, a.name, a.email FROM accounts a
    JOIN sessions s ON a.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(digest(token), Date.now());
  return row ? { id: row.id as string, name: row.name as string, email: row.email as string } : null;
}

function requireUser(db: DatabaseSync, token: string | undefined) {
  const user = accountForSession(db, token);
  if (!user) throw new CabinetError("Войдите в кабинет.", 401);
  return user;
}

function startSession(db: DatabaseSync, userId: string, token: string, previous: string | undefined) {
  const now = Date.now();
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  if (previous) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(digest(previous));
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(digest(token), userId, now + sessionLifetime);
}

const cardAccess = `c.owner_id = :userId OR EXISTS (
  SELECT 1 FROM card_grants g WHERE g.card_id = c.id AND g.recipient_id = :userId
)`;

function requireCard(db: DatabaseSync, cardId: string, userId: string, ownerOnly = false) {
  const card = db.prepare(`
    SELECT c.owner_id FROM cards c WHERE c.id = :cardId AND (${cardAccess})
  `).get({ cardId, userId });
  if (!card) throw new CabinetError("Карта недоступна.", 404);
  if (ownerOnly && card.owner_id !== userId) throw new CabinetError("Доступом управляет владелец карты.", 403);
}

const documentColumns = `
  d.id, d.card_id, d.title, d.category, d.exam_date, d.filename, d.mime,
  d.created_at, length(d.bytes) AS size
`;

function documentRecord(row: Record<string, SQLOutputValue>): MedicalDocument {
  return {
    id: row.id as string,
    cardId: row.card_id as string,
    title: row.title as string,
    category: row.category as MedicalDocument["category"],
    examDate: row.exam_date as string,
    filename: row.filename as string,
    mime: row.mime as string,
    createdAt: row.created_at as string,
    size: row.size as number,
  };
}

export function createLocalStore(directory: string, session: Session): CabinetStore {
  const database = localDatabase(directory);
  const readAsUser = <T>(run: UserOperation<T>) =>
    database.read((db) => run(db, requireUser(db, session.get())));
  const writeAsUser = <T>(run: UserOperation<T>) =>
    database.write((db) => run(db, requireUser(db, session.get())));

  return {
    async currentUser() {
      const token = session.get();
      return token ? database.read((db) => accountForSession(db, token)) : null;
    },

    async signUp(name, email, password) {
      const normalized = normalizeEmail(email);
      const salt = randomBytes(16);
      const key = await passwordKey(password, salt);
      const token = newToken();
      database.write((db) => {
        const userId = randomUUID();
        const result = db.prepare(`
          INSERT INTO accounts (id, name, email, password_salt, password_hash)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING
        `).run(userId, name.trim(), normalized, salt, key);
        if (!result.changes) throw new CabinetError("Не удалось зарегистрироваться с этими данными.", 409);
        db.prepare("INSERT INTO cards (id, owner_id, name, kind) VALUES (?, ?, ?, 'self')")
          .run(randomUUID(), userId, name.trim());
        startSession(db, userId, token, session.get());
      });
      session.set(token);
      return { confirmationRequired: false };
    },

    async signIn(email, password) {
      const row = database.read((db) => db.prepare(`
        SELECT id, password_salt, password_hash FROM accounts WHERE email = ?
      `).get(normalizeEmail(email)));
      const key = await passwordKey(password, row ? row.password_salt as Uint8Array : Buffer.alloc(16));
      if (!row || !timingSafeEqual(key, row.password_hash as Uint8Array)) {
        throw new CabinetError("Неверная почта или пароль.", 401);
      }
      const token = newToken();
      database.write((db) => startSession(db, row.id as string, token, session.get()));
      session.set(token);
    },

    async signOut() {
      const token = session.get();
      if (token) database.write((db) => db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(digest(token)));
      session.clear();
    },

    async listCards() {
      return readAsUser((db, user) => db.prepare(`
        SELECT c.id, c.name, c.owner_id = :userId AS is_owner,
          CASE WHEN c.kind = 'child' THEN 'child' WHEN c.owner_id = :userId THEN 'self' ELSE 'spouse' END AS relation
        FROM cards c WHERE ${cardAccess}
        ORDER BY (c.kind = 'self' AND c.owner_id = :userId) DESC, is_owner DESC, c.rowid
      `).all({ userId: user.id }).map((row) => ({
        id: row.id as string,
        name: row.name as string,
        relation: row.relation as Card["relation"],
        isOwner: row.is_owner === 1,
      })));
    },

    async addChild(name) {
      return writeAsUser((db, user) => {
        const id = randomUUID();
        db.prepare("INSERT INTO cards (id, owner_id, name, kind) VALUES (?, ?, ?, 'child')")
          .run(id, user.id, name.trim());
        return id;
      });
    },

    async listGrants(cardId) {
      return readAsUser((db, user) => {
        requireCard(db, cardId, user.id, true);
        return db.prepare(`
          SELECT id, email, CASE WHEN recipient_id IS NULL THEN 'pending' ELSE 'active' END AS status
          FROM card_grants WHERE card_id = ? AND (recipient_id IS NOT NULL OR expires_at > ?) ORDER BY email
        `).all(cardId, Date.now()).map((row) => ({
          id: row.id as string, email: row.email as string, status: row.status as Grant["status"],
        }));
      });
    },

    async invite(cardId, email) {
      return writeAsUser((db, user) => {
        requireCard(db, cardId, user.id, true);
        const normalized = normalizeEmail(email);
        if (normalized === user.email) throw new CabinetError("Вы уже владелец этой карты.");
        const now = Date.now();
        db.prepare("DELETE FROM card_grants WHERE card_id = ? AND email = ? AND expires_at <= ?")
          .run(cardId, normalized, now);
        const code = newToken();
        const result = db.prepare(`
          INSERT INTO card_grants (id, card_id, email, code_hash, expires_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(card_id, email) DO NOTHING
        `).run(randomUUID(), cardId, normalized, digest(code), now + inviteLifetime);
        if (!result.changes) throw new CabinetError("Для этого адреса уже есть приглашение или доступ.", 409);
        return code;
      });
    },

    async accept(code) {
      return writeAsUser((db, user) => {
        const grant = db.prepare(`
          UPDATE card_grants SET recipient_id = ?, code_hash = NULL, expires_at = NULL
          WHERE code_hash = ? AND email = ? AND recipient_id IS NULL AND expires_at > ?
          RETURNING card_id
        `).get(user.id, digest(code), user.email, Date.now());
        if (!grant) throw new CabinetError("Приглашение недоступно для этого аккаунта.");
        return grant.card_id as string;
      });
    },

    async revoke(cardId, grantId) {
      writeAsUser((db, user) => {
        requireCard(db, cardId, user.id, true);
        const result = db.prepare("DELETE FROM card_grants WHERE card_id = ? AND id = ?").run(cardId, grantId);
        if (!result.changes) throw new CabinetError("Доступ не найден.", 404);
      });
    },

    async documents(cardId) {
      return readAsUser((db, user) => {
        requireCard(db, cardId, user.id);
        return db.prepare(`
          SELECT ${documentColumns} FROM documents d WHERE d.card_id = ?
          ORDER BY d.exam_date DESC, d.created_at DESC, d.rowid DESC
        `).all(cardId).map(documentRecord);
      });
    },

    async upload(cardId, input) {
      return writeAsUser((db, user) => {
        requireCard(db, cardId, user.id);
        const id = randomUUID();
        db.prepare(`
          INSERT INTO documents (id, card_id, title, category, exam_date, filename, mime, created_at, bytes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, cardId, input.title, input.category, input.examDate, input.filename, input.mime,
          new Date().toISOString(), input.bytes);
        return id;
      });
    },

    async file(id) {
      return readAsUser((db, user) => {
        const row = db.prepare(`
          SELECT ${documentColumns}, d.bytes FROM documents d
          JOIN cards c ON c.id = d.card_id WHERE d.id = :id AND (${cardAccess})
        `).get({ id, userId: user.id });
        if (!row) throw new CabinetError("Документ недоступен.", 404);
        return { record: documentRecord(row), bytes: row.bytes as Uint8Array };
      });
    },
  };
}
