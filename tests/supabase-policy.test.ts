import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { MedicalDocument } from "../lib/cabinet.ts";

let db: PGlite;
const migration = new URL("../supabase/migrations/20261126000100_cabinet.sql", import.meta.url);
const existing = { id: randomUUID(), email: "existing@example.test" };

before(async () => {
  db = await PGlite.create();
  // The hosted services supply these relations, roles and request settings.
  // The migration supplies every application table, policy, trigger and RPC.
  await db.exec(`
    create role anon;
    create role authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
    create schema auth;
    create schema storage;
    create table auth.users (
      id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb
    );
    create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
    $$;
    create table storage.buckets (
      id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets,
      name text, metadata jsonb, user_metadata jsonb, created_at timestamptz default now(),
      unique (bucket_id, name)
    );
    alter table storage.objects enable row level security;
    grant usage on schema auth, storage to anon, authenticated;
    grant select, insert, update, delete on storage.objects to authenticated;
    create function storage.allow_only_operation(expected text) returns boolean language sql stable as $$
      select coalesce(regexp_replace(current_setting('storage.operation', true), '^storage[.]', '') =
        regexp_replace(expected, '^storage[.]', ''), false)
    $$;
  `);
  await db.query("insert into auth.users(id,email,email_confirmed_at) values ($1,$2,now())", [existing.id, existing.email]);
  await db.exec(await readFile(migration, "utf8"));
});

after(async () => { await db?.close(); });

async function scalar<T>(sql: string, params: unknown[] = []) {
  return (await db.query<{ value: T }>(sql, params)).rows[0]?.value;
}

async function account(name: string, confirmed = true) {
  await db.exec("reset role");
  const id = randomUUID();
  const email = `${id}@example.test`;
  await db.query(`insert into auth.users (id,email,raw_user_meta_data,email_confirmed_at)
    values ($1,$2,$3,case when $4 then now() end)`, [id, email, JSON.stringify({ name }), confirmed]);
  return { id, email };
}

async function act(user: { id: string; email: string }, jwtEmail = user.email) {
  await db.exec("reset role; set role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, false)",
    [JSON.stringify({ sub: user.id, email: jwtEmail, role: "authenticated" })]);
}

const cards = () => db.query<{ id: string; relation: string; isOwner: boolean }>("select * from public.cabinet_cards()");
const grants = (card: string) => db.query<{ id: string; email: string; status: string }>(
  "select * from public.cabinet_grants($1)", [card]);
const invite = (card: string, email: string) => scalar<string>("select public.cabinet_invite($1,$2) as value", [card, email]);
const accept = (code: string) => scalar<string>("select public.cabinet_accept($1) as value", [code]);
const revoke = (card: string, id: string) => db.query("select public.cabinet_revoke($1,$2)", [card, id]);
const denied = (err: unknown) => ["42501", "PT403", "PT404"].includes((err as { code: string }).code);

test("existing accounts receive a private adult card and anonymous requests cannot access the cabinet", async () => {
  await act(existing);
  const [adult] = (await cards()).rows;
  assert.equal(adult.relation, "self");
  assert.equal((await cards()).rows.length, 1);
  await db.exec("reset role; set role anon");
  await assert.rejects(cards(), { code: "42501" });
  await assert.rejects(db.query("select id from public.medical_cards"), { code: "42501" });
  await assert.rejects(invite(adult.id, "another@example.test"), { code: "42501" });
});

test("only the owner manages access to the selected adult or child card", async () => {
  const owner = await account("Ирина");
  const partner = await account("Саша");
  const third = await account("Борис");
  await act(owner);
  const [adult] = (await cards()).rows;
  assert.equal(adult.relation, "self");
  assert.equal(adult.isOwner, true);
  const child = await scalar<string>("select public.cabinet_add_child('Миша') as value");
  const childCode = await invite(child, partner.email.toUpperCase());
  const adultCode = await invite(adult.id, partner.email);
  const pending = (await grants(child)).rows[0];
  assert.deepEqual(pending, { id: pending.id, email: partner.email, status: "pending" });
  await assert.rejects(invite(child, partner.email), { code: "PT409" });
  await act(third, partner.email);
  await assert.rejects(accept(childCode), { code: "PT400" });
  await act(partner);
  assert.equal((await cards()).rows.length, 1);
  assert.equal(await accept(childCode), child);
  await assert.rejects(accept(childCode), { code: "PT400" });
  const shared = (await cards()).rows.find(row => row.id === child);
  assert.equal(shared?.relation, "child");
  assert.equal(shared?.isOwner, false);
  assert.ok(!(await cards()).rows.some(row => row.id === adult.id));
  await assert.rejects(grants(child), denied);
  await assert.rejects(invite(child, third.email), denied);
  await assert.rejects(revoke(child, pending.id), denied);
  assert.equal(await accept(adultCode), adult.id);
  assert.equal((await cards()).rows.find(row => row.id === adult.id)?.relation, "spouse");
  await act(owner);
  assert.equal((await grants(child)).rows[0].status, "active");
  await revoke(child, pending.id);
  await act(partner);
  assert.ok(!(await cards()).rows.some(row => row.id === child));
  assert.ok((await cards()).rows.some(row => row.id === adult.id));
  await assert.rejects(db.query("update public.medical_cards set owner_id=$1 where id=$2", [partner.id, adult.id]), denied);
});

