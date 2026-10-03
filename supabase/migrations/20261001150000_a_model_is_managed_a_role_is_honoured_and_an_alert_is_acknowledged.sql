-- ═══════════════════════════════════════════════════════════════════════════
-- A model is managed, a role is honoured, and an alert is acknowledged.
--
-- Decision 2026-09-30: ADM-84 reversed — the owner manages models in the panel
-- Decision 2026-09-30: secondary roles are honoured by every permission check
--
-- Bucket F, stream F-F (SCR-062–071 of the screen architecture). Nine things
-- the AI Workforce, Operations, Governance and Settings screens asked for and
-- the schema could not hold, each held here by a table, a door, or a rule:
--
--   SCR-064  `ai.models` gains its two doors, `ai.add_model` and
--            `ai.retire_model` (owner, audited). ADM-84 kept the registry
--            empty "by design"; the owner reversed that on 2026-09-30, so the
--            plain `models_write` policy (any admin, no audit) is dropped and
--            the two doors are the only way a model row changes.
--            `ai.fallback_chains` — one ordered list of model ids per work
--            class — is consulted by the runner's model choice AFTER the
--            agent override and the category policy and BEFORE the agent's
--            default. `ai.provider_budgets` caps a provider's spend per
--            calendar month; the runner asks before every call and a refusal
--            is recorded exactly as a policy refusal is
--            (`ai.agent_policy_refusals`, kind `provider_budget_exceeded`).
--   SCR-063  `ai.agents.allowed_work_classes[]`: which of ADM-61's classes
--            the agent may be given. Empty = every class, as before. Owner-
--            editable through `ai.set_agent_work_classes`, honoured by the
--            runner beside the autonomy gate.
--   SCR-065  `ai.agent_runs.latency_ms`, stamped by trigger when a run
--            settles, so the latency KPIs are recorded rather than derived
--            on every page; `ai.replay_run` re-queues the job that produced a
--            run, for `read` work only (read-only tools — the one class whose
--            replay cannot act on anything twice); `core.cancel_running_job`
--            sets a flag the runner honours between steps, since a running
--            job cannot be stopped by editing its row.
--   SCR-067  `core.alerts`: a situation somebody should look at, raised by
--            the runner (a dead job, a budget refusal) and ACKNOWLEDGED by a
--            person with a reason. Unacknowledged critical alerts feed the
--            cross-app incident banner.
--   SCR-068  `core.overrides`: the override centre. Every domain override —
--            a project started before it was ready, a scope baseline
--            unfrozen, a release paid for by override — lands here by a
--            trigger on the audit trail, in the same transaction, so the
--            centre is a record of what actually happened and not a second
--            form. `core.record_manual_override` records an exception with a
--            reason where no domain door exists.
--            `core.kill_switches`: agents_paused, outbound_paused,
--            jobs_paused. Owner only, reason required, honoured where the
--            work is claimed (`core.claim_agent_job`, `core.claim_jobs`) and
--            where every send passes (`crm.send_outbound_message`).
--   SCR-069  `security.incidents` and `security.access_reviews`, in a new
--            `security` schema, with their doors.
--   SCR-066  An operational failure is escalated through stream F-A's
--            `core.escalate` (20261001100000) — nothing of it is defined here.
--   F2       Secondary roles (core.membership_roles, 20260920190000) are now
--            honoured by every permission check. In the application,
--            `can()` reads the union of a person's roles. Here, `core.is_owner`,
--            `core.is_admin` and `core.can_write` consult `core.holds_role`,
--            which reads the JWT's primary role first and the membership's
--            secondary roles second — so a door that says "owner only" admits
--            a person an owner made a secondary owner. Policies that spell
--            `core.current_user_role() in (...)` still read the primary role
--            alone; the migration says so rather than rewriting them all.
--
-- Conventions unchanged: every new org-scoped table carries organization_id,
-- RLS enabled and forced, an internal select policy, no plain write policy
-- where a door exists, tenancy triggers for every FK to an org-scoped table,
-- a frozen organization_id, and every governed write audits through
-- core.record_audit inside its own transaction.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── F2: a role is honoured — every role a person holds ──────────────────────

create or replace function core.holds_role(p_role text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_org uuid := (select core.current_organization_id());
begin
  -- The JWT first: the primary role is what every session carries, and a
  -- person whose primary role is the one asked about needs no second read.
  if core.current_user_role() = p_role then
    return true;
  end if;
  if v_uid is null or v_org is null then
    return false;
  end if;
  -- Then the secondary roles an owner granted (core.membership_roles), for
  -- THIS person's ACTIVE membership in THIS organisation. SECURITY DEFINER so
  -- the read is not itself subject to a policy that calls back into here.
  return exists (
    select 1
      from core.membership_roles mr
      join core.memberships m on m.id = mr.membership_id
     where m.user_id = v_uid
       and m.organization_id = v_org
       and m.status = 'active'
       and mr.role = p_role
  );
end;
$$;

comment on function core.holds_role(text) is
  'True when the session''s primary role is p_role, or when the person''s active membership holds it as a secondary role (core.membership_roles). Decision 2026-09-30: secondary roles are honoured by every permission check. Reads only the caller''s own membership.';

revoke all on function core.holds_role(text) from public, anon;
grant execute on function core.holds_role(text) to authenticated, service_role;

create or replace function core.is_owner()
returns boolean
language sql
stable
set search_path = ''
as $$
  select core.holds_role('owner');
$$;

create or replace function core.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select core.holds_role('owner') or core.holds_role('ops_admin');
$$;

create or replace function core.can_write()
returns boolean
language sql
stable
set search_path = ''
as $$
  select core.current_user_role() in ('owner', 'ops_admin', 'delivery_lead', 'member')
      or core.holds_role('owner')
      or core.holds_role('ops_admin')
      or core.holds_role('delivery_lead')
      or core.holds_role('member');
$$;

comment on function core.is_owner() is
  'True for the owner — by primary role, or by a secondary owner role an owner granted (decision 2026-09-30: secondary roles are honoured by every permission check).';
comment on function core.is_admin() is
  'True for owner or ops_admin, primary or secondary (decision 2026-09-30).';
comment on function core.can_write() is
  'True for the four writing internal roles, primary or secondary (decision 2026-09-30).';

-- ── SCR-064: the owner manages models in the panel ─────────────────────────
--
-- Decision 2026-09-30: ADM-84 reversed — the owner manages models in the panel.
-- The plain write policy is dropped: a model row that appeared without an
-- audit entry would be a provider fact nobody signed. Both doors below are
-- SECURITY DEFINER for that reason and check core.is_owner() themselves.

drop policy if exists models_write on ai.models;

comment on table ai.models is
  'Which models an organization may route to, and what each can do (ADM-84 R1). Decision 2026-09-30: ADM-84 reversed — the owner adds and retires models from the panel through ai.add_model / ai.retire_model, both audited; there is no other write path.';

create or replace function ai.add_model(
  p_model_id                   text,
  p_provider                   text,
  p_capabilities               text[] default '{}'::text[],
  p_context_tokens             int    default null,
  p_input_cost_minor_per_mtok  bigint default null,
  p_output_cost_minor_per_mtok bigint default null
)
returns table (
  -- 'added' | 'reactivated'
  -- refusals: 'no_actor' | 'not_owner' | 'bad_model' | 'bad_provider' | 'bad_capabilities' | 'already_available'
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
  v_model    text := nullif(trim(coalesce(p_model_id, '')), '');
  v_provider text := nullif(trim(coalesce(p_provider, '')), '');
  v_before   jsonb;
  v_after    jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_owner()), false) then
    return query select 'not_owner'::text; return;
  end if;
  if v_model is null or length(v_model) > 120 then
    return query select 'bad_model'::text; return;
  end if;
  if v_provider is null or v_provider not in ('anthropic', 'openai', 'gemini', 'xai', 'openrouter') then
    return query select 'bad_provider'::text; return;
  end if;
  if not (coalesce(p_capabilities, '{}'::text[]) <@ array['reasoning', 'coding', 'long_context', 'structured_output', 'multimodal']::text[]) then
    return query select 'bad_capabilities'::text; return;
  end if;

  select to_jsonb(m.*) into v_before
    from ai.models m
   where m.organization_id = v_org and m.model_id = v_model;

  if v_before is not null and (v_before ->> 'status') = 'available' then
    return query select 'already_available'::text; return;
  end if;

  insert into ai.models (organization_id, model_id, provider, capabilities, context_tokens,
                         input_cost_minor_per_mtok, output_cost_minor_per_mtok, status)
  values (v_org, v_model, v_provider, coalesce(p_capabilities, '{}'::text[]), p_context_tokens,
          p_input_cost_minor_per_mtok, p_output_cost_minor_per_mtok, 'available')
  on conflict (organization_id, model_id) do update
     set provider                   = excluded.provider,
         capabilities               = excluded.capabilities,
         context_tokens             = excluded.context_tokens,
         input_cost_minor_per_mtok  = excluded.input_cost_minor_per_mtok,
         output_cost_minor_per_mtok = excluded.output_cost_minor_per_mtok,
         status                     = 'available',
         updated_at                 = now()
  returning to_jsonb(ai.models.*) into v_after;

  perform core.record_audit(
    v_org,
    case when v_before is null then 'model.added' else 'model.reactivated' end,
    'model',
    null,
    v_before,
    v_after
  );

  return query select (case when v_before is null then 'added' else 'reactivated' end)::text;
