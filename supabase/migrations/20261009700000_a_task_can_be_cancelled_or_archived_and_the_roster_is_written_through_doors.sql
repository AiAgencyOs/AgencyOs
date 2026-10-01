-- ═══════════════════════════════════════════════════════════════════════════
-- Round 3d, stream U1 (owner decisions T1-1, T1-2):
--
--  T1-1  Tasks gain a real `cancelled` status and an `archived_at` column.
--        A cancelled or archived task is SATISFIED as a dependency and is not
--        outstanding work: progress, health, KPIs, phase readiness, sprint
--        close, module progress and requirement coverage do not count it.
--        Moves (trigger projects.guard_task_cancel_and_archive, whichever path
--        writes the row; a system writer with no person is not bound):
--          - cancel: from todo, in progress, blocked or in review (never from
--            done), by an owner / ops admin / delivery lead (role union) or the
--            task's assignee;
--          - cancelled is terminal, except a roster manager may reopen it to
--            todo;
--          - archive / unarchive: only by a roster manager, through the audited
--            door projects.set_task_archived (task.archived / task.unarchived).
--        Q-B1 (done only from in review) and the B2 project-role binding are
--        untouched: other triggers on the same row still fire.
--        The dependency check reads the real columns now (no to_jsonb).
--
--  T1-2  The project roster (project_members) is written through audited
--        security-definer doors: add_project_member, change_project_member_role,
--        remove_project_member (roster-manager role union, tenancy, audit rows
--        project.member_added / project.member_role_changed /
--        project.member_removed). The write policy is dropped and the write
--        grants revoked from authenticated: select only. The service role (seed,
--        verifiers) bypasses RLS and keeps its grants.
--
-- Additive and idempotent: columns "if not exists", the check constraint is
-- dropped and recreated, functions are create or replace, triggers dropped and
-- recreated.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── T1-1. the column and the status ──────────────────────────────────────

alter table projects.tasks add column if not exists archived_at timestamptz;

comment on column projects.tasks.archived_at is
  'T1-1. Set when a roster manager archives the task (projects.set_task_archived). An archived task is hidden from default lists and is not outstanding work; its status is kept.';

alter table projects.tasks drop constraint if exists tasks_status_check;
alter table projects.tasks add constraint tasks_status_check
  check (status in ('todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'));

create index if not exists tasks_project_open_idx on projects.tasks (project_id, status) where archived_at is null;

-- ── T1-1. cancel / reopen / archive are governed moves ───────────────────

create or replace function projects.guard_task_cancel_and_archive()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_manager boolean;
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;
  v_manager := v_actor is null or coalesce((select projects.is_roster_manager()), false);

  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    if old.status not in ('todo', 'in_progress', 'blocked', 'in_review') then
      raise exception 'task_cancel_from_open_only: a task is cancelled only while it is open (was %)', old.status
        using errcode = 'check_violation';
    end if;
    if not v_manager and old.assignee_id is distinct from v_actor then
      raise exception 'task_cancel_requires_owner_or_lead: only the task''s assignee, an owner, an ops admin or a delivery lead cancels a task'
        using errcode = 'insufficient_privilege';
    end if;
  elsif old.status = 'cancelled' and new.status is distinct from 'cancelled' then
    if new.status <> 'todo' or not v_manager then
      raise exception 'task_cancelled_is_terminal: a cancelled task can only be reopened to To do, by an owner, an ops admin or a delivery lead'
        using errcode = 'check_violation';
    end if;
  end if;

  if new.archived_at is distinct from old.archived_at and not v_manager then
    raise exception 'task_archive_requires_roster_manager: only an owner, an ops admin or a delivery lead archives a task'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

comment on function projects.guard_task_cancel_and_archive() is
  'T1-1. Cancel only from an open status by the assignee or a roster manager; cancelled is terminal except a roster manager reopens it to todo; archived_at changes only by a roster manager. System writers (no person) are not bound.';

