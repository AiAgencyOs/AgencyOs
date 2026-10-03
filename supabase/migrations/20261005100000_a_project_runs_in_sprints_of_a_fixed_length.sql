-- ═══════════════════════════════════════════════════════════════════════════
-- A project runs in sprints of a fixed length, and a task sits in one of them.
--
-- Owner decision 1 (2026-10-03): a sprint belongs to ONE project, has a fixed
-- length (a start date and a number of days), and a task may be placed in one
-- sprint of ITS project. No capacity tracking, no velocity, no burndown.
--
-- ── the model ────────────────────────────────────────────────────────────
--   projects.sprints            name, starts_on, length_days (1–60), closed_at
--   projects.tasks.sprint_id    the one sprint a task is placed in (nullable)
--
-- The end of a sprint is never stored: it is starts_on + length_days - 1, so
-- it cannot disagree with the two facts it comes from.
--
-- ── how it is written ────────────────────────────────────────────────────
-- projects.sprints has NO write policy and NO write grant for authenticated.
-- The only ways in are three security-definer doors, each re-checking the
-- role (core.can_write()) and the organisation in its own body, each audited:
--
--   projects.create_sprint(project, name, starts_on, length_days)
--       refused if it overlaps another OPEN sprint of the same project
--   projects.close_sprint(sprint)
--       stamps closed_at; tasks stay where they are (nothing is moved or lost)
--   projects.place_task_in_sprint(task, sprint | null)
--       the sprint must be of the task's own project and still open; null takes
--       the task out of its sprint
--
-- A trigger keeps the rule when a task row is written by any other path: the
-- sprint of a task must be a sprint of the task's own project.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.sprints (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  project_id      uuid not null references projects.projects(id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 80),
  starts_on       date not null,
  length_days     integer not null check (length_days between 1 and 60),
  closed_at       timestamptz,
  closed_by       uuid references core.users(id) on delete set null,
  created_by      uuid references core.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table projects.sprints is
  'A fixed-length working period of one project (start date + length in days). No capacity. No write policy and no write grant for authenticated: every path in is projects.create_sprint / close_sprint.';
comment on column projects.sprints.length_days is
  'Whole days, 1–60. The last day of the sprint is starts_on + length_days - 1; it is never stored.';

create index if not exists sprints_project_idx on projects.sprints (project_id, starts_on desc);
create index if not exists sprints_organization_idx on projects.sprints (organization_id, project_id);

alter table projects.sprints enable row level security;
alter table projects.sprints force row level security;

drop policy if exists sprints_select on projects.sprints;
create policy sprints_select on projects.sprints
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

revoke all on table projects.sprints from public, anon, authenticated;
grant select on table projects.sprints to authenticated;
grant select, insert, update, delete on table projects.sprints to service_role;

drop trigger if exists set_updated_at on projects.sprints;
create trigger set_updated_at before update on projects.sprints
  for each row execute function core.set_updated_at();

drop trigger if exists org_match_sprints_project on projects.sprints;
create trigger org_match_sprints_project
  before insert or update of project_id, organization_id on projects.sprints
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_sprints on projects.sprints;
create trigger freeze_org_sprints
  before update of organization_id on projects.sprints
  for each row execute function core.freeze_organization_id();

-- ── the task's sprint ──────────────────────────────────────────────────────

alter table projects.tasks add column if not exists sprint_id uuid references projects.sprints(id) on delete set null;
create index if not exists tasks_sprint_idx on projects.tasks (sprint_id) where sprint_id is not null;

comment on column projects.tasks.sprint_id is
  'The one sprint of the task''s own project the task is placed in. Written by projects.place_task_in_sprint.';

create or replace function projects.tasks_sprint_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_sprint_project uuid;
begin
  if new.sprint_id is null then
    return new;
  end if;
  select s.project_id into v_sprint_project from projects.sprints s where s.id = new.sprint_id;
  if v_sprint_project is null then
    raise exception 'The sprint does not exist.' using errcode = '23503';
  end if;
  if v_sprint_project <> new.project_id then
    raise exception 'A task can only be placed in a sprint of its own project.' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Tenancy: a task's sprint must be of the task's own organisation
-- (core.unguarded_org_fks demands one for each org-scoped single-column FK).
drop trigger if exists org_match_tasks_sprint on projects.tasks;
create trigger org_match_tasks_sprint
  before insert or update of sprint_id, organization_id on projects.tasks
  for each row execute function core.enforce_parent_org('sprint_id', 'projects.sprints');

-- The same guard for the parent of a subtask, which 20261004100000 left
-- unguarded (found by core.unguarded_org_fks while adding the one above).
drop trigger if exists org_match_tasks_parent on projects.tasks;
create trigger org_match_tasks_parent
  before insert or update of parent_task_id, organization_id on projects.tasks
  for each row execute function core.enforce_parent_org('parent_task_id', 'projects.tasks');

