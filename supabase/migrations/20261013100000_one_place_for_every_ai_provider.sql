-- ═══════════════════════════════════════════════════════
-- One place for every AI provider, key and model.
--
-- Until now the five providers ADM-85 named were a constant in code (src/lib/ai/providers.ts), each with exactly
-- one API key (ai.provider_credentials, one row per provider), the same keys were managed in two Admin screens
-- (Settings and Security › Keys), a model was matched to its vendor by the SHAPE of its id, nothing could discover
-- a vendor's models, and nothing recorded whether a provider or a key was healthy.
--
-- This is the data model for the Provider Manager - extending what exists, not beside it:
--
--   • `ai.providers`      every provider the agency uses, built-in or custom, with its adapter kind, base URL, how it
--                         recognises its models, whether the Admin has it enabled, and its runtime HEALTH (separate
--                         from enabled: a disabled provider is an Admin decision, an unhealthy one is a condition).
--   • `ai.provider_keys`  MANY keys per provider, each encrypted with the same AES-256-GCM as the vault (the ciphertext
--                         of the old single keys is carried over unchanged), each with a label, a priority, health, a
--                         cooldown, and a last-4 hint. Nothing here is ever returned to a browser.
--   • `ai.models`         extended, not replaced: enabled/disabled per model, discovered vs manual, last seen, tiers.
--
-- Providers and keys are the AGENCY's (ADM-110: one Anthropic account, one OpenAI account - never a per-tenant billing
-- relationship), so like `ai.provider_credentials` they carry no organization_id and are admin-gated; the routing
-- CONFIGURATION that decides who uses them (models, policies, assignments) stays organization-scoped.
--
-- Every write is a security-definer door that re-checks the role and writes an audit row naming the actor, the object and
-- the change - never a secret. The old single-key table is kept, frozen, as the rollback record.
-- ═══════════════════════════════════════════════════════

-- ── providers ──────────────────────────────────────────────────────────

create table if not exists ai.providers (
  provider_id      text primary key check (provider_id ~ '^[a-z][a-z0-9_-]{1,39}$'),
  kind             text not null check (kind in ('anthropic', 'openai_compat', 'anthropic_compat')),
  display_name     text not null check (length(btrim(display_name)) between 1 and 80),
  is_builtin       boolean not null default false,
  enabled          boolean not null default true,
  -- Where its API lives. https only (plain http is allowed for a loopback host so a local gateway or a test stub works);
  -- the application layer additionally refuses private and link-local addresses before it connects.
  base_url         text not null check (base_url ~ '^https://[^/[:space:]]+' or base_url ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$)'),
  auth_scheme      text not null default 'bearer' check (auth_scheme in ('bearer', 'x-api-key')),
  api_version      text check (api_version is null or length(api_version) <= 40),
  -- How the provider recognises its models. A model matches when its id starts with a prefix OR contains a fragment.
  -- Plain strings, never a pattern: a custom provider's rule can never be a regular-expression bomb.
  match_prefixes   text[] not null default '{}',
  match_contains   text[] not null default '{}',
  -- Non-secret headers only (a referer, a gateway tag). A header that looks like a credential is refused by the door.
  extra_headers    jsonb not null default '{}'::jsonb,
  models_path      text not null default '/models' check (models_path ~ '^/[A-Za-z0-9/_.-]*$'),
  timeout_ms       int not null default 60000 check (timeout_ms between 1000 and 300000),
  retry_max        int not null default 1 check (retry_max between 0 and 3),
  -- Lower is asked first. OpenRouter is last so its slash-ids never claim a model a direct account serves.
  priority         int not null default 100 check (priority between 1 and 1000),
  archived_at      timestamptz,
  -- Runtime condition, never an Admin decision: see ai.record_provider_health.
  health_state     text not null default 'unknown'
                     check (health_state in ('unknown', 'healthy', 'degraded', 'rate_limited', 'quota_exhausted', 'auth_error', 'unavailable')),
  health_detail    text check (health_detail is null or length(health_detail) <= 400),
  health_checked_at timestamptz,
  last_success_at  timestamptz,
  last_failure_at  timestamptz,
  last_latency_ms  int,
  recent_calls     int not null default 0,
  recent_failures  int not null default 0,
  last_model_sync_at     timestamptz,
  last_model_sync_ok     boolean,
  last_model_sync_detail text check (last_model_sync_detail is null or length(last_model_sync_detail) <= 400),
  created_by       uuid references core.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint providers_match_something check (is_builtin or cardinality(match_prefixes) + cardinality(match_contains) > 0)
);

comment on table ai.providers is
  'Every AI provider the agency uses (built-in or custom). enabled is the Admin''s decision; health_state is the runtime condition and is never used to flip enabled. Agency-level, like ai.provider_credentials (ADM-110).';

