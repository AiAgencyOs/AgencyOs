-- ═══════════════════════════════════════════════════════
-- Routing is a mode, and every decision is recorded.
--
-- Until now which model an agent ran on was a rule baked into the runner (override, policy, chain, default) with no switch, no
-- explanation and no record of what actually ran: `ai.agent_runs.model` was the agent's DEFAULT, whatever model answered, and the
-- provider was only in a step's JSON. This adds the three missing things:
--
--   • a MODE per organization - AUTO (the orchestrator chooses among what the Admin allowed) or MANUAL (the Admin names the exact
--     provider and model per agent, and nothing substitutes). Changing it is the owner's, needs a reason, and is versioned.
--   • per-agent ASSIGNMENTS (provider + model + up to three explicit fallbacks). They are KEPT when the mode is AUTO and come back
--     when it returns to MANUAL: switching modes never deletes a decision.
--   • a ROUTING DECISION row for every run: which mode and configuration version applied, what was considered and why a candidate
--     was excluded, which provider and model served it, each attempt, whether a fallback was used, and the outcome. The run row now
--     records the provider and the model that ACTUALLY ran.
--
-- Nothing here holds a secret. The doors are owner-only (routing is how money is spent and where client text goes) and audited.
-- ═══════════════════════════════════════════════════════

create table if not exists ai.routing_settings (
  organization_id uuid primary key references core.organizations(id) on delete cascade,
  mode            text not null default 'auto' check (mode in ('auto', 'manual')),
  -- Bumped on every change to the mode OR to any assignment, so a decision can say which configuration it ran under.
  version         int not null default 1,
  reason          text check (reason is null or length(reason) <= 500),
  changed_by      uuid references core.users(id),
  changed_at      timestamptz not null default now()
);

comment on table ai.routing_settings is
  'The routing mode per organization. AUTO: the orchestrator picks among the providers and models the Admin enabled. MANUAL: the Admin''s per-agent assignments are honoured exactly and nothing substitutes. Default AUTO, so a tenant that sets nothing runs as before.';

alter table ai.routing_settings enable row level security;
alter table ai.routing_settings force row level security;
drop policy if exists routing_settings_admin_read on ai.routing_settings;
create policy routing_settings_admin_read on ai.routing_settings for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_admin()));
revoke all on table ai.routing_settings from public, anon, authenticated;
grant select on ai.routing_settings to authenticated, service_role;
grant insert, update on ai.routing_settings to service_role;
create trigger freeze_org_routing_settings before update of organization_id on ai.routing_settings for each row execute function core.freeze_organization_id();

create table if not exists ai.agent_model_assignments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  agent_key       text not null references ai.agents(key),
  provider_id     text not null references ai.providers(provider_id),
  model_id        text not null check (length(btrim(model_id)) between 1 and 200),
  -- Explicit fallbacks only: [{"providerId": "...", "modelId": "..."}], at most three. No fallback configured = no substitution.
  fallbacks       jsonb not null default '[]'::jsonb check (jsonb_typeof(fallbacks) = 'array' and jsonb_array_length(fallbacks) <= 3),
  note            text check (note is null or length(note) <= 300),
  set_by          uuid references core.users(id),
  updated_at      timestamptz not null default now(),
  unique (organization_id, agent_key)
);

comment on table ai.agent_model_assignments is
  'MANUAL mode: this agent runs on exactly this provider and model, and on its explicit fallbacks only. Kept (not deleted) when the mode is AUTO.';

alter table ai.agent_model_assignments enable row level security;
alter table ai.agent_model_assignments force row level security;
drop policy if exists agent_assignments_admin_read on ai.agent_model_assignments;
create policy agent_assignments_admin_read on ai.agent_model_assignments for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_admin()));
revoke all on table ai.agent_model_assignments from public, anon, authenticated;
grant select on ai.agent_model_assignments to authenticated, service_role;
grant insert, update, delete on ai.agent_model_assignments to service_role;
create trigger freeze_org_agent_assignments before update of organization_id on ai.agent_model_assignments for each row execute function core.freeze_organization_id();

-- ── one decision row per run ────────────────────────────────────────────────

create table if not exists ai.routing_decisions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  job_id           uuid,
  run_id           uuid,
  agent_key        text not null,
  work_class       text,
  category         text,
  mode             text not null check (mode in ('auto', 'manual')),
  config_version   int not null,
  -- What the plan was: candidates in order with the reason each was chosen, and what was excluded and why. No secret, ever.
  plan             jsonb not null default '{}'::jsonb,
  attempts         jsonb not null default '[]'::jsonb,
  provider_id      text,
  model_id         text,
  selection_source text,
  fallback_used    boolean not null default false,
  outcome          text not null check (outcome in ('succeeded', 'failed', 'blocked', 'exhausted')),
  blocked_reason   text check (blocked_reason is null or length(blocked_reason) <= 500),
  created_at       timestamptz not null default now()
);

comment on table ai.routing_decisions is
  'Why a run used the provider and model it did: the mode and configuration version, what was considered and excluded, each attempt, whether a fallback served it, and the outcome. Answers "why this provider, why this model, was it AUTO or MANUAL, was fallback used" without reading a log.';

