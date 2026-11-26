import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const schema = `
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_salt BLOB NOT NULL,
    password_hash BLOB NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash BLOB PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('self', 'child'))
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS personal_card ON cards(owner_id) WHERE kind = 'self';
  CREATE INDEX IF NOT EXISTS cards_owner ON cards(owner_id);

  CREATE TABLE IF NOT EXISTS card_grants (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    recipient_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    code_hash BLOB UNIQUE,
    expires_at INTEGER,
    UNIQUE (card_id, email),
    CHECK (
      (recipient_id IS NULL AND code_hash IS NOT NULL AND expires_at IS NOT NULL) OR
      (recipient_id IS NOT NULL AND code_hash IS NULL AND expires_at IS NULL)
    )
  ) STRICT;
  CREATE INDEX IF NOT EXISTS grants_recipient ON card_grants(recipient_id, card_id);

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('analysis', 'examination')),
    exam_date TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    created_at TEXT NOT NULL,
    bytes BLOB NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS documents_by_date ON documents(card_id, exam_date DESC, created_at DESC);
  PRAGMA user_version = 1;
`;

type Operation<T> = (db: DatabaseSync) => T;

export function localDatabase(directory: string) {
  const filename = join(directory, "cabinet.sqlite");

  function transaction<T>(write: boolean, run: Operation<T>): T {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    closeSync(openSync(filename, "a", 0o600));
    const db = new DatabaseSync(filename, { timeout: 10_000, enableForeignKeyConstraints: true });
    try {
      if (db.prepare("PRAGMA user_version").get()?.user_version === 0) {
        db.exec("BEGIN IMMEDIATE");
        db.exec(schema);
        db.exec("COMMIT");
      }
      db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
      const result = run(db);
      db.exec("COMMIT");
      return result;
    } finally {
      // Closing also rolls back a transaction if an operation threw.
      db.close();
    }
  }

  return {
    read: <T>(run: Operation<T>) => transaction(false, run),
    write: <T>(run: Operation<T>) => transaction(true, run),
  };
}
