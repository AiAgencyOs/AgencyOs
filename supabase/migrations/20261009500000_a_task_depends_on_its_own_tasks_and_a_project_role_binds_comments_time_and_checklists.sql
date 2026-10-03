-- ═══════════════════════════════════════════════════════════════════════════
-- Round 3b, stream S2 (owner decisions R2-1, R2-2, R2-3):
--
--  R2-1  Dependencies are PER TASK. `projects.task_dependencies` says "this task
--        waits for that task" (both on the same project, never itself, never a
--        loop). Start Task refuses, naming the failing task, while any task the
--        task depends on is not done. The Round 3 plan-level check ("any pending
--        plan dependency blocks every task") is REPLACED: the project plan's own
--        dependencies stay on the plan page as information and no longer gate
--        a task. The table is written only through two audited doors,
--        `projects.add_task_dependency` / `projects.remove_task_dependency`.
--
--  R2-2  A project role binds on task comments, time logs and checklist items too:
--        an observer changes none of them, a contributor only on a task assigned
--        to them (the same `projects.project_role_refusal` the task row and its
--        evidence already use). Person sessions only; system writers are not bound.
--
--  R2-3  The roster managers (owner, ops admin, delivery lead) are exempt from the
--        roster in the database by the role UNION, like `can()` in the service: a
--        person whose manager role is only a secondary role is exempt exactly as
--        a primary one. `core.can_manage_delivery()` reads the primary role only,
--        so the exemption now asks `core.holds_role` for each of the three roles.
--
-- Additive and idempotent: the table is `if not exists`, functions are
-- `create or replace` (the two whose result shape grows are dropped first),
-- triggers are dropped and recreated.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── R2-3. the roster managers, by the role union ─────────────────────────

create or replace function projects.is_roster_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select core.holds_role('owner')), false)
      or coalesce((select core.holds_role('ops_admin')), false)
      or coalesce((select core.holds_role('delivery_lead')), false);
$$;

comment on function projects.is_roster_manager() is
  'R2-3. True when the caller holds owner, ops_admin or delivery_lead as their primary OR a secondary role (core.holds_role) — the people who keep the project roster and so are never bound by it. Same union as can() in the service.';

revoke all on function projects.is_roster_manager() from public, anon;
grant execute on function projects.is_roster_manager() to authenticated, service_role;

