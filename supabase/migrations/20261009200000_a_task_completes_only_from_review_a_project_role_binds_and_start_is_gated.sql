-- ═══════════════════════════════════════════════════════════════════════════
-- Round 3, stream R2 (owner decisions Q-B1, Q-B2, Q-C3):
--
--  1. Q-B1  A task reaches Completed (`done`) only from In review. A BEFORE UPDATE
--           trigger refuses any other move to `done`, whichever path writes the
--           row (the status door, the Board, a verifier, a job). A task that is
--           already `done` may still be written (no new transition). A row
--           inserted already `done` is the acceptance trigger's business (a person
--           cannot; system writers seed history) and is unchanged.
--
--  2. Q-B2  Project roles are enforced on that project. A person whose
--           `projects.project_members.project_role` on the task's project is
--           `observer` changes nothing there; `contributor` changes only a task
--           that is assigned to them. Every other project role, and every person
--           with no roster row, is governed by the agency role as before. The
--           owner, ops admin and delivery lead (can_manage_delivery) are the people
--           who set the roster (Q-B3), so the roster does not bind them. Binds a
--           PERSON'S session only (auth.uid() not null); system writers are
--           governed by their own doors, exactly like the acceptance trigger.
--           Covers the task row (insert, update, delete) and evidence added to,
--           or removed from, a task.
--
--  3. Q-C3  Start Task is gated. `projects.task_start_check(task)` answers, in
--           words, whether the task passes (a) the requirement check: it is linked
--           to a requirement (requirement_version_id) or to a feature that carries
--           an included/optional scope item, and (b) the dependency check: the
--           project's newest plan has no dependency still pending, requested or
--           blocked. `projects.start_task` refuses with `no_requirement` or
--           `dependencies_open` before it writes; the task page reads the same
--           function to show the reason on the button.
--
-- Additive and idempotent: functions are `create or replace`, triggers are
-- dropped and recreated. No table, no grant to a table.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Completed only from In review ─────────────────────────────────────

create or replace function projects.refuse_completion_outside_review()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'done' and old.status is distinct from 'done' and old.status is distinct from 'in_review' then
    raise exception 'task_completion_requires_review: a task is completed only from in review (was %)', old.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function projects.refuse_completion_outside_review() is
  'Q-B1. A task reaches done only from in_review, whichever path writes it. Fires before the verification and acceptance gates so the sentence is the plain one.';

-- Trigger names fire alphabetically: "a_" sorts before the older gates, so a
-- move from to-do says the review rule rather than the evidence rule.
drop trigger if exists a_refuse_completion_outside_review on projects.tasks;
create trigger a_refuse_completion_outside_review
  before update of status on projects.tasks
  for each row execute function projects.refuse_completion_outside_review();

-- ── 2. A project role binds on that project ──────────────────────────────

-- The sentence code a person's change to a task would be refused with, or null.
-- p_assignee is the task's CURRENT assignee (null for a task not yet written).
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
  if coalesce((select core.can_manage_delivery()), false) then
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
  'Q-B2. null when the caller may change a task of this project that is held by p_assignee; otherwise project_role_observer_read_only or project_role_contributor_own_tasks. Person sessions only; owner, ops admin and delivery lead are never bound by the roster they keep.';

revoke all on function projects.project_role_refusal(uuid, uuid) from public, anon;
grant execute on function projects.project_role_refusal(uuid, uuid) to authenticated, service_role;

create or replace function projects.enforce_project_role_on_task()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_refusal text;
begin
  if tg_op = 'INSERT' then
    v_refusal := projects.project_role_refusal(new.project_id, new.assignee_id);
  else
    v_refusal := projects.project_role_refusal(old.project_id, old.assignee_id);
  end if;
  if v_refusal is not null then
    raise exception '%: your role on this project does not allow this change', v_refusal
      using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function projects.enforce_project_role_on_task() is
  'Q-B2. Refuses a task insert, update or delete by a person whose project role forbids it (observer: anything; contributor: a task not assigned to them).';

drop trigger if exists enforce_project_role_on_task on projects.tasks;
create trigger enforce_project_role_on_task
  before insert or update or delete on projects.tasks
  for each row execute function projects.enforce_project_role_on_task();

