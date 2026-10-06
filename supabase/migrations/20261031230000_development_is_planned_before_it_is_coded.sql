-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 Development Planning (Master Flow: TECHNICAL ANALYSIS -> PLANNING -> TASK BREAKDOWN -> DEPENDENCY GRAPH -> SPECIALIST ASSIGNMENT).
--
-- Reuses projects.tasks and task_dependencies; adds only what planning needs and the database can enforce:
--   tasks.acceptance_criteria / required_capability / risk_level / affected_paths / plan_id
--   projects.development_plans   versioned plan over ONE locked baseline (summary, risks, test strategy, rollback); frozen once approved
--   projects.check_development_plan   the plan's problems, named: scope not covered by a task, a task with no acceptance criteria, a capability that is
--        not a development specialist (or is NOT_REQUIRED on this project), a dependency cycle, two tasks on the same files with no sequencing
--   projects.approve_development_plan   an Admin approves a plan only when that list is empty
--   projects.start_task   a task starts only from an approved plan, and not beside an unsequenced task on the same files
-- Planning is not the PM's job (PM Agent hard boundary): the PM cannot approve a plan; only an Admin can.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.development_plans (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  baseline_id      uuid not null references projects.development_baselines(id) on delete restrict,
  version          int not null check (version > 0),
  status           text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  summary          text not null check (length(btrim(summary)) > 0),
  risks            text,
  test_strategy    text,
  rollback_plan    text,
  created_by       uuid references core.users(id) on delete set null,
  approved_by      uuid references core.users(id) on delete set null,
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id, version),
  check ((status = 'approved') = (approved_by is not null and approved_at is not null) or status = 'superseded')
);
create unique index if not exists development_plans_one_approved on projects.development_plans (project_id) where status = 'approved';
alter table projects.development_plans enable row level security;
drop policy if exists development_plans_read on projects.development_plans;
create policy development_plans_read on projects.development_plans for select to authenticated
  using (organization_id = (select core.current_organization_id()));
grant select on projects.development_plans to authenticated;
grant all on projects.development_plans to service_role;
do $$
declare r record;
begin
  for r in select * from (values ('project_id', 'projects.projects'), ('baseline_id', 'projects.development_baselines')) as t(col, parent) loop
    execute format('drop trigger if exists %I on projects.development_plans', 'development_plans_parent_org_' || r.col);
    execute format('create trigger %I before insert or update of %I on projects.development_plans for each row execute function core.enforce_parent_org(%L, %L)',
                   'development_plans_parent_org_' || r.col, r.col, r.col, r.parent);
  end loop;
end $$;
drop trigger if exists freeze_org_development_plans on projects.development_plans;
create trigger freeze_org_development_plans before update of organization_id on projects.development_plans for each row execute function core.freeze_organization_id();
drop trigger if exists development_plans_updated_at on projects.development_plans;
create trigger development_plans_updated_at before update on projects.development_plans for each row execute function core.set_updated_at();

-- an approved plan is a fact: only its supersession may change it
create or replace function projects.development_plans_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a development plan is never deleted' using errcode = 'restrict_violation';
  end if;
  if old.status in ('approved', 'superseded')
     and (new.summary is distinct from old.summary or new.risks is distinct from old.risks or new.test_strategy is distinct from old.test_strategy
          or new.rollback_plan is distinct from old.rollback_plan or new.baseline_id is distinct from old.baseline_id or new.version is distinct from old.version
          or (old.status = 'superseded' and new.status is distinct from old.status)
          or (old.status = 'approved' and new.status not in ('approved', 'superseded'))) then
    raise exception 'an approved development plan is never edited: a changed plan is a new version' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists development_plans_guard on projects.development_plans;
create trigger development_plans_guard before update or delete on projects.development_plans for each row execute function projects.development_plans_guard();

alter table projects.tasks
  add column if not exists acceptance_criteria text,
  add column if not exists required_capability text,
  add column if not exists risk_level text check (risk_level is null or risk_level in ('low', 'medium', 'high', 'critical')),
  add column if not exists affected_paths text[] not null default '{}',
  add column if not exists plan_id uuid references projects.development_plans(id) on delete restrict;
