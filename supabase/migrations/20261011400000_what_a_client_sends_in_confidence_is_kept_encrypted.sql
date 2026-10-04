-- ═══════════════════════════════════════════════════════
-- What a client sends in confidence is kept encrypted (ADM-106).
--
-- The PM document (§4.3) says a client's logins, hosting access and API keys
-- must never travel in the project group or in a file, and the owner answered
-- ADM-106 on 2026-10-04: "an encrypted vault per project — build it".
--
-- This is the SAME design as the integration vault (core.secret_credentials,
-- 20261002100000), scoped to a project:
--
--   • CIPHERTEXT only. AES-256-GCM happens in application code, keyed by
--     VAULT_ENCRYPTION_KEY, a hosting-only secret. A row read alone is noise.
--   • An ADMIN (owner or ops_admin) stores one — what the client sent over a
--     secure channel — and an admin reveals one. Nobody else, in any role.
--   • Nobody reads the table: no policy for `authenticated`, no grant. Every
--     path is one of the doors below (security definer, each re-checking the
--     role and the tenancy in its own body).
--   • EVERY reveal is audited, with who and when, BEFORE the ciphertext is
--     returned, in the same transaction — a reveal that cannot be audited
--     does not happen. The audit row names the label, never the value.
--   • A secret is never deleted by a person: revoking wipes the ciphertext and
--     keeps the row (who stored it, who revoked it, when) as the record.
-- ═══════════════════════════════════════════════════════

create table if not exists projects.client_secrets (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id),
  project_id      uuid not null references projects.projects(id),
  -- What it is, in the admin's words: "Hosting login", "Stripe live key".
  label           text not null check (char_length(btrim(label)) between 1 and 120),
  kind            text not null default 'other'
                  check (kind in ('login', 'api_key', 'hosting', 'domain', 'social', 'other')),
  ciphertext      text,
  iv              text,
  auth_tag        text,
  -- The last four characters, null for a short value (never half a secret).
  hint            text check (hint is null or char_length(hint) <= 4),
  stored_by       uuid not null references core.users(id),
  created_at      timestamptz not null default now(),
  revoked_by      uuid references core.users(id),
  revoked_at      timestamptz,
  -- Live: all three parts present. Revoked: all three wiped, with who and when.
  constraint client_secrets_live_or_revoked check (
    (revoked_at is null and ciphertext is not null and iv is not null and auth_tag is not null and revoked_by is null)
    or
    (revoked_at is not null and ciphertext is null and iv is null and auth_tag is null and revoked_by is not null)
  )
);

comment on table projects.client_secrets is
  'Encrypted client credentials, one project each (ADM-106). Ciphertext only; VAULT_ENCRYPTION_KEY never touches this table. No policy for authenticated: every read is projects.reveal_client_secret, which audits the view.';

create index if not exists client_secrets_project_idx on projects.client_secrets (project_id, created_at desc);

alter table projects.client_secrets enable row level security;
alter table projects.client_secrets force row level security;

drop policy if exists client_secrets_service_only on projects.client_secrets;
create policy client_secrets_service_only on projects.client_secrets
  for all to service_role using (true) with check (true);

revoke all on table projects.client_secrets from public, anon, authenticated;
grant select, insert, update on table projects.client_secrets to service_role;

drop trigger if exists org_match_client_secrets_project on projects.client_secrets;
create trigger org_match_client_secrets_project
  before insert or update of project_id, organization_id on projects.client_secrets
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_client_secrets on projects.client_secrets;
create trigger freeze_org_client_secrets
  before update of organization_id on projects.client_secrets
  for each row execute function core.freeze_organization_id();

-- A secret's value, once stored, is never edited: replacing means revoke + store.
create or replace function projects.client_secrets_immutable()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.ciphertext is not null and new.ciphertext is distinct from old.ciphertext then
    raise exception 'a stored client secret is never edited; revoke it and store a new one' using errcode = 'P0001';
  end if;
  if new.label is distinct from old.label or new.kind is distinct from old.kind
     or new.project_id is distinct from old.project_id or new.stored_by is distinct from old.stored_by then
    raise exception 'a client secret keeps its project, label, kind and author' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists client_secrets_immutable on projects.client_secrets;
create trigger client_secrets_immutable
  before update on projects.client_secrets
  for each row execute function projects.client_secrets_immutable();

-- ── store ────────────────────────────────────────────────────────────────