test("cancelled and expired invitations can be reissued and require a confirmed address", async () => {
  const owner = await account("Рита");
  const recipient = await account("Павел", false);
  await act(owner);
  const [adult] = (await cards()).rows;
  const cancelled = await invite(adult.id, recipient.email);
  await revoke(adult.id, (await grants(adult.id)).rows[0].id);
  const expired = await invite(adult.id, recipient.email);
  const oldId = (await grants(adult.id)).rows[0].id;
  await db.exec("reset role");
  await db.query("update cabinet_private.card_access set expires_at=now()-interval '1 second' where id=$1", [oldId]);
  await act(owner);
  assert.equal((await grants(adult.id)).rows.length, 0);
  const current = await invite(adult.id, recipient.email);
  await act(recipient);
  await assert.rejects(accept(current), { code: "PT400" });
  await db.exec("reset role");
  await db.query("update auth.users set email_confirmed_at=now() where id=$1", [recipient.id]);
  await act(recipient);
  await assert.rejects(accept(cancelled), { code: "PT400" });
  await assert.rejects(accept(expired), { code: "PT400" });
  assert.equal(await accept(current), adult.id);
});

test("private originals and document records follow current card access on every operation", async () => {
  const owner = await account("Ольга");
  const partner = await account("Антон");
  await act(owner);
  const [adult] = (await cards()).rows;
  const code = await invite(adult.id, partner.email);
  const grantId = (await grants(adult.id)).rows[0].id;
  const objectId = randomUUID();
  const key = `${adult.id}/${randomUUID()}`;
  const fields = { title: "Анализ крови", category: "analysis", examDate: "2026-11-25", filename: "анализ.pdf" };
  const operation = (name: string) => db.query("select set_config('storage.operation', $1, false)", ["storage.object." + name]);
  const upload = (path: string, metadata = fields, size = 12) => db.query(`insert into storage.objects
    (id,bucket_id,name,metadata,user_metadata) values ($1,'medical-originals',$2,$3,$4)`,
    [objectId, path, JSON.stringify({ size, mimetype: "application/pdf" }), JSON.stringify(metadata)]);
  const readable = () => scalar<boolean>("select exists(select 1 from storage.objects where id=$1) as value", [objectId]);
  const list = () => db.query<MedicalDocument>("select * from public.cabinet_documents(p_card => $1)", [adult.id]);
  const file = () => db.query<MedicalDocument>("select * from public.cabinet_documents(p_document => $1)", [objectId]);

  await act(partner);
  await operation("upload");
  await assert.rejects(upload(key), denied);
  await assert.rejects(list(), denied);
  await accept(code);
  await assert.rejects(upload(`${key}/extra`), denied);
  await assert.rejects(upload(key, { ...fields, examDate: "2026-02-31" }), denied);
  await assert.rejects(upload(key, fields, 0), denied);
  await assert.rejects(upload(key, fields, 12582913), denied);
  await upload(key);
  const [item] = (await list()).rows;
  assert.equal(item.id, objectId);
  assert.equal(item.cardId, adult.id);
  assert.equal(item.filename, fields.filename);
  assert.equal(item.examDate, fields.examDate);
  assert.equal(Number(item.size), 12);
  assert.equal(item.mime, "application/pdf");
  assert.deepEqual((await file()).rows[0], item);
  await operation("get_authenticated");
  assert.equal(await readable(), true);
  for (const method of ["sign", "sign_many", "list", "copy"]) {
    await operation(method);
    assert.equal(await readable(), false, method);
  }
  await operation("sign_upload_url");
  await assert.rejects(upload(`${adult.id}/${randomUUID()}`), denied);
  await act(owner);
  await revoke(adult.id, grantId);
  await act(partner);
  await operation("get_authenticated");
  assert.equal(await readable(), false);
  await assert.rejects(list(), denied);
  await assert.rejects(file(), denied);
  await operation("upload");
  await assert.rejects(upload(`${adult.id}/${randomUUID()}`), denied);
  await act(owner);
  await operation("get_authenticated");
  assert.equal(await readable(), true);
  assert.equal((await file()).rows[0].title, fields.title);
});