insert into ai.providers (provider_id, kind, display_name, is_builtin, base_url, auth_scheme, match_prefixes, match_contains, priority, extra_headers) values
  ('anthropic',  'anthropic',     'Anthropic (Claude)', true, 'https://api.anthropic.com',                                  'x-api-key', '{claude-}',                                                             '{}',  10, '{}'::jsonb),
  ('openai',     'openai_compat', 'OpenAI',             true, 'https://api.openai.com/v1',                                  'bearer',    '{gpt-,chatgpt-,o1,o2,o3,o4,o5,o6,o7,o8,o9}',                            '{}',  20, '{}'::jsonb),
  ('gemini',     'openai_compat', 'Google Gemini',      true, 'https://generativelanguage.googleapis.com/v1beta/openai',    'bearer',    '{gemini-}',                                                             '{}',  30, '{}'::jsonb),
  ('xai',        'openai_compat', 'xAI (Grok)',         true, 'https://api.x.ai/v1',                                        'bearer',    '{grok-}',                                                               '{}',  40, '{}'::jsonb),
  ('openrouter', 'openai_compat', 'OpenRouter',         true, 'https://openrouter.ai/api/v1',                               'bearer',    '{}',                                                                    '{/}', 900, '{"HTTP-Referer": "https://agencyos.app", "X-Title": "AgencyOS"}'::jsonb)
on conflict (provider_id) do nothing;

drop trigger if exists providers_updated_at on ai.providers;
create trigger providers_updated_at before update on ai.providers for each row execute function core.set_updated_at();

alter table ai.providers enable row level security;
alter table ai.providers force row level security;
drop policy if exists providers_admin_read on ai.providers;
create policy providers_admin_read on ai.providers for select to authenticated using ((select core.is_admin()));
revoke all on table ai.providers from public, anon, authenticated;
grant select on ai.providers to authenticated, service_role;
grant insert, update on ai.providers to service_role;

-- ── keys ────────────────────────────────────────────────────────────────

create table if not exists ai.provider_keys (
  id               uuid primary key default gen_random_uuid(),
  provider_id      text not null references ai.providers(provider_id),
  label            text not null check (length(btrim(label)) between 1 and 60),
  environment      text not null default 'production' check (environment in ('production', 'test')),
  ciphertext       text not null,
  iv               text not null,
  auth_tag         text not null,
  -- The last four characters, so two keys can be told apart on a screen. Null for a short value.
  hint             text check (hint is null or char_length(hint) <= 4),
  enabled          boolean not null default true,
  -- Lower is tried first.
  priority         int not null default 100 check (priority between 1 and 1000),
  expires_on       date,
  notes            text check (notes is null or length(notes) <= 300),
  health_state     text not null default 'unknown'
                     check (health_state in ('unknown', 'healthy', 'degraded', 'rate_limited', 'quota_exhausted', 'auth_error', 'unavailable')),
  last_used_at     timestamptz,
  last_success_at  timestamptz,
  last_error       text check (last_error is null or length(last_error) <= 400),
  last_error_at    timestamptz,
  consecutive_failures int not null default 0,
  -- A rate-limited key rests until this moment; an auth-failed key is not retried until a person rotates or re-enables it.
  cooldown_until   timestamptz,
  rotated_at       timestamptz,
  created_by       uuid references core.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (provider_id, label)
);

comment on table ai.provider_keys is
  'Many encrypted API keys per provider (AES-256-GCM in code, VAULT_ENCRYPTION_KEY env-only). No policy and no grant for any end-user role: every read of a value is the runtime''s (service role), every write is an ai.* door that audits. Metadata only ever leaves through ai.provider_key_status.';

drop trigger if exists provider_keys_updated_at on ai.provider_keys;
create trigger provider_keys_updated_at before update on ai.provider_keys for each row execute function core.set_updated_at();
create index if not exists provider_keys_provider_idx on ai.provider_keys (provider_id, priority);

alter table ai.provider_keys enable row level security;
alter table ai.provider_keys force row level security;
drop policy if exists provider_keys_service_only on ai.provider_keys;
create policy provider_keys_service_only on ai.provider_keys for all to service_role using (true) with check (true);
revoke all on table ai.provider_keys from public, anon, authenticated;
grant select, insert, update, delete on ai.provider_keys to service_role;

-- ── the legacy single keys come across unchanged, then the old table is frozen ──

insert into ai.provider_keys (provider_id, label, environment, ciphertext, iv, auth_tag, hint, enabled, priority, created_by, created_at)
select c.provider, 'primary', 'production', c.ciphertext, c.iv, c.auth_tag, null, true, 10, c.updated_by, c.created_at
  from ai.provider_credentials c
  join ai.providers p on p.provider_id = c.provider
on conflict (provider_id, label) do nothing;

