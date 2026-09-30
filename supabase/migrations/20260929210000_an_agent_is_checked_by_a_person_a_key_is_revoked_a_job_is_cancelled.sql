-- ═══════════════════════════════════════════════════════════════════════════
-- An agent is checked by a person, a key is revoked, a job is cancelled.
--
-- Four element-level gaps from docs/AGENCYOS_ADMIN_REMAINING_GAPS.md, bucket
-- C-1 (AI Workforce and Operations), each a control the Admin Panel PDF draws
-- that had no honest door:
--
--   SCR-062 Validate configuration — `ai.agents.last_validated_at` is written
--                                    only by the service-role cron tick
--                                    (stampAgentDefinitions), and `ai.agents`
--                                    is not tenant-writable (20260815380000).
--                                    A person pressing "validate now" needs a
--                                    row of their own to write, in their own
--                                    tenant, that never touches the registry.
--   SCR-064 Revoke a provider key   — vault.ts could store a key and never
--                                    remove one; the RLS policy admits DELETE
--                                    already, but a delete with no audit row
--                                    is a secret that vanished with no name
--                                    on it.
--   SCR-064 Routing by agent        — ai.routing_policies is per CATEGORY and
--                                    nothing bound an agent to a category. An
--                                    owner asking "this agent, on this kind of
--                                    work, uses this model" had no row.
--   SCR-066 Cancel a workflow       — core.jobs already allows 'cancelled' in
--                                    its CHECK (20260807120002) and nothing
--                                    has ever written it. The queue could be
--                                    revived (requeue_job) but never stopped.
--
-- Rules held here rather than by convention:
--   · a validation is a RECORD of what a person found, never a correction:
--     the registry row is not touched, so a validation that found problems
--     sits beside the row it describes rather than replacing the cron stamp.
--     Owner or ops_admin (core.is_admin()), the same tier that reads the
--     Operations screens.
--   · revoking a key is OWNER-ONLY — stricter than storing one (is_admin),
--     because losing a key stops every agent that routes to that vendor —
--     and is audited as provider_credential.revoked with who and when, never
--     what. security INVOKER: provider_credentials_admin_rw decides again.
--   · a routing override is owner-only, one per (agent, category), audited,
--     and CLEARED by deleting the row rather than emptying it, so the grid
--     reads "no override" rather than "an override that says nothing".
--   · only a QUEUED job may be cancelled (a retry is a queued row with a
--     run_at in the future; 'failed' is admitted too because the CHECK
--     allows it, though the runner has never written it). A running job has
--     a live claim, a finished one is history, a dead one has its own door.
--     Decided under a row lock, like requeue_job, and for the same reason.
--     SECURITY DEFINER for the same reason requeue_job is (20260815200000):
--     core.jobs has no UPDATE policy for authenticated and an INVOKER write
--     is silently filtered to nothing. The caller guard inside is the same:
--     own org, owner or ops_admin (the job.requeue capability).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── SCR-062: a person's validation of an agent's configuration ─────────────

create table if not exists ai.agent_validations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  agent_key        text not null references ai.agents(key) on delete cascade,
  validated_by     uuid references core.users(id) on delete set null,
  validated_at     timestamptz not null default now(),
  outcome          text not null check (outcome in ('ok', 'problems')),
  -- The registry revision the checks ran against — the same value the cron
  -- stamp writes to ai.agents.definition_version, so the two can be compared.
  registry_revision text not null,
  -- [{ "check": "...", "ok": true|false, "detail": "..." }, ...]
  findings         jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table ai.agent_validations is
  'What a person found when they validated an agent''s configuration against the registry (SCR-062). A record, never a correction: ai.agents is global and not tenant-writable, so the cron stamp and a person''s check sit side by side.';

create index if not exists agent_validations_latest_idx
  on ai.agent_validations (organization_id, agent_key, validated_at desc);

-- ── SCR-064: an owner's routing override for one agent on one category ─────

create table if not exists ai.agent_routing_overrides (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  agent_key        text not null references ai.agents(key) on delete cascade,
  -- The seven ADM-84 categories, the same CHECK ai.routing_policies carries.
  category         text not null check (category in (
                     'engineering', 'coordination', 'client_facing',
                     'extraction', 'design', 'money', 'certification'
                   )),
  -- Ordered preference; the runner takes the first one a registered provider
  -- serves. Never empty: clearing an override deletes the row.
  preferred_models text[] not null check (cardinality(preferred_models) between 1 and 8),
  note             text,
  set_by           uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint agent_routing_overrides_one_per_cell unique (organization_id, agent_key, category)
);