drop trigger if exists task_cancel_and_archive_guard on projects.tasks;
create trigger task_cancel_and_archive_guard
  before update of status, archived_at on projects.tasks
  for each row execute function projects.guard_task_cancel_and_archive();

create or replace function projects.set_task_archived(p_task_id uuid, p_archived boolean)
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
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select projects.is_roster_manager()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id and t.organization_id = v_org for update;
  if v_task.id is null then
    return query select 'not_found'::text; return;
  end if;
  if coalesce(p_archived, false) = (v_task.archived_at is not null) then
    return query select 'unchanged'::text; return;
  end if;

  update projects.tasks
     set archived_at = case when coalesce(p_archived, false) then now() else null end
   where id = p_task_id;

  perform core.record_audit(v_org,
    case when coalesce(p_archived, false) then 'task.archived' else 'task.unarchived' end,
    'task', p_task_id,
    jsonb_build_object('archivedAt', v_task.archived_at),
    jsonb_build_object('archived', coalesce(p_archived, false), 'projectId', v_task.project_id));
  return query select (case when coalesce(p_archived, false) then 'archived' else 'unarchived' end)::text;
end;
$$;

comment on function projects.set_task_archived(uuid, boolean) is
  'T1-1. Archives or unarchives one task. Owner, ops admin and delivery lead by the role union; tenancy checked; audited task.archived / task.unarchived.';

revoke all on function projects.set_task_archived(uuid, boolean) from public, anon;
grant execute on function projects.set_task_archived(uuid, boolean) to authenticated, service_role;

-- ── T1-1. a closed dependency is satisfied: the real columns ─────────────

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

  -- Satisfied: done, cancelled, or archived (archived_at set). Open: the rest.
  select string_agg('"' || x.title || '" (' || replace(x.status::text, '_', ' ') || ')', ', ' order by x.title)
    into v_names
    from (
      select t.title, t.status
        from projects.task_dependencies d
        join projects.tasks t on t.id = d.depends_on_task_id
       where d.task_id = p_task_id
         and t.status not in ('done', 'cancelled')
         and t.archived_at is null
       order by t.title
       limit 3
    ) x;
  select count(*)::integer into v_open
    from projects.task_dependencies d
    join projects.tasks t on t.id = d.depends_on_task_id
   where d.task_id = p_task_id
     and t.status not in ('done', 'cancelled')
     and t.archived_at is null;

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
  'Q-C3 / R2-1 / T1-1. The two gates in front of Start Task: the requirement check and the dependency check (every task this task depends on is done, cancelled or archived; a dependency on another project is refused when it is written). reason names the failing task.';

revoke all on function projects.task_start_check(uuid) from public, anon;
grant execute on function projects.task_start_check(uuid) to authenticated, service_role;

-- start_task: an archived task is not started (it is not open work).
create or replace function projects.start_task(p_task_id uuid)
returns table (outcome text, detail text)
language plpgsql
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
  if v_task.status <> 'todo' or v_task.archived_at is not null then
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

-- ── T1-1. cancelled / archived tasks are not outstanding work ────────────

create or replace function projects.module_progress(p_project_id uuid)
returns table (module_id uuid, name text, status text, tasks_total bigint, tasks_done bigint, open_defects bigint)
language sql
stable
set search_path = ''
as $$
  select
    m.id, m.name, m.status,
    (select count(*) from projects.tasks t
      where t.module_id = m.id and t.status <> 'cancelled' and t.archived_at is null),
    (select count(*) from projects.tasks t
      where t.module_id = m.id and t.status = 'done' and t.archived_at is null),
    (select count(*) from qa.defects d
      join projects.deliverables dv on dv.id = d.deliverable_id
     where dv.module_id = m.id and d.status = 'open')
  from projects.modules m
 where m.project_id = p_project_id
 order by m.position, m.name;
$$;