end;
$$;

comment on function ai.add_model(text, text, text[], int, bigint, bigint) is
  'Adds a model to this organisation''s registry, or reactivates a retired one (SCR-064; ADM-84 reversed 2026-09-30). Owner only, audited as model.added / model.reactivated. The model id is stored as the adapter accepts it — never translated.';

revoke all on function ai.add_model(text, text, text[], int, bigint, bigint) from public, anon;
grant execute on function ai.add_model(text, text, text[], int, bigint, bigint) to authenticated;

create or replace function ai.retire_model(p_model_id text, p_reason text)
returns table (
  -- 'retired'
  -- refusals: 'no_actor' | 'not_owner' | 'no_reason' | 'not_found' | 'already_retired' | 'in_a_chain'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_owner()), false) then
    return query select 'not_owner'::text; return;
  end if;
  if v_reason is null then
    return query select 'no_reason'::text; return;
  end if;

  select to_jsonb(m.*) into v_before
    from ai.models m
   where m.organization_id = v_org and m.model_id = p_model_id
   for update;

  if v_before is null then
    return query select 'not_found'::text; return;
  end if;
  if (v_before ->> 'status') = 'retired' then
    return query select 'already_retired'::text; return;
  end if;

  -- A model a fallback chain still names cannot be retired out from under it:
  -- the chain would carry an id the runner skips, silently. Take it out of
  -- the chain first, then retire it.
  if exists (
    select 1 from ai.fallback_chains fc
     where fc.organization_id = v_org and p_model_id = any (fc.model_ids)
  ) then
    return query select 'in_a_chain'::text; return;
  end if;

  update ai.models
     set status = 'retired', updated_at = now()
   where organization_id = v_org and model_id = p_model_id
  returning to_jsonb(ai.models.*) into v_after;

  perform core.record_audit(
    v_org, 'model.retired', 'model', null,
    v_before, v_after || jsonb_build_object('reason', v_reason)
  );

  return query select 'retired'::text;
end;
$$;

comment on function ai.retire_model(text, text) is
  'Retires a model from this organisation''s registry with a reason (SCR-064). Owner only, audited as model.retired. Refused while a fallback chain still names the model.';

revoke all on function ai.retire_model(text, text) from public, anon;
grant execute on function ai.retire_model(text, text) to authenticated;

-- ── SCR-064: a fallback chain per work class ───────────────────────────────

create table if not exists ai.fallback_chains (
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  work_class       text not null check (work_class in (
                     'read', 'draft', 'internal_plan', 'breakdown',
                     'client_direct', 'client_facing', 'money', 'delivery_approval'
                   )),
  -- Ordered: the runner tries the first a registered provider serves.
  model_ids        text[] not null default '{}'::text[]
                     check (coalesce(array_length(model_ids, 1), 0) <= 10),
  updated_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (organization_id, work_class)
);

comment on table ai.fallback_chains is
  'The ordered models the runner falls back to for one class of work (SCR-064, decision 2026-09-30). Consulted by routedModelFor AFTER the agent override and the category policy and BEFORE the agent''s default. Written only through ai.set_fallback_chain (owner, audited).';

drop trigger if exists set_updated_at on ai.fallback_chains;
create trigger set_updated_at before update on ai.fallback_chains
  for each row execute function core.set_updated_at();

drop trigger if exists freeze_org_fallback_chains on ai.fallback_chains;
create trigger freeze_org_fallback_chains
  before update of organization_id on ai.fallback_chains
  for each row execute function core.freeze_organization_id();

alter table ai.fallback_chains enable row level security;
alter table ai.fallback_chains force row level security;

drop policy if exists fallback_chains_select on ai.fallback_chains;
create policy fallback_chains_select on ai.fallback_chains
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on ai.fallback_chains to authenticated;
grant select, insert, update, delete on ai.fallback_chains to service_role;

create or replace function ai.set_fallback_chain(p_work_class text, p_model_ids text[])
returns table (
  -- 'set' | 'cleared'
  -- refusals: 'no_actor' | 'not_owner' | 'bad_work_class' | 'unknown_model' | 'too_many'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_ids    text[] := coalesce(p_model_ids, '{}'::text[]);
  v_id     text;
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_owner()), false) then
    return query select 'not_owner'::text; return;
  end if;
  if p_work_class is null or p_work_class not in (
    'read', 'draft', 'internal_plan', 'breakdown', 'client_direct', 'client_facing', 'money', 'delivery_approval'
  ) then
    return query select 'bad_work_class'::text; return;
  end if;
  if coalesce(array_length(v_ids, 1), 0) > 10 then
    return query select 'too_many'::text; return;
  end if;

  -- Every id in the chain is a model the owner has registered and not retired.
  -- A chain naming an unregistered id would be the free text ADM-84's reversal
  -- was meant to end.
  foreach v_id in array v_ids loop
    if not exists (
      select 1 from ai.models m
       where m.organization_id = v_org and m.model_id = v_id and m.status = 'available'
    ) then
      return query select 'unknown_model'::text; return;
    end if;
  end loop;

  select to_jsonb(fc.*) into v_before
    from ai.fallback_chains fc
   where fc.organization_id = v_org and fc.work_class = p_work_class;

  if coalesce(array_length(v_ids, 1), 0) = 0 then
    delete from ai.fallback_chains
     where organization_id = v_org and work_class = p_work_class;
    perform core.record_audit(v_org, 'fallback_chain.cleared', 'fallback_chain', null,
                              v_before, jsonb_build_object('work_class', p_work_class));
    return query select 'cleared'::text; return;
  end if;

  insert into ai.fallback_chains (organization_id, work_class, model_ids, updated_by)
  values (v_org, p_work_class, v_ids, v_actor)
  on conflict (organization_id, work_class) do update
     set model_ids = excluded.model_ids, updated_by = excluded.updated_by, updated_at = now()
  returning to_jsonb(ai.fallback_chains.*) into v_after;

  perform core.record_audit(v_org, 'fallback_chain.set', 'fallback_chain', null, v_before, v_after);

  return query select 'set'::text;
end;
$$;

comment on function ai.set_fallback_chain(text, text[]) is
  'Sets (or, with an empty list, clears) the fallback chain for one work class (SCR-064). Owner only; every id must be an available ai.models row; audited as fallback_chain.set / fallback_chain.cleared.';

revoke all on function ai.set_fallback_chain(text, text[]) from public, anon;
grant execute on function ai.set_fallback_chain(text, text[]) to authenticated;

-- ── SCR-064: a provider has a monthly budget ────────────────────────────────

create table if not exists ai.provider_budgets (
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  provider          text not null check (provider in ('anthropic', 'openai', 'gemini', 'xai', 'openrouter')),
  monthly_cap_minor bigint not null check (monthly_cap_minor > 0),
  set_by            uuid references core.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (organization_id, provider)
);

comment on table ai.provider_budgets is
  'The most one provider may cost this organisation in a calendar month, in minor units (SCR-064, decision 2026-09-30). The runner asks ai.provider_spend_this_month before every call and refuses — recorded as a policy refusal of kind provider_budget_exceeded — once the cap is reached. Written only through ai.set_provider_budget (owner, audited).';