create or replace function projects.enforce_project_role_on_evidence()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_task    projects.tasks;
  v_task_id uuid := case when tg_op = 'DELETE' then old.task_id else new.task_id end;
  v_refusal text;
begin
  select * into v_task from projects.tasks t where t.id = v_task_id;
  if v_task.id is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  v_refusal := projects.project_role_refusal(v_task.project_id, v_task.assignee_id);
  if v_refusal is not null then
    raise exception '%: your role on this project does not allow this change', v_refusal
      using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists enforce_project_role_on_evidence on projects.task_evidence;
create trigger enforce_project_role_on_evidence
  before insert or delete on projects.task_evidence
  for each row execute function projects.enforce_project_role_on_evidence();

-- ── 3. Start Task is gated ───────────────────────────────────────────────

create or replace function projects.task_start_check(p_task_id uuid)
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
  v_task    projects.tasks;
  v_req     boolean;
  v_open    integer := 0;
  v_plan    uuid;
begin
  select * into v_task from projects.tasks t where t.id = p_task_id;
  if v_task.id is null then
    return;
  end if;

  v_req := v_task.requirement_version_id is not null
    or (v_task.feature_id is not null and exists (
         select 1 from projects.scope_items si
          where si.feature_id = v_task.feature_id and si.inclusion in ('included', 'optional')));

  select pp.id into v_plan
    from projects.project_plans pp
   where pp.project_id = v_task.project_id
   order by pp.version desc
   limit 1;
  if v_plan is not null then
    select count(*)::integer into v_open
      from projects.plan_dependencies d
     where d.plan_id = v_plan and d.status in ('pending', 'requested', 'blocked');
  end if;

  return query select
    (v_req and v_open = 0),
    v_req,
    v_open,
    case
      when not v_req then 'Requirement check failed: this task is not linked to a requirement or scope item. Link it to the feature that delivers one, or ask the requirement on the task page.'
      when v_open > 0 then 'Dependency check failed: ' || v_open || case when v_open = 1 then ' dependency is' else ' dependencies are' end || ' still outstanding on the project plan. Mark them supplied or not applicable first.'
      else null
    end;
end;
$$;

comment on function projects.task_start_check(uuid) is
  'Q-C3. The two gates in front of Start Task: the requirement check (the task is linked to a requirement version, or to a feature carrying an included or optional scope item) and the dependency check (the project''s newest plan has no dependency pending, requested or blocked). reason is the sentence the button shows.';

revoke all on function projects.task_start_check(uuid) from public, anon;
grant execute on function projects.task_start_check(uuid) to authenticated, service_role;

create or replace function projects.start_task(p_task_id uuid)
returns table (outcome text)
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
    return query select 'forbidden'::text; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id for update;
  if v_task.id is null then
    return query select 'not_found'::text; return;
  end if;
  v_role := projects.project_role_refusal(v_task.project_id, v_task.assignee_id);
  if v_role is not null then
    return query select v_role; return;
  end if;
  if v_task.status <> 'todo' then
    return query select 'wrong_state'::text; return;
  end if;

  select * into v_check from projects.task_start_check(p_task_id);
  if not v_check.requirement_ok then
    return query select 'no_requirement'::text; return;
  end if;
  if v_check.open_dependencies > 0 then
    return query select 'dependencies_open'::text; return;
  end if;

  update projects.tasks set status = 'in_progress', started_at = coalesce(started_at, now()) where id = p_task_id;

  perform core.record_audit(
    v_task.organization_id, 'task.started', 'task', p_task_id,
    jsonb_build_object('status', v_task.status), jsonb_build_object('status', 'in_progress', 'projectId', v_task.project_id)
  );
  return query select 'started'::text;
end;
$$;

comment on function projects.start_task(uuid) is
  'SCR-041 / Q-C3 — todo → in_progress. Any task.write role, bound by the caller''s project role; refused wrong_state from any other status, no_requirement when the task is linked to no requirement or scope item, dependencies_open while the plan has an outstanding dependency; audited task.started.';

revoke all on function projects.start_task(uuid) from public, anon;
grant execute on function projects.start_task(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
