import { expect, test, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { Overview } from "../../lib/cabinet";

const origin = "http://127.0.0.1:3187";
const syntheticPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=", "base64");

function accountAction(api: APIRequestContext, data: Record<string, string>) {
  return api.post("/api/cabinet", { headers: { Origin: origin }, data });
}

test("создание аккаунта, загрузка обследования в браузере и повторное открытие оригинала", async ({ page }) => {
  const email = randomUUID() + "@example.test";
  await page.goto("/");
  await page.screenshot({ path: test.info().outputPath("login-desktop.png") });
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  await page.getByLabel("Ваше имя").fill("Тестовый пользователь");
  await page.getByLabel("Электронная почта").fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill("test-password-2026");
  await page.getByRole("button", { name: "Создать аккаунт" }).click();
  await expect(page.getByRole("heading", { name: "Документы", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Загрузить документ" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("input[type=file]").setInputFiles({ name: "пример.png", mimeType: "image/png", buffer: syntheticPng });
  await dialog.getByLabel("Название документа").fill("Тестовое обследование");
  await dialog.getByLabel("Категория").selectOption("examination");
  await dialog.getByLabel("Дата исследования").fill("2026-11-20");
  await dialog.locator('button[type="submit"]').click();
  const original = page.getByRole("link", { name: /Открыть оригинал «Тестовое обследование»/ });
  await expect(original).toBeVisible();
  await page.reload();
  await expect(original).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("cabinet-desktop.png") });
  const result = await page.request.get((await original.getAttribute("href"))!);
  expect(result.status()).toBe(200);
  expect(result.headers()["content-type"]).toBe("image/png");
  expect(await result.body()).toEqual(syntheticPng);
  await page.getByRole("button", { name: "Выйти из аккаунта" }).click();
  await expect(page.getByRole("heading", { name: "Вход в кабинет" })).toBeVisible();
  await page.getByLabel("Электронная почта").fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill("test-password-2026");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(original).toBeVisible();
});

test("супруги принимают адресованное приглашение через интерфейс, родитель переключает карту ребёнка", async ({ browser }) => {
  const owner = await browser.newContext({ baseURL: origin });
  const spouse = await browser.newContext({ baseURL: origin });
  const email = randomUUID() + "@example.test";
  try {
    await accountAction(owner.request, { action: "register", name: "Первый взрослый", email: randomUUID() + "@example.test", password: "test-password-2026" });
    await accountAction(spouse.request, { action: "register", name: "Второй взрослый", email, password: "test-password-2026" });
    const a = await owner.newPage();
    await a.goto("/");
    await a.getByRole("link", { name: "Семейный доступ" }).click();
    await a.getByRole("button", { name: "Пригласить близкого" }).click();
    const dialog = a.getByRole("dialog");
    await dialog.getByLabel("Электронная почта").fill(email);
    await dialog.getByRole("button", { name: "Создать приглашение" }).click();
    const code = await dialog.getByLabel("Код приглашения").inputValue();
    await dialog.getByRole("button", { name: "Готово" }).click();
    const b = await spouse.newPage();
    await b.goto("/");
    await b.getByRole("link", { name: "Семейный доступ" }).click();
    await b.getByRole("button", { name: "Ввести код" }).click();
    await b.getByRole("dialog").getByLabel("Код приглашения").fill(code);
    await b.getByRole("dialog").getByRole("button", { name: "Принять приглашение" }).click();
    await expect(b.getByRole("combobox", { name: "Выбрать медицинскую карту" }).locator("option:checked")).toHaveText("Первый взрослый — Карта супруга");
    await a.getByRole("button", { name: "Добавить карту ребёнка" }).click();
    await dialog.getByLabel("Имя ребёнка").fill("Детская карта");
    await dialog.getByRole("button", { name: "Создать карту" }).click();
    const switcher = a.getByRole("combobox", { name: "Выбрать медицинскую карту" });
    await expect(switcher.locator("option:checked")).toHaveText("Детская карта — Карта ребёнка");
    await switcher.selectOption({ label: "Первый взрослый — Личная карта" });
    await expect(switcher.locator("option:checked")).toHaveText("Первый взрослый — Личная карта");
    await a.getByRole("button", { name: "Отозвать доступ для " + email }).click();
    await dialog.getByRole("button", { name: "Отозвать доступ" }).click();
    await expect(dialog).toHaveCount(0);
    await b.reload();
    await expect(b.getByRole("combobox", { name: "Выбрать медицинскую карту" }).locator("option:checked")).toHaveText("Второй взрослый — Личная карта");
  } finally { await Promise.all([owner.close(), spouse.close()]); }
});

test("семейная карта и оригинал доступны только до отзыва приглашения", async ({ browser }) => {
  const owner = await browser.newContext({ baseURL: origin });
  const partner = await browser.newContext({ baseURL: origin });
  try {
    const partnerEmail = randomUUID() + "@example.test";
    for (const [context, email] of [[owner, randomUUID() + "@example.test"], [partner, partnerEmail]] as const) {
      expect((await accountAction(context.request, { action: "register", name: "Тест", email, password: "test-password-2026" })).status()).toBe(201);
    }
    const child = (await (await accountAction(owner.request, { action: "createChild", name: "Тестовая карта ребёнка" })).json()).cardId;
    const uploaded = await owner.request.post("/api/documents", {
      headers: { Origin: origin },
      multipart: { cardId: child, title: "Синтетический анализ", category: "analysis", examDate: "2026-10-11", file: { name: "example.png", mimeType: "image/png", buffer: syntheticPng } },
    });
    expect(uploaded.status()).toBe(201);
    const doc = (await uploaded.json()).id;
    expect((await partner.request.get("/api/documents/" + doc)).status()).toBe(404);
    const invite = await accountAction(owner.request, { action: "invite", cardId: child, email: partnerEmail });
    expect(invite.status()).toBe(201);
    const accepted = await accountAction(partner.request, { action: "accept", code: (await invite.json()).code });
    expect((await accepted.json()).cardId).toBe(child);
    const page = await partner.newPage();
    await page.goto("/?card=" + child);
    await expect(page.getByRole("link", { name: /Синтетический анализ/ })).toBeVisible();
    const overview: Overview = await (await owner.request.get("/api/cabinet?card=" + child)).json();
    expect((await accountAction(owner.request, { action: "revoke", cardId: child, grantId: overview.grants[0].id })).status()).toBe(200);
    expect((await partner.request.get("/api/documents/" + doc)).status()).toBe(404);
    await page.reload();
    await expect(page.getByRole("heading", { name: "В карте пока нет документов" })).toBeVisible();
  } finally { await Promise.all([owner.close(), partner.close()]); }
});

test("вход доступен в узком окне и закрытая карта требует сеанс", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Вход в кабинет" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("login-narrow.png") });
  expect((await page.request.get("/api/cabinet")).status()).toBe(401);
});

test("возврат из письма подтверждения сохраняет публичный адрес кабинета", async ({ request }) => {
  const publicUrl = "https://cabinet.example.test";
  const result = await request.get("/auth/confirm", {
    headers: { Host: "cabinet.example.test", "X-Forwarded-Proto": "https" },
    maxRedirects: 0,
  });
  expect(result.status()).toBe(307);
  expect(new URL(result.headers().location, publicUrl).href).toBe(publicUrl + "/?auth=expired");
});

test("PDF проходит через сервер до заявленных 12 МБ, превышение отклоняется", async ({ request }) => {
  await accountAction(request, { action: "register", name: "Проверка PDF", email: randomUUID() + "@example.test", password: "test-password-2026" });
  const { activeCardId }: Overview = await (await request.get("/api/cabinet")).json();
  const bytes = Buffer.alloc(12 * 1024 * 1024, 0x20);
  bytes.write("%PDF-1.7\n");
  bytes.write("%%EOF", bytes.length - 5);
  const upload = (buffer: Buffer) => request.post("/api/documents", { headers: { Origin: origin }, multipart: {
    cardId: activeCardId, title: "Проверка размера", category: "analysis", examDate: "2026-11-26",
    file: { name: "проверка.pdf", mimeType: "application/pdf", buffer },
  } });
  const stored = await upload(bytes);
  expect(stored.status()).toBe(201);
  const original = await request.get("/api/documents/" + (await stored.json()).id);
  expect(original.status()).toBe(200);
  expect(original.headers()["content-type"]).toBe("application/pdf");
  expect((await original.body()).equals(bytes)).toBe(true);
  expect((await upload(Buffer.concat([bytes, Buffer.from([0])]))).status()).toBe(413);
  const overview: Overview = await (await request.get("/api/cabinet")).json();
  expect(overview.documents).toHaveLength(1);
});