create or replace function ai.legacy_credentials_are_frozen()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'ai.provider_credentials is frozen: provider keys now live in ai.provider_keys (use the AI Provider Manager)' using errcode = 'P0001';
end;
$$;
drop trigger if exists legacy_credentials_are_frozen on ai.provider_credentials;
create trigger legacy_credentials_are_frozen
  before insert or update or delete on ai.provider_credentials
  for each row execute function ai.legacy_credentials_are_frozen();

comment on table ai.provider_credentials is
  'FROZEN 2026-10-13: the single-key vault. Its rows were carried into ai.provider_keys (label "primary") with the same ciphertext; kept only as the rollback record. Nothing reads or writes it.';

-- ── models: extended, not replaced ──────────────────────────────────────────

alter table ai.models add column if not exists enabled boolean not null default true;
alter table ai.models add column if not exists source text not null default 'manual' check (source in ('manual', 'discovered'));
alter table ai.models add column if not exists display_name text check (display_name is null or length(display_name) <= 120);
alter table ai.models add column if not exists discovered_at timestamptz;
alter table ai.models add column if not exists last_seen_at timestamptz;
alter table ai.models add column if not exists modalities text[] not null default '{}';
alter table ai.models add column if not exists tool_calling boolean;
alter table ai.models add column if not exists structured_output boolean;
-- Tiers are the Admin's, never guessed: null means "not rated".
alter table ai.models add column if not exists quality_tier smallint check (quality_tier is null or quality_tier between 1 and 5);
alter table ai.models add column if not exists latency_tier smallint check (latency_tier is null or latency_tier between 1 and 5);
alter table ai.models add column if not exists cost_tier smallint check (cost_tier is null or cost_tier between 1 and 5);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'models_provider_is_a_provider') then
    alter table ai.models add constraint models_provider_is_a_provider foreign key (provider) references ai.providers(provider_id);
  end if;
end $$;

-- ── who may do what ───────────────────────────────────────────────────────

create or replace function ai._provider_actor(p_need_owner boolean)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then return 'no_actor'; end if;
  if p_need_owner then
    if not coalesce((select core.is_owner()), false) then return 'owner_only'; end if;
  elsif not coalesce((select core.is_admin()), false) then
    return 'forbidden';
  end if;
  return 'ok';
end;
$$;
revoke all on function ai._provider_actor(boolean) from public, anon, authenticated;

-- ── provider doors ─────────────────────────────────────────────────────────

create or replace function ai.upsert_provider(
  p_provider_id text,
  p_kind text,
  p_display_name text,
  p_base_url text,
  p_auth_scheme text,
  p_match_prefixes text[],
  p_match_contains text[],
  p_extra_headers jsonb,
  p_timeout_ms int,
  p_retry_max int,
  p_models_path text,
  p_api_version text,
  p_priority int
)
returns table (outcome text)
-- 'created' | 'updated' | refusals 'no_actor' | 'forbidden' | 'invalid' | 'secret_in_headers' | 'reserved'
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := ai._provider_actor(false);
  v_org   uuid := (select core.current_organization_id());
  v_id    text := lower(btrim(coalesce(p_provider_id, '')));
  v_old   ai.providers;
  v_new   boolean;
begin
  if v_actor <> 'ok' then return query select v_actor; return; end if;
  if v_id !~ '^[a-z][a-z0-9_-]{1,39}$' then return query select 'invalid'::text; return; end if;
  -- A header that looks like a credential belongs in a key, never in a plain column.
  if exists (select 1 from jsonb_object_keys(coalesce(p_extra_headers, '{}'::jsonb)) k where lower(k) in ('authorization', 'x-api-key', 'api-key', 'cookie', 'proxy-authorization')) then
    return query select 'secret_in_headers'::text; return;
  end if;

  select * into v_old from ai.providers where provider_id = v_id for update;
  v_new := v_old.provider_id is null;

  if v_new then
    insert into ai.providers (provider_id, kind, display_name, is_builtin, base_url, auth_scheme, match_prefixes, match_contains, extra_headers,
                              models_path, timeout_ms, retry_max, api_version, priority, created_by)
    values (v_id, p_kind, btrim(p_display_name), false, btrim(p_base_url), coalesce(p_auth_scheme, 'bearer'),
            coalesce(p_match_prefixes, '{}'), coalesce(p_match_contains, '{}'), coalesce(p_extra_headers, '{}'::jsonb),
            coalesce(nullif(btrim(p_models_path), ''), '/models'), coalesce(p_timeout_ms, 60000), coalesce(p_retry_max, 1),
            nullif(btrim(coalesce(p_api_version, '')), ''), coalesce(p_priority, 100), (select auth.uid()));
  else
    -- A built-in keeps its kind and its model matching (code relies on them); everything operational is editable.
    update ai.providers
       set display_name = btrim(p_display_name),
           base_url = btrim(p_base_url),
           auth_scheme = case when v_old.is_builtin then v_old.auth_scheme else coalesce(p_auth_scheme, v_old.auth_scheme) end,
           kind = case when v_old.is_builtin then v_old.kind else p_kind end,
           match_prefixes = case when v_old.is_builtin then v_old.match_prefixes else coalesce(p_match_prefixes, '{}') end,
           match_contains = case when v_old.is_builtin then v_old.match_contains else coalesce(p_match_contains, '{}') end,
           extra_headers = coalesce(p_extra_headers, v_old.extra_headers),
           models_path = coalesce(nullif(btrim(p_models_path), ''), v_old.models_path),
           timeout_ms = coalesce(p_timeout_ms, v_old.timeout_ms),
           retry_max = coalesce(p_retry_max, v_old.retry_max),
           api_version = nullif(btrim(coalesce(p_api_version, '')), ''),
           priority = coalesce(p_priority, v_old.priority)
     where provider_id = v_id;
  end if;

  perform core.record_audit(v_org, case when v_new then 'ai_provider.created' else 'ai_provider.updated' end, 'ai_provider', null,
    case when v_new then null else jsonb_build_object('provider', v_id, 'base_url', v_old.base_url, 'enabled', v_old.enabled, 'priority', v_old.priority) end,
    jsonb_build_object('provider', v_id, 'kind', p_kind, 'base_url', btrim(p_base_url), 'priority', coalesce(p_priority, 100)));
  return query select case when v_new then 'created' else 'updated' end::text;