drop trigger if exists set_updated_at on ai.provider_budgets;
create trigger set_updated_at before update on ai.provider_budgets
  for each row execute function core.set_updated_at();

drop trigger if exists freeze_org_provider_budgets on ai.provider_budgets;
create trigger freeze_org_provider_budgets
  before update of organization_id on ai.provider_budgets
  for each row execute function core.freeze_organization_id();

alter table ai.provider_budgets enable row level security;
alter table ai.provider_budgets force row level security;

drop policy if exists provider_budgets_select on ai.provider_budgets;
create policy provider_budgets_select on ai.provider_budgets
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on ai.provider_budgets to authenticated;
grant select, insert, update, delete on ai.provider_budgets to service_role;

-- What a provider has cost this calendar month, from the steps the runtime
-- wrote (ai.agent_steps.request ->> 'provider'). SECURITY INVOKER: a session
-- caller reads under agent_steps_select; the runner reads as the service role.
create or replace function ai.provider_spend_this_month(p_organization_id uuid, p_provider text)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(s.cost_minor), 0)::bigint
    from ai.agent_steps s
   where s.organization_id = p_organization_id
     and s.kind = 'model_call'
     and s.request ->> 'provider' = p_provider
     and s.created_at >= date_trunc('month', now());
$$;

comment on function ai.provider_spend_this_month(uuid, text) is
  'Sum of ai.agent_steps.cost_minor for one provider since the first of this month — what the budget is measured against. Never estimated.';

revoke all on function ai.provider_spend_this_month(uuid, text) from public, anon;
grant execute on function ai.provider_spend_this_month(uuid, text) to authenticated, service_role;

create or replace function ai.set_provider_budget(p_provider text, p_monthly_cap_minor bigint)
returns table (
  -- 'set' | 'cleared'
  -- refusals: 'no_actor' | 'not_owner' | 'bad_provider' | 'bad_cap' | 'unchanged'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_owner()), false) then
    return query select 'not_owner'::text; return;
  end if;
  if p_provider is null or p_provider not in ('anthropic', 'openai', 'gemini', 'xai', 'openrouter') then
    return query select 'bad_provider'::text; return;
  end if;
  if p_monthly_cap_minor is not null and (p_monthly_cap_minor < 0 or p_monthly_cap_minor > 100000000000) then
    return query select 'bad_cap'::text; return;
  end if;

  select to_jsonb(b.*) into v_before
    from ai.provider_budgets b
   where b.organization_id = v_org and b.provider = p_provider;

  if coalesce(p_monthly_cap_minor, 0) = 0 then
    if v_before is null then
      return query select 'unchanged'::text; return;
    end if;
    delete from ai.provider_budgets where organization_id = v_org and provider = p_provider;
    perform core.record_audit(v_org, 'provider_budget.cleared', 'provider_budget', null,
                              v_before, jsonb_build_object('provider', p_provider));
    return query select 'cleared'::text; return;
  end if;

  if v_before is not null and (v_before ->> 'monthly_cap_minor')::bigint = p_monthly_cap_minor then
    return query select 'unchanged'::text; return;
  end if;

  insert into ai.provider_budgets (organization_id, provider, monthly_cap_minor, set_by)
  values (v_org, p_provider, p_monthly_cap_minor, v_actor)
  on conflict (organization_id, provider) do update
     set monthly_cap_minor = excluded.monthly_cap_minor, set_by = excluded.set_by, updated_at = now()
  returning to_jsonb(ai.provider_budgets.*) into v_after;

  perform core.record_audit(v_org, 'provider_budget.set', 'provider_budget', null, v_before, v_after);

  return query select 'set'::text;
end;
$$;

comment on function ai.set_provider_budget(text, bigint) is
  'Sets (or, with 0 / null, clears) a provider''s monthly cap in minor units (SCR-064). Owner only, audited as provider_budget.set / provider_budget.cleared.';

revoke all on function ai.set_provider_budget(text, bigint) from public, anon;
grant execute on function ai.set_provider_budget(text, bigint) to authenticated;

-- The budget beside its spend, for the page. security_invoker so RLS on both
-- tables still decides who sees a row.
create or replace view ai.provider_budget_status
with (security_invoker = on) as
  select b.organization_id,
         b.provider,
         b.monthly_cap_minor,
         ai.provider_spend_this_month(b.organization_id, b.provider) as spent_minor,
         b.updated_at
    from ai.provider_budgets b;

comment on view ai.provider_budget_status is
  'Each provider budget beside what the provider has cost this month (SCR-064). Read-only.';

grant select on ai.provider_budget_status to authenticated, service_role;

-- A budget refusal is recorded like a policy refusal — the same table, one
-- more kind, and no tool or project to name.
alter table ai.agent_policy_refusals drop constraint if exists agent_policy_refusals_kind_check;
alter table ai.agent_policy_refusals
  add constraint agent_policy_refusals_kind_check
  check (kind in ('tool_denied', 'tool_unrecorded', 'project_unassigned', 'provider_budget_exceeded'));

alter table ai.agent_policy_refusals drop constraint if exists agent_policy_refusals_names_its_subject;
alter table ai.agent_policy_refusals
  add constraint agent_policy_refusals_names_its_subject check (
    (kind in ('tool_denied', 'tool_unrecorded') and tool_key is not null)
    or (kind = 'project_unassigned' and project_id is not null)
    or (kind = 'provider_budget_exceeded')
  );

-- ── SCR-063: which classes of work an agent may be given ───────────────────

alter table ai.agents
  add column if not exists allowed_work_classes text[] not null default '{}'::text[];

alter table ai.agents drop constraint if exists agents_allowed_work_classes_check;
alter table ai.agents
  add constraint agents_allowed_work_classes_check
  check (allowed_work_classes <@ array[
    'read', 'draft', 'internal_plan', 'breakdown',
    'client_direct', 'client_facing', 'money', 'delivery_approval'
  ]::text[]);

comment on column ai.agents.allowed_work_classes is
  'ADM-61 work classes this agent may be handed (SCR-063). Empty means every class, as before this column existed. The runner refuses a job whose workflow declares a class outside a non-empty list, beside the autonomy gate. Owner-editable through ai.set_agent_work_classes, audited.';

