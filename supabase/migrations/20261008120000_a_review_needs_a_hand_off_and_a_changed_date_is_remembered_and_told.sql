-- ═══════════════════════════════════════════════════════════════════════════
-- TRACE B — the line-level trace of PDF pages 28-45 found two rules that were
-- enforced only where the screen drew them, and one that had no history at all.
--
--  1. A task enters Review only through the hand-off (SCR-020 "Move task only
--     through valid state transitions", SCR-021 "Submit for review").
--     `projects.mark_task_ready_for_qa` already insists on in progress + evidence
--     + not blocked, but the plain status door (and any other writer) could set
--     `in_review` on a task straight from To do or Blocked, with no evidence.
--     A BEFORE UPDATE trigger now refuses that move whichever path writes the
--     row, exactly as the agent-verification gate does for Done.
--
--  2. A milestone's due date change leaves a trace (SCR-022 "Changes must
--     preserve history", SCR-023 "Every significant action writes an audit
--     event"). `projects.milestones` had no audit trigger and its due date was
--     changed by a plain UPDATE, so the move of a date left nothing behind. An
--     AFTER UPDATE trigger records `milestone.due_changed` with the old and new
--     date and the actor.
--
--  3. The people a date change affects are told (SCR-022 "...notify affected
--     owners"). `projects.schedule_changes` is a read door over the audit trail
--     (task.schedule_set, milestone.due_changed, project.updated with a new due
--     date) that returns only changes where a date really moved, with the old and
--     new date and the actor's name. With `p_mine` it returns only the changes
--     that concern the caller and were made by somebody else:
--        * a task's date: the task's assignee and the project's delivery lead;
--        * a milestone's date: the assignees of the tasks filed under it and the
--          project's delivery lead;
--        * the project's due date: the delivery lead and the project's members.
--     The Notifications inbox lists these rows (derived, like every other row
--     there); nothing is stored beyond the audit rows themselves.
--
-- Additive and idempotent. No table, no direct write grant: a trigger and a read
-- door. The door re-checks the caller is internal and reads only its own
-- organisation; it never returns the before/after snapshots, only the two dates.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Review is entered through the hand-off ───────────────────────────

create or replace function projects.refuse_review_without_hand_off()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'in_review' and old.status is distinct from 'in_review' then
    if old.status <> 'in_progress' then
      raise exception 'task_review_requires_hand_off: a task enters review only from in progress, through its hand-off (was %)', old.status
        using errcode = 'check_violation';
    end if;
    if not exists (select 1 from projects.task_evidence e where e.task_id = new.id) then
      raise exception 'task_review_requires_hand_off: a task enters review only with evidence attached'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

comment on function projects.refuse_review_without_hand_off() is
  'SCR-020/021. A task enters in_review only from in_progress and only with at least one task_evidence row, whichever path writes it (the hand-off door satisfies both). Every other move is unchanged.';

drop trigger if exists refuse_review_without_hand_off on projects.tasks;
create trigger refuse_review_without_hand_off
  before update of status on projects.tasks
  for each row execute function projects.refuse_review_without_hand_off();

-- ── 2. A milestone's due date change is audited ─────────────────────────

create or replace function projects.audit_milestone_due_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.due_on is distinct from old.due_on then
    perform core.record_audit(
      new.organization_id, 'milestone.due_changed', 'milestone', new.id,
      jsonb_build_object('dueOn', old.due_on, 'name', old.name),
      jsonb_build_object('dueOn', new.due_on, 'name', new.name, 'projectId', new.project_id)
    );
  end if;
  return null;
end;
$$;

comment on function projects.audit_milestone_due_change() is
  'SCR-022/023. Appends milestone.due_changed (old and new due date, the milestone name, the project) to the audit trail whenever a milestone''s due date moves, by any writer.';

drop trigger if exists audit_milestone_due_change on projects.milestones;
create trigger audit_milestone_due_change
  after update of due_on on projects.milestones
  for each row execute function projects.audit_milestone_due_change();

-- ── 3. The schedule changes, and who they concern ───────────────────────

create or replace function projects.schedule_changes(
  p_project_id uuid    default null,
  p_mine       boolean default false,
  p_since      timestamptz default null,
  p_limit      integer default 50
)
returns table (
  audit_id     bigint,
  changed_at   timestamptz,
  kind         text,
  subject_id   uuid,
  project_id   uuid,
  project_name text,
  label        text,
  was_on       date,
  now_on       date,
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
  v_since timestamptz := coalesce(p_since, now() - interval '90 days');
  v_lim   integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  if v_me is null or not coalesce((select core.is_internal()), false) then
    return;
  end if;

  return query
  with changes as (
    select a.id as aid, a.created_at as at, 'task'::text as k, a.subject_id as sid,
           nullif(a.after->>'projectId', '')::uuid as pid,
           nullif(a.before->>'dueOn', '')::date as was, nullif(a.after->>'dueOn', '')::date as nowd,
           a.actor_id as actor
      from audit.audit_log a
     where a.organization_id = v_org and a.created_at >= v_since
       and a.action = 'task.schedule_set'
       and (a.before->>'dueOn') is distinct from (a.after->>'dueOn')
    union all
    select a.id, a.created_at, 'milestone', a.subject_id,
           nullif(a.after->>'projectId', '')::uuid,
           nullif(a.before->>'dueOn', '')::date, nullif(a.after->>'dueOn', '')::date,
           a.actor_id
      from audit.audit_log a
     where a.organization_id = v_org and a.created_at >= v_since
       and a.action = 'milestone.due_changed'
    union all
    select a.id, a.created_at, 'project', a.subject_id, a.subject_id,
           nullif(a.before->>'ends_on', '')::date, nullif(a.after->>'ends_on', '')::date,
           a.actor_id
      from audit.audit_log a
     where a.organization_id = v_org and a.created_at >= v_since
       and a.action = 'project.updated' and a.subject_type = 'project'
       and (a.before->>'ends_on') is distinct from (a.after->>'ends_on')
  )
  select c.aid, c.at, c.k, c.sid, p.id, p.name,
         case c.k when 'task' then t.title when 'milestone' then m.name else p.name end,
         c.was, c.nowd, coalesce(u.full_name, u.email)
    from changes c
    join projects.projects p on p.id = c.pid and p.organization_id = v_org and p.deleted_at is null
    left join projects.tasks t on c.k = 'task' and t.id = c.sid
    left join projects.milestones m on c.k = 'milestone' and m.id = c.sid
    left join core.users u on u.id = c.actor
   where (p_project_id is null or p.id = p_project_id)
     and (
       not coalesce(p_mine, false)
       or (
         c.actor is distinct from v_me
         and (
           p.delivery_lead_id = v_me
           or (c.k = 'task' and t.assignee_id = v_me)
           or (c.k = 'milestone' and exists (
                 select 1 from projects.tasks mt where mt.milestone_id = c.sid and mt.assignee_id = v_me))
           or (c.k = 'project' and exists (
                 select 1 from projects.project_members pm where pm.project_id = p.id and pm.user_id = v_me))
         )
       )
     )
   order by c.at desc, c.aid desc
   limit v_lim;
end;
$$;

comment on function projects.schedule_changes(uuid, boolean, timestamptz, integer) is
  'SCR-022. The date changes recorded in the audit trail (task due date, milestone due date, project due date) where a date really moved: old and new date, the thing, the project, the actor''s name. Never the snapshots. p_mine keeps only the changes that concern the caller (assignee of the task or of a task under the milestone, delivery lead, project member for the project date) and were made by somebody else.';

revoke all on function projects.schedule_changes(uuid, boolean, timestamptz, integer) from public, anon;
grant execute on function projects.schedule_changes(uuid, boolean, timestamptz, integer) to authenticated, service_role;