comment on table ai.agent_routing_overrides is
  'An owner''s model choice for one agent on one routing category (SCR-064). Consulted by the runner BEFORE the category policy in ai.routing_policies, and both before the agent row''s default_model. Cleared by deleting the row.';

create index if not exists agent_routing_overrides_agent_idx
  on ai.agent_routing_overrides (organization_id, agent_key);

do $$
declare t text;
begin
  foreach t in array array['agent_validations', 'agent_routing_overrides']
  loop
    execute format('drop trigger if exists set_updated_at on ai.%I', t);
    execute format(
      'create trigger set_updated_at before update on ai.%I for each row execute function core.set_updated_at()', t);

    execute format('alter table ai.%I enable row level security', t);
    execute format('alter table ai.%I force row level security', t);

    execute format('drop policy if exists %I_select on ai.%I', t, t);
    execute format(
      'create policy %I_select on ai.%I for select to authenticated
         using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))', t, t);

    execute format('drop trigger if exists freeze_org_%s on ai.%I', t, t);
    execute format(
      'create trigger freeze_org_%s before update of organization_id on ai.%I
         for each row execute function core.freeze_organization_id()', t, t);
  end loop;
end
$$;

-- A validation is written by owner or ops_admin — the tier that reads the
-- Operations screens — and only into their own tenant. Never updated or
-- deleted: a check that found problems is not something to tidy away.
drop policy if exists agent_validations_write on ai.agent_validations;
create policy agent_validations_write on ai.agent_validations
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id()) and (select core.is_admin()));

grant select, insert on ai.agent_validations to authenticated, service_role;

-- An override is owner-only, like the tool permissions beside it: which model
-- an agent spends the agency's money on is the owner's decision (ADM-84).
drop policy if exists agent_routing_overrides_write on ai.agent_routing_overrides;
create policy agent_routing_overrides_write on ai.agent_routing_overrides
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_owner()))
  with check (organization_id = (select core.current_organization_id()) and (select core.is_owner()));

grant select, insert, update, delete on ai.agent_routing_overrides to authenticated, service_role;

