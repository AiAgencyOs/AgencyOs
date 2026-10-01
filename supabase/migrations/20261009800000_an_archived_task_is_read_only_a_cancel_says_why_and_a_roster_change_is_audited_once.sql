-- ═══════════════════════════════════════════════════════════════════════════
-- Round 3e (owner decisions U1-1, U1-2, U1-3):
--
--  U1-1  An archived task is read-only. Whatever path writes the row (the
--        service, a door, PostgREST), a signed-in person cannot change the task
--        (status, fields, dependencies), nor add / change / remove a comment,
--        time log, checklist item, attachment, evidence row or dependency on it
--        or pointing at it, until it is unarchived. The one change an archived
--        task accepts is the unarchive itself (archived_at -> null, nothing
--        else), still by a roster manager through projects.set_task_archived.
--        A system writer with no person (service role, seed, verifiers) is not
--        bound, as for the project-role rules.
--
--  U1-2  Cancelling needs a reason: projects.tasks.cancel_reason (text). The
--        trigger refuses status -> cancelled without a non-empty reason
--        (task_cancel_requires_reason); the reason is cleared when the task is
--        reopened. The row audit (task.cancelled) carries the whole row, so the
--        reason is in the audit row. The assignee is told: event task.cancelled
--        (declared here, emitted when the task has an assignee other than the
--        person who cancelled it) and a derived inbox row through
--        projects.task_cancellations, the pattern projects.schedule_changes set.
--
--  U1-3  A roster change made through a door writes ONE audit row (the door's
--        project.member_*). The doors set the transaction-local flag
--        projects.via_door around their write and the table's audit trigger
--        skips its row while it is set (a WHEN clause on the trigger, so the
--        trigger function is not retyped). A direct service-role write keeps
--        the trigger's project_member.* row.
--
-- Additive and idempotent: the column is "if not exists", the check constraint
-- is dropped and recreated, functions are create or replace, triggers dropped
-- and recreated, the event type is on conflict do nothing.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── U1-2. the reason ─────────────────────────────────────────────────────

alter table projects.tasks add column if not exists cancel_reason text;

comment on column projects.tasks.cancel_reason is
  'U1-2. Why the task was cancelled; required when status becomes cancelled, cleared when it is reopened. The audit row (task.cancelled) keeps it.';

alter table projects.tasks drop constraint if exists tasks_cancel_reason_check;
alter table projects.tasks add constraint tasks_cancel_reason_check
  check (cancel_reason is null or length(btrim(cancel_reason)) between 1 and 1000);

insert into core.event_types (type, description, canonical) values
  ('task.cancelled',
   'U1-2. A task was cancelled, with the reason. Emitted when the task has an assignee other than the person who cancelled it; the assignee is told through the inbox.',
   false)
on conflict (type) do nothing;

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

  -- U1-2: a cancelled task carries its reason; any other status carries none.
  -- (A cancelled task archived or restored later is not asked for it again.)
  if new.status = 'cancelled' then
    if old.status is distinct from 'cancelled' or new.cancel_reason is distinct from old.cancel_reason then
      new.cancel_reason := nullif(btrim(coalesce(new.cancel_reason, '')), '');
      if new.cancel_reason is null then
        raise exception 'task_cancel_requires_reason: say why the task is cancelled'
          using errcode = 'check_violation';
      end if;
    end if;
  else
    new.cancel_reason := null;
  end if;

  if new.archived_at is distinct from old.archived_at and not v_manager then
    raise exception 'task_archive_requires_roster_manager: only an owner, an ops admin or a delivery lead archives a task'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

comment on function projects.guard_task_cancel_and_archive() is
  'T1-1 / U1-2. Cancel only from an open status by the assignee or a roster manager, and only with a reason; cancelled is terminal except a roster manager reopens it to todo (the reason is cleared); archived_at changes only by a roster manager. System writers (no person) are not bound by who, but a cancel still needs its reason.';

drop trigger if exists task_cancel_and_archive_guard on projects.tasks;
create trigger task_cancel_and_archive_guard
  before update of status, archived_at, cancel_reason on projects.tasks
  for each row execute function projects.guard_task_cancel_and_archive();

-- The assignee is told. Security definer: the outbox accepts a request-time
-- write only from an owner or ops admin, and a delivery lead or the assignee
-- cancels too.
create or replace function projects.announce_task_cancelled()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if new.assignee_id is null or new.assignee_id is not distinct from v_actor then
    return null;
  end if;
  perform core.emit_event(
    new.organization_id, 'task.cancelled', 'task', new.id,
    jsonb_build_object('taskId', new.id, 'projectId', new.project_id, 'assigneeId', new.assignee_id,
                       'cancelledBy', v_actor, 'reason', new.cancel_reason));
  return null;
end;
$$;

