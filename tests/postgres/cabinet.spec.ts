import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import type { Overview } from "../../lib/cabinet";
import { origin } from "../../playwright.postgres.config";
import { test, type Mailbox } from "./fixtures";
import { fullSizePdf, greenScan, redScan, type UploadFile } from "./files";

function account(name: string, mailbox: string) {
  return { name, email: mailbox + "@example.test", password: "synthetic-" + mailbox + "-passphrase" };
}
type Credentials = ReturnType<typeof account>;

function action(api: APIRequestContext, data: Record<string, string>) {
  return api.post("/api/cabinet", { headers: { Origin: origin }, data });
}

async function overview(api: APIRequestContext, card?: string): Promise<Overview> {
  const response = await api.get("/api/cabinet", { params: card ? { card } : {} });
  expect(response.status()).toBe(200);
  return response.json();
}

async function submit(page: Page, button: string) {
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url() === origin + "/api/cabinet" && r.request().method() === "POST"),
    page.getByRole("button", { name: button, exact: true }).click(),
  ]);
  return response;
}

async function register(page: Page, mailbox: Mailbox, user: Credentials) {
  await page.goto("/");
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  await page.getByLabel("Ваше имя").fill(user.name);
  await page.getByLabel("Электронная почта").fill(user.email);
  await page.getByLabel("Пароль", { exact: true }).fill(user.password);
  const response = await submit(page, "Создать аккаунт");
  expect(response.status()).toBe(201);
  expect(await response.json()).toMatchObject({ confirmationRequired: true });
  expect((await page.request.get("/api/cabinet")).status()).toBe(401);

  await expect.poll(() => mailbox.messages.get(user.email), { message: "Письмо для " + user.email }).toBeTruthy();
  const link = mailbox.messages.get(user.email)!.match(/https?:\/\/[^\s<>]+/u)?.[0];
  expect(link).toBeTruthy();
  const url = new URL(link!);
  expect(url.origin).toBe(origin);
  expect(url.pathname).toBe("/auth/confirm");
  expect(url.searchParams.get("token")).toBeTruthy();
  return url;
}

async function confirm(page: Page, link: URL, password: string) {
  await page.goto(link.href);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  expect((await submit(page, "Подтвердить почту")).status()).toBe(200);
}

function login(api: APIRequestContext, user: Credentials) {
  return action(api, { action: "login", email: user.email, password: user.password });
}

function upload(api: APIRequestContext, cardId: string, title: string, file: UploadFile) {
  return api.post("/api/documents", {
    headers: { Origin: origin },
    multipart: {
      cardId, title, category: "examination", examDate: "2026-11-20", file,
    },
  });
}

async function storeOriginal(api: APIRequestContext, card: string, title: string, file: UploadFile): Promise<string> {
  const response = await upload(api, card, title, file);
  expect(response.status()).toBe(201);
  return (await response.json()).id;
}

async function checkOriginal(api: APIRequestContext, id: string, file: UploadFile) {
  const response = await api.get("/api/documents/" + id);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe(file.mimeType);
  const bytes = await response.body();
  expect(bytes.length).toBe(file.buffer.length);
  expect(bytes.equals(file.buffer)).toBe(true);
  await response.dispose();
}

test("регистрация требует письмо и пароль, а использованная ссылка не открывает новый сеанс", async ({ page, browser, mailbox }) => {
  const user = account("Подтверждение", "confirmation");
  const link = await register(page, mailbox, user);
  const token = link.searchParams.get("token")!;
  await page.goto(link.href);
  await expect(page.getByLabel("Пароль", { exact: true })).toBeVisible();
  expect((await page.request.get("/api/cabinet")).status()).toBe(401);
  expect([401, 403]).toContain((await login(page.request, user)).status());
  const wrong = await action(page.request, { action: "confirm", token, password: "incorrect-passphrase" });
  expect([400, 401, 403]).toContain(wrong.status());
  expect([401, 403]).toContain((await login(page.request, user)).status());
  await confirm(page, link, user.password);

  const fresh = await browser.newContext({ baseURL: origin });
  try {
    const replay = await action(fresh.request, { action: "confirm", token, password: user.password });
    expect([400, 401, 403, 410]).toContain(replay.status());
    expect((await fresh.request.get("/api/cabinet")).status()).toBe(401);
    expect((await login(fresh.request, user)).status()).toBe(200);
    const data = await overview(fresh.request);
    expect(data.user.email).toBe(user.email);
    expect(data.cards).toEqual([{ id: data.activeCardId, name: user.name, relation: "self", isOwner: true }]);
  } finally { await fresh.close(); }
});