-- The door for an override: security INVOKER so the owner-only policy decides
-- again and the audit row carries the caller's own identity.
create or replace function ai.set_agent_routing_override(
  p_agent_key        text,
  p_category         text,
  p_preferred_models text[],
  p_note             text default null
)
returns table (
  -- 'set' | 'cleared'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'bad_category' | 'bad_models'
  outcome text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_models text[];
  v_before jsonb;
  v_after  jsonb;
  v_id     uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.is_owner()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  if p_category is null or p_category not in (
    'engineering', 'coordination', 'client_facing', 'extraction', 'design', 'money', 'certification'
  ) then
    return query select 'bad_category'::text; return;
  end if;

  if not exists (select 1 from ai.agents a where a.key = p_agent_key) then
    return query select 'not_found'::text; return;
  end if;

  -- Trimmed and emptied of blanks, so a form that submits ", ," clears.
  select coalesce(array_agg(m), '{}'::text[]) into v_models
    from (select nullif(trim(x), '') as m from unnest(coalesce(p_preferred_models, '{}'::text[])) as x) s
   where m is not null;

  if cardinality(v_models) > 8 then
    return query select 'bad_models'::text; return;
  end if;

  select to_jsonb(o), o.id into v_before, v_id
    from ai.agent_routing_overrides o
   where o.organization_id = v_org and o.agent_key = p_agent_key and o.category = p_category;

  if cardinality(v_models) = 0 then
    if v_id is null then
      -- Nothing to clear; say so as a success rather than invent a row.
      return query select 'cleared'::text; return;
    end if;

    delete from ai.agent_routing_overrides where id = v_id;

    insert into audit.audit_log (
      organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
    )
    values (v_org, 'user', v_actor, 'agent.routing_override_cleared', 'agent_routing_override', v_id, v_before, null);

    return query select 'cleared'::text; return;
  end if;

  insert into ai.agent_routing_overrides (organization_id, agent_key, category, preferred_models, note, set_by)
  values (v_org, p_agent_key, p_category, v_models, nullif(trim(coalesce(p_note, '')), ''), v_actor)
  on conflict (organization_id, agent_key, category) do update
    set preferred_models = excluded.preferred_models,
        note             = excluded.note,
        set_by           = excluded.set_by
  returning id, to_jsonb(ai.agent_routing_overrides.*) into v_id, v_after;

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (v_org, 'user', v_actor, 'agent.routing_override_set', 'agent_routing_override', v_id, v_before, v_after);

  return query select 'set'::text;
end;
$$;

comment on function ai.set_agent_routing_override(text, text, text[], text) is
  'Sets or clears (empty list) THIS tenant''s model override for one agent on one routing category (SCR-064). Owner only, and RLS says so again (security invoker). The runner consults it before the category policy. Audited.';

revoke all on function ai.set_agent_routing_override(text, text, text[], text) from public, anon;
grant execute on function ai.set_agent_routing_override(text, text, text[], text) to authenticated;

-- ── SCR-064: revoking a stored provider key ────────────────────────────────
--
-- ai.provider_credentials is global by design (20260920150000) and admin-only
-- by RLS. Revocation is narrower: owner only. security INVOKER, so
-- provider_credentials_admin_rw still decides, and the audit row is written
-- into the caller's own tenant under their own identity. The row's ciphertext
-- never enters the audit: before is provider, who set it and when.

create or replace function ai.revoke_provider_credential(p_provider text)
returns table (
  -- 'revoked'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found'
  outcome text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor      uuid := (select auth.uid());
  v_org        uuid := (select core.current_organization_id());
  v_updated_by uuid;
  v_updated_at timestamptz;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.is_owner()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  select c.updated_by, c.updated_at into v_updated_by, v_updated_at
    from ai.provider_credentials c
   where c.provider = p_provider;

  if not found then
    return query select 'not_found'::text; return;
  end if;

  delete from ai.provider_credentials where provider = p_provider;

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (
    v_org, 'user', v_actor, 'provider_credential.revoked', 'provider_credential', null,
    jsonb_build_object('provider', p_provider, 'updated_by', v_updated_by, 'updated_at', v_updated_at),
    jsonb_build_object('provider', p_provider, 'configured', false)
  );

  return query select 'revoked'::text;
end;
$$;

comment on function ai.revoke_provider_credential(text) is
  'Deletes one vault-stored provider key (SCR-064). Owner only; RLS (is_admin) decides again under security invoker. Audited as provider_credential.revoked with who set it and when — never the key.';

revoke all on function ai.revoke_provider_credential(text) from public, anon;
grant execute on function ai.revoke_provider_credential(text) to authenticated;

-- ── SCR-066: cancelling a job that has not started ─────────────────────────

create or replace function core.cancel_job(p_job_id uuid, p_reason text)
returns table (
  -- 'cancelled' | 'not_found' | 'not_cancellable' | 'no_reason'
  outcome    text,
  -- The status read under the lock, quoted back in a refusal.
  job_status text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org    uuid;
  v_status text;
  v_kind   text;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if v_reason is null then
    return query select 'no_reason'::text, null::text;
    return;
  end if;

  select j.organization_id, j.status, j.kind
    into v_org, v_status, v_kind
    from core.jobs j
   where j.id = p_job_id
     for update;

  if not found then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- The caller guard, the same as requeue_job's: a session caller may cancel
  -- only a job in their own org, and only as owner or ops_admin (job.requeue);
  -- the service role (null org) is unrestricted. Answered as not_found so
  -- nothing leaks to a caller who may not act on it.
  if core.current_organization_id() is not null
     and (core.current_organization_id() is distinct from v_org
          or core.current_user_role() not in ('owner', 'ops_admin')) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- A running job has a live claim; a succeeded one is finished; a cancelled
  -- one already is; a dead one has requeue_job. Only work that has not
  -- started — queued now or queued for a retry — can be stopped honestly.
  if v_status not in ('queued', 'failed') then
    return query select 'not_cancellable'::text, v_status;
    return;
  end if;

  update core.jobs
     set status     = 'cancelled',
         locked_at  = null,
         locked_by  = null,
         updated_at = now()
   where id = p_job_id;

  perform core.record_audit(
    v_org,
    'job.cancelled',
    'job',
    p_job_id,
    jsonb_build_object('status', v_status, 'kind', v_kind),
    jsonb_build_object('status', 'cancelled', 'kind', v_kind, 'reason', v_reason)
  );

  return query select 'cancelled'::text, 'cancelled'::text;
end;
$$;

comment on function core.cancel_job(uuid, text) is
  'Moves one queued (or retry-pending) job to cancelled with a stated reason (SCR-066). Refuses running, succeeded, cancelled and dead under a row lock, quoting the status back. Audits job.cancelled with the reason inside the transaction. SECURITY DEFINER for the reason requeue_job is: core.jobs has no UPDATE policy for authenticated; the caller guard inside restricts a session caller to their own org and owner/ops_admin.';

revoke all on function core.cancel_job(uuid, text) from public, anon;
grant execute on function core.cancel_job(uuid, text) to authenticated, service_role;
