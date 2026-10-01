-- ═══════════════════════════════════════════════════════════════════════════
-- Round 3f (owner decision V1-1): adding a subtask under an archived task is
-- refused. The archived task is wholly read-only (migration 20261009800000);
-- a new row pointing at it as its parent was the gap.
--
--  * projects.add_subtask answers outcome 'task_archived_read_only' when the
--    parent is archived (a signed-in person; a system writer with no person is
--    not bound, as for the other archived rules).
--  * A BEFORE INSERT trigger on projects.tasks refuses the same insert by any
--    other path (PostgREST), with the same sentence as the other archived
--    refusals.
--
-- V1-2 (a cancel always carries a reason, for every writer, the service role
-- included) already holds: task_cancel_requires_reason is not bound to a person.
--
-- Additive and idempotent: functions are create or replace, the trigger is
-- dropped and recreated.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.refuse_subtask_under_archived_task()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.parent_task_id is null or (select auth.uid()) is null then
    return new;
  end if;
  if exists (select 1 from projects.tasks p where p.id = new.parent_task_id and p.archived_at is not null) then
    raise exception 'task_archived_read_only: an archived task is read-only; restore it first'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function projects.refuse_subtask_under_archived_task() is
  'V1-1. Refuses a new subtask whose parent task is archived, for a signed-in person. System writers are not bound.';

drop trigger if exists a_refuse_subtask_under_archived_task on projects.tasks;
create trigger a_refuse_subtask_under_archived_task
  before insert on projects.tasks
  for each row execute function projects.refuse_subtask_under_archived_task();

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
  if v_parent.archived_at is not null and (select auth.uid()) is not null then
    return query select 'task_archived_read_only'::text, null::uuid; return;
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
  'Adds a subtask under a task. One level only (refused nested from a subtask); inherits the parent''s project, module, feature and milestone. Any task.write role; refused (task_archived_read_only) under an archived task; audited task.subtask_added.';

revoke all on function projects.add_subtask(uuid, text, date, uuid) from public, anon;
grant execute on function projects.add_subtask(uuid, text, date, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
