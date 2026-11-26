import { createServerClient, type CookieMethodsServer, type CookieOptions } from "@supabase/ssr";
import { isAuthSessionMissingError, type AuthError, type PostgrestSingleResponse } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { CabinetError, type CabinetStore, type Card, type Grant, type MedicalDocument } from "./cabinet";

const bucket = "medical-originals";
type StoredDocument = MedicalDocument & { storagePath: string };
type Empty = Record<never, never>;
type Rpc<Args extends Record<string, unknown>, Returns> = { Args: Args; Returns: Returns };
type Database = {
  public: {
    Tables: Empty;
    Views: Empty;
    Enums: Empty;
    CompositeTypes: Empty;
    Functions: {
      cabinet_cards: Rpc<Empty, Card[]>;
      cabinet_add_child: Rpc<{ p_name: string }, string>;
      cabinet_grants: Rpc<{ p_card: string }, Grant[]>;
      cabinet_invite: Rpc<{ p_card: string; p_email: string }, string>;
      cabinet_accept: Rpc<{ p_code: string }, string>;
      cabinet_revoke: Rpc<{ p_card: string; p_grant: string }, undefined>;
      cabinet_documents: Rpc<{ p_card?: string; p_document?: string }, StoredDocument[]>;
    };
  };
};

function serverClient(jar: CookieMethodsServer, incoming: Headers) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase URL and publishable key are required.");
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(incoming.get("host") ?? "");
  const secure = incoming.get("x-forwarded-proto")?.split(",")[0].trim() === "https"
    || (process.env.NODE_ENV === "production" && !loopback);
  return createServerClient<Database>(url, key, {
    cookies: jar,
    cookieOptions: { httpOnly: true, sameSite: "lax", secure, path: "/" },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });
}

export async function createSupabaseClient(readOnly = false) {
  const [jar, incoming] = await Promise.all([cookies(), headers()]);
  return serverClient({
    getAll: () => jar.getAll(),
    setAll: (changes) => {
      // The proxy already forwards and persists refreshes for read-only Server Components.
      if (readOnly) return;
      for (const { name, value, options } of changes) jar.set(name, value, options);
    },
  }, incoming);
}

export async function refreshSupabaseSession(request: NextRequest) {
  const changes: { name: string; value: string; options: CookieOptions }[] = [];
  const cacheHeaders = new Headers();
  const client = serverClient({
    getAll: () => request.cookies.getAll(),
    setAll: (updates, responseHeaders) => {
      for (const update of updates) request.cookies.set(update.name, update.value);
      changes.push(...updates);
      for (const [key, value] of Object.entries(responseHeaders)) cacheHeaders.set(key, value);
    },
  }, request.headers);
  // A Server Component gets the refreshed request cookie. The browser receives the same rotation.
  await client.auth.getClaims();
  const response = NextResponse.next({ request });
  for (const { name, value, options } of changes) response.cookies.set(name, value, options);
  cacheHeaders.forEach((value, key) => response.headers.set(key, value));
  return response;
}

function value<T>(result: PostgrestSingleResponse<T>): T {
  if (!result.error) return result.data;
  const { code, message } = result.error;
  if (/^PT(400|401|403|404|409)$/.test(code)) throw new CabinetError(message, Number(code.slice(2)));
  if (result.status === 401) throw new CabinetError("Войдите в кабинет.", 401);
  if (code === "22P02") throw new CabinetError("Карта или документ недоступны.", 404);
  throw new CabinetError("Не удалось получить данные кабинета. Попробуйте ещё раз.", 502);
}