drop trigger if exists tasks_parent_org_plan_id on projects.tasks;
create trigger tasks_parent_org_plan_id before insert or update of plan_id on projects.tasks
  for each row execute function core.enforce_parent_org('plan_id', 'projects.development_plans');

create or replace function projects.create_development_plan(p_project_id uuid, p_summary text, p_risks text default null, p_test_strategy text default null, p_rollback_plan text default null)
returns table (outcome text, plan_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_base uuid; v_next int; v_new uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_summary is null or length(btrim(p_summary)) = 0 then return query select 'empty'::text, null::uuid; return; end if;
  select b.id into v_base from projects.development_baselines b where b.project_id = p_project_id and b.organization_id = v_org;
  if v_base is null then return query select 'no_baseline'::text, null::uuid; return; end if;
  perform 1 from projects.projects p where p.id = p_project_id for update;
  select coalesce(max(version), 0) + 1 into v_next from projects.development_plans where project_id = p_project_id;
  insert into projects.development_plans (organization_id, project_id, baseline_id, version, summary, risks, test_strategy, rollback_plan, created_by)
  values (v_org, p_project_id, v_base, v_next, p_summary, p_risks, p_test_strategy, p_rollback_plan, v_actor) returning id into v_new;
  perform core.record_audit(v_org, 'development_plan.created', 'development_plan', v_new, null, jsonb_build_object('projectId', p_project_id, 'version', v_next));
  return query select 'created'::text, v_new;
end $$;
revoke all on function projects.create_development_plan(uuid, text, text, text, text) from public, anon;
grant execute on function projects.create_development_plan(uuid, text, text, text, text) to authenticated;

-- put a task in a DRAFT plan with its planning facts
create or replace function projects.plan_task(p_task_id uuid, p_plan_id uuid, p_acceptance_criteria text, p_required_capability text, p_risk_level text default 'medium', p_affected_paths text[] default '{}')
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_task projects.tasks; v_plan projects.development_plans;
begin
  if (select auth.uid()) is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_task from projects.tasks t where t.id = p_task_id and t.organization_id = v_org for update;
  select * into v_plan from projects.development_plans p where p.id = p_plan_id and p.organization_id = v_org;
  if v_task.id is null or v_plan.id is null then return query select 'not_found'::text; return; end if;
  if v_task.project_id <> v_plan.project_id then return query select 'wrong_project'::text; return; end if;
  if v_plan.status <> 'draft' then return query select 'plan_not_draft'::text; return; end if;
  if v_task.status <> 'todo' then return query select 'task_started'::text; return; end if;
  if p_risk_level not in ('low', 'medium', 'high', 'critical') then return query select 'bad_risk'::text; return; end if;
  update projects.tasks set plan_id = p_plan_id, acceptance_criteria = p_acceptance_criteria, required_capability = p_required_capability,
         risk_level = p_risk_level, affected_paths = coalesce(p_affected_paths, '{}') where id = p_task_id;
  return query select 'planned'::text;
end $$;
revoke all on function projects.plan_task(uuid, uuid, text, text, text, text[]) from public, anon;
grant execute on function projects.plan_task(uuid, uuid, text, text, text, text[]) to authenticated;

create or replace function projects.check_development_plan(p_plan_id uuid)
returns table (problem text)
language plpgsql stable set search_path = '' as $$
declare v_plan projects.development_plans; v_base projects.development_baselines;
begin
  select * into v_plan from projects.development_plans p where p.id = p_plan_id;
  if v_plan.id is null then return; end if;
  select * into v_base from projects.development_baselines b where b.id = v_plan.baseline_id;

  if not exists (select 1 from projects.tasks t where t.plan_id = p_plan_id and t.status <> 'cancelled') then
    return query select 'The plan has no tasks.'::text;
  end if;

  -- scope coverage: every feature carrying an included scope item (of the baseline's scope version) has a live task in this plan
  return query
    select format('Scope not covered: feature "%s" has an included scope item and no task in this plan.', f.name)
      from projects.features f
     where f.project_id = v_plan.project_id
       and exists (select 1 from projects.scope_items si where si.feature_id = f.id and si.scope_version_id = v_base.scope_version_id and si.inclusion = 'included')
       and not exists (select 1 from projects.tasks t where t.plan_id = p_plan_id and t.feature_id = f.id and t.status <> 'cancelled');

  return query
    select format('Task "%s" has no acceptance criteria.', t.title)
      from projects.tasks t where t.plan_id = p_plan_id and t.status <> 'cancelled' and (t.acceptance_criteria is null or length(btrim(t.acceptance_criteria)) = 0);

  return query
    select format('Task "%s" names no specialist (or "%s", which is not a development specialist).', t.title, coalesce(t.required_capability, ''))
      from projects.tasks t where t.plan_id = p_plan_id and t.status <> 'cancelled'
       and (t.required_capability is null or t.required_capability not in ('frontend_developer', 'backend_developer', 'database_developer', 'mobile_developer',
            'integration', 'devops_build', 'test_automation', 'security_review', 'bug_fix', 'refactor_performance', 'documentation'));

  -- a specialist recorded NOT_REQUIRED on this project cannot be given work
  return query
    select format('Task "%s" is assigned to %s, which is NOT_REQUIRED on this project (%s).', t.title, t.required_capability, s.reason)
      from projects.tasks t
      join projects.phase_five_agent_state s on s.project_id = t.project_id and s.agent_key = t.required_capability and s.state = 'not_required'
     where t.plan_id = p_plan_id and t.status <> 'cancelled';

  -- dependency cycles inside the plan
  return query
    with recursive walk(start_id, cur_id, path) as (
      select d.task_id, d.depends_on_task_id, array[d.task_id, d.depends_on_task_id]
        from projects.task_dependencies d join projects.tasks t on t.id = d.task_id and t.plan_id = p_plan_id
      union all
      select w.start_id, d.depends_on_task_id, w.path || d.depends_on_task_id
        from walk w join projects.task_dependencies d on d.task_id = w.cur_id
       where not d.depends_on_task_id = any (w.path) or d.depends_on_task_id = w.start_id
    )
    select distinct format('Dependency cycle through task "%s".', t.title)
      from walk w join projects.tasks t on t.id = w.start_id where w.cur_id = w.start_id;

  -- two tasks on the same files with no dependency either way must be sequenced
  return query
    select format('Tasks "%s" and "%s" touch the same files and are not sequenced: add a dependency.', a.title, b.title)
      from projects.tasks a
      join projects.tasks b on b.plan_id = a.plan_id and b.id > a.id and a.affected_paths && b.affected_paths
     where a.plan_id = p_plan_id and a.status <> 'cancelled' and b.status <> 'cancelled'
       and not exists (select 1 from projects.task_dependencies d where (d.task_id = a.id and d.depends_on_task_id = b.id) or (d.task_id = b.id and d.depends_on_task_id = a.id));
end $$;
revoke all on function projects.check_development_plan(uuid) from public, anon;
grant execute on function projects.check_development_plan(uuid) to authenticated, service_role;

create or replace function projects.approve_development_plan(p_plan_id uuid)
returns table (outcome text, problems text[])
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_plan projects.development_plans; v_problems text[];
begin
  if v_actor is null then return query select 'no_actor'::text, '{}'::text[]; return; end if;
  -- the PM cannot approve a plan: an Admin does
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, '{}'::text[]; return; end if;
  select * into v_plan from projects.development_plans p where p.id = p_plan_id and p.organization_id = v_org for update;
  if v_plan.id is null then return query select 'not_found'::text, '{}'::text[]; return; end if;
  if v_plan.status = 'approved' then return query select 'already_approved'::text, '{}'::text[]; return; end if;
  if v_plan.status <> 'draft' then return query select 'not_draft'::text, '{}'::text[]; return; end if;
  select coalesce(array_agg(c.problem), '{}') into v_problems from projects.check_development_plan(p_plan_id) c;
  if cardinality(v_problems) > 0 then return query select 'not_approvable'::text, v_problems; return; end if;
  update projects.development_plans set status = 'superseded' where project_id = v_plan.project_id and status = 'approved';
  update projects.development_plans set status = 'approved', approved_by = v_actor, approved_at = now() where id = v_plan.id;
  perform core.record_audit(v_org, 'development_plan.approved', 'development_plan', v_plan.id, null, jsonb_build_object('projectId', v_plan.project_id, 'version', v_plan.version));
  return query select 'approved'::text, '{}'::text[];
end $$;
revoke all on function projects.approve_development_plan(uuid) from public, anon;
grant execute on function projects.approve_development_plan(uuid) to authenticated;

CREATE OR REPLACE FUNCTION projects.start_task(p_task_id uuid)
 RETURNS TABLE(outcome text, detail text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_task  projects.tasks;
  v_check record;
  v_role  text;
  v_base  uuid;
begin
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::text; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id for update;
  if v_task.id is null then
    return query select 'not_found'::text, null::text; return;
  end if;
  v_role := projects.project_role_refusal(v_task.project_id, v_task.assignee_id);
  if v_role is not null then
    return query select v_role, null::text; return;
  end if;
  if v_task.status <> 'todo' or v_task.archived_at is not null then
    return query select 'wrong_state'::text, null::text; return;
  end if;

  if (v_task.module_id is not null or v_task.feature_id is not null) then
    -- Phase 5 gate 1: M2 verified paid.
    if not projects.m2_verified_paid(v_task.project_id) then
      return query select 'm2_not_verified'::text,
        'Phase 5 cannot start: the M2 payment is not verified paid. A client saying paid, a proof upload, a submission or a match recommendation does not open it; only an Admin verifying the payment does.'::text;
      return;
    end if;
    -- Phase 5 gate 2: a locked development baseline (for a project that ran the Phase 3/4 pipeline).
    if exists (select 1 from projects.phase_four p4 where p4.project_id = v_task.project_id) then
      select b.id into v_base from projects.development_baselines b where b.project_id = v_task.project_id;
      if v_base is null then
        return query select 'no_baseline'::text,
          'Phase 5 has no locked development baseline yet: development builds against the exact approved UI, prototype and scope, never "the latest design".'::text;
        return;
      end if;
    end if;
  end if;

  -- Phase 5 planning: against a locked baseline a task starts only from an APPROVED plan, and never beside another task that touches the
  -- same files without being sequenced after it ("do not run two agents against the same sensitive files blindly").
  if v_base is not null then
    if not exists (select 1 from projects.development_plans pl where pl.id = v_task.plan_id and pl.status = 'approved') then
      return query select 'no_approved_plan'::text,
        'This task is not part of an approved development plan: planning (acceptance criteria, specialist, dependencies) comes before code.'::text;
      return;
    end if;
    if cardinality(v_task.affected_paths) > 0 and exists (
         select 1 from projects.tasks o
          where o.project_id = v_task.project_id and o.id <> v_task.id and o.status = 'in_progress' and o.archived_at is null
            and o.affected_paths && v_task.affected_paths
            and not exists (select 1 from projects.task_dependencies td where td.task_id = v_task.id and td.depends_on_task_id = o.id)) then
      return query select 'path_conflict'::text,
        'Another task in progress touches the same files and this one does not depend on it: sequence them (add the dependency) before starting.'::text;
      return;
    end if;
  end if;

  select * into v_check from projects.task_start_check(p_task_id);
  if not v_check.requirement_ok then
    return query select 'no_requirement'::text, v_check.reason; return;
  end if;
  if v_check.open_dependencies > 0 then
    return query select 'dependencies_open'::text, v_check.reason; return;
  end if;

  update projects.tasks set status = 'in_progress', started_at = coalesce(started_at, now()), baseline_id = coalesce(baseline_id, v_base)
   where id = p_task_id;

  perform core.record_audit(
    v_task.organization_id, 'task.started', 'task', p_task_id,
    jsonb_build_object('status', v_task.status), jsonb_build_object('status', 'in_progress', 'projectId', v_task.project_id, 'baselineId', v_base)
  );
  return query select 'started'::text, null::text;
end;
$function$;

revoke all on function projects.start_task(uuid) from public, anon;
grant execute on function projects.start_task(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