create or replace function projects.project_role_refusal(p_project_id uuid, p_assignee uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me   uuid := (select auth.uid());
  v_role text;
begin
  if v_me is null then
    return null;
  end if;
  if coalesce((select projects.is_roster_manager()), false) then
    return null;
  end if;
  select pm.project_role into v_role
    from projects.project_members pm
   where pm.project_id = p_project_id and pm.user_id = v_me;
  if v_role = 'observer' then
    return 'project_role_observer_read_only';
  end if;
  if v_role = 'contributor' and p_assignee is distinct from v_me then
    return 'project_role_contributor_own_tasks';
  end if;
  return null;
end;
$$;

comment on function projects.project_role_refusal(uuid, uuid) is
  'Q-B2 / R2-3. null when the caller may change a task of this project that is held by p_assignee; otherwise project_role_observer_read_only or project_role_contributor_own_tasks. Person sessions only; a person who holds owner, ops admin or delivery lead as a primary or secondary role is never bound by the roster they keep.';

-- ── R2-2. comments, time logs and checklist items obey the project role ──

create or replace function projects.enforce_project_role_on_task_child()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_task_id uuid := case when tg_op = 'DELETE' then old.task_id else new.task_id end;
  v_task    projects.tasks;
  v_refusal text;
begin
  select * into v_task from projects.tasks t where t.id = v_task_id;
  -- A task that is gone (a cascade delete from the task itself) has no role to check.
  if v_task.id is not null then
    v_refusal := projects.project_role_refusal(v_task.project_id, v_task.assignee_id);
    if v_refusal is not null then
      raise exception '%: your role on this project does not allow this change', v_refusal
        using errcode = 'P0001';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function projects.enforce_project_role_on_task_child() is
  'R2-2. Refuses a comment, time log or checklist item written by a person whose project role forbids changing the task it belongs to (observer: anything; contributor: a task not assigned to them).';

drop trigger if exists enforce_project_role_on_task_comments on projects.task_comments;
create trigger enforce_project_role_on_task_comments
  before insert on projects.task_comments
  for each row execute function projects.enforce_project_role_on_task_child();

drop trigger if exists enforce_project_role_on_time_logs on projects.time_logs;
create trigger enforce_project_role_on_time_logs
  before insert or update or delete on projects.time_logs
  for each row execute function projects.enforce_project_role_on_task_child();

drop trigger if exists enforce_project_role_on_task_checklist_items on projects.task_checklist_items;
create trigger enforce_project_role_on_task_checklist_items
  before insert or update or delete on projects.task_checklist_items
  for each row execute function projects.enforce_project_role_on_task_child();

-- ── R2-1. per-task dependencies ──────────────────────────────────────────

create table if not exists projects.task_dependencies (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  task_id             uuid not null references projects.tasks(id) on delete cascade,
  depends_on_task_id  uuid not null references projects.tasks(id) on delete cascade,
  created_by          uuid references core.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  constraint task_dependencies_not_itself check (task_id <> depends_on_task_id),
  constraint task_dependencies_unique unique (task_id, depends_on_task_id)
);

comment on table projects.task_dependencies is
  'R2-1. task_id waits for depends_on_task_id (same project, no loop). Start Task refuses while any task it depends on is not done. Written only through projects.add_task_dependency / remove_task_dependency.';

create index if not exists task_dependencies_task_idx on projects.task_dependencies (task_id);
create index if not exists task_dependencies_depends_on_idx on projects.task_dependencies (depends_on_task_id);
create index if not exists task_dependencies_org_idx on projects.task_dependencies (organization_id);

alter table projects.task_dependencies enable row level security;
alter table projects.task_dependencies force row level security;

drop policy if exists task_dependencies_select on projects.task_dependencies;
create policy task_dependencies_select on projects.task_dependencies
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

revoke all on table projects.task_dependencies from public, anon, authenticated;
grant select on table projects.task_dependencies to authenticated;
grant select, insert, update, delete on table projects.task_dependencies to service_role;

-- Tenancy: both tasks belong to the row's organisation; the organisation never moves.
drop trigger if exists org_match_task_dependencies_task on projects.task_dependencies;
create trigger org_match_task_dependencies_task
  before insert or update of task_id, organization_id on projects.task_dependencies
  for each row execute function core.enforce_parent_org('task_id', 'projects.tasks');

drop trigger if exists org_match_task_dependencies_depends_on on projects.task_dependencies;
create trigger org_match_task_dependencies_depends_on
  before insert or update of depends_on_task_id, organization_id on projects.task_dependencies
  for each row execute function core.enforce_parent_org('depends_on_task_id', 'projects.tasks');

drop trigger if exists freeze_org_task_dependencies on projects.task_dependencies;
create trigger freeze_org_task_dependencies
  before update of organization_id on projects.task_dependencies
  for each row execute function core.freeze_organization_id();

-- Same project, and no loop: a trigger, whoever writes the row.
create or replace function projects.task_dependency_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_a projects.tasks;
  v_b projects.tasks;
begin
  select * into v_a from projects.tasks t where t.id = new.task_id;
  select * into v_b from projects.tasks t where t.id = new.depends_on_task_id;
  if v_a.id is null or v_b.id is null then
    raise exception 'task_dependency_task_missing: both tasks must exist' using errcode = '23503';
  end if;
  if v_a.project_id <> v_b.project_id then
    raise exception 'task_dependency_other_project: a task can depend only on a task of its own project' using errcode = '23514';
  end if;
  -- A loop: the task we would wait for already (transitively) waits for this one.
  if exists (
    with recursive chain(id) as (
      select new.depends_on_task_id
      union
      select d.depends_on_task_id from projects.task_dependencies d join chain c on d.task_id = c.id
    )
    select 1 from chain where id = new.task_id
  ) then
    raise exception 'task_dependency_cycle: that would make the tasks wait for each other' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists task_dependency_guard on projects.task_dependencies;
create trigger task_dependency_guard
  before insert or update of task_id, depends_on_task_id on projects.task_dependencies
  for each row execute function projects.task_dependency_guard();

create or replace function projects.add_task_dependency(p_task_id uuid, p_depends_on_task_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_task  projects.tasks;
  v_other projects.tasks;
  v_role  text;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id and t.organization_id = v_org;
  select * into v_other from projects.tasks t where t.id = p_depends_on_task_id and t.organization_id = v_org;
  if v_task.id is null or v_other.id is null then
    return query select 'not_found'::text; return;
  end if;
  v_role := projects.project_role_refusal(v_task.project_id, v_task.assignee_id);
  if v_role is not null then
    return query select v_role; return;
  end if;
  if v_task.id = v_other.id then
    return query select 'itself'::text; return;
  end if;
  if v_task.project_id <> v_other.project_id then
    return query select 'other_project'::text; return;
  end if;
  if exists (select 1 from projects.task_dependencies d where d.task_id = v_task.id and d.depends_on_task_id = v_other.id) then
    return query select 'already'::text; return;
  end if;
  if exists (
    with recursive chain(id) as (
      select v_other.id
      union
      select d.depends_on_task_id from projects.task_dependencies d join chain c on d.task_id = c.id
    )
    select 1 from chain where id = v_task.id
  ) then
    return query select 'cycle'::text; return;
  end if;

  insert into projects.task_dependencies (organization_id, task_id, depends_on_task_id, created_by)
  values (v_org, v_task.id, v_other.id, v_actor);

  perform core.record_audit(v_org, 'task.dependency_added', 'task', v_task.id,
    null, jsonb_build_object('dependsOnTaskId', v_other.id, 'dependsOnTitle', v_other.title, 'projectId', v_task.project_id));
  return query select 'added'::text;
end;
$$;

comment on function projects.add_task_dependency(uuid, uuid) is
  'R2-1. Makes p_task_id wait for p_depends_on_task_id. task.write role, bound by the caller''s project role on the dependent task; refused itself, other_project, already, cycle; audited task.dependency_added.';

revoke all on function projects.add_task_dependency(uuid, uuid) from public, anon;
grant execute on function projects.add_task_dependency(uuid, uuid) to authenticated, service_role;

create or replace function projects.remove_task_dependency(p_task_id uuid, p_depends_on_task_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_task  projects.tasks;
  v_dep   projects.task_dependencies;
  v_role  text;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id and t.organization_id = v_org;
  if v_task.id is null then
    return query select 'not_found'::text; return;
  end if;
  v_role := projects.project_role_refusal(v_task.project_id, v_task.assignee_id);
  if v_role is not null then
    return query select v_role; return;
  end if;
  select * into v_dep from projects.task_dependencies d
   where d.task_id = v_task.id and d.depends_on_task_id = p_depends_on_task_id and d.organization_id = v_org;
  if v_dep.id is null then
    return query select 'not_found'::text; return;
  end if;

  delete from projects.task_dependencies where id = v_dep.id;

  perform core.record_audit(v_org, 'task.dependency_removed', 'task', v_task.id,
    jsonb_build_object('dependsOnTaskId', p_depends_on_task_id, 'projectId', v_task.project_id), null);
  return query select 'removed'::text;
end;
$$;

comment on function projects.remove_task_dependency(uuid, uuid) is
  'R2-1. Removes one per-task dependency. task.write role, bound by the caller''s project role on the dependent task; audited task.dependency_removed.';

revoke all on function projects.remove_task_dependency(uuid, uuid) from public, anon;
grant execute on function projects.remove_task_dependency(uuid, uuid) to authenticated, service_role;

-- ── R2-1. Start Task reads the task's own dependencies ───────────────────

-- The result shape is the same four columns; dropped first only so the body can be
-- replaced whatever an earlier run left behind.
drop function if exists projects.task_start_check(uuid);
create function projects.task_start_check(p_task_id uuid)
returns table (
  startable          boolean,
  requirement_ok     boolean,
  open_dependencies  integer,
  reason             text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_task   projects.tasks;
  v_req    boolean;
  v_open   integer := 0;
  v_names  text;
begin
  select * into v_task from projects.tasks t where t.id = p_task_id;
  if v_task.id is null then
    return;
  end if;

  v_req := v_task.requirement_version_id is not null
    or (v_task.feature_id is not null and exists (
         select 1 from projects.scope_items si
          where si.feature_id = v_task.feature_id and si.inclusion in ('included', 'optional')));

  select string_agg('"' || x.title || '" (' || replace(x.status::text, '_', ' ') || ')', ', ' order by x.title)
    into v_names
    from (
      select t.title, t.status
        from projects.task_dependencies d
        join projects.tasks t on t.id = d.depends_on_task_id
       where d.task_id = p_task_id and t.status <> 'done'
       order by t.title
       limit 3
    ) x;
  select count(*)::integer into v_open
    from projects.task_dependencies d
    join projects.tasks t on t.id = d.depends_on_task_id
   where d.task_id = p_task_id and t.status <> 'done';

  return query select
    (v_req and v_open = 0),
    v_req,
    v_open,
    case
      when not v_req then 'Requirement check failed: this task is not linked to a requirement or scope item. Link it to the feature that delivers one, or ask the requirement on the task page.'
      when v_open > 0 then 'Dependency check failed: waiting on ' || v_names
        || case when v_open > 3 then ' and ' || (v_open - 3) || ' more' else '' end
        || '. Finish ' || case when v_open = 1 then 'it' else 'them' end || ' first, or remove the dependency.'
      else null
    end;
end;
$$;

comment on function projects.task_start_check(uuid) is
  'Q-C3 / R2-1. The two gates in front of Start Task: the requirement check (a requirement version, or a feature carrying an included or optional scope item) and the dependency check (every task this task depends on is done). reason is the sentence the button shows and names the failing task. The plan-level dependency check is replaced.';

revoke all on function projects.task_start_check(uuid) from public, anon;
grant execute on function projects.task_start_check(uuid) to authenticated, service_role;

drop function if exists projects.start_task(uuid);
create function projects.start_task(p_task_id uuid)
returns table (outcome text, detail text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_task  projects.tasks;
  v_check record;
  v_role  text;
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
  if v_task.status <> 'todo' then
    return query select 'wrong_state'::text, null::text; return;
  end if;

  select * into v_check from projects.task_start_check(p_task_id);
  if not v_check.requirement_ok then
    return query select 'no_requirement'::text, v_check.reason; return;
  end if;
  if v_check.open_dependencies > 0 then
    return query select 'dependencies_open'::text, v_check.reason; return;
  end if;

  update projects.tasks set status = 'in_progress', started_at = coalesce(started_at, now()) where id = p_task_id;

  perform core.record_audit(
    v_task.organization_id, 'task.started', 'task', p_task_id,
    jsonb_build_object('status', v_task.status), jsonb_build_object('status', 'in_progress', 'projectId', v_task.project_id)
  );
  return query select 'started'::text, null::text;
end;
$$;

comment on function projects.start_task(uuid) is
  'SCR-041 / Q-C3 / R2-1 — todo → in_progress. Any task.write role, bound by the caller''s project role; refused wrong_state from any other status, no_requirement when the task is linked to no requirement or scope item, dependencies_open (detail names the unfinished task) while a task it depends on is not done; audited task.started.';

revoke all on function projects.start_task(uuid) from public, anon;
grant execute on function projects.start_task(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