test("семья может работать только с приглашённой картой до отзыва, а владелец сохраняет оригиналы", async ({ page, browser, database, mailbox }) => {
  const owner = account("Первый взрослый", "owner");
  const partner = account("Второй взрослый", "partner");
  const stranger = account("Другой пользователь", "stranger");
  const partnerPage = await browser.newPage({ baseURL: origin });
  const strangerPage = await browser.newPage({ baseURL: origin });
  const freshOwner = await browser.newContext({ baseURL: origin });
  try {
    for (const [p, user] of [[page, owner], [partnerPage, partner], [strangerPage, stranger]] as const) {
      const link = await register(p, mailbox, user);
      await confirm(p, link, user.password);
      expect((await login(p.request, user)).status()).toBe(200);
    }
    const ownerApi = page.request;
    const partnerApi = partnerPage.request;
    const self = (await overview(ownerApi)).activeCardId;
    const created = await action(ownerApi, { action: "createChild", name: "Тестовая карта ребёнка" });
    expect(created.status()).toBe(201);
    const child: string = (await created.json()).cardId;
    const privateDoc = await storeOriginal(ownerApi, self, "Личное обследование", greenScan);
    const childDoc = await storeOriginal(ownerApi, child, "Детское обследование", redScan);
    const invite = await action(ownerApi, { action: "invite", cardId: child, email: partner.email });
    expect(invite.status()).toBe(201);
    const code: string = (await invite.json()).code;
    const pending = (await overview(ownerApi, child)).grants;
    expect(pending).toEqual([{ id: expect.any(String), email: partner.email, status: "pending" }]);

    const wrongPerson = await action(strangerPage.request, { action: "accept", code });
    expect([400, 403, 404]).toContain(wrongPerson.status());
    expect((await strangerPage.request.get("/api/cabinet?card=" + child)).status()).toBe(404);
    expect((await partnerApi.get("/api/documents/" + childDoc)).status()).toBe(404);
    const accepted = await action(partnerApi, { action: "accept", code });
    expect(accepted.status()).toBe(200);
    expect((await accepted.json()).cardId).toBe(child);
    const shared = await overview(partnerApi, child);
    expect(shared.cards).toContainEqual({ id: child, name: "Тестовая карта ребёнка", relation: "child", isOwner: false });
    expect(shared.cards.map(card => card.id)).not.toContain(self);
    expect(shared.grants).toEqual([]);
    expect(shared.documents.map(doc => doc.id)).toEqual([childDoc]);
    expect((await partnerApi.get("/api/documents/" + privateDoc)).status()).toBe(404);
    expect((await partnerApi.get("/api/cabinet?card=" + self)).status()).toBe(404);
    await partnerPage.goto("/?card=" + child);
    await expect(partnerPage.getByRole("link", { name: /Открыть оригинал «Детское обследование»/ }))
      .toHaveAttribute("href", "/api/documents/" + childDoc);
    await checkOriginal(partnerApi, childDoc, redScan);
    const pdf = fullSizePdf();
    const added = await storeOriginal(partnerApi, child, "Повторное обследование", pdf);
    await checkOriginal(ownerApi, added, pdf);

    const grant = pending[0].id;
    expect((await overview(ownerApi, child)).grants).toEqual([{ id: grant, email: partner.email, status: "active" }]);
    expect((await action(partnerApi, { action: "invite", cardId: child, email: stranger.email })).status()).toBe(403);
    expect((await action(partnerApi, { action: "revoke", cardId: child, grantId: grant })).status()).toBe(403);
    expect((await action(ownerApi, { action: "revoke", cardId: child, grantId: grant })).status()).toBe(200);
    expect((await overview(partnerApi)).cards.map(card => card.id)).not.toContain(child);
    expect((await partnerApi.get("/api/cabinet?card=" + child)).status()).toBe(404);
    expect((await upload(partnerApi, child, "После отзыва", redScan)).status()).toBe(404);
    for (const id of [childDoc, added]) {
      expect((await partnerApi.get("/api/documents/" + id)).status()).toBe(404);
    }

    expect((await action(ownerApi, { action: "logout" })).status()).toBe(200);
    expect((await freshOwner.request.get("/api/cabinet")).status()).toBe(401);
    expect((await login(freshOwner.request, owner)).status()).toBe(200);
    const saved = await overview(freshOwner.request, child);
    expect(saved.grants).toEqual([]);
    expect(saved.documents.map(doc => doc.id).sort()).toEqual([childDoc, added].sort());
    await checkOriginal(freshOwner.request, childDoc, redScan);
    await checkOriginal(freshOwner.request, added, pdf);
    await checkOriginal(freshOwner.request, privateDoc, greenScan);
    const stored = await database.client.query("SELECT size, sha256(bytes) AS digest FROM medic.documents WHERE id = $1", [added]);
    expect(stored.rows).toEqual([{ size: 12 * 1024 * 1024, digest: createHash("sha256").update(pdf.buffer).digest() }]);
  } finally {
    await Promise.all([partnerPage.close(), strangerPage.close(), freshOwner.close()]);
  }
});
