import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CabinetError, type NewDocument } from "../lib/cabinet.ts";
import { createLocalStore } from "../lib/local-store.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "my-medic-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function cookie(token?: string) {
  return {
    get: () => token,
    set(value: string) { token = value; },
    clear() { token = undefined; },
  };
}

function client(directory: string, token?: string) {
  const session = cookie(token);
  return { store: createLocalStore(directory, session), session };
}

function cabinetError(status: number) {
  return (error: unknown) => error instanceof CabinetError && error.status === status;
}

const password = "a long test passphrase";

const original: NewDocument = {
  title: "Общий анализ крови",
  category: "analysis",
  examDate: "2026-03-20",
  filename: "результат.pdf",
  mime: "application/pdf",
  bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0, 255, 10]),
};

async function register(directory: string, name: string, email: string) {
  const browser = client(directory);
  await browser.store.signUp(name, email, password);
  const [self] = await browser.store.listCards();
  return { ...browser, self };
}

test("registration creates one personal card and sessions survive independent requests", async (t) => {
  const directory = fixture(t);
  const first = client(directory);
  const second = client(directory);
  assert.equal(await first.store.currentUser(), null);
  await assert.rejects(first.store.listCards(), cabinetError(401));

  const result = await first.store.signUp("Анна", "  Anna@Example.test ", password);
  assert.deepEqual(result, { confirmationRequired: false });
  const user = await first.store.currentUser();
  assert.ok(user);
  assert.deepEqual(user, { id: user.id, name: "Анна", email: "anna@example.test" });
  const [self] = await first.store.listCards();
  assert.deepEqual(await first.store.listCards(), [{ id: self.id, name: "Анна", relation: "self", isOwner: true }]);
  await assert.rejects(second.store.signUp("Чужое имя", "anna@example.test", password), cabinetError(409));
  assert.equal(await second.store.currentUser(), null);

  const wrongPassword = await second.store.signIn("anna@example.test", "wrong").catch((error: unknown) => error);
  const unknownEmail = await second.store.signIn("absent@example.test", "wrong").catch((error: unknown) => error);
  assert.ok(wrongPassword instanceof CabinetError && wrongPassword.status === 401);
  assert.ok(unknownEmail instanceof CabinetError && unknownEmail.status === wrongPassword.status);
  assert.equal(unknownEmail.message, wrongPassword.message);
  await second.store.signIn("ANNA@example.test", password);
  assert.deepEqual(await second.store.currentUser(), user);

  const oldToken = first.session.get();
  assert.ok(oldToken && oldToken !== second.session.get());
  assert.deepEqual(await client(directory, oldToken).store.listCards(), [self]);
  await first.store.signOut();
  assert.equal(await client(directory, oldToken).store.currentUser(), null);
  assert.deepEqual(await second.store.currentUser(), user);
  await first.store.signIn(user.email, password);
  assert.deepEqual(await first.store.listCards(), [self]);
});

test("two concurrent registrations for the same normalized email create only one account and self card", async (t) => {
  const directory = fixture(t);
  const first = client(directory);
  const second = client(directory);
  const results = await Promise.allSettled([
    first.store.signUp("Первый", "same@example.test", password),
    second.store.signUp("Второй", "SAME@example.test", password),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.ok(rejection && cabinetError(409)(rejection.reason));
  const reader = client(directory);
  await reader.store.signIn("same@example.test", password);
  const cards = await reader.store.listCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].relation, "self");
});

