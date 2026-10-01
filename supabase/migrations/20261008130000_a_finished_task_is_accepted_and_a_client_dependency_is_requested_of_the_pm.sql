-- ═══════════════════════════════════════════════════════════════════════════
-- Trace C (PDF pages 46 to 63, SCR-037 to SCR-054): two lines the line-by-line
-- trace found unbuilt.
--
-- A. SCR-041 guardrails, verbatim from the PDF:
--      "Developer cannot decide own work is finally accepted"
--      "Task completion requires evidence and downstream QA where applicable"
--    The ready-for-QA door (projects.mark_task_ready_for_qa) already needs
--    evidence, but nothing stopped the Board, My Tasks or the task page from
--    setting a task to `done` directly: projects.set status = 'done' was open
--    to every role holding task.write (member, contractor), with no evidence.
--    Only an UNVERIFIED AGENT task was refused (tasks_refuse_unverified_agent_done).
--
--    The rule here uses only what the schema already says:
--      * the people who do the work (member, contractor: task.write only) do not
--        accept it; acceptance is a delivery-management act (core.can_manage_delivery:
--        owner, ops admin, delivery lead);
--      * a task is accepted only with evidence on it (projects.task_evidence, the
--        same rows the ready-for-QA door requires);
--      * "downstream QA where applicable": a task that has a defect raised against
--        it (qa.defects.task_id) is not accepted while that defect is open or
--        fixed-but-unverified. A task with no defect has no downstream QA to wait for.
--    It binds a PERSON'S session only (auth.uid() not null). The service role and
--    system writers (the job runner, verifiers, agents) are governed by their own
--    doors and are unchanged, exactly as the agent-verification trigger treats them.
--
-- B. SCR-040 action "Request missing client dependency through PM".
--    plan_dependencies already says a client item is the project manager's to
--    chase (CHECK plan_dependencies_client_items_are_pms), and "the PM" is
--    core.can_manage_delivery() (acknowledge_escalation). What was missing was the
--    request itself: a planner who finds the client has not supplied something had
--    only the free-text clarification, which dead-ends without a plan question.
--    This records a `dependency_requested` event on projects.development_events,
--    which the Development dashboard's "Waiting on the PM" list already reads and
--    the PM acknowledges. The plan row is not edited (a settled plan is immutable).
--
-- Additive and idempotent. No direct write grant is added.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── A. a finished task is accepted ─────────────────────────────────────────

create or replace function projects.require_acceptance_to_finish()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status is distinct from 'done' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'done' then
    return new;
  end if;
  -- A person's session only. The service role and system writers have no auth.uid().
  if (select auth.uid()) is null then
    return new;
  end if;

  if not coalesce((select core.can_manage_delivery()), false) then
    raise exception 'task_acceptance_not_yours: the person who does the work does not accept it. Mark it ready for QA with evidence; an owner, ops admin or delivery lead accepts it.'
      using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' or not exists (select 1 from projects.task_evidence e where e.task_id = new.id) then
    raise exception 'task_needs_evidence: a task is done only with evidence on it. Submit evidence on the task first.'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from qa.defects d where d.task_id = new.id and d.status in ('open', 'fixed')) then
    raise exception 'task_has_unverified_defect: a defect raised against this task is still open or waiting for QA to verify the fix.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function projects.require_acceptance_to_finish() is
  'SCR-041: a task reaches done only through a delivery-management role, with evidence on it, and with no unverified defect against it. Person sessions only; service role unchanged. Named to fire after tasks_refuse_unverified_agent_done so an unverified agent task still says agent_task_unverified.';

drop trigger if exists tasks_require_acceptance_to_finish on projects.tasks;
create trigger tasks_require_acceptance_to_finish
  before insert or update of status on projects.tasks
  for each row execute function projects.require_acceptance_to_finish();

-- ── B. a missing client dependency is requested of the PM ───────────────────

alter table projects.development_events drop constraint if exists development_events_kind_check;
alter table projects.development_events
  add constraint development_events_kind_check
  check (kind in ('blocker_escalated', 'qa_handoff_started', 'dependency_requested'));

