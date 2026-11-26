import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createPgConfig } from "@electric-sql/pglite/node-postgres";
import { Pool } from "pg";
import { CabinetError } from "../lib/cabinet.ts";
import { createPostgresAuth } from "../lib/postgres-auth.ts";

let database: PGlite;
let pool: Pool;

before(async () => {
  database = await PGlite.create();
  await database.exec("CREATE SCHEMA medic");
  await database.exec(await readFile(new URL("../db/migrations/001_cabinet.sql", import.meta.url), "utf8"));
  pool = new Pool({ ...createPgConfig(database), max: 1, idleTimeoutMillis: 0 });
});

after(async () => {
  await pool?.end();
  await database?.close();
});

function browser(initialToken?: string, deliver?: () => Promise<void>) {
  let cookie = initialToken;
  const session = {
    get: () => cookie,
    set(token: string) { cookie = token; },
    clear() { cookie = undefined; },
  };
  const messages: { email: string; token: string }[] = [];
  const auth = createPostgresAuth(pool, session, async (email, token) => {
    if (deliver) await deliver();
    messages.push({ email, token });
  });
  return { ...auth, session, messages };
}

const password = "synthetic test passphrase";

test("only the mailed link with its password creates the personal card and a revocable session", async () => {
  const email = "anna@example.test";
  const client = browser();
  assert.deepEqual(await client.signUp(" Анна ", " ANNA@example.test ", password), { confirmationRequired: true });
  assert.equal(await client.currentUser(), null);
  assert.equal((await pool.query("SELECT id FROM medic.accounts WHERE email = $1", [email])).rowCount, 0);
  await assert.rejects(client.signIn(email, password), { status: 401 });
  const [message] = client.messages;
  assert.equal(message.email, email);
  await assert.rejects(client.confirmEmail(message.token, "wrong password"), { status: 400 });
  assert.equal(await client.currentUser(), null);
  await client.confirmEmail(message.token, password);
  const user = await client.currentUser();
  assert.ok(user);
  assert.deepEqual(user, { id: user.id, name: "Анна", email });
  assert.deepEqual((await pool.query("SELECT kind, name FROM medic.cards WHERE owner_id = $1", [user.id])).rows,
    [{ kind: "self", name: "Анна" }]);
  await assert.rejects(browser().confirmEmail(message.token, password), { status: 400 });

  const firstToken = client.session.get();
  assert.ok(firstToken);
  assert.deepEqual(await browser(firstToken).currentUser(), user);
  await client.signIn(email.toUpperCase(), password);
  assert.notEqual(client.session.get(), firstToken);
  assert.equal(await browser(firstToken).currentUser(), null);
  const second = browser();
  await second.signIn(email, password);
  const rotated = client.session.get();
  await client.signOut();
  assert.equal(await browser(rotated).currentUser(), null);
  assert.deepEqual(await second.currentUser(), user);
  await pool.query("UPDATE medic.sessions SET expires_at = now() - interval '1 minute' WHERE account_id = $1", [user.id]);
  assert.equal(await second.currentUser(), null);
});

test("separate signups cannot replace each other's password or the confirmed account", async () => {
  const email = "family@example.test";
  const first = browser();
  const second = browser();
  const otherPassword = "a different test password";
  await first.signUp("Первая", email, password);
  await second.signUp("Вторая", email, otherPassword);
  assert.equal(second.messages.length, 0);
  await pool.query("UPDATE medic.registrations SET created_at = now() - interval '5 minutes' WHERE email = $1", [email]);
  await second.signUp("Вторая", email, otherPassword);
  const original = first.messages[0].token;
  const retry = second.messages[0].token;
  assert.notEqual(original, retry);
  await assert.rejects(first.confirmEmail(retry, password), { status: 400 });
  await assert.rejects(second.confirmEmail(original, otherPassword), { status: 400 });
  await second.confirmEmail(retry, otherPassword);
  await assert.rejects(first.confirmEmail(original, password), { status: 400 });
  assert.deepEqual(await first.signUp("Третья", email, password), { confirmationRequired: true });
  assert.equal(first.messages.length, 1);
  await assert.rejects(first.signIn(email, password), { status: 401 });
  await first.signIn(email, otherPassword);
  assert.equal((await first.currentUser())?.name, "Вторая");
});

test("registration can be retried after an SMTP failure or an expired email", async () => {
  const email = "retry@example.test";
  let unavailable = true;
  const client = browser(undefined, async () => {
    if (unavailable) throw new Error("synthetic SMTP details");
  });
  await assert.rejects(client.signUp("Лидия", email, password), (error: unknown) =>
    error instanceof CabinetError && error.status === 502 && !error.message.includes("synthetic"));
  unavailable = false;
  await client.signUp("Лидия", email, password);
  const expired = client.messages[0].token;
  await pool.query(`UPDATE medic.registrations SET created_at = now() - interval '2 days',
    expires_at = now() - interval '1 minute' WHERE email = $1`, [email]);
  await assert.rejects(client.confirmEmail(expired, password), { status: 400 });
  await client.signUp("Лидия", email, password);
  assert.equal(client.messages.length, 2);
  await client.confirmEmail(client.messages[1].token, password);
  assert.equal((await client.currentUser())?.email, email);
});

test("a failed session insert rolls back confirmation and leaves the link available to retry", async () => {
  const email = "transaction@example.test";
  const client = browser();
  await client.signUp("Маша", email, password);
  const token = client.messages[0].token;
  await pool.query("ALTER TABLE medic.sessions ADD CONSTRAINT test_session_failure CHECK (false) NOT VALID");
  try {
    await assert.rejects(client.confirmEmail(token, password), { code: "23514" });
    assert.equal(client.session.get(), undefined);
    assert.equal((await pool.query("SELECT id FROM medic.accounts WHERE email = $1", [email])).rowCount, 0);
  } finally {
    await pool.query("ALTER TABLE medic.sessions DROP CONSTRAINT test_session_failure");
  }
  await client.confirmEmail(token, password);
  assert.equal((await client.currentUser())?.email, email);
});