exception when check_violation then
  return query select 'invalid'::text;
end;
$$;
revoke all on function ai.upsert_provider(text, text, text, text, text, text[], text[], jsonb, int, int, text, text, int) from public, anon;
grant execute on function ai.upsert_provider(text, text, text, text, text, text[], text[], jsonb, int, int, text, text, int) to authenticated;

create or replace function ai.set_provider_enabled(p_provider_id text, p_enabled boolean, p_reason text default null)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := ai._provider_actor(false);
  v_org   uuid := (select core.current_organization_id());
  v_old   ai.providers;
begin
  if v_actor <> 'ok' then return query select v_actor; return; end if;
  select * into v_old from ai.providers where provider_id = p_provider_id for update;
  if v_old.provider_id is null then return query select 'unknown_provider'::text; return; end if;
  if v_old.archived_at is not null and p_enabled then return query select 'archived'::text; return; end if;
  -- Turning a provider OFF stops every agent routed to it: a reason is part of the record.
  if not p_enabled and length(btrim(coalesce(p_reason, ''))) = 0 then return query select 'needs_reason'::text; return; end if;
  update ai.providers set enabled = p_enabled where provider_id = p_provider_id;
  perform core.record_audit(v_org, case when p_enabled then 'ai_provider.enabled' else 'ai_provider.disabled' end, 'ai_provider', null,
    jsonb_build_object('provider', p_provider_id, 'enabled', v_old.enabled), jsonb_build_object('provider', p_provider_id, 'enabled', p_enabled, 'reason', left(p_reason, 300)));
  return query select case when p_enabled then 'enabled' else 'disabled' end::text;
end;
$$;
revoke all on function ai.set_provider_enabled(text, boolean, text) from public, anon;
grant execute on function ai.set_provider_enabled(text, boolean, text) to authenticated;

