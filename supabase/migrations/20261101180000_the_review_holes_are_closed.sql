-- Independent review of the Phase 5/6 doors: four confirmed holes closed.
--  1. qa.invalidate_stale_results was SECURITY DEFINER and checked no organization: a member could invalidate another tenant's QA results.
--  2. projects.tasks and qa.defects have FOR ALL write policies: a direct UPDATE walked around start_task / triage. The guards below refuse a
--     direct (non-door) write of the facts the gates read. Doors are SECURITY DEFINER, so they run as the function owner, not as `authenticated`.
--  3. qa.mark_duplicate could hide an open blocker behind a closed canonical defect.

create or replace function qa.invalidate_stale_results(p_project_id uuid)
returns table (outcome text, invalidated int)
language plpgsql security definer set search_path = '' as $$
declare v_service boolean := coalesce((select auth.role()), '') = 'service_role'; v_in projects.qa_intakes; v_commit text; v_n int;
begin
  if (select auth.uid()) is null and not v_service then return query select 'no_actor'::text, 0; return; end if;
  if (select auth.uid()) is not null and not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, 0; return; end if;
  select * into v_in from projects.qa_intakes i where i.project_id = p_project_id;
  if v_in.id is null or (not v_service and v_in.organization_id is distinct from (select core.current_organization_id())) then return query select 'no_intake'::text, 0; return; end if;
  select dd.commit_ref into v_commit from projects.deliverable_details dd where dd.deliverable_id = v_in.build_deliverable_id;
  perform set_config('qa.phase6_sanctioned', 'on', true);
  with stale as (
    update qa.phase6_cases c set status = 'invalidated'
     where c.project_id = p_project_id and c.status in ('pass', 'fail', 'blocked', 'skipped_with_reason') and c.result_commit is distinct from v_commit
    returning c.id, c.organization_id, c.result_commit
  )
  insert into qa.phase6_result_history (organization_id, case_id, status, result_commit, reason)
  select organization_id, id, 'invalidated', result_commit, 'the build under test changed' from stale;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    update projects.qa_intakes set status = 'stale' where id = v_in.id and v_commit is distinct from v_in.commit_ref;
  end if;
  return query select 'invalidated'::text, v_n;
end $$;
revoke all on function qa.invalidate_stale_results(uuid) from public, anon;
grant execute on function qa.invalidate_stale_results(uuid) to authenticated, service_role;

