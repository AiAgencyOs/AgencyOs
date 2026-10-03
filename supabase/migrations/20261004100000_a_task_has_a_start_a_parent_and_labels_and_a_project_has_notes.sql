-- ═══════════════════════════════════════════════════════════════════════════
-- A task has a start, a parent and labels, and a project keeps notes.
--
-- UI parity round 2, stream Q1 (project overview, board, task page, milestones,
-- timeline). The reference screens draw four things the model could not
-- honestly back:
--
--   • a task START date (the timeline / Gantt bar runs start → due)
--   • SUBTASKS, and the PARENT a subtask belongs to (task page: Subtasks table,
--     Related → Parent Task)
--   • LABELS on a task (the chips beside a card: "Feature", "Backend", "UI/UX")
--   • PROJECT NOTES (the overview's "Project Notes" card: a title, a body, a date)
--
-- Sprint is NOT here: no spec in docs/ or the 71-screen PDF defines a sprint
-- (cadence, capacity, who owns one). That is a business decision, asked of the
-- owner in the stream report, not invented in a column.
--
-- ── how each is written ──────────────────────────────────────────────────
--
-- The three task facts ride on projects.tasks, which already has a write
-- policy (tasks_write → core.can_write()) and an audit trigger. Each is
-- written through a door that re-checks the role, refuses with a named
-- outcome, and writes its own audit row (core.record_audit) in the same
-- transaction:
--
--   projects.set_task_schedule(task, start_on, due_on)   — both dates at once,
--       because start ≤ due is one rule and two separate writes can each be
--       fine and together wrong
--   projects.add_subtask(parent, title, due_on, assignee) — one level only: a
--       subtask has no subtasks; it inherits the parent's project, module,
--       feature and milestone
--   projects.set_task_labels(task, labels)               — trimmed, de-duplicated,
--       at most eight, each 1–24 characters
--
-- Project notes are a NEW table with no write grant to `authenticated` and no
-- write policy: the only ways in are projects.add_project_note and
-- projects.remove_project_note (security definer, each re-checking the role
-- and the organisation in its own body, each audited).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. task columns ────────────────────────────────────────────────────────

alter table projects.tasks add column if not exists start_on date;
alter table projects.tasks add column if not exists parent_task_id uuid references projects.tasks(id) on delete set null;
alter table projects.tasks add column if not exists labels text[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_start_before_due' and conrelid = 'projects.tasks'::regclass) then
    alter table projects.tasks
      add constraint tasks_start_before_due check (start_on is null or due_on is null or start_on <= due_on);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_not_its_own_parent' and conrelid = 'projects.tasks'::regclass) then
    alter table projects.tasks
      add constraint tasks_not_its_own_parent check (parent_task_id is null or parent_task_id <> id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_labels_bounded' and conrelid = 'projects.tasks'::regclass) then
    alter table projects.tasks
      add constraint tasks_labels_bounded check (coalesce(cardinality(labels), 0) <= 8);
  end if;
end
$$;

comment on column projects.tasks.start_on is
  'The day work on the task is planned to begin. Optional; never after due_on. Drawn as the left edge of the task''s bar on the project timeline.';
comment on column projects.tasks.parent_task_id is
  'The task this one is a subtask of. One level only (a subtask has no subtasks), same project. Set once, by projects.add_subtask.';
comment on column projects.tasks.labels is
  'Free labels shown as chips on the board card and the task page. At most eight, each 1–24 characters; written by projects.set_task_labels.';

create index if not exists tasks_parent_idx on projects.tasks (parent_task_id) where parent_task_id is not null;

-- The parent must be a task of the SAME project and organisation, and must not
-- itself be a subtask. A trigger, not a CHECK, because it reads another row.
create or replace function projects.tasks_parent_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_parent projects.tasks;
begin
  if new.parent_task_id is null then
    return new;
  end if;
  select * into v_parent from projects.tasks where id = new.parent_task_id;
  if v_parent.id is null then
    raise exception 'The parent task does not exist.' using errcode = '23503';
  end if;
  if v_parent.project_id <> new.project_id or v_parent.organization_id <> new.organization_id then
    raise exception 'A subtask must belong to its parent''s project.' using errcode = '23514';
  end if;
  if v_parent.parent_task_id is not null then
    raise exception 'A subtask cannot have subtasks of its own.' using errcode = '23514';
  end if;
  -- A task that already has subtasks cannot become one.
  if tg_op = 'UPDATE' and exists (select 1 from projects.tasks c where c.parent_task_id = new.id) then
    raise exception 'A task with subtasks cannot become a subtask.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_parent_guard on projects.tasks;
create trigger tasks_parent_guard
  before insert or update of parent_task_id, project_id on projects.tasks
  for each row execute function projects.tasks_parent_guard();

-- ── 2. the three task doors ────────────────────────────────────────────────

create or replace function projects.set_task_schedule(p_task_id uuid, p_start_on date, p_due_on date)
returns table (outcome text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_task projects.tasks;
begin
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id for update;
  if v_task.id is null then
    return query select 'not_found'::text; return;
  end if;
  if p_start_on is not null and p_due_on is not null and p_start_on > p_due_on then
    return query select 'start_after_due'::text; return;
  end if;

  update projects.tasks set start_on = p_start_on, due_on = p_due_on where id = p_task_id;

  perform core.record_audit(
    v_task.organization_id, 'task.schedule_set', 'task', p_task_id,
    jsonb_build_object('startOn', v_task.start_on, 'dueOn', v_task.due_on),
    jsonb_build_object('startOn', p_start_on, 'dueOn', p_due_on, 'projectId', v_task.project_id)
  );
  return query select 'set'::text;
end;
$$;

comment on function projects.set_task_schedule(uuid, date, date) is
  'Sets a task''s start and due dates together (either may be null). Any task.write role; refused start_after_due when start is later than due; audited task.schedule_set.';

revoke all on function projects.set_task_schedule(uuid, date, date) from public, anon;
grant execute on function projects.set_task_schedule(uuid, date, date) to authenticated, service_role;

create or replace function projects.add_subtask(
  p_parent_id   uuid,
  p_title       text,
  p_due_on      date default null,
  p_assignee_id uuid default null
)
returns table (outcome text, task_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_parent projects.tasks;
  v_title  text := btrim(coalesce(p_title, ''));
  v_id     uuid;
begin
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  select * into v_parent from projects.tasks t where t.id = p_parent_id;
  if v_parent.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if v_parent.parent_task_id is not null then
    return query select 'nested'::text, null::uuid; return;
  end if;
  if char_length(v_title) < 1 or char_length(v_title) > 200 then
    return query select 'invalid_title'::text, null::uuid; return;
  end if;
  if p_assignee_id is not null and not exists (
       select 1 from core.memberships m
        where m.organization_id = v_parent.organization_id and m.user_id = p_assignee_id and m.status = 'active') then
    return query select 'invalid_assignee'::text, null::uuid; return;
  end if;

  insert into projects.tasks (organization_id, project_id, parent_task_id, module_id, feature_id, milestone_id, title, due_on, assignee_id)
  values (v_parent.organization_id, v_parent.project_id, v_parent.id, v_parent.module_id, v_parent.feature_id, v_parent.milestone_id,
          v_title, p_due_on, p_assignee_id)
  returning id into v_id;

  perform core.record_audit(
    v_parent.organization_id, 'task.subtask_added', 'task', v_id,
    null, jsonb_build_object('parentTaskId', v_parent.id, 'projectId', v_parent.project_id, 'title', v_title)
  );
  return query select 'added'::text, v_id;
end;
$$;

comment on function projects.add_subtask(uuid, text, date, uuid) is
  'Adds a subtask under a task. One level only (refused nested from a subtask); inherits the parent''s project, module, feature and milestone. Any task.write role; audited task.subtask_added.';

revoke all on function projects.add_subtask(uuid, text, date, uuid) from public, anon;
grant execute on function projects.add_subtask(uuid, text, date, uuid) to authenticated, service_role;

create or replace function projects.set_task_labels(p_task_id uuid, p_labels text[])
returns table (outcome text, labels text[])
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_task   projects.tasks;
  v_clean  text[];
begin
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::text[]; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id for update;
  if v_task.id is null then
    return query select 'not_found'::text, null::text[]; return;
  end if;

  -- Trim, drop blanks, drop duplicates (case-insensitively, keeping the first
  -- spelling and the order given).
  select coalesce(array_agg(x.label order by x.first_at), '{}')
    into v_clean
    from (
      select min(u.ord) as first_at, (array_agg(u.label order by u.ord))[1] as label
        from (
          select btrim(l) as label, o as ord
            from unnest(coalesce(p_labels, '{}')) with ordinality as t(l, o)
        ) u
       where u.label <> ''
       group by lower(u.label)
    ) x;

  if cardinality(v_clean) > 8 then
    return query select 'too_many'::text, null::text[]; return;
  end if;
  if exists (select 1 from unnest(v_clean) as c where char_length(c) > 24) then
    return query select 'label_too_long'::text, null::text[]; return;
  end if;

  update projects.tasks set labels = v_clean where id = p_task_id;

  perform core.record_audit(
    v_task.organization_id, 'task.labels_set', 'task', p_task_id,
    jsonb_build_object('labels', v_task.labels), jsonb_build_object('labels', v_clean, 'projectId', v_task.project_id)
  );
  return query select 'set'::text, v_clean;
end;
$$;

comment on function projects.set_task_labels(uuid, text[]) is
  'Replaces a task''s labels: trimmed, blanks and case-insensitive duplicates dropped, at most eight, each at most 24 characters. Any task.write role; audited task.labels_set.';

revoke all on function projects.set_task_labels(uuid, text[]) from public, anon;
grant execute on function projects.set_task_labels(uuid, text[]) to authenticated, service_role;

-- ── 3. project notes ───────────────────────────────────────────────────────

create table if not exists projects.project_notes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  project_id      uuid not null references projects.projects(id) on delete cascade,
  title           text not null check (char_length(btrim(title)) between 1 and 160),
  body            text check (body is null or char_length(body) <= 4000),
  created_by      uuid references core.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table projects.project_notes is
  'A note kept on a project (the overview''s Project Notes card): a title and a body, internal only. No write policy and no write grant for authenticated: every path in is projects.add_project_note / remove_project_note.';

create index if not exists project_notes_project_idx on projects.project_notes (project_id, created_at desc);
create index if not exists project_notes_organization_idx on projects.project_notes (organization_id, project_id);

alter table projects.project_notes enable row level security;
alter table projects.project_notes force row level security;

drop policy if exists project_notes_select on projects.project_notes;
create policy project_notes_select on projects.project_notes
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

revoke all on table projects.project_notes from public, anon, authenticated;
grant select on table projects.project_notes to authenticated;
grant select, insert, update, delete on table projects.project_notes to service_role;

drop trigger if exists set_updated_at on projects.project_notes;
create trigger set_updated_at before update on projects.project_notes
  for each row execute function core.set_updated_at();

drop trigger if exists org_match_project_notes_project on projects.project_notes;
create trigger org_match_project_notes_project
  before insert or update of project_id, organization_id on projects.project_notes
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_project_notes on projects.project_notes;
create trigger freeze_org_project_notes
  before update of organization_id on projects.project_notes
  for each row execute function core.freeze_organization_id();

create or replace function projects.add_project_note(p_project_id uuid, p_title text, p_body text default null)
returns table (outcome text, note_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_title text := btrim(coalesce(p_title, ''));
  v_body  text := nullif(btrim(coalesce(p_body, '')), '');
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
  if char_length(v_title) < 1 or char_length(v_title) > 160 then
    return query select 'invalid_title'::text, null::uuid; return;
  end if;
  if v_body is not null and char_length(v_body) > 4000 then
    return query select 'invalid_body'::text, null::uuid; return;
  end if;

  insert into projects.project_notes (organization_id, project_id, title, body, created_by)
  values (v_org, p_project_id, v_title, v_body, v_actor)
  returning id into v_id;

  perform core.record_audit(
    v_org, 'project.note_added', 'project_note', v_id,
    null, jsonb_build_object('projectId', p_project_id, 'title', v_title)
  );
  return query select 'added'::text, v_id;
end;
$$;

comment on function projects.add_project_note(uuid, text, text) is
  'Adds a note to a project. Any task.write role of the same organisation; audited project.note_added. Security definer because the table has no write grant.';

revoke all on function projects.add_project_note(uuid, text, text) from public, anon;
grant execute on function projects.add_project_note(uuid, text, text) to authenticated, service_role;

create or replace function projects.remove_project_note(p_note_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_note  projects.project_notes;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_note from projects.project_notes n where n.id = p_note_id and n.organization_id = v_org for update;
  if v_note.id is null then
    return query select 'not_found'::text; return;
  end if;

  delete from projects.project_notes where id = p_note_id;

  perform core.record_audit(
    v_org, 'project.note_removed', 'project_note', p_note_id,
    jsonb_build_object('projectId', v_note.project_id, 'title', v_note.title), null
  );
  return query select 'removed'::text;
end;
$$;

comment on function projects.remove_project_note(uuid) is
  'Removes a project note. Any task.write role of the same organisation; audited project.note_removed with the title it had.';

revoke all on function projects.remove_project_note(uuid) from public, anon;
grant execute on function projects.remove_project_note(uuid) to authenticated, service_role;