create index if not exists routing_decisions_org_idx on ai.routing_decisions (organization_id, created_at desc);
create index if not exists routing_decisions_agent_idx on ai.routing_decisions (organization_id, agent_key, created_at desc);

alter table ai.routing_decisions enable row level security;
alter table ai.routing_decisions force row level security;
drop policy if exists routing_decisions_admin_read on ai.routing_decisions;
create policy routing_decisions_admin_read on ai.routing_decisions for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_admin()));
revoke all on table ai.routing_decisions from public, anon, authenticated;
grant select on ai.routing_decisions to authenticated, service_role;
grant insert on ai.routing_decisions to service_role;
create trigger freeze_org_routing_decisions before update of organization_id on ai.routing_decisions for each row execute function core.freeze_organization_id();

create or replace function ai.routing_decisions_are_history()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'a routing decision is history and cannot be edited or removed' using errcode = 'P0001';
end;
$$;
drop trigger if exists routing_decisions_are_history on ai.routing_decisions;
create trigger routing_decisions_are_history before update or delete on ai.routing_decisions for each row execute function ai.routing_decisions_are_history();

-- The run records what actually ran.
alter table ai.agent_runs add column if not exists provider_id text;
alter table ai.agent_runs add column if not exists routing_mode text check (routing_mode is null or routing_mode in ('auto', 'manual'));
alter table ai.agent_runs add column if not exists routing_decision_id uuid;

-- ── doors (owner only: routing decides where client text goes and what is spent) ──

create or replace function ai.set_routing_mode(p_mode text, p_reason text)
returns table (outcome text, version int)
-- 'changed' | 'unchanged' | refusals 'no_actor' | 'owner_only' | 'bad_mode' | 'needs_reason'
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := ai._provider_actor(true);
  v_org   uuid := (select core.current_organization_id());
  v_old   ai.routing_settings;
  v_ver   int;
begin
  if v_actor <> 'ok' then return query select v_actor, null::int; return; end if;
  if p_mode not in ('auto', 'manual') then return query select 'bad_mode'::text, null::int; return; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then return query select 'needs_reason'::text, null::int; return; end if;
  select * into v_old from ai.routing_settings where organization_id = v_org for update;
  if v_old.organization_id is not null and v_old.mode = p_mode then return query select 'unchanged'::text, v_old.version; return; end if;
  v_ver := coalesce(v_old.version, 0) + 1;
  insert into ai.routing_settings (organization_id, mode, version, reason, changed_by, changed_at)
  values (v_org, p_mode, v_ver, left(btrim(p_reason), 500), (select auth.uid()), now())
  on conflict (organization_id) do update set mode = excluded.mode, version = excluded.version, reason = excluded.reason, changed_by = excluded.changed_by, changed_at = excluded.changed_at;
  perform core.record_audit(v_org, 'ai_routing.mode_changed', 'ai_routing', null,
    jsonb_build_object('mode', coalesce(v_old.mode, 'auto'), 'version', v_old.version), jsonb_build_object('mode', p_mode, 'version', v_ver, 'reason', left(p_reason, 300)));
  return query select 'changed'::text, v_ver;
end;
$$;
revoke all on function ai.set_routing_mode(text, text) from public, anon;
grant execute on function ai.set_routing_mode(text, text) to authenticated;

