-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 6 defect management (P601 §26-§28, P612): severity S0-S4, triage and classification, fix handoff, an INDEPENDENT retest of the FIXED build,
-- REOPENED, and the rule that a new client request is a Change Request, not a defect.
--
--   qa.defects  + s_level (0 blocker .. 4 low; defaults from the existing severity), classification, triage, phase6, found_commit, retest_commit/evidence
--   a test defect, an environment defect, a duplicate or a clarification is NOT a product defect: it is excluded from the hard gates, and says why
--   qa.triage_defect  classifies and assigns; 'change_request' raises a Change Request and leaves the gates
--   qa.hand_off_defect  the fix request carries the exact build, the reproduction and the required retest/regression; QA never fixes (it routes)
--   verification: a Phase 6 defect is VERIFIED only by a retest that names the FIXED commit (not the commit it was found on) and its evidence;
--                 a failed retest reopens it; a verified defect found to have regressed reopens too
-- ═══════════════════════════════════════════════════════════════════════════

alter table qa.defects
  add column if not exists s_level smallint check (s_level between 0 and 4),
  add column if not exists classification text not null default 'product_defect'
    check (classification in ('product_defect', 'test_defect', 'environment_defect', 'integration_blocker', 'duplicate', 'needs_clarification', 'change_request', 'not_reproduced')),
  add column if not exists triage_reason text,
  add column if not exists triaged_by uuid references core.users(id) on delete set null,
  add column if not exists triaged_at timestamptz,
  add column if not exists phase6 boolean not null default false,
  add column if not exists found_commit text,
  add column if not exists retest_commit text,
  add column if not exists retest_evidence text;

-- a defect that is not a product defect says why it is not
alter table qa.defects drop constraint if exists defects_not_product_says_why;
alter table qa.defects add constraint defects_not_product_says_why check (classification = 'product_defect' or (triage_reason is not null and length(btrim(triage_reason)) > 0));

-- the existing four-level severity maps onto S1-S4; S0 (catastrophic) is chosen on purpose, at triage
create or replace function qa.defects_default_s_level()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.s_level is null then
    new.s_level := case new.severity when 'blocker' then 1 when 'major' then 2 when 'minor' then 3 else 4 end;
  end if;
  return new;
end $$;
drop trigger if exists defects_default_s_level on qa.defects;
create trigger defects_default_s_level before insert on qa.defects for each row execute function qa.defects_default_s_level();
update qa.defects set s_level = case severity when 'blocker' then 1 when 'major' then 2 when 'minor' then 3 else 4 end where s_level is null;