comment on function projects.announce_task_cancelled() is
  'U1-2. Emits task.cancelled for the assignee when a task is cancelled by somebody else. Skipped when there is no assignee or the assignee cancelled it themselves.';

drop trigger if exists task_cancelled_announce on projects.tasks;
create trigger task_cancelled_announce
  after update of status on projects.tasks
  for each row
  when (new.status = 'cancelled' and old.status is distinct from 'cancelled')
  execute function projects.announce_task_cancelled();

-- The inbox row: cancellations of my tasks by somebody else, from the audit trail.
create or replace function projects.task_cancellations(p_since timestamptz default null, p_limit integer default 50)
returns table (
  audit_id     bigint,
  changed_at   timestamptz,
  task_id      uuid,
  task_title   text,
  project_id   uuid,
  project_name text,
  reason       text,
  actor_name   text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org   uuid := (select core.current_organization_id());
  v_me    uuid := (select auth.uid());
  v_since timestamptz := coalesce(p_since, now() - interval '30 days');
  v_lim   integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  if v_me is null or not coalesce((select core.is_internal()), false) then
    return;
  end if;
  return query
  select a.id, a.created_at, a.subject_id, coalesce(a.after->>'title', ''),
         p.id, p.name, coalesce(a.after->>'cancel_reason', ''),
         coalesce(u.full_name, u.email)
    from audit.audit_log a
    join projects.projects p on p.id = nullif(a.after->>'project_id', '')::uuid
                            and p.organization_id = v_org and p.deleted_at is null
    left join core.users u on u.id = a.actor_id
   where a.organization_id = v_org
     and a.created_at >= v_since
     and a.action = 'task.cancelled'
     and a.subject_type = 'task'
     and nullif(a.after->>'assignee_id', '')::uuid = v_me
     and a.actor_id is distinct from v_me
   order by a.created_at desc, a.id desc
   limit v_lim;
end;
$$;

comment on function projects.task_cancellations(timestamptz, integer) is
  'U1-2. Tasks assigned to the caller that somebody else cancelled (from the audit trail), with the reason and who cancelled. The Notifications inbox lists them.';

revoke all on function projects.task_cancellations(timestamptz, integer) from public, anon;
grant execute on function projects.task_cancellations(timestamptz, integer) to authenticated, service_role;

-- ── U1-1. an archived task is read-only ──────────────────────────────────

create or replace function projects.refuse_change_to_archived_task()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- A system writer with no person (service role, seed, verifiers) is not bound.
  if (select auth.uid()) is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    -- Only a direct delete: a cascade (pg_trigger_depth > 1) is the parent's own business.
    if old.archived_at is not null and pg_trigger_depth() = 1 then
      raise exception 'task_archived_read_only: an archived task is read-only; restore it first'
        using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.archived_at is not null then
    if new.archived_at is null then
      -- Restore: archived_at is the only thing that may change.
      if (to_jsonb(new) - 'updated_at' - 'archived_at') is distinct from (to_jsonb(old) - 'updated_at' - 'archived_at') then
        raise exception 'task_archived_read_only: an archived task is read-only; restore it first'
          using errcode = 'check_violation';
      end if;
    elsif (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
      raise exception 'task_archived_read_only: an archived task is read-only; restore it first'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

comment on function projects.refuse_change_to_archived_task() is
  'U1-1. Refuses any change to an archived task by a signed-in person except the unarchive itself (archived_at to null, nothing else). System writers are not bound.';

drop trigger if exists a_refuse_change_to_archived_task on projects.tasks;
create trigger a_refuse_change_to_archived_task
  before update or delete on projects.tasks
  for each row execute function projects.refuse_change_to_archived_task();

create or replace function projects.refuse_change_on_archived_task_child()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ids uuid[] := '{}';
begin
  if (select auth.uid()) is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_ids := v_ids || array[(to_jsonb(old)->>'task_id')::uuid, (to_jsonb(old)->>'depends_on_task_id')::uuid];
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_ids := v_ids || array[(to_jsonb(new)->>'task_id')::uuid, (to_jsonb(new)->>'depends_on_task_id')::uuid];
  end if;
  if exists (select 1 from projects.tasks t where t.id = any (v_ids) and t.archived_at is not null) then
    raise exception 'task_archived_read_only: an archived task is read-only; restore it first'
      using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function projects.refuse_change_on_archived_task_child() is
  'U1-1. Refuses a comment, time log, checklist item, attachment, evidence row or dependency written by a signed-in person on, or pointing at, an archived task. System writers are not bound.';

drop trigger if exists a_refuse_change_on_archived_task on projects.task_comments;
create trigger a_refuse_change_on_archived_task
  before insert or update or delete on projects.task_comments
  for each row execute function projects.refuse_change_on_archived_task_child();

drop trigger if exists a_refuse_change_on_archived_task on projects.time_logs;
create trigger a_refuse_change_on_archived_task
  before insert or update or delete on projects.time_logs
  for each row execute function projects.refuse_change_on_archived_task_child();

drop trigger if exists a_refuse_change_on_archived_task on projects.task_checklist_items;
create trigger a_refuse_change_on_archived_task
  before insert or update or delete on projects.task_checklist_items
  for each row execute function projects.refuse_change_on_archived_task_child();

drop trigger if exists a_refuse_change_on_archived_task on projects.task_attachments;
create trigger a_refuse_change_on_archived_task
  before insert or update or delete on projects.task_attachments
  for each row execute function projects.refuse_change_on_archived_task_child();

drop trigger if exists a_refuse_change_on_archived_task on projects.task_evidence;
create trigger a_refuse_change_on_archived_task
  before insert or update or delete on projects.task_evidence
  for each row execute function projects.refuse_change_on_archived_task_child();

drop trigger if exists a_refuse_change_on_archived_task on projects.task_dependencies;
create trigger a_refuse_change_on_archived_task
  before insert or update or delete on projects.task_dependencies
  for each row execute function projects.refuse_change_on_archived_task_child();

-- The dependency doors answer in a word rather than an exception.
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
  -- U1-1: an archived task is read-only, on either end of the dependency.
  if v_task.archived_at is not null or v_other.archived_at is not null then
    return query select 'task_archived_read_only'::text; return;
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
  -- U1-1: an archived task is read-only, on either end of the dependency.
  if v_task.archived_at is not null
     or exists (select 1 from projects.tasks o where o.id = p_depends_on_task_id and o.archived_at is not null) then
    return query select 'task_archived_read_only'::text; return;
  end if;

  delete from projects.task_dependencies where id = v_dep.id;

  perform core.record_audit(v_org, 'task.dependency_removed', 'task', v_task.id,
    jsonb_build_object('dependsOnTaskId', p_depends_on_task_id, 'projectId', v_task.project_id), null);
  return query select 'removed'::text;
end;
$$;

revoke all on function projects.add_task_dependency(uuid, uuid) from public, anon;
revoke all on function projects.remove_task_dependency(uuid, uuid) from public, anon;
grant execute on function projects.add_task_dependency(uuid, uuid) to authenticated, service_role;
grant execute on function projects.remove_task_dependency(uuid, uuid) to authenticated, service_role;

-- ── U1-3. a roster change through a door is audited once ─────────────────

drop trigger if exists audit_row_change on projects.project_members;
create trigger audit_row_change after insert or update or delete on projects.project_members
  for each row
  when (coalesce(current_setting('projects.via_door', true), '') <> '1')
  execute function projects.record_stream_fc_change();

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

  perform set_config('projects.via_door', '1', true);
  insert into projects.project_members (organization_id, project_id, user_id, project_role, added_by)
  values (v_org, p_project_id, p_user_id, p_project_role, v_actor)
  returning id into v_id;
  perform set_config('projects.via_door', '', true);

  perform core.record_audit(v_org, 'project.member_added', 'project', p_project_id, null,
    jsonb_build_object('memberId', v_id, 'userId', p_user_id, 'projectRole', p_project_role));
  return query select 'added'::text, v_id;
end;
$$;

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

  perform set_config('projects.via_door', '1', true);
  update projects.project_members set project_role = p_project_role where id = p_member_id;
  perform set_config('projects.via_door', '', true);

  perform core.record_audit(v_org, 'project.member_role_changed', 'project', v_before.project_id,
    jsonb_build_object('memberId', v_before.id, 'userId', v_before.user_id, 'projectRole', v_before.project_role),
    jsonb_build_object('memberId', v_before.id, 'userId', v_before.user_id, 'projectRole', p_project_role));
  return query select 'changed'::text, v_before.id;
end;
$$;

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

  perform set_config('projects.via_door', '1', true);
  delete from projects.project_members where id = p_member_id;
  perform set_config('projects.via_door', '', true);

  perform core.record_audit(v_org, 'project.member_removed', 'project', v_before.project_id,
    jsonb_build_object('memberId', v_before.id, 'userId', v_before.user_id, 'projectRole', v_before.project_role), null);
  return query select 'removed'::text, v_before.id;
end;
$$;

revoke all on function projects.add_project_member(uuid, uuid, text) from public, anon;
revoke all on function projects.change_project_member_role(uuid, text) from public, anon;
revoke all on function projects.remove_project_member(uuid) from public, anon;
grant execute on function projects.add_project_member(uuid, uuid, text) to authenticated, service_role;
grant execute on function projects.change_project_member_role(uuid, text) to authenticated, service_role;
grant execute on function projects.remove_project_member(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
