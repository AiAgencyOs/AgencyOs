-- Phase 5 follow-up: connect the Orchestrator's built-but-unreachable writers to the things that really happen.
--
--   1. LEASES.  start_task claims a concurrency lease on the task's affected files (a project that has a phase_five workspace only) and refuses with
--      'path_lease_conflict' when another live lease overlaps and the two tasks are not sequenced; a lease is released when the task leaves in_progress.
--   2. QA EVENTS.  Two event types, project.dev_task_qa_failed / project.dev_task_qa_passed, are written where the QA fact is written (a CLOSED test
--      run linked to a planned task, or a defect raised against one), so the Orchestrator's routeQaFailed / routeQaPassed have something to react to.
--
-- Nothing here is a decision: the lease rules are claim_concurrency_lease's own (copied from its LIVE definition, not retyped), and the events are
-- claims the handler re-checks against the rows.

-- ── 1a. the claim, callable from another door ───────────────────────────────
-- claim_concurrency_lease answers only the service role (it reads auth.role()). start_task runs for a signed-in person, so it needs the same claim
-- without the role gate. The body is DERIVED from the live definition so the two can not disagree about what "the same files" means; the new
-- function is callable by nobody but a SECURITY DEFINER door (no grant to any request role).
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('projects.claim_concurrency_lease(uuid,text,text[],integer)'::regprocedure);
  n := replace(d, 'projects.claim_concurrency_lease(', 'projects.claim_lease_internal(');
  if n = d then raise exception 'claim_lease_internal: function name anchor not found'; end if;
  d := n;
  n := replace(d, $r$  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid, null::uuid, null::uuid; return; end if;
$r$, '');
  if n = d then raise exception 'claim_lease_internal: role gate anchor not found'; end if;
  execute n;
end $m$;
revoke all on function projects.claim_lease_internal(uuid, text, text[], integer) from public, anon, authenticated, service_role;

-- ── 1b. start_task claims the lease (patched on the LIVE definition) ─────────
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('projects.start_task(uuid)'::regprocedure);

  n := replace(d, '  v_base  uuid;', '  v_base  uuid;
  v_lease record;');
  if n = d then raise exception 'start_task: declare anchor not found'; end if;
  d := n;

  n := replace(d, '  update projects.tasks set status = ''in_progress'',', $r$  -- the files this task will change are claimed for it, for a project with a Phase 5 workspace. The claim's own rule (overlap, unless the two tasks
  -- are sequenced) decides; a refusal is the answer here and the task stays todo.
  if cardinality(v_task.affected_paths) > 0 and exists (select 1 from projects.phase_five f where f.project_id = v_task.project_id) then
    select * into v_lease from projects.claim_lease_internal(p_task_id, coalesce(nullif(btrim(v_task.required_capability), ''), 'task_owner'), v_task.affected_paths, 1440);
    if v_lease.outcome = 'conflict' then
      return query select 'path_lease_conflict'::text,
        'Another task holds a lease on the same files and this one is not sequenced with it: wait for it to finish, or add the dependency.'::text;
      return;
    end if;
    if v_lease.outcome not in ('claimed', 'already_leased') then
      return query select 'path_lease_invalid'::text, ('The task''s affected files could not be leased (' || v_lease.outcome || ').')::text;
      return;
    end if;
  end if;

  update projects.tasks set status = 'in_progress',$r$);
  if n = d then raise exception 'start_task: update anchor not found'; end if;
  d := n;

  execute d;
end $m$;

-- ── 1c. a lease ends when the task leaves in_progress ────────────────────────
create or replace function projects.release_leases_of_task() returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    update projects.concurrency_leases l
       set state = 'released', released_at = now(), release_reason = left('task left in_progress: ' || coalesce(new.status, ''), 300)
     where l.task_id = new.id and l.state = 'active'
    returning l.id, l.organization_id
  loop
    perform core.record_audit(r.organization_id, 'orchestrator.lease_released', 'concurrency_lease', r.id, null,
                              jsonb_build_object('task_id', new.id, 'reason', 'task left in_progress: ' || coalesce(new.status, '')));
  end loop;
  return new;
end $$;
revoke all on function projects.release_leases_of_task() from public, anon, authenticated;
drop trigger if exists tasks_release_leases on projects.tasks;
create trigger tasks_release_leases after update of status, archived_at on projects.tasks
  for each row when (old.status = 'in_progress' and (new.status <> 'in_progress' or (new.archived_at is not null and old.archived_at is null)))
  execute function projects.release_leases_of_task();

-- ── 2. a QA result on a planned task is an event ────────────────────────────
insert into core.event_types (type, description, canonical) values
  ('project.dev_task_qa_failed',
   'QA failed a development task: a closed test run linked to it has failures or blocked cases, or a defect was raised against it. The Orchestrator routes the fix and records why.',
   true),
  ('project.dev_task_qa_passed',
   'QA passed a development task: a closed test run linked to it passed with nothing failed, skipped-as-pass or blocked. The Orchestrator decides only whether it is ELIGIBLE for integration; acceptance is a separate decision.',
   true)
on conflict (type) do nothing;

create or replace function projects.emit_dev_task_qa_from_evidence() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_task projects.tasks; v_run qa.test_runs;
begin
  select * into v_task from projects.tasks t where t.id = new.task_id;
  select * into v_run from qa.test_runs r where r.id = new.test_run_id;
  -- only planned development tasks, and only a run whose counts are final
  if v_task.id is null or v_task.plan_id is null or v_run.id is null or v_run.status <> 'closed' then return new; end if;
  if v_run.failed > 0 or coalesce(v_run.blocked, 0) > 0 then
    perform core.emit_event(v_task.organization_id, 'project.dev_task_qa_failed', 'task', v_task.id,
      jsonb_build_object('projectId', v_task.project_id, 'taskId', v_task.id, 'testRunId', v_run.id, 'source', 'test_run'));
  elsif v_run.passed > 0 then
    perform core.emit_event(v_task.organization_id, 'project.dev_task_qa_passed', 'task', v_task.id,
      jsonb_build_object('projectId', v_task.project_id, 'taskId', v_task.id, 'testRunId', v_run.id, 'source', 'test_run'));
  end if;
  return new;
end $$;
revoke all on function projects.emit_dev_task_qa_from_evidence() from public, anon, authenticated;
drop trigger if exists task_test_evidence_emit_qa on projects.task_test_evidence;
create trigger task_test_evidence_emit_qa after insert on projects.task_test_evidence
  for each row execute function projects.emit_dev_task_qa_from_evidence();

create or replace function projects.emit_dev_task_qa_from_defect() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_task projects.tasks;
begin
  select * into v_task from projects.tasks t where t.id = new.task_id;
  if v_task.id is null or v_task.plan_id is null then return new; end if;
  perform core.emit_event(v_task.organization_id, 'project.dev_task_qa_failed', 'task', v_task.id,
    jsonb_build_object('projectId', v_task.project_id, 'taskId', v_task.id, 'defectId', new.id, 'source', 'defect'));
  return new;
end $$;
revoke all on function projects.emit_dev_task_qa_from_defect() from public, anon, authenticated;
drop trigger if exists defects_emit_task_qa_failed on qa.defects;
create trigger defects_emit_task_qa_failed after insert on qa.defects
  for each row when (new.task_id is not null) execute function projects.emit_dev_task_qa_from_defect();

notify pgrst, 'reload schema';