create or replace function projects.request_client_dependency(
  p_dependency_id uuid,
  p_note          text default null
)
returns table (outcome text, event_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_dep   projects.plan_dependencies;
  v_plan  projects.project_plans;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_id    uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  select d.* into v_dep from projects.plan_dependencies d
   where d.id = p_dependency_id and d.organization_id = (select core.current_organization_id());
  if v_dep.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if v_dep.kind not in ('client_information', 'client_access') then
    return query select 'not_a_client_dependency'::text, null::uuid; return;
  end if;
  if v_dep.status not in ('pending', 'blocked') then
    return query select 'not_outstanding'::text, null::uuid; return;
  end if;
  if v_note is not null and length(v_note) > 4000 then
    return query select 'note_too_long'::text, null::uuid; return;
  end if;

  select * into v_plan from projects.project_plans p where p.id = v_dep.plan_id;
  if v_plan.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  if exists (
    select 1 from projects.development_events e
     where e.kind = 'dependency_requested' and e.status = 'open'
       and e.project_id = v_plan.project_id
       and e.detail ->> 'dependencyId' = p_dependency_id::text
  ) then
    return query select 'already_open'::text, null::uuid; return;
  end if;

  insert into projects.development_events (organization_id, project_id, kind, reason, detail, raised_by)
  values (
    v_dep.organization_id, v_plan.project_id, 'dependency_requested', v_note,
    jsonb_build_object('dependencyId', v_dep.id, 'description', v_dep.description, 'kind', v_dep.kind, 'neededByPhase', v_dep.needed_by_phase, 'planId', v_plan.id),
    v_actor
  )
  returning id into v_id;

  perform core.record_audit(
    v_dep.organization_id, 'plan.dependency_requested', 'plan_dependency', v_dep.id, null,
    jsonb_build_object('eventId', v_id, 'projectId', v_plan.project_id, 'description', v_dep.description, 'note', v_note)
  );
  return query select 'requested'::text, v_id;
end;
$$;

comment on function projects.request_client_dependency(uuid, text) is
  'SCR-040: a planner asks the PM (core.can_manage_delivery) to request an outstanding client dependency from the client. Records a dependency_requested development event once while it is open; audited plan.dependency_requested. The plan row is not edited.';

revoke all on function projects.request_client_dependency(uuid, text) from public, anon;
grant execute on function projects.request_client_dependency(uuid, text) to authenticated, service_role;

-- The PM acknowledges either kind; the audit row names what was acknowledged.
create or replace function projects.acknowledge_escalation(p_event_id uuid)
returns table (outcome text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.development_events;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_row from projects.development_events e where e.id = p_event_id for update;
  if v_row.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_row.status <> 'open' then
    return query select 'not_open'::text; return;
  end if;
  update projects.development_events set status = 'acknowledged', acknowledged_by = v_actor, acknowledged_at = now() where id = p_event_id;
  if v_row.kind = 'dependency_requested' then
    perform core.record_audit(
      v_row.organization_id, 'plan.dependency_request_acknowledged', 'plan_dependency',
      nullif(v_row.detail ->> 'dependencyId', '')::uuid,
      jsonb_build_object('status', 'open'), jsonb_build_object('status', 'acknowledged', 'eventId', p_event_id, 'projectId', v_row.project_id)
    );
  else
    perform core.record_audit(
      v_row.organization_id, 'task.escalation_acknowledged', 'task', v_row.task_id,
      jsonb_build_object('status', 'open'), jsonb_build_object('status', 'acknowledged', 'eventId', p_event_id, 'projectId', v_row.project_id)
    );
  end if;
  return query select 'acknowledged'::text;
end;
$$;

comment on function projects.acknowledge_escalation(uuid) is
  'SCR-039/040: the PM (owner, ops_admin, delivery_lead) acknowledges an escalated blocker or a requested client dependency. Audited task.escalation_acknowledged or plan.dependency_request_acknowledged.';

revoke all on function projects.acknowledge_escalation(uuid) from public, anon;
grant execute on function projects.acknowledge_escalation(uuid) to authenticated, service_role;
