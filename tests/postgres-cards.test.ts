import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createPgConfig } from "@electric-sql/pglite/node-postgres";
import { Pool } from "pg";
import { cardUser, pdf } from "./postgres/card-user.ts";
import { migrateTestDatabase } from "./postgres/pglite.ts";

let database: PGlite;
let pool: Pool;

before(async () => {
  database = await PGlite.create();
  await migrateTestDatabase(database);
  pool = new Pool({ ...createPgConfig(database), max: 1, idleTimeoutMillis: 0 });
});

after(async () => {
  await pool?.end();
  await database?.close();
});

test("only the owner can share each card, and revocation immediately removes document access", async () => {
  const owner = await cardUser(pool, "Анна", "anna@example.test");
  const partner = await cardUser(pool, "Пётр", "peter@example.test");
  const third = await cardUser(pool, "Ирина", "irina@example.test");
  const child = await owner.store.addChild("  Ваня  ");
  const adultFile = await owner.store.upload(owner.self, pdf);
  const childFile = await owner.store.upload(child, pdf);
  const code = await owner.store.invite(child, "  PETER@EXAMPLE.TEST  ");
  const [grant] = await owner.store.listGrants(child);
  assert.deepEqual(grant, { id: grant.id, email: partner.email, status: "pending" });
  await assert.rejects(owner.store.invite(child, owner.email), { status: 400 });
  await assert.rejects(owner.store.invite(child, partner.email), { status: 409 });
  await assert.rejects(third.store.accept(code), { status: 400 });
  await assert.rejects(partner.store.documents(child), { status: 404 });
  await assert.rejects(partner.store.file(childFile), { status: 404 });
  assert.equal(await partner.store.accept(code), child);
  await assert.rejects(partner.store.accept(code), { status: 400 });
  assert.deepEqual(await partner.store.listCards(), [
    { id: partner.self, name: "Пётр", relation: "self", isOwner: true },
    { id: child, name: "Ваня", relation: "child", isOwner: false },
  ]);
  assert.deepEqual(await owner.store.listGrants(child), [{ id: grant.id, email: partner.email, status: "active" }]);
  await assert.rejects(partner.store.listGrants(child), { status: 403 });
  await assert.rejects(partner.store.invite(child, third.email), { status: 403 });
  await assert.rejects(partner.store.revoke(child, grant.id), { status: 403 });
  await assert.rejects(owner.store.revoke(owner.self, grant.id), { status: 404 });
  await assert.rejects(partner.store.file(adultFile), { status: 404 });
  const partnerUpload = await partner.store.upload(child, pdf);
  await partner.store.accept(await owner.store.invite(owner.self, partner.email));
  await owner.store.revoke(child, grant.id);
  assert.deepEqual(await partner.store.listCards(), [
    { id: partner.self, name: "Пётр", relation: "self", isOwner: true },
    { id: owner.self, name: "Анна", relation: "spouse", isOwner: false },
  ]);
  await assert.rejects(partner.store.file(partnerUpload), { status: 404 });
  await assert.rejects(partner.store.documents(child), { status: 404 });
  await assert.rejects(partner.store.upload(child, pdf), { status: 404 });
  assert.equal((await owner.store.file(partnerUpload)).record.cardId, child);
  assert.equal((await partner.store.file(adultFile)).record.cardId, owner.self);
  await pool.query("DELETE FROM medic.sessions WHERE token_hash = $1", [partner.tokenHash]);
  await assert.rejects(partner.store.file(adultFile), { status: 401 });
});

test("expired and cancelled invitation codes cannot accept a reissued invitation", async () => {
  const owner = await cardUser(pool, "Саша", "sasha@example.test");
  const partner = await cardUser(pool, "Соня", "sonya@example.test");
  const expired = await owner.store.invite(owner.self, partner.email);
  const [first] = await owner.store.listGrants(owner.self);
  await pool.query("UPDATE medic.card_grants SET expires_at = now() - interval '1 second' WHERE id = $1", [first.id]);
  assert.deepEqual(await owner.store.listGrants(owner.self), []);
  const cancelled = await owner.store.invite(owner.self, partner.email);
  const [second] = await owner.store.listGrants(owner.self);
  await assert.rejects(owner.store.revoke(owner.self, first.id), { status: 404 });
  await owner.store.revoke(owner.self, second.id);
  const current = await owner.store.invite(owner.self, partner.email);
  await assert.rejects(partner.store.accept(expired), { status: 400 });
  await assert.rejects(partner.store.accept(cancelled), { status: 400 });
  assert.equal(await partner.store.accept(current), owner.self);
  await assert.rejects(partner.store.accept(current), { status: 400 });
});

test("document lists expose ordered metadata and originals retain every byte", async () => {
  const owner = await cardUser(pool, "Ольга", "olga@example.test");
  const first = await owner.store.upload(owner.self, pdf);
  const second = await owner.store.upload(owner.self, { ...pdf, title: "УЗИ", category: "examination", examDate: "2026-11-23" });
  const [newer, older] = await owner.store.documents(owner.self);
  assert.equal(newer.id, second);
  assert.equal(newer.category, "examination");
  assert.match(older.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d.*Z$/u);
  assert.deepEqual(older, {
    id: first, cardId: owner.self, title: "Анализ крови", category: "analysis", examDate: "2026-11-20",
    filename: "анализ.pdf", mime: "application/pdf", size: 7, createdAt: older.createdAt,
  });
  const original = await owner.store.file(first);
  assert.deepEqual(original.record, older);
  assert.deepEqual(Array.from(original.bytes), [37, 80, 68, 70, 45, 0, 255]);
  await assert.rejects(owner.store.upload(owner.self, { ...pdf, bytes: new Uint8Array() }), { status: 400 });
  await assert.rejects(owner.store.upload(owner.self, { ...pdf, bytes: new Uint8Array(12582913) }), { status: 413 });
  const invalid = "invalid-id";
  await assert.rejects(owner.store.file(invalid), { status: 404 });
  await assert.rejects(owner.store.documents(invalid), { status: 404 });
  await assert.rejects(owner.store.upload(invalid, pdf), { status: 404 });
  await assert.rejects(owner.store.invite(invalid, "other@example.test"), { status: 404 });
  await assert.rejects(owner.store.revoke(owner.self, invalid), { status: 404 });
  await pool.query("UPDATE medic.sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [owner.tokenHash]);
  await assert.rejects(owner.store.listCards(), { status: 401 });
  await assert.rejects(owner.store.file(first), { status: 401 });
});
