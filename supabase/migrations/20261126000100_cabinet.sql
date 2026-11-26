-- Cabinet accounts, card-specific sharing and private document originals.
create schema cabinet_private;
revoke all on schema cabinet_private from public, anon, authenticated;
grant usage on schema cabinet_private to authenticated;

create table public.medical_cards (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('adult', 'child')),
  name text not null check (char_length(btrim(name)) between 1 and 100 and name !~ '[[:cntrl:]]'),
  created_at timestamptz not null default now()
);
create unique index medical_cards_one_adult on public.medical_cards(owner_id) where kind = 'adult';
create index medical_cards_owner on public.medical_cards(owner_id);

create table cabinet_private.card_access (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.medical_cards(id) on delete cascade,
  email text not null,
  token_hash bytea unique,
  recipient_id uuid references auth.users(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '7 days',
  unique (card_id, email),
  unique (card_id, recipient_id),
  check ((token_hash is null) = (recipient_id is not null))
);
create index card_access_recipient on cabinet_private.card_access(recipient_id) where recipient_id is not null;
alter table public.medical_cards enable row level security;
alter table cabinet_private.card_access enable row level security;
revoke all on public.medical_cards, cabinet_private.card_access from public, anon, authenticated;
grant select on public.medical_cards to authenticated;

create function cabinet_private.profile_name(p_email text, p_metadata jsonb)
returns text language sql immutable set search_path = '' as $$
  select left(coalesce(nullif(btrim(regexp_replace(p_metadata->>'name', '[[:cntrl:]]', '', 'g')), ''),
    nullif(split_part(p_email, '@', 1), ''), 'Личная карта'), 100)
$$;

create function cabinet_private.register_adult()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.medical_cards(owner_id, kind, name)
    values (new.id, 'adult', cabinet_private.profile_name(new.email, new.raw_user_meta_data));
  return new;
end
$$;
create trigger cabinet_create_adult after insert on auth.users
  for each row execute function cabinet_private.register_adult();
insert into public.medical_cards(owner_id, kind, name)
  select id, 'adult', cabinet_private.profile_name(email, raw_user_meta_data) from auth.users
  on conflict do nothing;

create function cabinet_private.can_read_card(p_card uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.medical_cards c where c.id = p_card and c.owner_id = (select auth.uid()))
    or exists(select 1 from cabinet_private.card_access a where a.card_id = p_card and a.recipient_id = (select auth.uid()))
$$;
create policy cabinet_read_cards on public.medical_cards for select to authenticated
  using (cabinet_private.can_read_card(id));

create function cabinet_private.require_owner(p_card uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not cabinet_private.can_read_card(p_card) then
    raise sqlstate 'PT404' using message = 'Карта недоступна.';
  end if;
  if not exists (select 1 from public.medical_cards where id = p_card and owner_id = auth.uid()) then
    raise sqlstate 'PT403' using message = 'Доступом управляет владелец карты.';
  end if;
end
$$;

create function public.cabinet_cards()
returns table (id uuid, name text, relation text, "isOwner" boolean)
language sql stable security invoker set search_path = '' as $$
  select c.id, c.name, case when c.kind = 'child' then 'child'
    when c.owner_id = auth.uid() then 'self' else 'spouse' end, c.owner_id = auth.uid()
  from public.medical_cards c
  order by (c.kind = 'adult' and c.owner_id = auth.uid()) desc, (c.owner_id = auth.uid()) desc, c.created_at, c.id
$$;

create function public.cabinet_add_child(p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_name is null or char_length(btrim(p_name)) not between 1 and 100 or p_name ~ '[[:cntrl:]]' then
    raise sqlstate 'PT400' using message = 'Проверьте имя ребёнка.';
  end if;
  insert into public.medical_cards(owner_id, kind, name) values (auth.uid(), 'child', btrim(p_name))
    returning id into v_id;
  return v_id;
end
$$;

create function public.cabinet_grants(p_card uuid)
returns table (id uuid, email text, status text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform cabinet_private.require_owner(p_card);
  return query select a.id, a.email, case when a.recipient_id is null then 'pending' else 'active' end
    from cabinet_private.card_access a where a.card_id = p_card
      and (a.recipient_id is not null or a.expires_at > now()) order by a.email;
end
$$;

create function public.cabinet_invite(p_card uuid, p_email text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(p_email));
  v_code text := replace(gen_random_uuid()::text, '-', '');
begin
  perform cabinet_private.require_owner(p_card);
  if v_email is null or char_length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      or v_email ~ '[[:cntrl:]]' then
    raise sqlstate 'PT400' using message = 'Введите адрес электронной почты.';
  end if;
  if exists (select 1 from auth.users u where u.id = auth.uid() and lower(u.email) = v_email) then
    raise sqlstate 'PT400' using message = 'Вы уже владелец этой карты.';
  end if;
  delete from cabinet_private.card_access
    where card_id = p_card and email = v_email and recipient_id is null and expires_at <= now();
  insert into cabinet_private.card_access(card_id, email, token_hash)
    values (p_card, v_email, sha256(convert_to(v_code, 'UTF8')))
    on conflict (card_id, email) do nothing;
  if not found then
    raise sqlstate 'PT409' using message = 'Для этого адреса уже есть приглашение или доступ.';
  end if;
  return v_code;
end
$$;

create function public.cabinet_accept(p_code text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_card uuid;
begin
  update cabinet_private.card_access a set recipient_id = u.id, token_hash = null
    from auth.users u
    where u.id = auth.uid() and u.email_confirmed_at is not null and lower(u.email) = a.email
      and a.token_hash = sha256(convert_to(btrim(p_code), 'UTF8'))
      and a.recipient_id is null and a.expires_at > now()
    returning a.card_id into v_card;
  if not found then
    raise sqlstate 'PT400' using message = 'Приглашение недоступно для этого аккаунта.';
  end if;
  return v_card;
exception when unique_violation then
  raise sqlstate 'PT409' using message = 'У этого аккаунта уже есть доступ.';
end
$$;

create function public.cabinet_revoke(p_card uuid, p_grant uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform cabinet_private.require_owner(p_card);
  delete from cabinet_private.card_access where card_id = p_card and id = p_grant;
  if not found then
    raise sqlstate 'PT404' using message = 'Доступ не найден.';
  end if;
end
$$;

-- The bucket is private. A document key consists only of the card UUID and a fresh UUID.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
  values ('medical-originals', 'medical-originals', false, 12582912,
    array['application/pdf', 'image/jpeg', 'image/png']);

create function cabinet_private.object_card(p_path text)
returns uuid language sql immutable strict set search_path = '' as $$
  select case when p_path ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    then split_part(p_path, '/', 1)::uuid end
$$;

create function cabinet_private.valid_document_fields(p_fields jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  v_date text := p_fields->>'examDate';
  v_filename text := p_fields->>'filename';
begin
  if not coalesce(
    jsonb_typeof(p_fields->'title') = 'string' and char_length(btrim(p_fields->>'title')) between 1 and 140
    and (p_fields->>'title') !~ '[[:cntrl:]]'
    and jsonb_typeof(p_fields->'filename') = 'string' and char_length(btrim(v_filename)) between 1 and 200
    and v_filename !~ '[[:cntrl:]/]' and strpos(v_filename, chr(92)) = 0
    and p_fields->>'category' in ('analysis', 'examination')
    and v_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', false
  ) then
    return false;
  end if;
  perform make_date(substr(v_date, 1, 4)::integer, substr(v_date, 6, 2)::integer, substr(v_date, 9, 2)::integer);
  return true;
exception when datetime_field_overflow then
  return false;
end
$$;

create policy cabinet_upload_original on storage.objects for insert to authenticated with check (
  bucket_id = 'medical-originals' and storage.allow_only_operation('object.upload')
  and cabinet_private.can_read_card(cabinet_private.object_card(name))
  and cabinet_private.valid_document_fields(user_metadata)
  and metadata->>'mimetype' in ('application/pdf', 'image/jpeg', 'image/png')
  -- The permission probe can precede a known length. The commit probe carries the actual size.
  and coalesce((metadata->>'size')::bigint, (metadata->>'contentLength')::bigint, 1) between 1 and 12582912
);
-- Signed downloads would keep working until expiry after the card owner revoked access.
create policy cabinet_download_original on storage.objects for select to authenticated using (
  bucket_id = 'medical-originals' and storage.allow_only_operation('object.get_authenticated')
  and cabinet_private.can_read_card(cabinet_private.object_card(name))
);

-- Storage commits custom metadata and original together. Its ID, MIME type, size and
-- timestamp are authoritative. These RPCs expose only objects in a currently accessible card.
create function public.cabinet_documents(p_card uuid default null, p_document uuid default null)
returns table (id uuid, "cardId" uuid, title text, category text, "examDate" text, filename text,
  mime text, size integer, "createdAt" timestamptz, "storagePath" text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if num_nonnulls(p_card, p_document) <> 1 then
    raise sqlstate 'PT400' using message = 'Выберите карту или документ.';
  end if;
  if p_card is not null and not cabinet_private.can_read_card(p_card) then
    raise sqlstate 'PT404' using message = 'Карта недоступна.';
  end if;
  return query select o.id, c.id, o.user_metadata->>'title', o.user_metadata->>'category',
    o.user_metadata->>'examDate', o.user_metadata->>'filename', o.metadata->>'mimetype',
    (o.metadata->>'size')::integer, o.created_at, o.name
    from storage.objects o
    join public.medical_cards c on c.id = cabinet_private.object_card(o.name)
    where o.bucket_id = 'medical-originals' and cabinet_private.can_read_card(c.id)
      and (p_card is null or (c.id = p_card and o.name like p_card::text || '/%'))
      and (p_document is null or o.id = p_document)
      and cabinet_private.valid_document_fields(o.user_metadata)
    order by o.user_metadata->>'examDate' desc, o.created_at desc, o.id;
  if p_document is not null and not found then
    raise sqlstate 'PT404' using message = 'Документ недоступен.';
  end if;
end
$$;

revoke all on all functions in schema cabinet_private from public, anon, authenticated;
grant execute on function cabinet_private.can_read_card(uuid), cabinet_private.object_card(text),
  cabinet_private.valid_document_fields(jsonb) to authenticated;
revoke all on function public.cabinet_cards(), public.cabinet_add_child(text), public.cabinet_grants(uuid),
  public.cabinet_invite(uuid, text), public.cabinet_accept(text), public.cabinet_revoke(uuid, uuid),
  public.cabinet_documents(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cabinet_cards(), public.cabinet_add_child(text), public.cabinet_grants(uuid),
  public.cabinet_invite(uuid, text), public.cabinet_accept(text), public.cabinet_revoke(uuid, uuid),
  public.cabinet_documents(uuid, uuid) to authenticated;
notify pgrst, 'reload schema';