drop trigger if exists tasks_sprint_guard on projects.tasks;
create trigger tasks_sprint_guard
  before insert or update of sprint_id, project_id on projects.tasks
  for each row execute function projects.tasks_sprint_guard();

-- ── the doors ──────────────────────────────────────────────────────────────

create or replace function projects.create_sprint(p_project_id uuid, p_name text, p_starts_on date, p_length_days integer)
returns table (outcome text, sprint_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_name  text := btrim(coalesce(p_name, ''));
  v_proj  projects.projects;
  v_id    uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  select * into v_proj from projects.projects p where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null;
  if v_proj.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    return query select 'invalid_name'::text, null::uuid; return;
  end if;
  if p_starts_on is null then
    return query select 'invalid_start'::text, null::uuid; return;
  end if;
  if p_length_days is null or p_length_days < 1 or p_length_days > 60 then
    return query select 'invalid_length'::text, null::uuid; return;
  end if;
  -- One project, one sprint at a time: an open sprint may not overlap another.
  perform 1 from projects.projects p where p.id = p_project_id for update;
  if exists (
    select 1 from projects.sprints s
     where s.project_id = p_project_id and s.closed_at is null
       and s.starts_on <= p_starts_on + (p_length_days - 1)
       and p_starts_on <= s.starts_on + (s.length_days - 1)
  ) then
    return query select 'overlaps'::text, null::uuid; return;
  end if;

  insert into projects.sprints (organization_id, project_id, name, starts_on, length_days, created_by)
  values (v_org, p_project_id, v_name, p_starts_on, p_length_days, v_actor)
  returning id into v_id;

  perform core.record_audit(
    v_org, 'sprint.created', 'sprint', v_id,
    null, jsonb_build_object('projectId', p_project_id, 'name', v_name, 'startsOn', p_starts_on, 'lengthDays', p_length_days)
  );
  return query select 'created'::text, v_id;
end;
$$;

comment on function projects.create_sprint(uuid, text, date, integer) is
  'Creates a sprint of a project: a name, a start date and a fixed length in days (1–60). Any task.write role of the same organisation; refused overlaps when it overlaps another open sprint of the project; audited sprint.created.';

revoke all on function projects.create_sprint(uuid, text, date, integer) from public, anon;
grant execute on function projects.create_sprint(uuid, text, date, integer) to authenticated, service_role;

create or replace function projects.close_sprint(p_sprint_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_sprint projects.sprints;
  v_open   integer;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_sprint from projects.sprints s where s.id = p_sprint_id and s.organization_id = v_org for update;
  if v_sprint.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_sprint.closed_at is not null then
    return query select 'already_closed'::text; return;
  end if;

  select count(*)::integer into v_open from projects.tasks t where t.sprint_id = p_sprint_id and t.status <> 'done';
  update projects.sprints set closed_at = now(), closed_by = v_actor where id = p_sprint_id;

  perform core.record_audit(
    v_org, 'sprint.closed', 'sprint', p_sprint_id,
    jsonb_build_object('name', v_sprint.name),
    jsonb_build_object('projectId', v_sprint.project_id, 'unfinishedTasks', v_open)
  );
  return query select 'closed'::text;
end;
$$;

comment on function projects.close_sprint(uuid) is
  'Closes a sprint. Tasks keep their sprint (nothing is moved); the audit row records how many were not done. Any task.write role of the same organisation; audited sprint.closed.';

revoke all on function projects.close_sprint(uuid) from public, anon;
grant execute on function projects.close_sprint(uuid) to authenticated, service_role;

create or replace function projects.place_task_in_sprint(p_task_id uuid, p_sprint_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_task   projects.tasks;
  v_sprint projects.sprints;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id and t.organization_id = v_org for update;
  if v_task.id is null then
    return query select 'not_found'::text; return;
  end if;
  if p_sprint_id is not null then
    select * into v_sprint from projects.sprints s where s.id = p_sprint_id and s.organization_id = v_org;
    if v_sprint.id is null then
      return query select 'sprint_not_found'::text; return;
    end if;
    if v_sprint.project_id <> v_task.project_id then
      return query select 'other_project'::text; return;
    end if;
    if v_sprint.closed_at is not null then
      return query select 'sprint_closed'::text; return;
    end if;
  end if;

  update projects.tasks set sprint_id = p_sprint_id where id = p_task_id;

  perform core.record_audit(
    v_org, 'task.sprint_set', 'task', p_task_id,
    jsonb_build_object('sprintId', v_task.sprint_id),
    jsonb_build_object('sprintId', p_sprint_id, 'projectId', v_task.project_id)
  );
  return query select case when p_sprint_id is null then 'removed' else 'placed' end::text;
end;
$$;

comment on function projects.place_task_in_sprint(uuid, uuid) is
  'Places a task in an open sprint of its own project, or (null) takes it out of its sprint. Any task.write role of the same organisation; audited task.sprint_set.';

revoke all on function projects.place_task_in_sprint(uuid, uuid) from public, anon;
grant execute on function projects.place_task_in_sprint(uuid, uuid) to authenticated, service_role;
