-- ═══════════════════════════════════════════════════════════════════════════
-- A key is kept in one place.
--
-- The owner asked for one screen in the admin panel from which every key the
-- system uses can be managed. Until now only the five AI provider keys had a
-- vault (ai.provider_credentials, 20260920140000); the GitHub token, the email
-- key, the WhatsApp token and secret, the alert webhook, the Figma token and
-- the Google service-account key were deployment environment variables that
-- only whoever holds the hosting account could change.
--
-- This migration is the store for all of them — the SAME design as the
-- provider vault, generalised:
--
--   • CIPHERTEXT only. Encryption is AES-256-GCM in application code
--     (src/lib/ai/vault.ts, keyed by VAULT_ENCRYPTION_KEY, a hosting-only
--     secret). A row read on its own decrypts to nothing.
--   • Global, not per organization: one GitHub account, one WhatsApp app, one
--     email provider serve the agency, exactly as one Anthropic account does.
--   • Keyed by SLOT, the environment variable's own name (GITHUB_TOKEN,
--     RESEND_API_KEY …). Which slots exist, and what each is for, is the
--     registry in src/lib/secrets/registry.ts — the database only checks that
--     a slot looks like an env-var name, so a new integration needs no
--     migration.
--   • The environment still wins. A value set in the deployment environment is
--     used before a vault value (the provider vault's own rule), so nothing
--     that works today changes on the day this ships.
--
-- ── who may do what ───────────────────────────────────────────────────────
--
-- Storing or replacing a key and revoking one are OWNER-only: a GitHub token
-- can merge a pull request and a WhatsApp token can message every client.
-- Reading which slots are set — presence, the last four characters as a hint,
-- the expiry, who and when — is admin-tier. Nobody, in any role, can read a
-- value back through PostgREST: the table has no policy for `authenticated`
-- and no grant, so every path is one of the four functions below (security
-- definer, each re-checking the role in its own body) or the service role that
-- decrypts a key to call a vendor. Every change is audited with WHO and WHEN
-- and the slot — never the value, and the hint only as the last four
-- characters the person already typed.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists core.secret_credentials (
  slot                 text primary key
                       check (slot ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  ciphertext           text not null,
  iv                   text not null,
  auth_tag             text not null,
  -- The last four characters, so an owner can tell which of two tokens is
  -- stored. Null for a short value: four characters of an eight-character key
  -- would be half of it.
  hint                 text check (hint is null or char_length(hint) <= 4),
  -- Known for a GitHub token or a Figma token; null for a key that never
  -- expires. The panel warns before and after.
  expires_on           date,
  last_verified_at     timestamptz,
  last_verified_ok     boolean,
  last_verified_detail text check (last_verified_detail is null or char_length(last_verified_detail) <= 300),
  updated_by           uuid not null references core.users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table core.secret_credentials is
  'Encrypted integration secrets, owner-entered through the Keys & secrets screen. Ciphertext only; VAULT_ENCRYPTION_KEY never touches this table. No policy for authenticated: every path is core.store_secret / revoke_secret / secret_status / record_secret_check, or the service role decrypting to call a vendor.';

alter table core.secret_credentials enable row level security;
alter table core.secret_credentials force row level security;

drop policy if exists secret_credentials_service_only on core.secret_credentials;
create policy secret_credentials_service_only on core.secret_credentials
  for all to service_role
  using (true)
  with check (true);

revoke all on table core.secret_credentials from public, anon, authenticated;
grant select, insert, update, delete on table core.secret_credentials to service_role;

create or replace function core.secret_credentials_touch()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists secret_credentials_touch on core.secret_credentials;
create trigger secret_credentials_touch
  before update on core.secret_credentials
  for each row execute function core.secret_credentials_touch();

-- ── store or replace one key ──────────────────────────────────────────────

create or replace function core.store_secret(
  p_slot       text,
  p_ciphertext text,
  p_iv         text,
  p_auth_tag   text,
  p_hint       text default null,
  p_expires_on date default null
)
returns table (
  -- 'stored' (a new slot) | 'replaced'
  -- refusals: 'no_actor' | 'not_authorized' | 'invalid_slot' | 'invalid_value' | 'expired'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_org      uuid := (select core.current_organization_id());
  v_existing boolean;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_owner()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if p_slot is null or p_slot !~ '^[A-Z][A-Z0-9_]{2,63}$' then
    return query select 'invalid_slot'::text; return;
  end if;
  if nullif(trim(coalesce(p_ciphertext, '')), '') is null
     or nullif(trim(coalesce(p_iv, '')), '') is null
     or nullif(trim(coalesce(p_auth_tag, '')), '') is null then
    return query select 'invalid_value'::text; return;
  end if;
  if p_expires_on is not null and p_expires_on < current_date then
    return query select 'expired'::text; return;
  end if;

  select true into v_existing from core.secret_credentials where slot = p_slot;
  v_existing := coalesce(v_existing, false);

  insert into core.secret_credentials (slot, ciphertext, iv, auth_tag, hint, expires_on, updated_by)
  values (p_slot, p_ciphertext, p_iv, p_auth_tag, nullif(trim(coalesce(p_hint, '')), ''), p_expires_on, v_actor)
  on conflict (slot) do update
     set ciphertext = excluded.ciphertext,
         iv = excluded.iv,
         auth_tag = excluded.auth_tag,
         hint = excluded.hint,
         expires_on = excluded.expires_on,
         updated_by = excluded.updated_by,
         -- a new value has not been checked yet
         last_verified_at = null,
         last_verified_ok = null,
         last_verified_detail = null;

  perform core.record_audit(
    v_org,
    case when v_existing then 'secret.replaced' else 'secret.stored' end,
    'secret',
    null,
    jsonb_build_object('slot', p_slot, 'configured', v_existing),
    jsonb_build_object('slot', p_slot, 'configured', true, 'hint', nullif(trim(coalesce(p_hint, '')), ''), 'expires_on', p_expires_on)
  );

  return query select case when v_existing then 'replaced' else 'stored' end::text;
end;
$$;

comment on function core.store_secret(text, text, text, text, text, date) is
  'Stores or replaces one encrypted secret (the Keys & secrets screen). Owner only, re-checked here. The value arrives already encrypted; the audit row names the slot, the four-character hint and the expiry — never the value.';

revoke all on function core.store_secret(text, text, text, text, text, date) from public, anon;
grant execute on function core.store_secret(text, text, text, text, text, date) to authenticated;

-- ── revoke ────────────────────────────────────────────────────────────────

create or replace function core.revoke_secret(p_slot text)
returns table (
  -- 'revoked'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := (select auth.uid());
  v_org        uuid := (select core.current_organization_id());
  v_updated_by uuid;
  v_updated_at timestamptz;
  v_hint       text;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_owner()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  select c.updated_by, c.updated_at, c.hint into v_updated_by, v_updated_at, v_hint
    from core.secret_credentials c where c.slot = p_slot;
  if not found then
    return query select 'not_found'::text; return;
  end if;

  delete from core.secret_credentials where slot = p_slot;

  perform core.record_audit(
    v_org, 'secret.revoked', 'secret', null,
    jsonb_build_object('slot', p_slot, 'hint', v_hint, 'updated_by', v_updated_by, 'updated_at', v_updated_at),
    jsonb_build_object('slot', p_slot, 'configured', false)
  );

  return query select 'revoked'::text;
end;
$$;

comment on function core.revoke_secret(text) is
  'Deletes one vault-stored secret. Owner only. Audited as secret.revoked with who set it and when — never the value. A value set in the deployment environment cannot be revoked from here.';

revoke all on function core.revoke_secret(text) from public, anon;
grant execute on function core.revoke_secret(text) to authenticated;

-- ── which slots are stored: presence and moment, never the value ───────────

create or replace function core.secret_status()
returns table (
  slot                 text,
  hint                 text,
  expires_on           date,
  updated_at           timestamptz,
  updated_by           uuid,
  updated_by_name      text,
  last_verified_at     timestamptz,
  last_verified_ok     boolean,
  last_verified_detail text
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.slot, c.hint, c.expires_on, c.updated_at, c.updated_by,
         coalesce(u.full_name, u.email), c.last_verified_at, c.last_verified_ok, c.last_verified_detail
    from core.secret_credentials c
    left join core.users u on u.id = c.updated_by
   where coalesce((select core.is_admin()), false)
   order by c.slot;
$$;

comment on function core.secret_status() is
  'The vault-stored slots with hint, expiry, who and when — an admin session only. Never the ciphertext, never the value.';

revoke all on function core.secret_status() from public, anon;
grant execute on function core.secret_status() to authenticated;

-- ── record the result of a live check ─────────────────────────────────────

create or replace function core.record_secret_check(p_slot text, p_ok boolean, p_detail text default null)
returns table (
  -- 'recorded' | refusals: 'no_actor' | 'not_authorized' | 'not_found'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  update core.secret_credentials
     set last_verified_at = now(),
         last_verified_ok = p_ok,
         last_verified_detail = left(nullif(trim(coalesce(p_detail, '')), ''), 300)
   where slot = p_slot;
  if not found then
    return query select 'not_found'::text; return;
  end if;

  perform core.record_audit(
    v_org, 'secret.verified', 'secret', null, null,
    jsonb_build_object('slot', p_slot, 'ok', p_ok)
  );

  return query select 'recorded'::text;
end;
$$;

comment on function core.record_secret_check(text, boolean, text) is
  'Records the result of a live check of a stored secret (a person pressed Verify). Admin tier. Audited as secret.verified with the slot and the result.';

revoke all on function core.record_secret_check(text, boolean, text) from public, anon;
grant execute on function core.record_secret_check(text, boolean, text) to authenticated;

notify pgrst, 'reload schema';
