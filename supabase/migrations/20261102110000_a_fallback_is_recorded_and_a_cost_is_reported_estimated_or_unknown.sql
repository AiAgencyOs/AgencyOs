-- Orchestrator depth (Phase 5 Orchestrator spec 20, 22): a fallback is a recorded decision that was validated, and a usage cost says where its number came from.

-- ── FallbackRecord ──────────────────────────────────────────────────────────
-- The validator is pure TypeScript over the agent registry (src/modules/agents/registry.ts, which is not in the database). What the database keeps is
-- the verdict and its reasons, and one rule it can enforce alone: a fallback is ACCEPTED exactly when no violation was found.
create table if not exists projects.fallback_records (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  task_id          uuid references projects.tasks(id) on delete cascade,
  primary_agent    text not null check (length(btrim(primary_agent)) > 0 and length(primary_agent) <= 80),
  fallback_agent   text not null check (length(btrim(fallback_agent)) > 0 and length(fallback_agent) <= 80),
  failure_class    text check (failure_class is null or length(failure_class) <= 80),
  reason           text not null check (length(btrim(reason)) > 0 and length(reason) <= 500),
  violations       jsonb not null default '[]'::jsonb check (jsonb_typeof(violations) = 'array'),
  outcome          text not null check (outcome in ('accepted', 'rejected')),
  created_at       timestamptz not null default now(),
  check ((outcome = 'accepted') = (jsonb_array_length(violations) = 0))
);
comment on table projects.fallback_records is
  'Orchestrator spec 20: the primary route that failed, the fallback considered, why, and whether it was accepted. Accepted only with zero violations. Append-only; written through projects.record_fallback (service role).';
create index if not exists fallback_records_project_idx on projects.fallback_records (project_id, created_at desc);
create index if not exists fallback_records_task_idx on projects.fallback_records (task_id) where task_id is not null;

-- ── UsageCostRecord ─────────────────────────────────────────────────────────
-- A number whose source is unknown is not zero. `unknown` carries NULL cost and the other two sources carry a number, so a dashboard that sums the
-- column can not mistake "we do not know" for "free".
create table if not exists projects.usage_cost_records (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  task_id          uuid references projects.tasks(id) on delete cascade,
  agent_key        text not null check (length(btrim(agent_key)) > 0 and length(agent_key) <= 80),
  provider         text check (provider is null or length(provider) <= 80),
  model            text check (model is null or length(model) <= 120),
  input_tokens     bigint check (input_tokens is null or input_tokens >= 0),
  output_tokens    bigint check (output_tokens is null or output_tokens >= 0),
  cost_source      text not null check (cost_source in ('reported', 'estimated', 'unknown')),
  cost_usd         numeric(14, 6),
  created_at       timestamptz not null default now(),
  constraint usage_cost_unknown_has_no_number check (
    (cost_source = 'unknown' and cost_usd is null) or (cost_source in ('reported', 'estimated') and cost_usd is not null and cost_usd >= 0)
  )
);
comment on table projects.usage_cost_records is
  'Orchestrator spec 22: what a run cost and where that number came from. cost_source = unknown means NULL cost, never 0. Append-only; written through projects.record_usage_cost (service role).';
create index if not exists usage_cost_records_project_idx on projects.usage_cost_records (project_id, created_at desc);

-- a fallback decision and a cost fact are never rewritten (deleted only with their project or organization, by cascade)
create or replace function projects.orchestrator_records_append_only() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'a % record is never rewritten', tg_table_name using errcode = 'restrict_violation'; end $$;