create or replace function qa.mark_duplicate(p_defect_id uuid, p_canonical_id uuid, p_reason text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_d qa.defects; v_c qa.defects;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_defect_id = p_canonical_id then return query select 'cannot_duplicate_itself'::text; return; end if;
  select * into v_d from qa.defects d where d.id = p_defect_id and d.organization_id = v_org for update;
  select * into v_c from qa.defects d where d.id = p_canonical_id and d.organization_id = v_org;
  if v_d.id is null or v_c.id is null then return query select 'not_found'::text; return; end if;
  if v_d.project_id <> v_c.project_id then return query select 'different_project'::text; return; end if;
  -- the canonical defect is a real one: not itself a duplicate, and still tracked
  if v_c.classification <> 'product_defect' then return query select 'canonical_is_not_a_product_defect'::text; return; end if;
  -- a duplicate may not hide a live blocker behind a defect that is itself closed
  if v_c.status not in ('open', 'fixed', 'needs_evidence', 'not_reproduced') then return query select 'canonical_is_closed'::text; return; end if;
  if v_d.status in ('verified', 'wontfix') then return query select 'closed'::text; return; end if;
  update qa.defects set classification = 'duplicate', duplicate_of = v_c.id, triage_reason = coalesce(nullif(btrim(p_reason), ''), 'same root cause as ' || v_c.title), triaged_by = v_actor, triaged_at = now() where id = v_d.id;
  -- the new report's evidence is PRESERVED on the canonical defect
  insert into qa.defect_evidence (organization_id, defect_id, kind, value, added_by)
  values (v_org, v_c.id, 'note', left('Duplicate report: ' || v_d.title || ' - ' || coalesce(v_d.reproduction, ''), 2000), v_actor);
  perform core.record_audit(v_org, 'defect.marked_duplicate', 'defect', v_d.id, null, jsonb_build_object('canonicalId', v_c.id));
  return query select 'marked'::text;
end $$;
revoke all on function qa.mark_duplicate(uuid, uuid, text) from public, anon;
grant execute on function qa.mark_duplicate(uuid, uuid, text) to authenticated;

create or replace function projects.tasks_phase_five_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- only a direct write by an end user is refused; the doors (start_task, plan_task) are definer functions and run as their owner
  if current_user in ('authenticated', 'anon')
     and exists (select 1 from projects.phase_five pf where pf.project_id = new.project_id) then
    if tg_op = 'INSERT' then
      if new.status in ('in_progress', 'in_review', 'done') or new.plan_id is not null then
        raise exception 'a Phase 5 task is created un-started and unplanned; use plan_task and start_task' using errcode = 'restrict_violation';
      end if;
    else
      if new.plan_id is distinct from old.plan_id
         or new.acceptance_criteria is distinct from old.acceptance_criteria
         or new.affected_paths is distinct from old.affected_paths
         or (new.status is distinct from old.status and old.status = 'todo' and new.status in ('in_progress', 'in_review', 'done')) then
        raise exception 'a Phase 5 task is planned and started through plan_task and start_task, which check M2, the baseline and the approved plan' using errcode = 'restrict_violation';
      end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists tasks_phase_five_guard on projects.tasks;
create trigger tasks_phase_five_guard before insert or update on projects.tasks for each row execute function projects.tasks_phase_five_guard();

create or replace function qa.defects_direct_write_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.status is distinct from 'open' then
        raise exception 'a defect is raised open; it is moved by the fix and retest doors' using errcode = 'restrict_violation';
      end if;
    elsif new.severity is distinct from old.severity
       or new.s_level is distinct from old.s_level
       or new.classification is distinct from old.classification
       or new.duplicate_of is distinct from old.duplicate_of
       or new.phase6 is distinct from old.phase6
       or new.triage_reason is distinct from old.triage_reason then
      raise exception 'a defect is classified, graded and de-duplicated through triage_defect / mark_duplicate, which record who and why' using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists defects_direct_write_guard on qa.defects;
create trigger defects_direct_write_guard before insert or update on qa.defects for each row execute function qa.defects_direct_write_guard();

-- start_task is the door: it now runs as its owner (so the guard above can tell a door from a direct write) and checks the organization itself
CREATE OR REPLACE FUNCTION projects.start_task(p_task_id uuid)
 RETURNS TABLE(outcome text, detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_task  projects.tasks;
  v_check record;
  v_role  text;
  v_base  uuid;
begin
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::text; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id for update;
  if v_task.id is null or v_task.organization_id is distinct from (select core.current_organization_id()) then
    return query select 'not_found'::text, null::text; return;
  end if;
  v_role := projects.project_role_refusal(v_task.project_id, v_task.assignee_id);
  if v_role is not null then
    return query select v_role, null::text; return;
  end if;
  if v_task.status <> 'todo' or v_task.archived_at is not null then
    return query select 'wrong_state'::text, null::text; return;
  end if;

  if (v_task.module_id is not null or v_task.feature_id is not null) then
    -- Phase 5 gate 1: M2 verified paid.
    if not projects.m2_verified_paid(v_task.project_id) then
      return query select 'm2_not_verified'::text,
        'Phase 5 cannot start: the M2 payment is not verified paid. A client saying paid, a proof upload, a submission or a match recommendation does not open it; only an Admin verifying the payment does.'::text;
      return;
    end if;
    -- Phase 5 gate 2: a locked development baseline (for a project that ran the Phase 3/4 pipeline).
    if exists (select 1 from projects.phase_four p4 where p4.project_id = v_task.project_id) then
      select b.id into v_base from projects.development_baselines b where b.project_id = v_task.project_id;
      if v_base is null then
        return query select 'no_baseline'::text,
          'Phase 5 has no locked development baseline yet: development builds against the exact approved UI, prototype and scope, never "the latest design".'::text;
        return;
      end if;
    end if;
  end if;

  -- Phase 5 planning: against a locked baseline a task starts only from an APPROVED plan, and never beside another task that touches the
  -- same files without being sequenced after it ("do not run two agents against the same sensitive files blindly").
  if v_base is not null then
    if not exists (select 1 from projects.development_plans pl where pl.id = v_task.plan_id and pl.status = 'approved') then
      return query select 'no_approved_plan'::text,
        'This task is not part of an approved development plan: planning (acceptance criteria, specialist, dependencies) comes before code.'::text;
      return;
    end if;
    if cardinality(v_task.affected_paths) > 0 and exists (
         select 1 from projects.tasks o
          where o.project_id = v_task.project_id and o.id <> v_task.id and o.status = 'in_progress' and o.archived_at is null
            and o.affected_paths && v_task.affected_paths
            and not exists (select 1 from projects.task_dependencies td where td.task_id = v_task.id and td.depends_on_task_id = o.id)) then
      return query select 'path_conflict'::text,
        'Another task in progress touches the same files and this one does not depend on it: sequence them (add the dependency) before starting.'::text;
      return;
    end if;
  end if;

  select * into v_check from projects.task_start_check(p_task_id);
  if not v_check.requirement_ok then
    return query select 'no_requirement'::text, v_check.reason; return;
  end if;
  if v_check.open_dependencies > 0 then
    return query select 'dependencies_open'::text, v_check.reason; return;
  end if;

  update projects.tasks set status = 'in_progress', started_at = coalesce(started_at, now()), baseline_id = coalesce(baseline_id, v_base)
   where id = p_task_id;

  perform core.record_audit(
    v_task.organization_id, 'task.started', 'task', p_task_id,
    jsonb_build_object('status', v_task.status), jsonb_build_object('status', 'in_progress', 'projectId', v_task.project_id, 'baselineId', v_base)
  );
  return query select 'started'::text, null::text;
end;
$function$;
revoke all on function projects.start_task(uuid) from public, anon;
grant execute on function projects.start_task(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
