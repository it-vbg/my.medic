import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createPgConfig } from "@electric-sql/pglite/node-postgres";
import { Pool } from "pg";
import { CabinetError } from "../lib/cabinet.ts";
import { createPostgresAuth } from "../lib/postgres-auth.ts";
import { migrateTestDatabase } from "./postgres/pglite.ts";

let database: PGlite;
let pool: Pool;

before(async () => {
  database = await PGlite.create();
  await migrateTestDatabase(database);
  pool = new Pool({ ...createPgConfig(database), max: 1, idleTimeoutMillis: 0 });
});

beforeEach(async () => { await pool.query("DELETE FROM medic.auth_rate_limits"); });

after(async () => {
  await pool?.end();
  await database?.close();
});

function browser(initialToken?: string, deliver?: () => Promise<void>, clientAddress?: string) {
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
  }, clientAddress);
  return { ...auth, session, messages };
}

const password = "synthetic test passphrase";
const unusedToken = () => randomBytes(32).toString("base64url");

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

test("confirmed and unconfirmed addresses receive the same registration responses, SMTP retries and resend cooldown", async () => {
  const confirmed = "confirmed@example.test";
  const pending = "pending@example.test";
  const first = browser();
  await first.signUp("Анна", confirmed, password);
  await first.confirmEmail(first.messages[0].token, password);
  await first.signUp("Вера", pending, password);
  const retry = browser();
  const addresses = [confirmed, pending];
  for (const address of addresses) {
    assert.deepEqual(await retry.signUp("Анна", address, "new test password"), { confirmationRequired: true });
  }
  assert.equal(retry.messages.length, 0);
  await pool.query("UPDATE medic.registrations SET created_at = now() - interval '5 minutes' WHERE email = ANY($1)", [addresses]);
  const failing = browser(undefined, async () => { throw new Error("synthetic delivery error"); });
  for (const address of addresses) {
    await assert.rejects(failing.signUp("Анна", address, "new test password"), { status: 502 });
    assert.deepEqual(await retry.signUp("Анна", address, "new test password"), { confirmationRequired: true });
  }
  assert.deepEqual(retry.messages.map(message => message.email), addresses);
  await assert.rejects(retry.confirmEmail(retry.messages[0].token, "new test password"), { status: 400 });
  await assert.rejects(retry.signIn(confirmed, "new test password"), { status: 401 });
  await retry.signIn(confirmed, password);
  assert.deepEqual(await retry.currentUser(), await first.currentUser());
});

function resultStatus(result: Promise<unknown>) {
  return result.then(() => 200, (error: unknown) => {
    assert.ok(error instanceof CabinetError);
    return error.status;
  });
}

test("parallel attempts share independent limits per normalized login, signup address and confirmation token", async () => {
  const email = "parallel@example.test";
  const browsers = Array.from({ length: 11 }, (_, index) => browser(undefined, undefined, "192.0.2." + (index + 1)));
  const login = await Promise.all(browsers.map((client, index) => resultStatus(
    client.signIn(index % 2 ? email.toUpperCase() : email, password))));
  assert.equal(login.filter(status => status === 401).length, 10);
  assert.equal(login.filter(status => status === 429).length, 1);
  const signup = await Promise.all(browsers.slice(0, 6).map((client, index) => resultStatus(
    client.signUp("Анна", index % 2 ? email.toUpperCase() : email, password))));
  assert.equal(signup.filter(status => status === 200).length, 5);
  assert.equal(signup.filter(status => status === 429).length, 1);
  const token = unusedToken();
  const confirmation = await Promise.all(browsers.slice(0, 6).map(client => resultStatus(client.confirmEmail(token, password))));
  assert.equal(confirmation.filter(status => status === 400).length, 5);
  assert.equal(confirmation.filter(status => status === 429).length, 1);
  await pool.query("UPDATE medic.auth_rate_limits SET expires_at = now() - interval '1 second'");
  assert.equal(await resultStatus(browsers[0].signIn(email, password)), 401);
  assert.equal(await resultStatus(browsers[0].confirmEmail(token, password)), 400);
});

test("a client budget covers different identities and requests with no trusted address have a shared budget", async () => {
  const active = browser(undefined, undefined, "192.0.2.1");
  await active.signUp("Алиса", "source@example.test", password);
  await active.confirmEmail(active.messages[0].token, password);
  const fromAddress = await Promise.all(Array.from({ length: 29 }, () =>
    resultStatus(active.confirmEmail(unusedToken(), password))));
  assert.equal(fromAddress.filter(status => status === 400).length, 28);
  assert.equal(fromAddress.filter(status => status === 429).length, 1);
  assert.equal((await active.currentUser())?.email, "source@example.test");

  const shared = await Promise.all(Array.from({ length: 31 }, () =>
    resultStatus(browser().confirmEmail(unusedToken(), password))));
  assert.equal(shared.filter(status => status === 400).length, 30);
  assert.equal(shared.filter(status => status === 429).length, 1);
});

test("the installation caps new keys across clients and forgets expired windows on the next request", async () => {
  const attempt = (index: number) => resultStatus(browser(undefined, undefined, "198.51.100." + index)
    .confirmEmail(unusedToken(), password));
  const results = await Promise.all(Array.from({ length: 122 }, (_, index) => attempt(index + 1)));
  assert.equal(results.filter(status => status === 400).length, 120);
  assert.equal(results.filter(status => status === 429).length, 2);
  const count = async () => (await pool.query("SELECT count(*)::integer AS n FROM medic.auth_rate_limits")).rows[0].n;
  const full = await count();
  assert.equal(await attempt(123), 429);
  assert.equal(await count(), full);
  await pool.query("UPDATE medic.auth_rate_limits SET expires_at = now() - interval '1 second'");
  assert.equal(await attempt(124), 400);
  assert.ok(await count() < full);
});
