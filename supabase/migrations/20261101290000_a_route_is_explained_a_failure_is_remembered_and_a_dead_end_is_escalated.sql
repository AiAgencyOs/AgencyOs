-- Orchestrator Phase 5 (spec 21, 28, 31): a routing decision carries WHY (candidates and the reason each was not chosen, policy version, baseline
-- references); a failed attempt is a durable record with what was decided about it; a task nothing can take is escalated to a person with the reason.

alter table projects.routing_decisions
  add column if not exists candidates jsonb not null default '[]'::jsonb check (jsonb_typeof(candidates) = 'array'),
  add column if not exists policy_version text,
  add column if not exists baseline_refs jsonb not null default '{}'::jsonb check (jsonb_typeof(baseline_refs) = 'object'),
  add column if not exists correlation_id uuid,
  add column if not exists requires_security_review boolean not null default false;

create table if not exists projects.execution_attempts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  task_id          uuid not null references projects.tasks(id) on delete cascade,
  attempt          integer not null check (attempt >= 1),
  failure_class    text not null check (failure_class in (
    'transient_provider_error', 'timeout', 'rate_limit', 'tool_failure', 'schema_failure', 'invalid_output', 'permission_denied', 'no_capable_route',
    'side_effect_uncertain', 'business_guard_failure', 'build_failure', 'test_failure', 'dependency_blocked', 'repo_conflict', 'policy_block', 'tool_unavailable')),
  retry            text not null check (retry in ('safe', 'after_reconcile', 'never')),
  fallback         boolean not null,
  escalate         boolean not null,
  detail           text,
  created_at       timestamptz not null default now(),
  unique (task_id, attempt, failure_class)
);
create index if not exists execution_attempts_task_idx on projects.execution_attempts (task_id, attempt);

create table if not exists projects.orchestrator_escalations (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references core.organizations(id) on delete cascade,
  project_id           uuid not null references projects.projects(id) on delete cascade,
  task_id              uuid not null references projects.tasks(id) on delete cascade,
  required_capability  text,
  root_cause           text not null check (root_cause in ('no_capability', 'not_a_specialist', 'no_route', 'activation_condition', 'production_deploy_not_permitted', 'failure')),
  candidates           jsonb not null default '[]'::jsonb check (jsonb_typeof(candidates) = 'array'),
  recommendation       text not null check (length(btrim(recommendation)) > 0),
  status               text not null default 'open' check (status in ('open', 'resolved')),
  resolved_by          uuid references core.users(id) on delete set null,
  resolved_at          timestamptz,
  resolution           text,
  created_at           timestamptz not null default now(),
  check ((status = 'open') or (resolved_at is not null and resolution is not null and length(btrim(resolution)) > 0))
);
create unique index if not exists orchestrator_escalations_open_key on projects.orchestrator_escalations (task_id, root_cause) where status = 'open';

do $m$
declare t text;
begin
  foreach t in array array['execution_attempts', 'orchestrator_escalations'] loop
    execute format('alter table projects.%I enable row level security', t);
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
  end loop;
end $m$;

-- an attempt is a fact: append-only
create or replace function projects.execution_attempts_append_only() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'an execution attempt is never rewritten' using errcode = 'restrict_violation'; end $$;
drop trigger if exists execution_attempts_append_only on projects.execution_attempts;
create trigger execution_attempts_append_only before update or delete on projects.execution_attempts for each row execute function projects.execution_attempts_append_only();

-- the runner records a failed attempt (service_role only): the organization comes from the TASK
create or replace function projects.record_execution_failure(p_task_id uuid, p_attempt integer, p_failure_class text, p_retry text, p_fallback boolean, p_escalate boolean, p_detail text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_task projects.tasks;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text; return; end if;
  select * into v_task from projects.tasks t where t.id = p_task_id;
  if v_task.id is null then return query select 'not_found'::text; return; end if;
  begin
    insert into projects.execution_attempts (organization_id, project_id, task_id, attempt, failure_class, retry, fallback, escalate, detail)
    values (v_task.organization_id, v_task.project_id, v_task.id, p_attempt, p_failure_class, p_retry, p_fallback, p_escalate, left(p_detail, 1000))
    on conflict (task_id, attempt, failure_class) do nothing;
  exception when check_violation then return query select 'bad_input'::text; return;
  end;
  if p_escalate then
    insert into projects.orchestrator_escalations (organization_id, project_id, task_id, required_capability, root_cause, recommendation)
    values (v_task.organization_id, v_task.project_id, v_task.id, v_task.required_capability, 'failure',
            'Attempt ' || p_attempt || ' failed (' || p_failure_class || ') and the failure rules say a person decides next. ' || coalesce(left(p_detail, 300), ''))
    on conflict (task_id, root_cause) where status = 'open' do nothing;
  end if;
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_execution_failure(uuid, integer, text, text, boolean, boolean, text) from public, anon, authenticated;
grant execute on function projects.record_execution_failure(uuid, integer, text, text, boolean, boolean, text) to service_role;

-- an Admin closes an escalation with the decision taken
create or replace function projects.resolve_escalation(p_escalation_id uuid, p_resolution text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_resolution is null or length(btrim(p_resolution)) = 0 then return query select 'resolution_required'::text; return; end if;
  update projects.orchestrator_escalations set status = 'resolved', resolved_by = v_actor, resolved_at = now(), resolution = btrim(p_resolution)
   where id = p_escalation_id and organization_id = v_org and status = 'open';
  if not found then return query select 'not_found_or_closed'::text; return; end if;
  perform core.record_audit(v_org, 'orchestrator.escalation_resolved', 'orchestrator_escalation', p_escalation_id, null, null);
  return query select 'resolved'::text;
end $$;
revoke all on function projects.resolve_escalation(uuid, text) from public, anon;
grant execute on function projects.resolve_escalation(uuid, text) to authenticated;
notify pgrst, 'reload schema';