test("stored documents retain their original bytes, metadata and card after a fresh login", async (t) => {
  const directory = fixture(t);
  const { store, self } = await register(directory, "Ирина", "irina@example.test");
  const childId = await store.addChild("Саша");
  const resultId = await store.upload(childId, original);
  const olderId = await store.upload(childId, { ...original, examDate: "2020-01-01" });
  const examId = await store.upload(self.id, { ...original, title: "УЗИ", category: "examination" });
  await store.signOut();
  await assert.rejects(store.file(resultId), cabinetError(401));

  const reader = client(directory).store;
  await reader.signIn("irina@example.test", password);
  const child = (await reader.listCards()).find((card) => card.id === childId);
  assert.deepEqual(child, { id: childId, name: "Саша", relation: "child", isOwner: true });
  const [result, older] = await reader.documents(childId);
  assert.equal(older.id, olderId);
  assert.match(result.createdAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(result, {
    id: resultId, cardId: childId, title: "Общий анализ крови", category: "analysis",
    examDate: "2026-03-20", filename: "результат.pdf", mime: "application/pdf",
    size: 7, createdAt: result.createdAt,
  });
  const file = await reader.file(resultId);
  assert.deepEqual(file.record, result);
  assert.deepEqual(Array.from(file.bytes), [0x25, 0x50, 0x44, 0x46, 0, 255, 10]);
  assert.deepEqual((await reader.documents(self.id)).map((doc) => [doc.id, doc.category]), [[examId, "examination"]]);
});

test("a named adult can work on each expressly shared card until its owner revokes that card", async (t) => {
  const directory = fixture(t);
  const owner = await register(directory, "Анна", "anna@example.test");
  const partner = await register(directory, "Пётр", "peter@example.test");
  const third = await register(directory, "Мария", "maria@example.test");
  const childId = await owner.store.addChild("Саша");
  const childFile = await owner.store.upload(childId, original);
  const adultFile = await owner.store.upload(owner.self.id, original);
  const email = "peter@example.test";

  await assert.rejects(owner.store.invite(childId, " ANNA@example.test "), cabinetError(400));
  const childCode = await owner.store.invite(childId, " Peter@Example.test ");
  const [grant] = await owner.store.listGrants(childId);
  assert.deepEqual(grant, { id: grant.id, email, status: "pending" });
  await assert.rejects(owner.store.invite(childId, email), cabinetError(409));
  await assert.rejects(third.store.accept(childCode), CabinetError);
  await assert.rejects(partner.store.documents(childId), CabinetError);
  await assert.rejects(partner.store.upload(childId, original), CabinetError);
  await assert.rejects(partner.store.file(childFile), CabinetError);
  assert.equal(await partner.store.accept(childCode), childId);
  await assert.rejects(partner.store.accept(childCode), CabinetError);
  assert.deepEqual(await owner.store.listGrants(childId), [{ id: grant.id, email, status: "active" }]);
  assert.deepEqual(await partner.store.listCards(), [
    partner.self, { id: childId, name: "Саша", relation: "child", isOwner: false },
  ]);
  assert.equal((await partner.store.file(childFile)).record.cardId, childId);
  const addedFile = await partner.store.upload(childId, original);
  assert.equal((await owner.store.file(addedFile)).record.cardId, childId);
  await assert.rejects(partner.store.file(adultFile), CabinetError);
  await assert.rejects(partner.store.listGrants(childId), CabinetError);
  await assert.rejects(partner.store.invite(childId, "maria@example.test"), CabinetError);
  await assert.rejects(partner.store.revoke(childId, grant.id), CabinetError);
  await assert.rejects(owner.store.revoke(owner.self.id, grant.id), CabinetError);
  assert.deepEqual(await third.store.listCards(), [third.self]);
  await assert.rejects(third.store.file(childFile), CabinetError);
  await assert.rejects(third.store.upload(childId, original), CabinetError);

  const adultCode = await owner.store.invite(owner.self.id, email);
  assert.equal(await partner.store.accept(adultCode), owner.self.id);
  assert.deepEqual((await partner.store.listCards()).find((card) => card.id === owner.self.id), {
    id: owner.self.id, name: "Анна", relation: "spouse", isOwner: false,
  });
  assert.equal((await partner.store.file(adultFile)).record.cardId, owner.self.id);
  const partnerUpload = await partner.store.upload(owner.self.id, original);
  assert.equal((await owner.store.file(partnerUpload)).record.cardId, owner.self.id);
  const [adultGrant] = await owner.store.listGrants(owner.self.id);
  await assert.rejects(partner.store.invite(owner.self.id, "maria@example.test"), CabinetError);
  await assert.rejects(partner.store.revoke(owner.self.id, adultGrant.id), CabinetError);
  await owner.store.revoke(owner.self.id, adultGrant.id);
  await assert.rejects(partner.store.file(adultFile), CabinetError);
  await assert.rejects(partner.store.file(partnerUpload), CabinetError);
  assert.equal((await partner.store.file(childFile)).record.id, childFile);
  await owner.store.revoke(childId, grant.id);
  assert.deepEqual(await partner.store.listCards(), [partner.self]);
  await assert.rejects(partner.store.documents(childId), CabinetError);
  await assert.rejects(partner.store.upload(childId, original), CabinetError);
  await assert.rejects(partner.store.file(addedFile), CabinetError);
  await assert.rejects(partner.store.accept(childCode), CabinetError);
  assert.equal((await owner.store.file(addedFile)).record.id, addedFile);
});

test("cancelled and expired invitations cannot be used, and a session expires independently", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00Z") });
  const directory = fixture(t);
  const owner = await register(directory, "Анна", "anna@example.test");
  const email = "peter@example.test";
  const cancelled = await owner.store.invite(owner.self.id, email);
  const partner = await register(directory, "Пётр", email);
  const [pending] = await owner.store.listGrants(owner.self.id);
  await owner.store.revoke(owner.self.id, pending.id);
  await assert.rejects(partner.store.accept(cancelled), CabinetError);

  const expired = await owner.store.invite(owner.self.id, email);
  t.mock.timers.tick(8 * 24 * 60 * 60 * 1000);
  await assert.rejects(partner.store.accept(expired), CabinetError);
  assert.deepEqual(await owner.store.listGrants(owner.self.id), []);
  const fresh = await owner.store.invite(owner.self.id, email);
  assert.notEqual(fresh, expired);
  assert.equal(await partner.store.accept(fresh), owner.self.id);
  t.mock.timers.tick(23 * 24 * 60 * 60 * 1000);
  assert.equal(await partner.store.currentUser(), null);
  await assert.rejects(partner.store.documents(owner.self.id), cabinetError(401));
  await partner.store.signIn(email, password);
  assert.ok((await partner.store.listCards()).some((card) => card.id === owner.self.id));
});