create or replace function ai._assignment_target_ok(p_org uuid, p_provider text, p_model text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_m ai.models;
begin
  if not exists (select 1 from ai.providers where provider_id = p_provider and archived_at is null) then return 'unknown_provider'; end if;
  select * into v_m from ai.models where organization_id = p_org and model_id = p_model;
  if v_m.model_id is null then return 'unknown_model'; end if;
  if v_m.provider <> p_provider then return 'provider_mismatch'; end if;
  -- MANUAL mode may only select a model the Admin has enabled and the vendor still serves.
  if not v_m.enabled or v_m.status <> 'available' then return 'model_not_enabled'; end if;
  return 'ok';
end;
$$;
revoke all on function ai._assignment_target_ok(uuid, text, text) from public, anon, authenticated;

create or replace function ai.set_agent_assignment(p_agent_key text, p_provider_id text, p_model_id text, p_fallbacks jsonb, p_note text default null)
returns table (outcome text, detail text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := ai._provider_actor(true);
  v_org   uuid := (select core.current_organization_id());
  v_ok    text;
  f       jsonb;
  v_old   ai.agent_model_assignments;
  v_ver   int;
begin
  if v_actor <> 'ok' then return query select v_actor, null::text; return; end if;
  if not exists (select 1 from ai.agents where key = p_agent_key) then return query select 'unknown_agent'::text, null::text; return; end if;
  v_ok := ai._assignment_target_ok(v_org, p_provider_id, btrim(p_model_id));
  if v_ok <> 'ok' then return query select v_ok, 'primary'::text; return; end if;
  if jsonb_typeof(coalesce(p_fallbacks, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_fallbacks, '[]'::jsonb)) > 3 then
    return query select 'too_many_fallbacks'::text, null::text; return;
  end if;
  for f in select * from jsonb_array_elements(coalesce(p_fallbacks, '[]'::jsonb)) loop
    v_ok := ai._assignment_target_ok(v_org, f->>'providerId', f->>'modelId');
    if v_ok <> 'ok' then return query select v_ok, 'fallback ' || coalesce(f->>'modelId', '?'); return; end if;
  end loop;

  select * into v_old from ai.agent_model_assignments where organization_id = v_org and agent_key = p_agent_key;
  insert into ai.agent_model_assignments (organization_id, agent_key, provider_id, model_id, fallbacks, note, set_by, updated_at)
  values (v_org, p_agent_key, p_provider_id, btrim(p_model_id), coalesce(p_fallbacks, '[]'::jsonb), left(p_note, 300), (select auth.uid()), now())
  on conflict (organization_id, agent_key) do update
     set provider_id = excluded.provider_id, model_id = excluded.model_id, fallbacks = excluded.fallbacks, note = excluded.note, set_by = excluded.set_by, updated_at = now();
  -- The configuration changed, so the version a decision can cite changes.
  insert into ai.routing_settings (organization_id, mode, version, changed_by, changed_at) values (v_org, 'auto', 2, (select auth.uid()), now())
  on conflict (organization_id) do update set version = ai.routing_settings.version + 1, changed_by = (select auth.uid()), changed_at = now()
  returning version into v_ver;
  perform core.record_audit(v_org, 'ai_routing.assignment_set', 'ai_routing', null,
    case when v_old.id is null then null else jsonb_build_object('agent', p_agent_key, 'provider', v_old.provider_id, 'model', v_old.model_id, 'fallbacks', v_old.fallbacks) end,
    jsonb_build_object('agent', p_agent_key, 'provider', p_provider_id, 'model', btrim(p_model_id), 'fallbacks', coalesce(p_fallbacks, '[]'::jsonb), 'version', v_ver));
  return query select 'saved'::text, null::text;
end;
$$;
revoke all on function ai.set_agent_assignment(text, text, text, jsonb, text) from public, anon;
grant execute on function ai.set_agent_assignment(text, text, text, jsonb, text) to authenticated;

create or replace function ai.clear_agent_assignment(p_agent_key text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := ai._provider_actor(true);
  v_org   uuid := (select core.current_organization_id());
  v_old   ai.agent_model_assignments;
begin
  if v_actor <> 'ok' then return query select v_actor; return; end if;
  select * into v_old from ai.agent_model_assignments where organization_id = v_org and agent_key = p_agent_key for update;
  if v_old.id is null then return query select 'none'::text; return; end if;
  delete from ai.agent_model_assignments where id = v_old.id;
  update ai.routing_settings set version = version + 1, changed_by = (select auth.uid()), changed_at = now() where organization_id = v_org;
  perform core.record_audit(v_org, 'ai_routing.assignment_cleared', 'ai_routing', null,
    jsonb_build_object('agent', p_agent_key, 'provider', v_old.provider_id, 'model', v_old.model_id, 'fallbacks', v_old.fallbacks), null);
  return query select 'cleared'::text;
end;
$$;
revoke all on function ai.clear_agent_assignment(text) from public, anon;
grant execute on function ai.clear_agent_assignment(text) to authenticated;

-- ── the runner records what it decided and what happened (service role only) ──

create or replace function ai.record_routing_decision(
  p_organization_id uuid, p_job_id uuid, p_run_id uuid, p_agent_key text, p_work_class text, p_category text,
  p_mode text, p_config_version int, p_plan jsonb, p_attempts jsonb, p_outcome text,
  p_provider_id text, p_model_id text, p_selection_source text, p_fallback_used boolean, p_blocked_reason text
)
returns table (decision_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into ai.routing_decisions (organization_id, job_id, run_id, agent_key, work_class, category, mode, config_version, plan, attempts,
                                    provider_id, model_id, selection_source, fallback_used, outcome, blocked_reason)
  values (p_organization_id, p_job_id, p_run_id, p_agent_key, p_work_class, p_category, p_mode, p_config_version, coalesce(p_plan, '{}'::jsonb), coalesce(p_attempts, '[]'::jsonb),
          p_provider_id, p_model_id, p_selection_source, coalesce(p_fallback_used, false), p_outcome, left(p_blocked_reason, 500))
  returning id into v_id;
  -- The run says what ACTUALLY ran (its `model` was the agent's default, whatever answered).
  if p_run_id is not null then
    update ai.agent_runs
       set provider_id = coalesce(p_provider_id, provider_id), routing_mode = p_mode, routing_decision_id = v_id,
           model = coalesce(p_model_id, model)
     where id = p_run_id and organization_id = p_organization_id;
  end if;
  return query select v_id;
end;
$$;
revoke all on function ai.record_routing_decision(uuid, uuid, uuid, text, text, text, text, int, jsonb, jsonb, text, text, text, text, boolean, text) from public, anon, authenticated;
grant execute on function ai.record_routing_decision(uuid, uuid, uuid, text, text, text, text, int, jsonb, jsonb, text, text, text, text, boolean, text) to service_role;

notify pgrst, 'reload schema';