create or replace function projects.requirement_coverage(p_project_id uuid)
returns table (requirement_version_id uuid, version integer, modules integer, features integer, tasks integer, tasks_done integer)
language sql
stable
set search_path = ''
as $$
  select rv.id,
         rv.version,
         (select count(distinct m.id)::int from projects.modules m
           where m.project_id = p_project_id and m.requirement_version_id = rv.id),
         (select count(distinct f.id)::int from projects.features f
           where f.project_id = p_project_id and f.requirement_version_id = rv.id),
         (select count(*)::int from projects.tasks t
           where t.project_id = p_project_id and t.requirement_version_id = rv.id
             and t.status <> 'cancelled' and t.archived_at is null),
         (select count(*)::int from projects.tasks t
           where t.project_id = p_project_id and t.requirement_version_id = rv.id
             and t.status = 'done' and t.archived_at is null)
    from crm.requirement_versions rv
   where rv.conversation_id in (
           -- Through the opportunity, for the reason break_down_requirement
           -- gives: projects.lead_id is a core.users reference, the delivery
           -- lead, and joining on it here would silently return nothing.
           select c.id from crm.conversations c
            where c.lead_id = (
              select o.lead_id
                from projects.projects p
                join sales.opportunities o on o.id = p.opportunity_id
               where p.id = p_project_id
            )
         )
     and rv.status = 'accepted'
   order by rv.version desc;
$$;

create or replace function projects.start_qa_handoff(p_project_id uuid)
returns table (outcome text, event_id uuid, blocked integer, not_ready integer)
language plpgsql
set search_path = ''
as $$
declare
  v_actor     uuid := (select auth.uid());
  v_org       uuid;
  v_blocked   int;
  v_not_ready int;
  v_id        uuid;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text, null::uuid, null::int, null::int; return;
  end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id;
  if v_org is null then
    return query select 'not_found'::text, null::uuid, null::int, null::int; return;
  end if;

  -- An archived task is not open work (a cancelled one is in neither list).
  select count(*) filter (where t.status = 'blocked')::int,
         count(*) filter (where t.status in ('todo', 'in_progress'))::int
    into v_blocked, v_not_ready
    from projects.tasks t where t.project_id = p_project_id and t.archived_at is null;

  -- The gate: nothing blocked, nothing still being worked on.
  if v_blocked > 0 or v_not_ready > 0 then
    return query select 'gate_refused'::text, null::uuid, v_blocked, v_not_ready; return;
  end if;
  if exists (select 1 from projects.development_events e where e.project_id = p_project_id and e.kind = 'qa_handoff_started' and e.status = 'open') then
    return query select 'already_open'::text, null::uuid, 0, 0; return;
  end if;

  insert into projects.development_events (organization_id, project_id, kind, detail, raised_by)
  values (v_org, p_project_id, 'qa_handoff_started', jsonb_build_object('blocked', v_blocked, 'notReady', v_not_ready), v_actor)
  returning id into v_id;

  perform core.record_audit(
    v_org, 'project.qa_handoff_started', 'project', p_project_id, null,
    jsonb_build_object('eventId', v_id)
  );
  return query select 'started'::text, v_id, 0, 0;
end;
$$;

create or replace function projects.close_sprint(p_sprint_id uuid)
returns table (outcome text)
language plpgsql
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

  select count(*)::integer into v_open from projects.tasks t
   where t.sprint_id = p_sprint_id and t.status not in ('done', 'cancelled') and t.archived_at is null;
  update projects.sprints set closed_at = now(), closed_by = v_actor where id = p_sprint_id;

  perform core.record_audit(
    v_org, 'sprint.closed', 'sprint', p_sprint_id,
    jsonb_build_object('name', v_sprint.name),
    jsonb_build_object('projectId', v_sprint.project_id, 'unfinishedTasks', v_open)
  );
  return query select 'closed'::text;
end;
$$;

-- phase readiness: Phase 5 counts development tasks (cancelled and archived ones do not count).
CREATE OR REPLACE FUNCTION projects.phase_readiness(p_project_id uuid, p_phase integer)
 RETURNS TABLE(outcome text, missing text[], facts jsonb)
 LANGUAGE plpgsql
 STABLE
 set search_path = ''