// PostgREST may cap rows below the requested range according to the project's Data API settings.
async function allRows<T>(fetchPage: (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>) {
  const records: T[] = [];
  const pageSize = 500;
  for (;;) {
    const result = await fetchPage(records.length, records.length + pageSize - 1);
    if (records.length && result.error?.code === "PGRST103") return records;
    const page = value(result);
    records.push(...page);
    if (!page.length || (result.count === null ? page.length < pageSize : records.length >= result.count)) return records;
  }
}

function authError(error: AuthError, fallback: string, status = 400): CabinetError {
  if (!error.status || error.status >= 500) return new CabinetError("Сервис аккаунтов временно недоступен.", 502);
  if (error.status === 429) return new CabinetError("Слишком много запросов. Попробуйте позже.", 429);
  if (error.code === "email_not_confirmed") return new CabinetError("Сначала подтвердите адрес электронной почты.", 403);
  if (error.code === "weak_password") return new CabinetError("Выберите более надёжный пароль.");
  if (error.code === "user_already_exists") return new CabinetError("Не удалось зарегистрироваться с этими данными.", 409);
  return new CabinetError(fallback, status);
}

function storageError(error: { status?: number; statusCode?: string }, reading: boolean): CabinetError {
  const status = Number(error.statusCode) || error.status;
  if (status === 401) return new CabinetError("Войдите в кабинет.", 401);
  if (status === 403 || status === 404 || (reading && status === 400)) {
    return new CabinetError(reading ? "Документ недоступен." : "Карта недоступна.", 404);
  }
  if (status === 413) return new CabinetError("Максимальный размер файла — 12 МБ.", 413);
  return new CabinetError("Не удалось обратиться к хранилищу. Попробуйте ещё раз.", 502);
}

export async function createSupabaseStore(readOnly = false): Promise<CabinetStore> {
  const client = await createSupabaseClient(readOnly);
  return {
    async currentUser() {
      const { data, error } = await client.auth.getUser();
      if (error) {
        if (isAuthSessionMissingError(error) || error.code === "session_not_found" || error.status === 401 || error.status === 403) return null;
        throw authError(error, "Не удалось проверить аккаунт.", 502);
      }
      if (!data.user?.email) return null;
      const { id, email, user_metadata: meta } = data.user;
      const name = typeof meta.name === "string" ? meta.name.trim().slice(0, 100) : "";
      return { id, email, name: name || email.split("@")[0] };
    },

    async signUp(name, email, password) {
      const origin = (await headers()).get("origin");
      const { data, error } = await client.auth.signUp({
        email: email.trim().toLowerCase(), password,
        options: { data: { name: name.trim() }, emailRedirectTo: origin ? new URL("/auth/confirm", origin).href : undefined },
      });
      if (error) throw authError(error, "Не удалось зарегистрироваться с этими данными.");
      return { confirmationRequired: !data.session };
    },

    async signIn(email, password) {
      const { error } = await client.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
      if (error) throw authError(error, "Неверная почта или пароль.", 401);
    },

    async signOut() {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error && !isAuthSessionMissingError(error)) throw authError(error, "Не удалось выйти из аккаунта.", 502);
    },

    async listCards() {
      return allRows((from, to) => client.rpc("cabinet_cards", {}, { count: "exact" }).range(from, to));
    },
    async addChild(name) {
      return value(await client.rpc("cabinet_add_child", { p_name: name }));
    },
    async listGrants(cardId) {
      return allRows((from, to) => client.rpc("cabinet_grants", { p_card: cardId }, { count: "exact" }).range(from, to));
    },
    async invite(cardId, email) {
      return value(await client.rpc("cabinet_invite", { p_card: cardId, p_email: email }));
    },
    async accept(code) {
      return value(await client.rpc("cabinet_accept", { p_code: code }));
    },
    async revoke(cardId, grantId) {
      value(await client.rpc("cabinet_revoke", { p_card: cardId, p_grant: grantId }));
    },
    async documents(cardId) {
      const rows = await allRows((from, to) => client.rpc("cabinet_documents", { p_card: cardId }, { count: "exact" }).range(from, to));
      return rows.map(({ storagePath: _path, ...record }) => record);
    },
    async upload(cardId, { bytes, mime, title, category, examDate, filename }) {
      const path = cardId + "/" + crypto.randomUUID();
      const { data, error } = await client.storage.from(bucket).upload(path, bytes, {
        contentType: mime, cacheControl: "0", upsert: false, metadata: { title, category, examDate, filename },
      });
      if (error) throw storageError(error, false);
      return data.id;
    },
    async file(id) {
      const rows = value(await client.rpc("cabinet_documents", { p_document: id }));
      if (!rows.length) throw new CabinetError("Документ недоступен.", 404);
      const { storagePath, ...record } = rows[0];
      const { data, error } = await client.storage.from(bucket).download(storagePath);
      if (error) throw storageError(error, true);
      return { record, bytes: new Uint8Array(await data.arrayBuffer()) };
    },
  };
}