do $m$
declare t text;
begin
  foreach t in array array['fallback_records', 'usage_cost_records'] loop
    execute format('alter table projects.%I enable row level security', t);
    execute format('alter table projects.%I force row level security', t);
    execute format('drop policy if exists %I on projects.%I', t || '_read', t);
    execute format('create policy %I on projects.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))', t || '_read', t);
    execute format('revoke all on projects.%I from public, anon', t);
    execute format('revoke insert, update, delete on projects.%I from authenticated', t);
    execute format('grant select on projects.%I to authenticated', t);
    execute format('grant all on projects.%I to service_role', t);
    execute format('drop trigger if exists %I on projects.%I', t || '_parent_org_project', t);
    execute format('create trigger %I before insert or update of project_id on projects.%I for each row execute function core.enforce_parent_org(%L, %L)', t || '_parent_org_project', t, 'project_id', 'projects.projects');
    execute format('drop trigger if exists %I on projects.%I', t || '_parent_org_task', t);
    execute format('create trigger %I before insert or update of task_id on projects.%I for each row execute function core.enforce_parent_org(%L, %L)', t || '_parent_org_task', t, 'task_id', 'projects.tasks');
    execute format('drop trigger if exists %I on projects.%I', 'freeze_org_' || t, t);
    execute format('create trigger %I before update of organization_id on projects.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || t, t);
    execute format('drop trigger if exists %I on projects.%I', t || '_append_only', t);
    execute format('create trigger %I before update on projects.%I for each row execute function projects.orchestrator_records_append_only()', t || '_append_only', t);
  end loop;
end $m$;

-- ── record a fallback decision ──────────────────────────────────────────────
create or replace function projects.record_fallback(p_task_id uuid, p_primary_agent text, p_fallback_agent text, p_reason text, p_violations jsonb default '[]'::jsonb, p_failure_class text default null)
returns table (outcome text, fallback_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_task projects.tasks; v_id uuid; v_outcome text;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_task from projects.tasks t where t.id = p_task_id;
  if v_task.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if p_violations is null or jsonb_typeof(p_violations) <> 'array' or p_reason is null or length(btrim(p_reason)) = 0 then
    return query select 'bad_input'::text, null::uuid; return;
  end if;
  -- a fallback onto itself is not a fallback
  if p_primary_agent is not distinct from p_fallback_agent then return query select 'same_agent'::text, null::uuid; return; end if;
  v_outcome := case when jsonb_array_length(p_violations) = 0 then 'accepted' else 'rejected' end;
  begin
    insert into projects.fallback_records (organization_id, project_id, task_id, primary_agent, fallback_agent, failure_class, reason, violations, outcome)
    values (v_task.organization_id, v_task.project_id, v_task.id, btrim(p_primary_agent), btrim(p_fallback_agent), p_failure_class, left(btrim(p_reason), 500), p_violations, v_outcome)
    returning id into v_id;
  exception when check_violation or not_null_violation then return query select 'bad_input'::text, null::uuid; return;
  end;
  perform core.record_audit(v_task.organization_id, 'orchestrator.fallback_' || v_outcome, 'fallback_record', v_id, null,
                            jsonb_build_object('task_id', v_task.id, 'primary', p_primary_agent, 'fallback', p_fallback_agent, 'violations', p_violations));
  return query select v_outcome, v_id;
end $$;
revoke all on function projects.record_fallback(uuid, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function projects.record_fallback(uuid, text, text, text, jsonb, text) to service_role;

-- ── record a usage cost ─────────────────────────────────────────────────────
create or replace function projects.record_usage_cost(
  p_project_id uuid, p_agent_key text, p_cost_source text, p_cost_usd numeric default null,
  p_task_id uuid default null, p_provider text default null, p_model text default null, p_input_tokens bigint default null, p_output_tokens bigint default null)
returns table (outcome text, usage_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_task_project uuid; v_id uuid;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid; return; end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id;
  if v_org is null then return query select 'not_found'::text, null::uuid; return; end if;
  if p_task_id is not null then
    select t.project_id into v_task_project from projects.tasks t where t.id = p_task_id;
    if v_task_project is distinct from p_project_id then return query select 'task_not_in_project'::text, null::uuid; return; end if;
  end if;
  if p_cost_source = 'unknown' and p_cost_usd is not null then return query select 'unknown_has_no_cost'::text, null::uuid; return; end if;
  if p_cost_source in ('reported', 'estimated') and p_cost_usd is null then return query select 'cost_required'::text, null::uuid; return; end if;
  begin
    insert into projects.usage_cost_records (organization_id, project_id, task_id, agent_key, provider, model, input_tokens, output_tokens, cost_source, cost_usd)
    values (v_org, p_project_id, p_task_id, btrim(p_agent_key), p_provider, p_model, p_input_tokens, p_output_tokens, p_cost_source, p_cost_usd)
    returning id into v_id;
  exception when check_violation or not_null_violation or numeric_value_out_of_range then return query select 'bad_input'::text, null::uuid; return;
  end;
  return query select 'recorded'::text, v_id;
end $$;
revoke all on function projects.record_usage_cost(uuid, text, text, numeric, uuid, text, text, bigint, bigint) from public, anon, authenticated;
grant execute on function projects.record_usage_cost(uuid, text, text, numeric, uuid, text, text, bigint, bigint) to service_role;

-- ── staff read: totals per source, an unknown total stays unknown ───────────
-- SECURITY INVOKER: the table's own policy (internal staff of this organization) decides who sees what. An `unknown` group sums NULLs and so answers
-- NULL, never 0: the panel shows "unknown", not a free run.
create or replace function projects.usage_cost_summary(p_project_id uuid)
returns table (cost_source text, records bigint, input_tokens bigint, output_tokens bigint, cost_usd numeric)
language sql stable security invoker set search_path = '' as $$
  select u.cost_source, count(*), sum(u.input_tokens)::bigint, sum(u.output_tokens)::bigint, sum(u.cost_usd)
    from projects.usage_cost_records u
   where u.project_id = p_project_id
   group by u.cost_source
   order by u.cost_source
$$;
revoke all on function projects.usage_cost_summary(uuid) from public, anon;
grant execute on function projects.usage_cost_summary(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