AS $$
declare
  v_org      uuid;
  v_missing  text[] := '{}';
  v_total    int;
  v_open     int;
  v_runs     int;
  v_failing  int;
  v_blockers int;
  v_m2       boolean;
begin
  if p_phase not in (5, 6) then
    return query select 'invalid_phase'::text, '{}'::text[], '{}'::jsonb; return;
  end if;

  select p.organization_id into v_org
    from projects.projects p
   where p.id = p_project_id and p.deleted_at is null;
  if v_org is null then
    return query select 'not_found'::text, '{}'::text[], '{}'::jsonb; return;
  end if;

  if exists (select 1 from projects.phase_completions c where c.project_id = p_project_id and c.phase = p_phase) then
    return query select 'completed'::text, '{}'::text[], '{}'::jsonb; return;
  end if;

  -- T1-1: a cancelled or archived task is not outstanding work and does not block.
  select count(*), count(*) filter (where t.status not in ('done', 'completed'))
    into v_total, v_open
    from projects.tasks t
   where t.project_id = p_project_id
     and (t.module_id is not null or t.feature_id is not null)
     and t.status <> 'cancelled'
     and t.archived_at is null;

  if p_phase = 5 then
    if v_total = 0 then
      v_missing := array_append(v_missing, 'No development task exists yet (a task attached to a module or a feature).');
    elsif v_open > 0 then
      v_missing := array_append(v_missing, format('%s of %s development task%s not done yet.', v_open, v_total, case when v_total = 1 then ' is' else 's are' end));
    end if;
    -- R1-3: the M2 invoice must be verified paid (the verified basis).
    v_m2 := projects.m2_verified_paid(p_project_id);
    if not v_m2 then
      v_missing := array_append(v_missing, 'M2 not verified paid');
    end if;
    return query select case when cardinality(v_missing) = 0 then 'ready' else 'not_ready' end::text,
                        v_missing,
                        jsonb_build_object('developmentTasks', v_total, 'openDevelopmentTasks', v_open, 'm2VerifiedPaid', v_m2);
    return;
  end if;

  -- Phase 6
  if not exists (select 1 from projects.phase_completions c where c.project_id = p_project_id and c.phase = 5) then
    v_missing := array_append(v_missing, 'Phase 5 is not complete yet.');
  end if;

  select count(*) into v_runs from qa.test_runs r where r.project_id = p_project_id;
  if v_runs = 0 then
    v_missing := array_append(v_missing, 'No test run has been recorded.');
  end if;

  select count(*) into v_failing
    from (
      select distinct on (r.suite) r.suite, r.failed
        from qa.test_runs r
       where r.project_id = p_project_id
       order by r.suite, r.executed_at desc, r.created_at desc
    ) latest
   where latest.failed > 0;
  if v_failing > 0 then
    v_missing := array_append(v_missing, format('The latest run of %s suite%s has failures.', v_failing, case when v_failing = 1 then '' else 's' end));
  end if;

  select count(*) into v_blockers
    from qa.defects d
   where d.project_id = p_project_id and d.status = 'open' and d.severity in ('blocker', 'major');
  if v_blockers > 0 then
    v_missing := array_append(v_missing, format('%s blocker or major defect%s still open.', v_blockers, case when v_blockers = 1 then ' is' else 's are' end));
  end if;

  return query select case when cardinality(v_missing) = 0 then 'ready' else 'not_ready' end::text,
                      v_missing,
                      jsonb_build_object('testRuns', v_runs, 'suitesWithFailures', v_failing, 'openBlockingDefects', v_blockers);
end;
$$;

-- ── T1-2. the roster is written through audited doors ────────────────────