create or replace function ai.set_agent_work_classes(p_agent_key text, p_work_classes text[])
returns table (
  -- 'set'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'bad_work_class' | 'unchanged'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_wc     text[] := coalesce(p_work_classes, '{}'::text[]);
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_owner()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if not (v_wc <@ array['read', 'draft', 'internal_plan', 'breakdown', 'client_direct', 'client_facing', 'money', 'delivery_approval']::text[]) then
    return query select 'bad_work_class'::text; return;
  end if;

  select jsonb_build_object('key', a.key, 'allowed_work_classes', a.allowed_work_classes)
    into v_before
    from ai.agents a
   where a.key = p_agent_key;

  if v_before is null then
    return query select 'not_found'::text; return;
  end if;

  if (select a.allowed_work_classes from ai.agents a where a.key = p_agent_key) = v_wc then
    return query select 'unchanged'::text; return;
  end if;

  update ai.agents
     set allowed_work_classes = v_wc
   where key = p_agent_key
  returning jsonb_build_object('key', key, 'allowed_work_classes', allowed_work_classes) into v_after;

  perform core.record_audit(v_org, 'agent.work_classes_set', 'agent', null, v_before, v_after);

  return query select 'set'::text;
end;
$$;

comment on function ai.set_agent_work_classes(text, text[]) is
  'Sets which ADM-61 work classes a registry agent may be handed (SCR-063). Owner only; SECURITY DEFINER because ai.agents is not tenant-writable; audited as agent.work_classes_set in the acting owner''s tenant.';

revoke all on function ai.set_agent_work_classes(text, text[]) from public, anon;
grant execute on function ai.set_agent_work_classes(text, text[]) to authenticated;

-- ── SCR-065: a run knows how long it took ──────────────────────────────────

alter table ai.agent_runs
  add column if not exists latency_ms int check (latency_ms is null or latency_ms >= 0);

comment on column ai.agent_runs.latency_ms is
  'Wall-clock milliseconds from started_at to finished_at, stamped by trigger when the run settles (SCR-065). Null while the run is open or when either instant is missing.';

create or replace function ai.agent_runs_stamp_latency()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.finished_at is not null and new.started_at is not null and new.finished_at >= new.started_at then
    new.latency_ms := floor(extract(epoch from (new.finished_at - new.started_at)) * 1000)::int;
  end if;
  return new;
end;
$$;

drop trigger if exists agent_runs_stamp_latency on ai.agent_runs;
create trigger agent_runs_stamp_latency
  before insert or update of finished_at, started_at on ai.agent_runs
  for each row execute function ai.agent_runs_stamp_latency();

update ai.agent_runs
   set latency_ms = floor(extract(epoch from (finished_at - started_at)) * 1000)::int
 where latency_ms is null
   and finished_at is not null
   and started_at is not null
   and finished_at >= started_at;

-- ── SCR-065 / SCR-066: a running job can be asked to stop ──────────────────

alter table core.jobs add column if not exists cancel_requested_at timestamptz;
alter table core.jobs add column if not exists cancel_reason text;

comment on column core.jobs.cancel_requested_at is
  'When a person asked a RUNNING job to stop (core.cancel_running_job). The runner reads it between steps and settles the job as cancelled at the next one; a queued job is cancelled outright by core.cancel_job instead.';

create or replace function core.cancel_running_job(p_job_id uuid, p_reason text)
returns table (
  -- 'requested' | 'not_found' | 'not_running' | 'no_reason' | 'already_requested'
  outcome    text,
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
  v_flag   timestamptz;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if v_reason is null then
    return query select 'no_reason'::text, null::text; return;
  end if;

  select j.organization_id, j.status, j.kind, j.cancel_requested_at
    into v_org, v_status, v_kind, v_flag
    from core.jobs j
   where j.id = p_job_id
     for update;

  if not found then
    return query select 'not_found'::text, null::text; return;
  end if;

  -- The same caller guard cancel_job keeps: own organisation, owner or
  -- ops_admin (job.requeue). Answered as not_found so nothing leaks.
  if core.current_organization_id() is not null
     and (core.current_organization_id() is distinct from v_org
          or not coalesce((select core.is_admin()), false)) then
    return query select 'not_found'::text, null::text; return;
  end if;

  if v_status <> 'running' then
    return query select 'not_running'::text, v_status; return;
  end if;
  if v_flag is not null then
    return query select 'already_requested'::text, v_status; return;
  end if;

  update core.jobs
     set cancel_requested_at = now(),
         cancel_reason       = v_reason,
         updated_at          = now()
   where id = p_job_id;

  perform core.record_audit(
    v_org, 'job.cancel_requested', 'job', p_job_id,
    jsonb_build_object('status', v_status, 'kind', v_kind),
    jsonb_build_object('status', v_status, 'kind', v_kind, 'reason', v_reason)
  );

  return query select 'requested'::text, v_status;
end;
$$;

comment on function core.cancel_running_job(uuid, text) is
  'Asks a RUNNING job to stop, with a reason (SCR-065/066). The runner honours the flag between steps and settles the job as cancelled; this function cannot stop the work itself, and says so by leaving the status running. Owner or ops_admin; audited as job.cancel_requested.';

revoke all on function core.cancel_running_job(uuid, text) from public, anon;
grant execute on function core.cancel_running_job(uuid, text) to authenticated;

-- The runner's half: settle the job and its run as cancelled, audited, in one
-- transaction. Service role only — only the runner knows it stopped.
create or replace function core.settle_cancelled_job(p_job_id uuid, p_run_id uuid default null)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org    uuid;
  v_kind   text;
  v_reason text;
  v_status text;
begin
  select j.organization_id, j.kind, j.cancel_reason, j.status
    into v_org, v_kind, v_reason, v_status
    from core.jobs j
   where j.id = p_job_id
     for update;
  if not found then return; end if;

  update core.jobs
     set status = 'cancelled', locked_at = null, locked_by = null, updated_at = now(),
         last_error = 'cancelled while running: ' || coalesce(v_reason, 'no reason recorded')
   where id = p_job_id;

  if p_run_id is not null then
    update ai.agent_runs
       set status = 'cancelled',
           error = 'cancelled while running: ' || coalesce(v_reason, 'no reason recorded'),
           finished_at = now()
     where id = p_run_id;
  end if;

  perform core.record_audit(
    v_org, 'job.cancelled', 'job', p_job_id,
    jsonb_build_object('status', v_status, 'kind', v_kind),
    jsonb_build_object('status', 'cancelled', 'kind', v_kind, 'reason', v_reason, 'run_id', p_run_id, 'while', 'running')
  );
end;
$$;

comment on function core.settle_cancelled_job(uuid, uuid) is
  'The runner''s settlement for a job whose cancel flag it honoured between steps: job and run to cancelled, audited as job.cancelled. Service role only.';

revoke all on function core.settle_cancelled_job(uuid, uuid) from public, anon, authenticated;
grant execute on function core.settle_cancelled_job(uuid, uuid) to service_role;

-- ── SCR-065: a run of read-only work can be replayed ───────────────────────

create or replace function ai.replay_run(p_run_id uuid, p_reason text)
returns table (
  -- 'replayed'
  -- refusals: 'no_actor' | 'not_authorized' | 'no_reason' | 'not_found' | 'unsafe_work_class' | 'no_job'
  outcome text,
  job_id  uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid := (select core.current_organization_id());
  v_reason  text := nullif(trim(coalesce(p_reason, '')), '');
  v_run     ai.agent_runs;
  v_job     core.jobs;
  v_new_job uuid;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;
  if v_reason is null then
    return query select 'no_reason'::text, null::uuid; return;
  end if;

  select r.* into v_run from ai.agent_runs r where r.id = p_run_id and r.organization_id = v_org;
  if v_run.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  -- Only `read` work replays: the one ADM-61 class whose tools are read-only,
  -- so running it twice cannot draft, plan, send or spend anything twice.
  if v_run.work_class is distinct from 'read' then
    return query select 'unsafe_work_class'::text, null::uuid; return;
  end if;

  if v_run.trigger !~ '^job:[0-9a-f-]{36}$' then
    return query select 'no_job'::text, null::uuid; return;
  end if;

  select j.* into v_job from core.jobs j where j.id = substring(v_run.trigger from 5)::uuid and j.organization_id = v_org;
  if v_job.id is null then
    return query select 'no_job'::text, null::uuid; return;
  end if;

  insert into core.jobs (organization_id, kind, payload, priority, correlation_id, status, run_at)
  values (v_org, v_job.kind, v_job.payload, v_job.priority, v_job.correlation_id, 'queued', now())
  returning id into v_new_job;

  perform core.record_audit(
    v_org, 'agent_run.replayed', 'agent_run', p_run_id,
    jsonb_build_object('job_id', v_job.id, 'kind', v_job.kind, 'work_class', v_run.work_class),
    jsonb_build_object('job_id', v_new_job, 'kind', v_job.kind, 'reason', v_reason)
  );

  return query select 'replayed'::text, v_new_job;
end;
$$;

comment on function ai.replay_run(uuid, text) is
  'Queues the job that produced a run again, with a reason (SCR-065). Only a run of `read` work — read-only tools — may be replayed; every other class is refused as unsafe_work_class. Owner or ops_admin; audited as agent_run.replayed.';

revoke all on function ai.replay_run(uuid, text) from public, anon;
grant execute on function ai.replay_run(uuid, text) to authenticated;

-- ── SCR-067: an alert is acknowledged by a person ───────────────────────────

create table if not exists core.alerts (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  -- Where it came from: 'jobs' (a dead job), 'ai' (a budget refusal), 'ops'.
  source             text not null check (length(trim(source)) > 0 and length(source) <= 40),
  severity           text not null check (severity in ('info', 'warning', 'critical')),
  summary            text not null check (length(trim(summary)) > 0),
  -- The same situation raised twice is one alert seen twice, not two rows.
  fingerprint        text not null check (length(trim(fingerprint)) > 0 and length(fingerprint) <= 200),
  occurrences        int not null default 1 check (occurrences > 0),
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  acknowledged_by    uuid references core.users(id) on delete set null,
  acknowledged_at    timestamptz,
  acknowledge_reason text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint alerts_acknowledgement_is_whole check (
    (acknowledged_at is null and acknowledged_by is null and acknowledge_reason is null)
    or (acknowledged_at is not null and acknowledged_by is not null and acknowledge_reason is not null)
  )
);

comment on table core.alerts is
  'A situation somebody should look at (SCR-067): raised by the runner or the tick through core.raise_alert, acknowledged by a person with a reason through core.acknowledge_alert. Unacknowledged critical alerts feed the incident banner every internal page shows.';

create unique index if not exists alerts_open_fingerprint_idx
  on core.alerts (organization_id, fingerprint)
  where acknowledged_at is null;

create index if not exists alerts_open_idx
  on core.alerts (organization_id, severity, last_seen_at desc)
  where acknowledged_at is null;

drop trigger if exists set_updated_at on core.alerts;
create trigger set_updated_at before update on core.alerts
  for each row execute function core.set_updated_at();

drop trigger if exists freeze_org_alerts on core.alerts;
create trigger freeze_org_alerts
  before update of organization_id on core.alerts
  for each row execute function core.freeze_organization_id();

alter table core.alerts enable row level security;
alter table core.alerts force row level security;

drop policy if exists alerts_select on core.alerts;
create policy alerts_select on core.alerts
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on core.alerts to authenticated;
grant select, insert, update on core.alerts to service_role;

create or replace function core.raise_alert(
  p_organization_id uuid,
  p_source          text,
  p_severity        text,
  p_summary         text,
  p_fingerprint     text
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into core.alerts (organization_id, source, severity, summary, fingerprint)
  values (p_organization_id, p_source, p_severity, p_summary, p_fingerprint)
  on conflict (organization_id, fingerprint) where acknowledged_at is null do update
     set occurrences  = core.alerts.occurrences + 1,
         last_seen_at = now(),
         summary      = excluded.summary,
         severity     = excluded.severity
  returning id into v_id;
  return v_id;
end;
$$;

comment on function core.raise_alert(uuid, text, text, text, text) is
  'Raises an alert for an organisation, or bumps the open one with the same fingerprint (SCR-067). Service role only: the runner and the tick are the only things that know a situation arose.';

revoke all on function core.raise_alert(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function core.raise_alert(uuid, text, text, text, text) to service_role;

create or replace function core.acknowledge_alert(p_alert_id uuid, p_reason text)
returns table (
  -- 'acknowledged'
  -- refusals: 'no_actor' | 'not_authorized' | 'no_reason' | 'not_found' | 'already_acknowledged'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if v_reason is null then
    return query select 'no_reason'::text; return;
  end if;

  select to_jsonb(a.*) into v_before
    from core.alerts a
   where a.id = p_alert_id and a.organization_id = v_org
   for update;

  if v_before is null then
    return query select 'not_found'::text; return;
  end if;
  if (v_before ->> 'acknowledged_at') is not null then
    return query select 'already_acknowledged'::text; return;
  end if;

  update core.alerts
     set acknowledged_by = v_actor, acknowledged_at = now(), acknowledge_reason = v_reason
   where id = p_alert_id
  returning to_jsonb(core.alerts.*) into v_after;

  perform core.record_audit(v_org, 'alert.acknowledged', 'alert', p_alert_id, v_before, v_after);

  return query select 'acknowledged'::text;
end;
$$;

comment on function core.acknowledge_alert(uuid, text) is
  'A person acknowledges an alert with a reason (SCR-067). Owner or ops_admin; audited as alert.acknowledged. An acknowledged alert leaves the banner; the same situation arising again is a new row.';

revoke all on function core.acknowledge_alert(uuid, text) from public, anon;
grant execute on function core.acknowledge_alert(uuid, text) to authenticated;

-- ── SCR-068: the override centre ───────────────────────────────────────────

create table if not exists core.overrides (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  subject_type     text not null check (length(trim(subject_type)) > 0),
  subject_id       uuid,
  -- 'project.start_before_ready' | 'scope.unfreeze' | 'release.payment_override' | 'manual.<slug>'
  kind             text not null check (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  reason           text not null check (length(trim(reason)) > 0),
  actor_id         uuid references core.users(id) on delete set null,
  expires_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table core.overrides is
  'The override centre (SCR-068): every time a person overrode a rule, with the reason they gave. Domain overrides (a project started before ready, a scope baseline unfrozen, a release paid for by override) are mirrored here by a trigger on the audit trail in the same transaction; core.record_manual_override records an exception no domain door covers. Never edited.';

create index if not exists overrides_org_idx
  on core.overrides (organization_id, created_at desc);

drop trigger if exists set_updated_at on core.overrides;
create trigger set_updated_at before update on core.overrides
  for each row execute function core.set_updated_at();

drop trigger if exists freeze_org_overrides on core.overrides;
create trigger freeze_org_overrides
  before update of organization_id on core.overrides
  for each row execute function core.freeze_organization_id();

alter table core.overrides enable row level security;
alter table core.overrides force row level security;

drop policy if exists overrides_select on core.overrides;
create policy overrides_select on core.overrides
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on core.overrides to authenticated;
grant select, insert on core.overrides to service_role;

-- The domain overrides write rows here without knowing about this table: the
-- audit trail already carries each one (the project row's start_override_reason,
-- scope_version.unfrozen with its reason, release.payment_overridden), so an
-- AFTER INSERT trigger on audit.audit_log mirrors exactly those entries — in
-- the same transaction as the override itself. SECURITY DEFINER because
-- core.overrides has no end-user write policy.
create or replace function core.mirror_override_from_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind   text;
  v_reason text;
  v_actor  uuid := case when new.actor_type = 'user' then new.actor_id else null end;
begin
  if new.organization_id is null then
    return null;
  end if;

  if new.action = 'scope_version.unfrozen' then
    v_kind := 'scope.unfreeze';
    v_reason := coalesce(new.after ->> 'reason', 'no reason recorded');
  elsif new.action = 'release.payment_overridden' then
    v_kind := 'release.payment_override';
    v_reason := coalesce(new.after ->> 'reason', new.after ->> 'override_reason', 'no reason recorded');
  elsif new.subject_type = 'project'
        and nullif(new.after ->> 'start_override_reason', '') is not null
        and (new.after ->> 'start_override_reason') is distinct from (new.before ->> 'start_override_reason') then
    v_kind := 'project.start_before_ready';
    v_reason := new.after ->> 'start_override_reason';
  else
    return null;
  end if;

  insert into core.overrides (organization_id, subject_type, subject_id, kind, reason, actor_id)
  values (new.organization_id, coalesce(new.subject_type, 'unknown'), new.subject_id, v_kind, v_reason, v_actor);

  return null;
end;
$$;

comment on function core.mirror_override_from_audit() is
  'Mirrors the three domain overrides the audit trail already records into core.overrides, in the same transaction (SCR-068). Ignores every other audit entry.';

drop trigger if exists mirror_override_from_audit on audit.audit_log;
create trigger mirror_override_from_audit
  after insert on audit.audit_log
  for each row execute function core.mirror_override_from_audit();

create or replace function core.record_manual_override(
  p_subject_type text,
  p_subject_id   uuid,
  p_kind         text,
  p_reason       text,
  p_expires_at   timestamptz default null
)
returns table (
  -- 'recorded'
  -- refusals: 'no_actor' | 'not_owner' | 'no_reason' | 'bad_kind' | 'bad_subject'
  outcome text,
  id      uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid := (select core.current_organization_id());
  v_reason  text := nullif(trim(coalesce(p_reason, '')), '');
  v_subject text := nullif(trim(coalesce(p_subject_type, '')), '');
  v_kind    text := nullif(trim(coalesce(p_kind, '')), '');
  v_id      uuid;
  v_after   jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.is_owner()), false) then
    return query select 'not_owner'::text, null::uuid; return;
  end if;
  if v_reason is null or length(v_reason) < 10 then
    return query select 'no_reason'::text, null::uuid; return;
  end if;
  if v_kind is null or v_kind !~ '^manual\.[a-z][a-z0-9_]*$' then
    return query select 'bad_kind'::text, null::uuid; return;
  end if;
  if v_subject is null or length(v_subject) > 40 then
    return query select 'bad_subject'::text, null::uuid; return;
  end if;

  insert into core.overrides (organization_id, subject_type, subject_id, kind, reason, actor_id, expires_at)
  values (v_org, v_subject, p_subject_id, v_kind, v_reason, v_actor, p_expires_at)
  returning core.overrides.id, to_jsonb(core.overrides.*) into v_id, v_after;

  perform core.record_audit(v_org, 'override.recorded', 'override', v_id, null, v_after);

  return query select 'recorded'::text, v_id;
end;
$$;

comment on function core.record_manual_override(text, uuid, text, text, timestamptz) is
  'Records an exception a person is taking responsibility for where no domain door exists (SCR-068). Owner only, reason of at least ten characters, kind manual.<slug>; audited as override.recorded.';

revoke all on function core.record_manual_override(text, uuid, text, text, timestamptz) from public, anon;
grant execute on function core.record_manual_override(text, uuid, text, text, timestamptz) to authenticated;

-- ── SCR-068: emergency controls ────────────────────────────────────────────

create table if not exists core.kill_switches (
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  switch           text not null check (switch in ('agents_paused', 'outbound_paused', 'jobs_paused')),
  active           boolean not null default false,
  reason           text,
  set_by           uuid references core.users(id) on delete set null,
  set_at           timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (organization_id, switch),
  constraint kill_switches_active_says_why check (not active or (reason is not null and length(trim(reason)) > 0))
);

comment on table core.kill_switches is
  'The three emergency stops (SCR-068): agents_paused (no agent job is claimed or continued), outbound_paused (crm.send_outbound_message refuses every send), jobs_paused (no job of any kind is claimed). Owner only, reason required, through core.set_kill_switch; read by core.org_paused wherever work is claimed or sent.';

drop trigger if exists set_updated_at on core.kill_switches;
create trigger set_updated_at before update on core.kill_switches
  for each row execute function core.set_updated_at();

drop trigger if exists freeze_org_kill_switches on core.kill_switches;
create trigger freeze_org_kill_switches
  before update of organization_id on core.kill_switches
  for each row execute function core.freeze_organization_id();

alter table core.kill_switches enable row level security;
alter table core.kill_switches force row level security;

drop policy if exists kill_switches_select on core.kill_switches;
create policy kill_switches_select on core.kill_switches
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on core.kill_switches to authenticated;
grant select, insert, update on core.kill_switches to service_role;

-- The read every chokepoint makes. SECURITY DEFINER so the claim functions and
-- the send function — which may run as the service role or as a session — get
-- the same answer without a policy in the way.
create or replace function core.org_paused(p_organization_id uuid, p_switch text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from core.kill_switches k
     where k.organization_id = p_organization_id
       and k.switch = p_switch
       and k.active
  );
$$;

comment on function core.org_paused(uuid, text) is
  'True when the named kill switch is engaged for the organisation (SCR-068).';

revoke all on function core.org_paused(uuid, text) from public, anon;
grant execute on function core.org_paused(uuid, text) to authenticated, service_role;

create or replace function core.set_kill_switch(p_switch text, p_active boolean, p_reason text)
returns table (
  -- 'set'
  -- refusals: 'no_actor' | 'not_owner' | 'bad_switch' | 'no_reason' | 'unchanged'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_owner()), false) then
    return query select 'not_owner'::text; return;
  end if;
  if p_switch is null or p_switch not in ('agents_paused', 'outbound_paused', 'jobs_paused') then
    return query select 'bad_switch'::text; return;
  end if;
  if v_reason is null then
    return query select 'no_reason'::text; return;
  end if;

  select to_jsonb(k.*) into v_before
    from core.kill_switches k
   where k.organization_id = v_org and k.switch = p_switch
   for update;

  if coalesce((v_before ->> 'active')::boolean, false) = coalesce(p_active, false) then
    return query select 'unchanged'::text; return;
  end if;

  insert into core.kill_switches (organization_id, switch, active, reason, set_by, set_at)
  values (v_org, p_switch, coalesce(p_active, false), v_reason, v_actor, now())
  on conflict (organization_id, switch) do update
     set active = excluded.active, reason = excluded.reason, set_by = excluded.set_by, set_at = now(), updated_at = now()
  returning to_jsonb(core.kill_switches.*) into v_after;

  perform core.record_audit(
    v_org,
    case when coalesce(p_active, false) then 'kill_switch.engaged' else 'kill_switch.released' end,
    'kill_switch', null, v_before, v_after
  );

  return query select 'set'::text;
end;
$$;

comment on function core.set_kill_switch(text, boolean, text) is
  'Engages or releases one emergency stop with a reason (SCR-068). Owner only; audited as kill_switch.engaged / kill_switch.released.';

revoke all on function core.set_kill_switch(text, boolean, text) from public, anon;
grant execute on function core.set_kill_switch(text, boolean, text) to authenticated;

-- The claims honour the switches. Both bodies are the live definitions read
-- back with pg_get_functiondef, each with one marked edit in the WHERE.
CREATE OR REPLACE FUNCTION core.claim_agent_job(p_worker_id text, p_kinds text[])
 RETURNS SETOF core.jobs
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update core.jobs j
     set status    = 'running',
         locked_at = now(),
         locked_by = p_worker_id,
         -- Against the row being locked, not a copy read a statement earlier —
         -- the property `claim_jobs` exists to hold, held the same way here.
         attempts  = j.attempts + 1
   where j.id = (
     select id
       from core.jobs
      where kind = any(p_kinds)
        and status = 'queued'
        and run_at <= now()
        -- EDIT (20261001150000): an organisation whose agents or jobs are
        -- paused has nothing claimable. The row waits, unclaimed and
        -- unattempted, until the owner releases the switch.
        and not core.org_paused(organization_id, 'agents_paused')
        and not core.org_paused(organization_id, 'jobs_paused')
      -- The whole of the fix. Ordered by what the queue is actually about:
      -- what has waited longest, not what the caller listed first.
      order by priority, run_at, id
      limit 1
        for update skip locked
   )
  returning j.*;
$function$;

CREATE OR REPLACE FUNCTION core.claim_jobs(p_worker_id text, p_kind text, p_batch_size integer DEFAULT 1)
 RETURNS SETOF core.jobs
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update core.jobs j
     set status    = 'running',
         locked_at = now(),
         locked_by = p_worker_id,
         -- Evaluated against the row being locked, not against a copy read a
         -- statement earlier. This is the whole of it: two runners cannot both
         -- write "the count I saw, plus one".
         attempts  = j.attempts + 1
   where j.id in (
     select id
       from core.jobs
      where kind = p_kind
        and status = 'queued'
        and run_at <= now()
        -- EDIT (20261001150000): jobs_paused holds every kind back.
        and not core.org_paused(organization_id, 'jobs_paused')
      order by priority, run_at
      -- G-119. Total, not merely conventional: `LIMIT NULL` is no limit at
      -- all, so a null here claimed every queued job of the kind into one
      -- worker and stranded all but one in `running`. `greatest(…, 1)` also
      -- refuses 0 and negatives, which would claim nothing and report an
      -- empty queue — the same lie in the other direction.
      limit greatest(coalesce(p_batch_size, 1), 1)
        -- The second runner steps over a row somebody else is taking rather
        -- than blocking on it, which is what keeps one slow claim from stalling
        -- a tick.
        for update skip locked
   )
  returning j.*;
$function$;

-- The send chokepoint honours outbound_paused. The body is the live
-- definition read back with pg_get_functiondef, with one marked edit.
CREATE OR REPLACE FUNCTION crm.send_outbound_message(p_conversation_id uuid, p_body text, p_external_ref text, p_author_id uuid DEFAULT NULL::uuid, p_media_type text DEFAULT NULL::text, p_media_filename text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, message_id uuid, seq integer, to_phone text, from_phone_number_id text, recipient_type text, delivery text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_conversation crm.conversations;
  v_existing     crm.conversation_messages;
  v_next         int;
  v_row          crm.conversation_messages;
  v_contact      crm.contacts;
  v_settings     jsonb;
  v_is_group     boolean;
begin
  -- ── EDIT 2 (the only new refusal) ─────────────────────────────────────────
  -- A document row and a text row are exclusive shapes, and the exclusivity
  -- is already law: conversation_messages_body_check makes body-with-media a
  -- constraint violation. Refusing here turns that violation into an answer
  -- a caller can read. `document` only — this function has no business
  -- claiming an outbound image or voice note was sent when nothing here can
  -- send one, and the inbound reading engine (crm.awaits_media_reading)
  -- wakes for image/audio rows, which an outbound send must never look like.
  if p_media_type is not null and (p_media_type <> 'document' or length(trim(p_body)) > 0) then
    return query select 'bad_shape'::text, null::uuid, null::int, null::text, null::text, null::text, null::text;
    return;
  end if;

  select c.* into v_conversation
    from crm.conversations c
   where c.id = p_conversation_id
   for update;

  if v_conversation.id is null then
    return query select 'not_found'::text, null::uuid, null::int, null::text, null::text, null::text, null::text;
    return;
  end if;

  -- ── EDIT (20261001150000): the outbound kill switch ─────────────────────
  -- SCR-068 emergency controls. When the owner has paused outbound for this
  -- organisation (core.kill_switches 'outbound_paused'), nothing is recorded
  -- and nothing is sent: refused here, at the one chokepoint every send
  -- passes, so no caller can skip it by not knowing about it. Checked before
  -- consent and before the idempotency lookup: a paused send must not become
  -- a sent one by being retried while the switch is on.
  if core.org_paused(v_conversation.organization_id, 'outbound_paused') then
    return query select 'outbound_paused'::text, null::uuid, null::int, null::text, null::text, null::text, null::text;
    return;
  end if;

  v_is_group := v_conversation.kind in ('project_group', 'internal_group');

  -- ── consent, at the chokepoint ─────────────────────────────────────────
  --
  -- G-012, ADM-70, ADM-81. Placed here rather than in a caller because ADM-70
  -- required the communication system to enforce it: both callers pass through
  -- this function, so a future third one does not get to skip the rule by not
  -- knowing about it. That is the G-093 argument again.
  --
  -- Checked BEFORE the idempotency lookup deliberately. A send that was
  -- refused for want of consent must not become permitted by being retried.
  -- `direct` only, and the boundary is a category judgement rather than a
  -- convenience. This consent model is per contact per channel, and `direct`
  -- is the only kind that has a contact.
  --
  -- A `project_group` has none, so group consent is UNMODELLED and recorded as
  -- G-136 / ADM-86 rather than quietly resolved here — refusing every group
  -- send would break the group messaging G-014 and G-109 built, and pretending
  -- a group "consented" would invent a record nobody made.
  --
  -- `internal_group` is exempt because there is no client on the other end at
  -- all: the approval announcement runs through this same function, and
  -- suppressing it would silently break G-110.
  --
  -- G-139: `client_account` joins `direct` here. A post-project thread carries
  -- the client account's contact, so it IS a kind that has a contact, and the
  -- same per-contact consent rule applies — it is client-facing communication.
  if v_conversation.kind in ('direct', 'client_account') then
    if v_conversation.contact_id is null then
      -- A client-facing conversation with nobody identifiable on the other
      -- end. Refused rather than allowed: treating "no identifiable contact"
      -- as "no objection" is how a consent model becomes decorative.
      return query select 'no_consent'::text, null::uuid, null::int,
                          null::text, null::text, null::text, null::text;
      return;
    end if;

    if not exists (
      select 1
        from crm.communication_consent cc
       where cc.organization_id = v_conversation.organization_id
         and cc.contact_id      = v_conversation.contact_id
         and cc.channel         = 'whatsapp'
         and cc.status          = 'granted'
    ) then
      -- Absent and withdrawn are the same answer. ADM-70: absent consent means
      -- do not send, and withdrawn stops future sends on that channel.
      return query select 'no_consent'::text, null::uuid, null::int,
                          null::text, null::text, null::text, null::text;
      return;
    end if;
  end if;

  select m.* into v_existing
    from crm.conversation_messages m
   where m.organization_id = v_conversation.organization_id
     and m.external_ref    = p_external_ref;

  select o.settings into v_settings
    from core.organizations o
   where o.id = v_conversation.organization_id;

  if v_existing.id is not null then
    -- A retry of the same send. The recipient is recomputed rather than
    -- remembered, so a caller that retries after a group was linked gets the
    -- current answer instead of the one that was true the first time. And now
    -- the delivery state travels with it, so the caller sends again only if
    -- the row is not already `sent`.
    select ct.* into v_contact from crm.contacts ct where ct.id = v_conversation.contact_id;

    return query select 'already_sent'::text, v_existing.id, v_existing.seq,
                        -- EDIT (G-159): an internal_direct channel is addressed by the
                        -- number inside its own external_ref — it has no contact row to
                        -- read a phone from, and it is not a group.
                        case when v_is_group then v_conversation.external_ref
                             when v_conversation.kind = 'internal_direct'
                               then regexp_replace(v_conversation.external_ref, '^internal:\+', '')
                             else v_contact.phone end,
                        v_settings->>'whatsapp_phone_number_id',
                        case when v_is_group then 'group' else 'individual' end,
                        coalesce(v_existing.metadata->>'delivery', 'pending');
    return;
  end if;

  -- `-1`, not `0`: a thread's first message is seq 0. Carried forward from the
  -- original verbatim, because rewriting it as `coalesce(max, 0) + 1` — which
  -- is what this said for one commit — shifts every thread's numbering by one
  -- and was caught only by verify-outbound-messages asserting the first seq.
  -- Exactly the regeneration drift D16 was.
  select coalesce(max(m.seq), -1) + 1 into v_next
    from crm.conversation_messages m
   where m.conversation_id = p_conversation_id;

  insert into crm.conversation_messages (
    organization_id, conversation_id, seq, author_type, author_id,
    body, external_ref, metadata, occurred_at
  )
  values (
    v_conversation.organization_id, p_conversation_id, v_next, 'user', p_author_id,
    -- EDIT 3: a document row records an empty body (the body check's media
    -- shape) and carries its kind and filename in metadata, exactly where the
    -- inbound ingest records a client's media. `direction` says which way it
    -- went; media_id is deliberately absent, so nothing tries to re-read it.
    case when p_media_type is null then p_body else '' end, p_external_ref,
    jsonb_build_object('channel', 'whatsapp', 'direction', 'outbound', 'delivery', 'pending')
      || case when p_media_type is null then '{}'::jsonb
              else jsonb_build_object('media_type', p_media_type, 'media_filename', p_media_filename) end,
    now()
  )
  returning * into v_row;

  select ct.* into v_contact from crm.contacts ct where ct.id = v_conversation.contact_id;

  perform core.record_audit(
    v_conversation.organization_id,
    'message.outbound.queued',
    'conversation_message',
    v_row.id,
    null,
    jsonb_build_object('conversation_id', p_conversation_id, 'seq', v_next)
  );

  return query select 'created'::text, v_row.id, v_next,
                      -- The whole fix, in one expression: a group is addressed
                      -- by the provider id G-109 already stores, not by a
                      -- contact's phone that a group does not have.
                      -- EDIT (G-159): and an internal_direct channel by the number
                      -- inside its own external_ref, as an individual.
                      case when v_is_group then v_conversation.external_ref
                           when v_conversation.kind = 'internal_direct'
                             then regexp_replace(v_conversation.external_ref, '^internal:\+', '')
                           else v_contact.phone end,
                      v_settings->>'whatsapp_phone_number_id',
                      case when v_is_group then 'group' else 'individual' end,
                      'pending'::text;
end;
$function$;

-- ── SCR-069: security incidents and access reviews ─────────────────────────

create schema if not exists security;

comment on schema security is
  'Security governance (SCR-069): incidents a person opened and resolved, and access reviews of memberships. Distinct from audit, which is the trail, and from core, which is the tenancy.';

grant usage on schema security to authenticated, service_role;

-- The same appending block the approvals and qa schemas needed: a schema a
-- migration creates is not in pgrst.db_schemas, and the failure mode is every
-- call answering 406. Additive; a warning if the role cannot be altered.
do $$
declare v_list text;
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then return; end if;

  select split_part(cfg, '=', 2) into v_list
    from pg_roles r, unnest(r.rolconfig) as cfg
   where r.rolname = 'authenticator' and cfg like 'pgrst.db_schemas=%';

  if v_list is null or position('security' in v_list) > 0 then return; end if;

  execute format('alter role authenticator set pgrst.db_schemas = %L', v_list || ', security');
  notify pgrst, 'reload config';
exception
  when insufficient_privilege then
    raise warning 'could not expose the security schema (%). Add it in Dashboard -> Project Settings -> API -> Exposed schemas.', sqlerrm;
end;
$$;

create table if not exists security.incidents (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  kind             text not null check (kind in (
                     'unauthorized_access', 'credential_exposure', 'data_exposure',
                     'policy_violation', 'suspicious_activity', 'other'
                   )),
  severity         text not null check (severity in ('low', 'medium', 'high', 'critical')),
  summary          text not null check (length(trim(summary)) > 0),
  -- What was seen: audit entry ids, run ids, free notes. Recorded, never interpreted.
  evidence         jsonb not null default '{}'::jsonb,
  opened_by        uuid references core.users(id) on delete set null,
  opened_at        timestamptz not null default now(),
  resolved_by      uuid references core.users(id) on delete set null,
  resolved_at      timestamptz,
  resolution       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint incidents_resolution_is_whole check (
    (resolved_at is null and resolved_by is null and resolution is null)
    or (resolved_at is not null and resolved_by is not null and resolution is not null)
  )
);

comment on table security.incidents is
  'A security incident or exception a person opened, with its evidence, and how it was resolved (SCR-069). Written only through security.open_incident and security.resolve_incident (owner or ops_admin, audited).';

create index if not exists incidents_org_idx
  on security.incidents (organization_id, resolved_at, opened_at desc);

drop trigger if exists set_updated_at on security.incidents;
create trigger set_updated_at before update on security.incidents
  for each row execute function core.set_updated_at();

drop trigger if exists freeze_org_incidents on security.incidents;
create trigger freeze_org_incidents
  before update of organization_id on security.incidents
  for each row execute function core.freeze_organization_id();

alter table security.incidents enable row level security;
alter table security.incidents force row level security;

drop policy if exists incidents_select on security.incidents;
create policy incidents_select on security.incidents
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on security.incidents to authenticated;
grant select, insert, update on security.incidents to service_role;

create or replace function security.open_incident(
  p_kind     text,
  p_severity text,
  p_summary  text,
  p_evidence jsonb default '{}'::jsonb
)
returns table (
  -- 'opened'
  -- refusals: 'no_actor' | 'not_authorized' | 'bad_kind' | 'bad_severity' | 'no_summary'
  outcome text,
  id      uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid := (select core.current_organization_id());
  v_summary text := nullif(trim(coalesce(p_summary, '')), '');
  v_id      uuid;
  v_after   jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;
  if p_kind is null or p_kind not in ('unauthorized_access', 'credential_exposure', 'data_exposure', 'policy_violation', 'suspicious_activity', 'other') then
    return query select 'bad_kind'::text, null::uuid; return;
  end if;
  if p_severity is null or p_severity not in ('low', 'medium', 'high', 'critical') then
    return query select 'bad_severity'::text, null::uuid; return;
  end if;
  if v_summary is null then
    return query select 'no_summary'::text, null::uuid; return;
  end if;

  insert into security.incidents (organization_id, kind, severity, summary, evidence, opened_by)
  values (v_org, p_kind, p_severity, v_summary, coalesce(p_evidence, '{}'::jsonb), v_actor)
  returning security.incidents.id, to_jsonb(security.incidents.*) into v_id, v_after;

  perform core.record_audit(v_org, 'security_incident.opened', 'security_incident', v_id, null, v_after);

  return query select 'opened'::text, v_id;
end;
$$;

comment on function security.open_incident(text, text, text, jsonb) is
  'Opens a security incident with its evidence (SCR-069). Owner or ops_admin; audited as security_incident.opened.';

revoke all on function security.open_incident(text, text, text, jsonb) from public, anon;
grant execute on function security.open_incident(text, text, text, jsonb) to authenticated;

create or replace function security.resolve_incident(p_incident_id uuid, p_resolution text)
returns table (
  -- 'resolved'
  -- refusals: 'no_actor' | 'not_authorized' | 'no_resolution' | 'not_found' | 'already_resolved'
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
  v_resolution text := nullif(trim(coalesce(p_resolution, '')), '');
  v_before     jsonb;
  v_after      jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if v_resolution is null then
    return query select 'no_resolution'::text; return;
  end if;

  select to_jsonb(i.*) into v_before
    from security.incidents i
   where i.id = p_incident_id and i.organization_id = v_org
   for update;

  if v_before is null then
    return query select 'not_found'::text; return;
  end if;
  if (v_before ->> 'resolved_at') is not null then
    return query select 'already_resolved'::text; return;
  end if;

  update security.incidents
     set resolved_by = v_actor, resolved_at = now(), resolution = v_resolution
   where id = p_incident_id
  returning to_jsonb(security.incidents.*) into v_after;

  perform core.record_audit(v_org, 'security_incident.resolved', 'security_incident', p_incident_id, v_before, v_after);

  return query select 'resolved'::text;
end;
$$;

comment on function security.resolve_incident(uuid, text) is
  'Resolves a security incident with a stated resolution (SCR-069). Owner or ops_admin; audited as security_incident.resolved.';

revoke all on function security.resolve_incident(uuid, text) from public, anon;
grant execute on function security.resolve_incident(uuid, text) to authenticated;

create table if not exists security.access_reviews (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  membership_id    uuid not null references core.memberships(id) on delete cascade,
  reviewer_id      uuid references core.users(id) on delete set null,
  decision         text not null check (decision in ('confirmed', 'revoke_requested')),
  note             text,
  reviewed_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table security.access_reviews is
  'One row per time an admin reviewed a membership''s access and said whether it stands (SCR-069). A revoke_requested decision does not itself revoke anything — suspension is core.set_membership_status''s door — it records that a person judged the access should go. Written only through security.record_access_review.';

create index if not exists access_reviews_membership_idx
  on security.access_reviews (organization_id, membership_id, reviewed_at desc);

drop trigger if exists set_updated_at on security.access_reviews;
create trigger set_updated_at before update on security.access_reviews
  for each row execute function core.set_updated_at();

drop trigger if exists freeze_org_access_reviews on security.access_reviews;
create trigger freeze_org_access_reviews
  before update of organization_id on security.access_reviews
  for each row execute function core.freeze_organization_id();

drop trigger if exists org_match_access_reviews_membership on security.access_reviews;
create trigger org_match_access_reviews_membership
  before insert or update of membership_id, organization_id on security.access_reviews
  for each row execute function core.enforce_parent_org('membership_id', 'core.memberships');

alter table security.access_reviews enable row level security;
alter table security.access_reviews force row level security;

drop policy if exists access_reviews_select on security.access_reviews;
create policy access_reviews_select on security.access_reviews
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on security.access_reviews to authenticated;
grant select, insert on security.access_reviews to service_role;

create or replace function security.record_access_review(p_membership_id uuid, p_decision text, p_note text default null)
returns table (
  -- 'recorded'
  -- refusals: 'no_actor' | 'not_authorized' | 'bad_decision' | 'not_a_member' | 'note_required'
  outcome text,
  id      uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_note  text := nullif(trim(coalesce(p_note, '')), '');
  v_id    uuid;
  v_after jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;
  if p_decision is null or p_decision not in ('confirmed', 'revoke_requested') then
    return query select 'bad_decision'::text, null::uuid; return;
  end if;
  -- Asking for somebody's access to go is a judgement that needs its reason.
  if p_decision = 'revoke_requested' and v_note is null then
    return query select 'note_required'::text, null::uuid; return;
  end if;
  if not exists (select 1 from core.memberships m where m.id = p_membership_id and m.organization_id = v_org) then
    return query select 'not_a_member'::text, null::uuid; return;
  end if;

  insert into security.access_reviews (organization_id, membership_id, reviewer_id, decision, note)
  values (v_org, p_membership_id, v_actor, p_decision, v_note)
  returning security.access_reviews.id, to_jsonb(security.access_reviews.*) into v_id, v_after;

  perform core.record_audit(v_org, 'access.reviewed', 'membership', p_membership_id, null, v_after);

  return query select 'recorded'::text, v_id;
end;
$$;

comment on function security.record_access_review(uuid, text, text) is
  'Records an access review of one membership: confirmed, or revoke requested with a note (SCR-069). Owner or ops_admin; audited as access.reviewed.';

revoke all on function security.record_access_review(uuid, text, text) from public, anon;
grant execute on function security.record_access_review(uuid, text, text) to authenticated;

-- The realtime publication gains core.alerts and core.kill_switches in the
-- companion file 20261001150001 (a publication file lists tables and nothing
-- else, which the realtime test holds it to).

notify pgrst, 'reload schema';