create or replace function ai.archive_provider(p_provider_id text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := ai._provider_actor(true);
  v_org   uuid := (select core.current_organization_id());
begin
  if v_actor <> 'ok' then return query select v_actor; return; end if;
  update ai.providers set archived_at = now(), enabled = false where provider_id = p_provider_id and archived_at is null;
  if not found then return query select 'unknown_provider'::text; return; end if;
  update ai.provider_keys set enabled = false where provider_id = p_provider_id;
  perform core.record_audit(v_org, 'ai_provider.archived', 'ai_provider', null, null, jsonb_build_object('provider', p_provider_id));
  return query select 'archived'::text;
end;
$$;
revoke all on function ai.archive_provider(text) from public, anon;
grant execute on function ai.archive_provider(text) to authenticated;

-- Permanent deletion only for a custom provider nothing ever used: history is kept, never orphaned.
create or replace function ai.delete_provider(p_provider_id text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := ai._provider_actor(true);
  v_org   uuid := (select core.current_organization_id());
  v_p     ai.providers;
begin
  if v_actor <> 'ok' then return query select v_actor; return; end if;
  select * into v_p from ai.providers where provider_id = p_provider_id for update;
  if v_p.provider_id is null then return query select 'unknown_provider'::text; return; end if;
  if v_p.is_builtin then return query select 'builtin'::text; return; end if;
  if exists (select 1 from ai.models m where m.provider = p_provider_id)
     or exists (select 1 from ai.agent_steps s where s.request->>'provider' = p_provider_id limit 1) then
    return query select 'has_history'::text; return;
  end if;
  delete from ai.provider_keys where provider_id = p_provider_id;
  delete from ai.providers where provider_id = p_provider_id;
  perform core.record_audit(v_org, 'ai_provider.deleted', 'ai_provider', null, jsonb_build_object('provider', p_provider_id, 'base_url', v_p.base_url), null);
  return query select 'deleted'::text;
end;
$$;
revoke all on function ai.delete_provider(text) from public, anon;
grant execute on function ai.delete_provider(text) to authenticated;

-- ── key doors ───────────────────────────────────────────────────────────────

create or replace function ai.add_provider_key(
  p_provider_id text, p_label text, p_environment text,
  p_ciphertext text, p_iv text, p_auth_tag text, p_hint text, p_priority int
)
returns table (outcome text, key_id uuid)
-- 'added' | refusals 'no_actor' | 'forbidden' | 'unknown_provider' | 'invalid' | 'label_taken'
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := ai._provider_actor(false);
  v_org   uuid := (select core.current_organization_id());
  v_id    uuid;
begin
  if v_actor <> 'ok' then return query select v_actor, null::uuid; return; end if;
  if not exists (select 1 from ai.providers where provider_id = p_provider_id and archived_at is null) then
    return query select 'unknown_provider'::text, null::uuid; return;
  end if;
  if nullif(btrim(coalesce(p_ciphertext, '')), '') is null or nullif(btrim(coalesce(p_iv, '')), '') is null or nullif(btrim(coalesce(p_auth_tag, '')), '') is null then
    return query select 'invalid'::text, null::uuid; return;
  end if;
  if exists (select 1 from ai.provider_keys where provider_id = p_provider_id and label = btrim(p_label)) then
    return query select 'label_taken'::text, null::uuid; return;
  end if;
  insert into ai.provider_keys (provider_id, label, environment, ciphertext, iv, auth_tag, hint, priority, created_by)
  values (p_provider_id, btrim(p_label), coalesce(p_environment, 'production'), p_ciphertext, p_iv, p_auth_tag, nullif(btrim(coalesce(p_hint, '')), ''), coalesce(p_priority, 100), (select auth.uid()))
  returning id into v_id;
  perform core.record_audit(v_org, 'ai_provider_key.added', 'ai_provider_key', v_id, null,
    jsonb_build_object('provider', p_provider_id, 'label', btrim(p_label), 'environment', coalesce(p_environment, 'production'), 'hint', nullif(btrim(coalesce(p_hint, '')), '')));
  return query select 'added'::text, v_id;
exception when check_violation then
  return query select 'invalid'::text, null::uuid;
end;
$$;
revoke all on function ai.add_provider_key(text, text, text, text, text, text, text, int) from public, anon;
grant execute on function ai.add_provider_key(text, text, text, text, text, text, text, int) to authenticated;

create or replace function ai.rotate_provider_key(p_key_id uuid, p_ciphertext text, p_iv text, p_auth_tag text, p_hint text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := ai._provider_actor(false);
  v_org   uuid := (select core.current_organization_id());
  v_k     ai.provider_keys;
begin
  if v_actor <> 'ok' then return query select v_actor; return; end if;
  if nullif(btrim(coalesce(p_ciphertext, '')), '') is null or nullif(btrim(coalesce(p_iv, '')), '') is null or nullif(btrim(coalesce(p_auth_tag, '')), '') is null then
    return query select 'invalid'::text; return;
  end if;
  select * into v_k from ai.provider_keys where id = p_key_id for update;
  if v_k.id is null then return query select 'unknown_key'::text; return; end if;
  -- A new value starts fresh: whatever condition the old one was in says nothing about it.
  update ai.provider_keys
     set ciphertext = p_ciphertext, iv = p_iv, auth_tag = p_auth_tag, hint = nullif(btrim(coalesce(p_hint, '')), ''),
         rotated_at = now(), health_state = 'unknown', consecutive_failures = 0, cooldown_until = null, last_error = null, last_error_at = null, enabled = true
   where id = p_key_id;
  perform core.record_audit(v_org, 'ai_provider_key.rotated', 'ai_provider_key', p_key_id,
    jsonb_build_object('provider', v_k.provider_id, 'label', v_k.label, 'hint', v_k.hint), jsonb_build_object('provider', v_k.provider_id, 'label', v_k.label, 'hint', nullif(btrim(coalesce(p_hint, '')), '')));
  return query select 'rotated'::text;
end;
$$;
revoke all on function ai.rotate_provider_key(uuid, text, text, text, text) from public, anon;
grant execute on function ai.rotate_provider_key(uuid, text, text, text, text) to authenticated;

create or replace function ai.set_provider_key_state(p_key_id uuid, p_enabled boolean, p_priority int default null)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := ai._provider_actor(false);
  v_org   uuid := (select core.current_organization_id());
  v_k     ai.provider_keys;
begin
  if v_actor <> 'ok' then return query select v_actor; return; end if;
  select * into v_k from ai.provider_keys where id = p_key_id for update;
  if v_k.id is null then return query select 'unknown_key'::text; return; end if;
  update ai.provider_keys
     set enabled = p_enabled, priority = coalesce(p_priority, priority),
         -- Re-enabling is a person's decision to try it again: clear the auth stop and any cooldown.
         health_state = case when p_enabled and not v_k.enabled then 'unknown' else health_state end,
         consecutive_failures = case when p_enabled and not v_k.enabled then 0 else consecutive_failures end,
         cooldown_until = case when p_enabled and not v_k.enabled then null else cooldown_until end
   where id = p_key_id;
  perform core.record_audit(v_org, case when p_enabled then 'ai_provider_key.enabled' else 'ai_provider_key.disabled' end, 'ai_provider_key', p_key_id,
    jsonb_build_object('provider', v_k.provider_id, 'label', v_k.label, 'enabled', v_k.enabled, 'priority', v_k.priority),
    jsonb_build_object('provider', v_k.provider_id, 'label', v_k.label, 'enabled', p_enabled, 'priority', coalesce(p_priority, v_k.priority)));
  return query select 'saved'::text;
end;
$$;
revoke all on function ai.set_provider_key_state(uuid, boolean, int) from public, anon;
grant execute on function ai.set_provider_key_state(uuid, boolean, int) to authenticated;

create or replace function ai.remove_provider_key(p_key_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := ai._provider_actor(true);
  v_org   uuid := (select core.current_organization_id());
  v_k     ai.provider_keys;
begin
  if v_actor <> 'ok' then return query select v_actor; return; end if;
  select * into v_k from ai.provider_keys where id = p_key_id for update;
  if v_k.id is null then return query select 'unknown_key'::text; return; end if;
  delete from ai.provider_keys where id = p_key_id;
  perform core.record_audit(v_org, 'ai_provider_key.removed', 'ai_provider_key', p_key_id,
    jsonb_build_object('provider', v_k.provider_id, 'label', v_k.label, 'hint', v_k.hint, 'created_by', v_k.created_by), null);
  return query select 'removed'::text;
end;
$$;
revoke all on function ai.remove_provider_key(uuid) from public, anon;
grant execute on function ai.remove_provider_key(uuid) to authenticated;

-- What a screen may show about a key: everything except the secret.
create or replace function ai.provider_key_status(p_provider_id text default null)
returns table (
  id uuid, provider_id text, label text, environment text, hint text, enabled boolean, priority int, expires_on date, notes text,
  health_state text, last_used_at timestamptz, last_success_at timestamptz, last_error text, last_error_at timestamptz,
  consecutive_failures int, cooldown_until timestamptz, rotated_at timestamptz, created_at timestamptz, created_by_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select k.id, k.provider_id, k.label, k.environment, k.hint, k.enabled, k.priority, k.expires_on, k.notes, k.health_state, k.last_used_at,
         k.last_success_at, k.last_error, k.last_error_at, k.consecutive_failures, k.cooldown_until, k.rotated_at, k.created_at,
         coalesce(u.full_name, u.email)
    from ai.provider_keys k
    left join core.users u on u.id = k.created_by
   where coalesce((select core.is_admin()), false)
     and (p_provider_id is null or k.provider_id = p_provider_id)
   order by k.provider_id, k.priority, k.label;
$$;
revoke all on function ai.provider_key_status(text) from public, anon;
grant execute on function ai.provider_key_status(text) to authenticated;

-- ── the runtime reports what happened (service role only) ──────────────────

create or replace function ai.record_key_outcome(p_key_id uuid, p_ok boolean, p_error text, p_kind text, p_cooldown_seconds int)
returns table (outcome text)
-- p_kind: 'ok' | 'auth' | 'rate_limit' | 'quota' | 'unavailable' | 'other'
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_ok then
    update ai.provider_keys set last_used_at = now(), last_success_at = now(), health_state = 'healthy', consecutive_failures = 0, cooldown_until = null, last_error = null
     where id = p_key_id;
  else
    update ai.provider_keys
       set last_used_at = now(), last_error = left(p_error, 400), last_error_at = now(), consecutive_failures = consecutive_failures + 1,
           health_state = case p_kind when 'auth' then 'auth_error' when 'rate_limit' then 'rate_limited' when 'quota' then 'quota_exhausted' when 'unavailable' then 'unavailable' else 'degraded' end,
           -- An auth failure is not retried until a person acts (enabled stays true so the Admin sees it; the runtime skips auth_error keys).
           cooldown_until = case when p_kind in ('rate_limit', 'quota', 'unavailable') then now() + make_interval(secs => greatest(5, least(coalesce(p_cooldown_seconds, 60), 86400))) else cooldown_until end
     where id = p_key_id;
  end if;
  return query select 'recorded'::text;
end;
$$;
revoke all on function ai.record_key_outcome(uuid, boolean, text, text, int) from public, anon, authenticated;
grant execute on function ai.record_key_outcome(uuid, boolean, text, text, int) to service_role;

create or replace function ai.record_provider_health(p_provider_id text, p_state text, p_detail text, p_latency_ms int, p_counted boolean default true)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update ai.providers
     set health_state = p_state, health_detail = left(p_detail, 400), health_checked_at = now(), last_latency_ms = coalesce(p_latency_ms, last_latency_ms),
         last_success_at = case when p_state = 'healthy' then now() else last_success_at end,
         last_failure_at = case when p_state not in ('healthy', 'unknown') then now() else last_failure_at end,
         recent_calls = case when p_counted then least(recent_calls + 1, 1000) else recent_calls end,
         recent_failures = case when p_counted and p_state not in ('healthy', 'unknown') then least(recent_failures + 1, 1000) else recent_failures end
   where provider_id = p_provider_id;
  return query select 'recorded'::text;
end;
$$;
revoke all on function ai.record_provider_health(text, text, text, int, boolean) from public, anon, authenticated;
grant execute on function ai.record_provider_health(text, text, text, int, boolean) to service_role;

create or replace function ai.record_model_sync(p_provider_id text, p_ok boolean, p_detail text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update ai.providers set last_model_sync_at = now(), last_model_sync_ok = p_ok, last_model_sync_detail = left(p_detail, 400) where provider_id = p_provider_id;
  return query select 'recorded'::text;
end;
$$;
revoke all on function ai.record_model_sync(text, boolean, text) from public, anon, authenticated;
grant execute on function ai.record_model_sync(text, boolean, text) to service_role;

-- ── model doors (organization-scoped: it is each organization's registry) ──

create or replace function ai.set_model_enabled(p_model_id text, p_enabled boolean)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := ai._provider_actor(false);
  v_org   uuid := (select core.current_organization_id());
  v_m     ai.models;
begin
  if v_actor <> 'ok' then return query select v_actor; return; end if;
  select * into v_m from ai.models where organization_id = v_org and model_id = p_model_id for update;
  if v_m.model_id is null then return query select 'unknown_model'::text; return; end if;
  update ai.models set enabled = p_enabled where organization_id = v_org and model_id = p_model_id;
  perform core.record_audit(v_org, case when p_enabled then 'ai_model.enabled' else 'ai_model.disabled' end, 'ai_model', null,
    jsonb_build_object('model', p_model_id, 'enabled', v_m.enabled), jsonb_build_object('model', p_model_id, 'enabled', p_enabled));
  return query select case when p_enabled then 'enabled' else 'disabled' end::text;
end;
$$;
revoke all on function ai.set_model_enabled(text, boolean) from public, anon;
grant execute on function ai.set_model_enabled(text, boolean) to authenticated;

-- A model the Admin registers by hand (the vendor has no usable /models endpoint).
create or replace function ai.register_manual_model(
  p_provider_id text, p_model_id text, p_display_name text, p_capabilities text[],
  p_context_tokens int, p_tool_calling boolean, p_structured_output boolean
)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := ai._provider_actor(false);
  v_org   uuid := (select core.current_organization_id());
begin
  if v_actor <> 'ok' then return query select v_actor; return; end if;
  if not exists (select 1 from ai.providers where provider_id = p_provider_id and archived_at is null) then return query select 'unknown_provider'::text; return; end if;
  if length(btrim(coalesce(p_model_id, ''))) = 0 or length(p_model_id) > 200 then return query select 'invalid'::text; return; end if;
  insert into ai.models (organization_id, model_id, provider, capabilities, context_tokens, status, enabled, source, display_name, tool_calling, structured_output)
  values (v_org, btrim(p_model_id), p_provider_id, coalesce(p_capabilities, '{}'), p_context_tokens, 'available', true, 'manual', nullif(btrim(coalesce(p_display_name, '')), ''), p_tool_calling, p_structured_output)
  on conflict (organization_id, model_id) do update
     set provider = excluded.provider, capabilities = excluded.capabilities, context_tokens = excluded.context_tokens, display_name = excluded.display_name,
         tool_calling = excluded.tool_calling, structured_output = excluded.structured_output, status = 'available', source = 'manual';
  perform core.record_audit(v_org, 'ai_model.registered', 'ai_model', null, null, jsonb_build_object('model', btrim(p_model_id), 'provider', p_provider_id, 'source', 'manual'));
  return query select 'registered'::text;
exception when check_violation then
  return query select 'invalid'::text;
end;
$$;
revoke all on function ai.register_manual_model(text, text, text, text[], int, boolean, boolean) from public, anon;
grant execute on function ai.register_manual_model(text, text, text, text[], int, boolean, boolean) to authenticated;

-- What discovery found. Upserts; a model that disappears is marked deprecated, never deleted (history keeps its id).
create or replace function ai.record_discovered_models(p_provider_id text, p_models jsonb)
returns table (outcome text, added int, refreshed int, gone int)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := ai._provider_actor(false);
  v_org   uuid := (select core.current_organization_id());
  m       jsonb;
  v_id    text;
  v_added int := 0; v_refreshed int := 0; v_gone int;
  v_seen  text[] := '{}';
begin
  if v_actor <> 'ok' then return query select v_actor, 0, 0, 0; return; end if;
  if not exists (select 1 from ai.providers where provider_id = p_provider_id) then return query select 'unknown_provider'::text, 0, 0, 0; return; end if;
  if jsonb_typeof(p_models) <> 'array' or jsonb_array_length(p_models) > 2000 then return query select 'invalid'::text, 0, 0, 0; return; end if;

  for m in select * from jsonb_array_elements(p_models) loop
    v_id := btrim(coalesce(m->>'id', ''));
    if v_id = '' or length(v_id) > 200 then continue; end if;
    v_seen := v_seen || v_id;
    if exists (select 1 from ai.models x where x.organization_id = v_org and x.model_id = v_id) then
      -- Never overwrite what an Admin set by hand (enabled, tiers, prices, a manual registration's own metadata).
      update ai.models
         set last_seen_at = now(),
             status = case when status = 'deprecated' and source = 'discovered' then 'available' else status end,
             context_tokens = coalesce(context_tokens, nullif(m->>'contextTokens', '')::int),
             display_name = coalesce(display_name, nullif(m->>'displayName', ''))
       where organization_id = v_org and model_id = v_id and provider = p_provider_id;
      v_refreshed := v_refreshed + 1;
    else
      -- New models arrive DISABLED: the Admin chooses what becomes routable. Nothing a vendor lists is routed to by itself.
      insert into ai.models (organization_id, model_id, provider, capabilities, context_tokens, status, enabled, source, display_name, discovered_at, last_seen_at)
      values (v_org, v_id, p_provider_id, '{}', nullif(m->>'contextTokens', '')::int, 'available', false, 'discovered', nullif(m->>'displayName', ''), now(), now())
      on conflict (organization_id, model_id) do nothing;
      v_added := v_added + 1;
    end if;
  end loop;

  update ai.models set status = 'deprecated'
   where organization_id = v_org and provider = p_provider_id and source = 'discovered' and status = 'available' and not (model_id = any (v_seen));
  get diagnostics v_gone = row_count;

  perform core.record_audit(v_org, 'ai_model.discovery_recorded', 'ai_provider', null, null, jsonb_build_object('provider', p_provider_id, 'added', v_added, 'refreshed', v_refreshed, 'gone', v_gone));
  return query select 'recorded'::text, v_added, v_refreshed, v_gone;
end;
$$;
revoke all on function ai.record_discovered_models(text, jsonb) from public, anon;
grant execute on function ai.record_discovered_models(text, jsonb) to authenticated;

-- ── the old doors now speak to the new store ─────────────────────────────

create or replace function ai.provider_credential_status()
returns table (provider text, configured boolean, updated_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select p.provider_id, exists (select 1 from ai.provider_keys k where k.provider_id = p.provider_id and k.enabled), max(k.updated_at)
    from ai.providers p
    left join ai.provider_keys k on k.provider_id = p.provider_id
   where coalesce((select core.is_admin()), false)
   group by p.provider_id
   order by p.provider_id;
$$;

create or replace function ai.revoke_provider_credential(p_provider text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := ai._provider_actor(true);
  v_org   uuid := (select core.current_organization_id());
  v_k     ai.provider_keys;
begin
  if v_actor <> 'ok' then return query select case v_actor when 'owner_only' then 'not_authorized' else v_actor end; return; end if;
  -- The legacy "revoke the stored key" means the key labelled primary.
  select * into v_k from ai.provider_keys where provider_id = p_provider and label = 'primary' for update;
  if v_k.id is null then return query select 'not_found'::text; return; end if;
  delete from ai.provider_keys where id = v_k.id;
  perform core.record_audit(v_org, 'provider_credential.revoked', 'provider_credential', null,
    jsonb_build_object('provider', p_provider, 'updated_by', v_k.created_by, 'updated_at', v_k.updated_at), jsonb_build_object('provider', p_provider, 'configured', false));
  return query select 'revoked'::text;
end;
$$;

notify pgrst, 'reload schema';