create or replace function projects.add_project_member(p_project_id uuid, p_user_id uuid, p_project_role text)
returns table (outcome text, member_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_id    uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select projects.is_roster_manager()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if p_project_role is null or p_project_role not in ('project_manager', 'designer', 'developer', 'qa', 'contributor', 'observer') then
    return query select 'bad_role'::text, null::uuid; return;
  end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null) then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if not exists (
    select 1 from core.memberships m
     where m.user_id = p_user_id and m.organization_id = v_org and m.status = 'active'
       and m.role in ('owner', 'ops_admin', 'delivery_lead', 'member', 'contractor')
  ) then
    return query select 'not_internal'::text, null::uuid; return;
  end if;
  if exists (select 1 from projects.project_members x where x.project_id = p_project_id and x.user_id = p_user_id) then
    return query select 'already_member'::text, null::uuid; return;
  end if;

  insert into projects.project_members (organization_id, project_id, user_id, project_role, added_by)
  values (v_org, p_project_id, p_user_id, p_project_role, v_actor)
  returning id into v_id;

  perform core.record_audit(v_org, 'project.member_added', 'project', p_project_id, null,
    jsonb_build_object('memberId', v_id, 'userId', p_user_id, 'projectRole', p_project_role));
  return query select 'added'::text, v_id;
end;
$$;

comment on function projects.add_project_member(uuid, uuid, text) is
  'T1-2. Puts a person on a project roster. Owner, ops admin and delivery lead by the role union; the person must hold an active internal membership in this organisation; audited project.member_added.';

create or replace function projects.change_project_member_role(p_member_id uuid, p_project_role text)
returns table (outcome text, member_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_before projects.project_members;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select projects.is_roster_manager()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if p_project_role is null or p_project_role not in ('project_manager', 'designer', 'developer', 'qa', 'contributor', 'observer') then
    return query select 'bad_role'::text, null::uuid; return;
  end if;
  select * into v_before from projects.project_members x where x.id = p_member_id and x.organization_id = v_org for update;
  if v_before.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if v_before.project_role = p_project_role then
    return query select 'unchanged'::text, v_before.id; return;
  end if;

  update projects.project_members set project_role = p_project_role where id = p_member_id;

  perform core.record_audit(v_org, 'project.member_role_changed', 'project', v_before.project_id,
    jsonb_build_object('memberId', v_before.id, 'userId', v_before.user_id, 'projectRole', v_before.project_role),
    jsonb_build_object('memberId', v_before.id, 'userId', v_before.user_id, 'projectRole', p_project_role));
  return query select 'changed'::text, v_before.id;
end;
$$;

comment on function projects.change_project_member_role(uuid, text) is
  'T1-2. Changes one roster member''s project role. Role union of owner, ops admin, delivery lead; tenancy checked; audited project.member_role_changed.';

create or replace function projects.remove_project_member(p_member_id uuid)
returns table (outcome text, member_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_before projects.project_members;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select projects.is_roster_manager()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  select * into v_before from projects.project_members x where x.id = p_member_id and x.organization_id = v_org for update;
  if v_before.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  delete from projects.project_members where id = p_member_id;

  perform core.record_audit(v_org, 'project.member_removed', 'project', v_before.project_id,
    jsonb_build_object('memberId', v_before.id, 'userId', v_before.user_id, 'projectRole', v_before.project_role), null);
  return query select 'removed'::text, v_before.id;
end;
$$;

comment on function projects.remove_project_member(uuid) is
  'T1-2. Takes a person off a project roster. Role union of owner, ops admin, delivery lead; tenancy checked; audited project.member_removed.';

revoke all on function projects.add_project_member(uuid, uuid, text) from public, anon;
revoke all on function projects.change_project_member_role(uuid, text) from public, anon;
revoke all on function projects.remove_project_member(uuid) from public, anon;
grant execute on function projects.add_project_member(uuid, uuid, text) to authenticated, service_role;
grant execute on function projects.change_project_member_role(uuid, text) to authenticated, service_role;
grant execute on function projects.remove_project_member(uuid) to authenticated, service_role;

-- Select only for a signed-in person; the doors above are the only way in.
drop policy if exists project_members_write on projects.project_members;
revoke insert, update, delete on projects.project_members from authenticated;

notify pgrst, 'reload schema';