create or replace function qa.triage_defect(p_defect_id uuid, p_s_level int, p_classification text, p_assignee_id uuid default null, p_reason text default null)
returns table (outcome text, change_request_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_d qa.defects; v_cr record; v_cr_id uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_s_level not between 0 and 4 then return query select 'bad_level'::text, null::uuid; return; end if;
  if p_classification not in ('product_defect', 'test_defect', 'environment_defect', 'integration_blocker', 'duplicate', 'needs_clarification', 'change_request', 'not_reproduced') then
    return query select 'bad_classification'::text, null::uuid; return;
  end if;
  if p_classification <> 'product_defect' and (p_reason is null or length(btrim(p_reason)) = 0) then return query select 'reason_required'::text, null::uuid; return; end if;
  select * into v_d from qa.defects d where d.id = p_defect_id and d.organization_id = v_org for update;
  if v_d.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_d.status in ('verified', 'wontfix') then return query select 'closed'::text, null::uuid; return; end if;

  if p_classification = 'change_request' then
    -- a new client request found during QA is a Change Request, never a defect (P601 §38)
    select * into v_cr from projects.submit_change_request(v_d.project_id, v_d.title || ': ' || coalesce(v_d.reproduction, ''), 'internal', null);
    if v_cr.change_request_id is null then return query select coalesce(v_cr.outcome, 'change_request_failed')::text, null::uuid; return; end if;
    v_cr_id := v_cr.change_request_id;
  end if;

  update qa.defects set s_level = p_s_level, classification = p_classification, triage_reason = case when p_classification = 'product_defect' then null else p_reason end,
         assignee_id = coalesce(p_assignee_id, assignee_id), triaged_by = v_actor, triaged_at = now() where id = v_d.id;
  perform core.record_audit(v_org, 'defect.triaged', 'defect', v_d.id, null, jsonb_build_object('projectId', v_d.project_id, 'sLevel', p_s_level, 'classification', p_classification));
  return query select 'triaged'::text, v_cr_id;
end $$;
revoke all on function qa.triage_defect(uuid, int, text, uuid, text) from public, anon;
grant execute on function qa.triage_defect(uuid, int, text, uuid, text) to authenticated;

-- fix handoff: the exact build, the reproduction, the evidence and what must be re-run - to the Bug Fix capability; QA does not fix
create or replace function qa.hand_off_defect(p_defect_id uuid)
returns table (outcome text, handoff_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_d qa.defects; v_new uuid; v_existing uuid;
begin
  if (select auth.uid()) is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_d from qa.defects d where d.id = p_defect_id and d.organization_id = v_org;
  if v_d.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_d.classification <> 'product_defect' then return query select 'not_a_product_defect'::text, null::uuid; return; end if;
  if v_d.status <> 'open' then return query select 'not_open'::text, null::uuid; return; end if;
  select h.id into v_existing from ai.handoffs h where h.subject_type = 'defect' and h.subject_id = v_d.id and h.status in ('queued', 'accepted', 'running', 'needs_input', 'awaiting_approval');
  if v_existing is not null then return query select 'already_handed_off'::text, v_existing; return; end if;
  insert into ai.handoffs (organization_id, correlation_id, from_agent, to_agent, project_id, subject_type, subject_id, objective, context, requirements)
  values (v_org, v_d.project_id, 'orchestrator', 'bug_fix', v_d.project_id, 'defect', v_d.id,
          'Fix defect (S' || v_d.s_level || '): ' || v_d.title,
          jsonb_build_object('defectId', v_d.id, 'sLevel', v_d.s_level, 'foundCommit', v_d.found_commit, 'buildDeliverableId', v_d.deliverable_id,
                             'reproduction', v_d.reproduction, 'expected', v_d.expected, 'actual', v_d.actual, 'evidenceUrl', v_d.evidence_url),
          jsonb_build_object('mustReproduceFirst', true, 'minimalFixOnly', true, 'targetedTests', true, 'securityReviewIfSensitive', true,
                             'qaMustRetestFixedBuild', true, 'regressionRequired', true, 'fixReadyIsNotVerified', true))
  returning id into v_new;
  update projects.phase_six set state = 'defect_fix_loop' where project_id = v_d.project_id and state in ('testing', 'final_verification', 'plan_ready');
  return query select 'handed_off'::text, v_new;
end $$;
revoke all on function qa.hand_off_defect(uuid) from public, anon;
grant execute on function qa.hand_off_defect(uuid) to authenticated;

-- the independent retest door: the Phase 6 QA person verifies the FIXED build (the defect guard refuses the fixer and a retest on the old build)
create or replace function qa.record_retest(p_defect_id uuid, p_passed boolean, p_retest_commit text, p_retest_evidence text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_d qa.defects;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_d from qa.defects d where d.id = p_defect_id and d.organization_id = v_org for update;
  if v_d.id is null then return query select 'not_found'::text; return; end if;
  if v_d.status <> 'fixed' then return query select 'not_fix_ready'::text; return; end if;
  begin
    if p_passed then
      update qa.defects set status = 'verified', verified_by = v_actor, verified_at = now(), retest_commit = p_retest_commit, retest_evidence = p_retest_evidence where id = v_d.id;
      return query select 'verified'::text; return;
    end if;
    -- a failed retest REOPENS the defect (the guard clears the fix claim)
    update qa.defects set status = 'open', triage_reason = triage_reason where id = v_d.id;
    return query select 'reopened'::text; return;
  exception when restrict_violation then
    return query select (case when sqlerrm like '%FIXED build%' then 'retest_on_the_wrong_build' when sqlerrm like '%fixer%' or sqlerrm like '%cannot verify%' then 'fixer_cannot_verify' else 'retest_incomplete' end)::text; return;
  end;
end $$;
revoke all on function qa.record_retest(uuid, boolean, text, text) from public, anon;
grant execute on function qa.record_retest(uuid, boolean, text, text) to authenticated;

-- the unresolved product defects the hard gates read
create or replace function qa.unresolved_product_defects(p_project_id uuid)
returns table (defect_id uuid, s_level smallint, title text, status text)
language sql stable set search_path = '' as $$
  select d.id, d.s_level, d.title, d.status from qa.defects d
   where d.project_id = p_project_id and d.classification = 'product_defect' and d.status in ('open', 'fixed', 'needs_evidence', 'not_reproduced')
$$;
revoke all on function qa.unresolved_product_defects(uuid) from public, anon;
grant execute on function qa.unresolved_product_defects(uuid) to authenticated, service_role;

CREATE OR REPLACE FUNCTION qa.defects_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.organization_id is distinct from old.organization_id
     or new.project_id   is distinct from old.project_id
     or new.created_at   is distinct from old.created_at
  then
    raise exception 'a defect may not change tenancy, project or creation time'
      using errcode = 'restrict_violation';
  end if;

  if new.status is distinct from old.status then
    if old.status in ('verified', 'wontfix') and not (old.status = 'verified' and old.phase6 and new.status = 'open') then
      raise exception 'defect % is already %; raise a new one', old.id, old.status
        using errcode = 'restrict_violation';
    end if;

    if not (
      (old.status = 'open'  and new.status in ('fixed', 'wontfix', 'needs_evidence', 'not_reproduced'))
      -- REOPENED: a Phase 6 defect found fixed-and-verified can come back (a regression); the verification is dropped
      or (old.status = 'verified' and new.status = 'open' and old.phase6)
      or (old.status = 'fixed' and new.status in ('verified', 'open'))
      or (old.status in ('needs_evidence', 'not_reproduced') and new.status in ('open', 'wontfix'))
    ) then
      raise exception 'a defect does not move from % to %', old.status, new.status
        using errcode = 'restrict_violation';
    end if;

    if new.status = 'fixed' then
      -- FIX_READY: who claims it is recorded, and it is a claim, not a verification.
      new.fixed_by := coalesce((select auth.uid()), new.fixed_by);
      new.fixed_at := now();
    end if;

    if new.status = 'verified' and new.phase6 then
      -- Phase 6: only an INDEPENDENT retest of the FIXED build verifies: it names the commit it ran on (not the commit the defect was found on) and its evidence
      if new.retest_commit is null or length(btrim(new.retest_commit)) = 0 or new.retest_evidence is null or length(btrim(new.retest_evidence)) = 0 then
        raise exception 'a Phase 6 defect is verified by a retest of the fixed build: name the commit retested and the evidence' using errcode = 'restrict_violation';
      end if;
      if new.retest_commit is not distinct from new.found_commit then
        raise exception 'the retest must run on the FIXED build, not the build the defect was found on' using errcode = 'restrict_violation';
      end if;
    end if;

    if new.status = 'verified' then
      if new.verified_by is not null and new.verified_by is not distinct from old.fixed_by then
        raise exception 'the person who fixed defect % cannot verify it: FIX_READY is not VERIFIED', old.id
          using errcode = 'restrict_violation';
      end if;
      if (select auth.uid()) is not null and new.verified_by is distinct from (select auth.uid()) then
        raise exception 'a defect is verified by the person doing the verifying, not by someone named on their behalf'
          using errcode = 'restrict_violation';
      end if;
    end if;

    if new.status = 'open' and old.status in ('fixed', 'verified') then
      -- a failed retest REOPENS it: the fix claim and any verification fields are cleared
      new.fixed_by := null;
      new.fixed_at := null;
      new.verified_by := null;
      new.verified_at := null;
      new.retest_commit := null;
      new.retest_evidence := null;
    end if;
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION qa.record_case_result(p_case_id uuid, p_status text, p_evidence_ref text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, defect_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_case qa.phase6_cases; v_plan qa.master_test_plans; v_producer uuid; v_commit text; v_defect uuid; v_sev text; v_build uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_status not in ('pass', 'fail', 'blocked', 'skipped_with_reason', 'running') then return query select 'bad_status'::text, null::uuid; return; end if;
  select * into v_case from qa.phase6_cases c where c.id = p_case_id and c.organization_id = v_org for update;
  if v_case.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  select * into v_plan from qa.master_test_plans p where p.id = v_case.plan_id;
  if v_plan.status <> 'approved' then return query select 'plan_not_approved'::text, null::uuid; return; end if;

  select i.build_deliverable_id into v_build from projects.qa_intakes i where i.id = v_plan.intake_id;
  select dd.commit_ref into v_commit from projects.deliverable_details dd where dd.deliverable_id = v_build;
  -- evidence about any other commit is not evidence about this one
  if v_commit is distinct from v_plan.commit_ref then return query select 'stale_plan'::text, null::uuid; return; end if;
  -- creator != validator
  select d.created_by into v_producer from projects.deliverables d where d.id = v_build;
  if v_producer is not null and v_producer = v_actor then return query select 'self_review'::text, null::uuid; return; end if;

  if p_status = 'pass' and (p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0) then return query select 'evidence_required'::text, null::uuid; return; end if;
  if p_status in ('blocked', 'skipped_with_reason') and (p_reason is null or length(btrim(p_reason)) = 0) then return query select 'reason_required'::text, null::uuid; return; end if;
  if p_status = 'skipped_with_reason' and v_case.priority = 'critical' then return query select 'critical_cannot_be_skipped'::text, null::uuid; return; end if;

  perform set_config('qa.phase6_sanctioned', 'on', true);
  if p_status = 'fail' then
    v_sev := case v_case.priority when 'critical' then 'blocker' when 'high' then 'major' when 'medium' then 'minor' else 'trivial' end;
    insert into qa.defects (organization_id, project_id, deliverable_id, severity, title, reproduction, expected, actual, reported_by, build_id, phase6, found_commit)
    values (v_case.organization_id, v_case.project_id, v_build, v_sev, left('Phase 6: ' || v_case.title, 200), coalesce(v_case.steps, v_case.title), v_case.expected, p_reason, v_actor, v_build, true, v_commit)
    returning id into v_defect;
  end if;
  update qa.phase6_cases
     set status = p_status, result_commit = v_commit, evidence_ref = p_evidence_ref, reason = p_reason,
         defect_id = case when p_status = 'fail' then v_defect else qa.phase6_cases.defect_id end, executed_by = v_actor, executed_at = now()
   where id = v_case.id;
  insert into qa.phase6_result_history (organization_id, case_id, status, result_commit, evidence_ref, reason, recorded_by)
  values (v_case.organization_id, v_case.id, p_status, v_commit, p_evidence_ref, p_reason, v_actor);
  update projects.phase_six set state = 'testing' where project_id = v_case.project_id and state = 'plan_ready';
  return query select 'recorded'::text, v_defect;
end $function$;

revoke all on function qa.record_case_result(uuid, text, text, text) from public, anon;
grant execute on function qa.record_case_result(uuid, text, text, text) to authenticated;

notify pgrst, 'reload schema';
