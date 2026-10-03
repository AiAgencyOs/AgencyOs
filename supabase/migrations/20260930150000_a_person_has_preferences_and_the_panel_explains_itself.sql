-- ═══════════════════════════════════════════════════════════════════════════
-- A person has preferences, and the panel explains itself.
--
-- Bucket E, decision E3 (owner, 2026-09-30): build Profile / Preferences (the
-- Phase 1 blueprint's A32) and Help (A34). This migration is the data half of
-- A32. A34 — the /help page — is generated from the screen inventory at build
-- time and needs no table: what the panel can do is a fact about the code,
-- not a row somebody typed.
--
-- WHY THERE IS NO organization_id ON core.user_preferences
--
-- Every other table in this database carries `organization_id` because every
-- other row belongs to a tenant. A preference does not. The timezone a person
-- wants to read dates in, whether they want an email or a WhatsApp nudge, and
-- how often a digest arrives are facts about the PERSON, and core.users itself
-- "deliberately has no organization_id: membership is the many-to-many join,
-- so a user can later belong to several organizations". A preference row
-- keyed by organization would mean a person who belongs to two tenants sets
-- their timezone twice and gets it wrong in one of them. So the row follows
-- the person: `user_id` is the primary key and the foreign key, the row goes
-- when the person goes, and row-level security admits exactly one reader and
-- one writer — the person themself (`user_id = auth.uid()`). No staff policy,
-- no admin policy: an owner has no business reading a colleague's digest
-- setting, and the panel never needs to.
--
-- What IS tenant-scoped is the audit row. A change to preferences or to the
-- profile is recorded through core.record_audit in the ACTING organisation —
-- the one the caller's active membership names, `core.current_organization_id()`
-- — because audit.audit_log is per tenant and `audit_log_insert` refuses any
-- other org. A caller with no active membership (no acting org) is refused
-- by the doors with 'no_organization': a governed write with no place to
-- record it is not written.
--
-- The timezone is validated the way core.organizations.timezone and
-- crm.meetings.timezone already are: `core.is_known_timezone`, the one
-- predicate over pg_timezone_names (20260912140000), enforced by a trigger so
-- a direct write cannot store a zone the door would refuse. Null means
-- "follow the organisation", which is what every person has today.
--
-- core.users gains nothing. `full_name` and `avatar_url` already exist and
-- `users_update_self` already admits the person's own UPDATE; the door
-- core.update_own_profile exists for the audit row and the validation, not
-- to bypass anything (security invoker throughout).
--
-- Avatars live in a Supabase Storage bucket `avatars`, keyed
-- `<user_id>/<file>`, created here only where a storage service exists —
-- the local stack has none, and the profile page says so in words.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the row ───────────────────────────────────────────────────────────

create table if not exists core.user_preferences (
  user_id                uuid primary key references core.users(id) on delete cascade,

  -- null = the organisation's timezone (core.organizations.timezone).
  timezone               text,
  locale                 text not null default 'en-IN'
                           check (locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$'),
  date_format            text not null default 'medium'
                           check (date_format in ('medium', 'long', 'numeric')),
  notification_email     boolean not null default true,
  notification_whatsapp  boolean not null default false,
  digest                 text not null default 'off'
                           check (digest in ('off', 'daily', 'weekly')),

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table core.user_preferences is
  'What one person wants from the panel — display timezone (null = the organisation''s), locale, date format, notification channels, digest cadence. Keyed by the person, not the tenant, because preferences follow the person across organisations; read and written only by that person, through core.set_own_preferences, audited in the acting organisation.';

comment on column core.user_preferences.timezone is
  'IANA zone the person reads dates in, validated against pg_timezone_names by trigger; null follows core.organizations.timezone.';

drop trigger if exists set_updated_at on core.user_preferences;
create trigger set_updated_at before update on core.user_preferences
  for each row execute function core.set_updated_at();

-- The zone is a zone — the same predicate the organisation and meetings use.
create or replace function core.user_preference_timezone_is_known()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.timezone is not distinct from old.timezone then
    return new;
  end if;
  if new.timezone is not null and not core.is_known_timezone(new.timezone) then
    raise exception 'user_preferences.timezone: "%" is not a zone Postgres knows', new.timezone
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function core.user_preference_timezone_is_known() is
  'Refuses a display timezone pg_timezone_names does not carry (through core.is_known_timezone), so a direct write cannot store what the door would refuse.';

drop trigger if exists user_preferences_timezone_is_known on core.user_preferences;
create trigger user_preferences_timezone_is_known
  before insert or update of timezone on core.user_preferences
  for each row execute function core.user_preference_timezone_is_known();

-- ── 2. own-row security ──────────────────────────────────────────────────

alter table core.user_preferences enable row level security;
alter table core.user_preferences force row level security;

drop policy if exists user_preferences_select_self on core.user_preferences;
create policy user_preferences_select_self on core.user_preferences
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists user_preferences_insert_self on core.user_preferences;
create policy user_preferences_insert_self on core.user_preferences
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists user_preferences_update_self on core.user_preferences;
create policy user_preferences_update_self on core.user_preferences
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- No delete for authenticated: the row goes with the person (cascade), and
-- "back to the defaults" is an update, not a deletion.
grant select, insert, update on core.user_preferences to authenticated, service_role;

-- ── 3. the doors ─────────────────────────────────────────────────────────
--
-- security invoker: the own-row policies above and users_update_self decide
-- again inside. The functions exist for validation and the audit row.

create or replace function core.set_own_preferences(
  p_timezone              text,
  p_locale                text,
  p_date_format           text,
  p_notification_email    boolean,
  p_notification_whatsapp boolean,
  p_digest                text
)
returns table (outcome text)   -- 'saved' | 'unauthenticated' | 'no_organization' | 'invalid_timezone' | 'invalid'
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_tz     text := nullif(btrim(coalesce(p_timezone, '')), '');
  v_locale text := coalesce(nullif(btrim(coalesce(p_locale, '')), ''), 'en-IN');
  v_format text := coalesce(nullif(btrim(coalesce(p_date_format, '')), ''), 'medium');
  v_digest text := coalesce(nullif(btrim(coalesce(p_digest, '')), ''), 'off');
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null then
    return query select 'unauthenticated'::text; return;
  end if;
  if v_org is null then
    return query select 'no_organization'::text; return;
  end if;

  if v_tz is not null and not core.is_known_timezone(v_tz) then
    return query select 'invalid_timezone'::text; return;
  end if;
  if v_format not in ('medium', 'long', 'numeric')
     or v_digest not in ('off', 'daily', 'weekly')
     or v_locale !~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$' then
    return query select 'invalid'::text; return;
  end if;

  select to_jsonb(p) - 'user_id' - 'created_at' - 'updated_at' into v_before
    from core.user_preferences p
   where p.user_id = v_actor;

  insert into core.user_preferences (
    user_id, timezone, locale, date_format, notification_email, notification_whatsapp, digest
  )
  values (
    v_actor, v_tz, v_locale, v_format,
    coalesce(p_notification_email, true), coalesce(p_notification_whatsapp, false), v_digest
  )
  on conflict (user_id) do update
    set timezone              = excluded.timezone,
        locale                = excluded.locale,
        date_format           = excluded.date_format,
        notification_email    = excluded.notification_email,
        notification_whatsapp = excluded.notification_whatsapp,
        digest                = excluded.digest;

  select to_jsonb(p) - 'user_id' - 'created_at' - 'updated_at' into v_after
    from core.user_preferences p
   where p.user_id = v_actor;

  -- Audited in the acting organisation: the row follows the person, the
  -- history follows the tenant it was changed in.
  perform core.record_audit(
    v_org, 'preferences.updated', 'user_preferences', v_actor, v_before, v_after
  );

  return query select 'saved'::text;
end;
$$;

comment on function core.set_own_preferences(text, text, text, boolean, boolean, text) is
  'Writes the caller''s own core.user_preferences row (upsert). Timezone validated against pg_timezone_names (null follows the organisation); locale, date format and digest validated by name. Requires an acting organisation so the change is audited there as preferences.updated. SECURITY INVOKER: the own-row policies decide again.';

revoke all on function core.set_own_preferences(text, text, text, boolean, boolean, text) from public, anon;
grant execute on function core.set_own_preferences(text, text, text, boolean, boolean, text) to authenticated, service_role;

create or replace function core.update_own_profile(
  p_full_name  text,
  p_avatar_url text
)
returns table (outcome text)   -- 'updated' | 'unauthenticated' | 'no_organization' | 'invalid' | 'not_found'
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_name   text := nullif(btrim(coalesce(p_full_name, '')), '');
  v_avatar text := nullif(btrim(coalesce(p_avatar_url, '')), '');
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null then
    return query select 'unauthenticated'::text; return;
  end if;
  if v_org is null then
    return query select 'no_organization'::text; return;
  end if;
  if v_name is null or length(v_name) > 120 or length(coalesce(v_avatar, '')) > 1024 then
    return query select 'invalid'::text; return;
  end if;

  select jsonb_build_object('full_name', u.full_name, 'avatar_url', u.avatar_url) into v_before
    from core.users u
   where u.id = v_actor;
  if v_before is null then
    return query select 'not_found'::text; return;
  end if;

  update core.users
     set full_name  = v_name,
         avatar_url = v_avatar
   where id = v_actor;

  v_after := jsonb_build_object('full_name', v_name, 'avatar_url', v_avatar);

  if v_before is distinct from v_after then
    perform core.record_audit(v_org, 'profile.updated', 'user', v_actor, v_before, v_after);
  end if;

  return query select 'updated'::text;
end;
$$;

comment on function core.update_own_profile(text, text) is
  'Writes the caller''s own core.users.full_name and avatar_url (users_update_self decides again). Requires an acting organisation so the change is audited there as profile.updated with before and after. Never touches another person''s row.';

revoke all on function core.update_own_profile(text, text) from public, anon;
grant execute on function core.update_own_profile(text, text) to authenticated, service_role;

-- ── 4. the avatars bucket, where a storage service exists ────────────────

do $$
begin
  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise notice 'storage schema absent: the avatars bucket and its policies are not created here (the local stack has no storage service)';
    return;
  end if;

  insert into storage.buckets (id, name, public)
  values ('avatars', 'avatars', false)
  on conflict (id) do nothing;

  -- Objects are keyed <user_id>/<file>. Anyone signed in may read an avatar
  -- (it is shown beside a colleague's name); only the person writes their own
  -- folder, and a re-upload replaces the object (upsert), so update is admitted
  -- on the same terms.
  execute 'drop policy if exists avatars_objects_select on storage.objects';
  execute $p$create policy avatars_objects_select on storage.objects
    for select to authenticated
    using (bucket_id = 'avatars')$p$;

  execute 'drop policy if exists avatars_objects_insert on storage.objects';
  execute $p$create policy avatars_objects_insert on storage.objects
    for insert to authenticated
    with check (bucket_id = 'avatars'
                and (storage.foldername(name))[1] = (select auth.uid())::text)$p$;

  execute 'drop policy if exists avatars_objects_update on storage.objects';
  execute $p$create policy avatars_objects_update on storage.objects
    for update to authenticated
    using (bucket_id = 'avatars'
           and (storage.foldername(name))[1] = (select auth.uid())::text)
    with check (bucket_id = 'avatars'
                and (storage.foldername(name))[1] = (select auth.uid())::text)$p$;

  execute 'drop policy if exists avatars_objects_delete on storage.objects';
end;
$$;