create or replace function projects.store_client_secret(
  p_project_id uuid,
  p_label      text,
  p_kind       text,
  p_ciphertext text,
  p_iv         text,
  p_auth_tag   text,
  p_hint       text default null
)
returns table (
  -- 'stored'
  -- refusals: 'no_actor' | 'not_authorized' | 'project_not_found' | 'invalid_label' | 'invalid_value'
  outcome   text,
  secret_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_label text := btrim(coalesce(p_label, ''));
  v_id    uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org) then
    return query select 'project_not_found'::text, null::uuid; return;
  end if;
  if v_label = '' or char_length(v_label) > 120 then
    return query select 'invalid_label'::text, null::uuid; return;
  end if;
  if nullif(btrim(coalesce(p_ciphertext, '')), '') is null
     or nullif(btrim(coalesce(p_iv, '')), '') is null
     or nullif(btrim(coalesce(p_auth_tag, '')), '') is null then
    return query select 'invalid_value'::text, null::uuid; return;
  end if;

  insert into projects.client_secrets (organization_id, project_id, label, kind, ciphertext, iv, auth_tag, hint, stored_by)
  values (v_org, p_project_id, v_label, coalesce(nullif(btrim(p_kind), ''), 'other'), p_ciphertext, p_iv, p_auth_tag,
          nullif(btrim(coalesce(p_hint, '')), ''), v_actor)
  returning id into v_id;

  perform core.record_audit(
    v_org, 'client_secret.stored', 'client_secret', v_id, null,
    jsonb_build_object('project_id', p_project_id, 'label', v_label, 'kind', coalesce(nullif(btrim(p_kind), ''), 'other'))
  );

  return query select 'stored'::text, v_id;
end;
$$;

comment on function projects.store_client_secret(uuid, text, text, text, text, text, text) is
  'Stores one encrypted client secret on a project. Owner or ops_admin, re-checked here. The value arrives already encrypted; the audit row names the label, never the value.';

revoke all on function projects.store_client_secret(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function projects.store_client_secret(uuid, text, text, text, text, text, text) to authenticated;

-- ── list: what exists, never the value ─────────────────────────────────────

create or replace function projects.client_secret_list(p_project_id uuid)
returns table (
  id             uuid,
  label          text,
  kind           text,
  hint           text,
  stored_by_name text,
  created_at     timestamptz,
  revoked_at     timestamptz,
  revoked_by_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.label, s.kind, s.hint, coalesce(u.full_name, u.email), s.created_at, s.revoked_at, coalesce(r.full_name, r.email)
    from projects.client_secrets s
    left join core.users u on u.id = s.stored_by
    left join core.users r on r.id = s.revoked_by
   where s.project_id = p_project_id
     and s.organization_id = (select core.current_organization_id())
     and coalesce((select core.is_admin()), false)
   order by s.created_at desc;
$$;

comment on function projects.client_secret_list(uuid) is
  'The secrets stored on a project: label, kind, hint, who and when. Admin only. Never the ciphertext, never the value.';

revoke all on function projects.client_secret_list(uuid) from public, anon;
grant execute on function projects.client_secret_list(uuid) to authenticated;

-- ── reveal: audited before anything is returned ──────────────────────────────

create or replace function projects.reveal_client_secret(p_secret_id uuid)
returns table (
  -- 'revealed'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'revoked'
  outcome    text,
  label      text,
  ciphertext text,
  iv         text,
  auth_tag   text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_row   projects.client_secrets%rowtype;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::text, null::text, null::text, null::text; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text, null::text, null::text, null::text, null::text; return;
  end if;

  select * into v_row from projects.client_secrets s where s.id = p_secret_id and s.organization_id = v_org;
  if not found then
    return query select 'not_found'::text, null::text, null::text, null::text, null::text; return;
  end if;
  if v_row.revoked_at is not null then
    return query select 'revoked'::text, v_row.label, null::text, null::text, null::text; return;
  end if;

  -- The view is recorded first, in this transaction. If this raises, nothing is returned.
  perform core.record_audit(
    v_org, 'client_secret.viewed', 'client_secret', v_row.id, null,
    jsonb_build_object('project_id', v_row.project_id, 'label', v_row.label, 'viewed_by', v_actor)
  );

  return query select 'revealed'::text, v_row.label, v_row.ciphertext, v_row.iv, v_row.auth_tag;
end;
$$;

comment on function projects.reveal_client_secret(uuid) is
  'Returns one secret''s ciphertext to an admin and records client_secret.viewed (who, when, which label) in the same transaction first. The only read path.';

revoke all on function projects.reveal_client_secret(uuid) from public, anon;
grant execute on function projects.reveal_client_secret(uuid) to authenticated;

-- ── revoke ──────────────────────────────────────────────────────────────

create or replace function projects.revoke_client_secret(p_secret_id uuid)
returns table (
  -- 'revoked'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'already_revoked'
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
  v_row   projects.client_secrets%rowtype;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  select * into v_row from projects.client_secrets s where s.id = p_secret_id and s.organization_id = v_org;
  if not found then
    return query select 'not_found'::text; return;
  end if;
  if v_row.revoked_at is not null then
    return query select 'already_revoked'::text; return;
  end if;

  update projects.client_secrets
     set ciphertext = null, iv = null, auth_tag = null, revoked_at = now(), revoked_by = v_actor
   where id = v_row.id;

  perform core.record_audit(
    v_org, 'client_secret.revoked', 'client_secret', v_row.id,
    jsonb_build_object('project_id', v_row.project_id, 'label', v_row.label), null
  );

  return query select 'revoked'::text;
end;
$$;

comment on function projects.revoke_client_secret(uuid) is
  'Wipes a secret''s ciphertext and keeps the row (who stored it, who revoked it, when). Admin only. Nothing deletes a secret row.';

revoke all on function projects.revoke_client_secret(uuid) from public, anon;
grant execute on function projects.revoke_client_secret(uuid) to authenticated;
