-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 development builds, the client-test gate, the Definition of Done and the Phase 6 financial gate.
--
--  * A build is a projects.deliverables row (kind = 'build') with deliverable_details. Reused, not duplicated.
--  * target_env cannot be production: "NO PRODUCTION DEPLOYMENT IN PHASE 5" is a CHECK, not a convention.
--  * (project, build_number) is unique; commit_ref / build_number / target_env freeze once the build is submitted (a client-shared build
--    is never rewritten under the same id; the artifact itself is already immutable via deliverables_guard).
--  * A build reaches the client only when it names an exact commit, passed an INDEPENDENT QA verdict (not by whoever built it) and the
--    Admin approved it - the prototype gate, reused, with no owner override door for builds.
--  * Phase 5 completes only on a locked baseline, a client-approved FINAL build and no unverified blocker/major defect.
--  * Phase 6 is financially available only on M3 verified paid in full (projects.m3_verified_paid), the sibling of the M2 gate.
--    (phase_readiness(...,6) used to ignore M3 and treated a FIX_READY blocker as resolved.)
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.deliverable_details
  add column if not exists target_env text not null default 'dev'
    check (target_env in ('dev', 'review', 'staging', 'client_test')),
  add column if not exists environment_fingerprint jsonb;

create unique index if not exists deliverable_details_build_number_key
  on projects.deliverable_details (project_id, build_number) where build_number is not null;

create or replace function projects.freeze_build_lineage()
returns trigger language plpgsql set search_path = '' as $$
declare v_status text;
begin
  select d.status into v_status from projects.deliverables d where d.id = new.deliverable_id;
  if v_status in ('in_review', 'approved', 'superseded')
     and (new.commit_ref is distinct from old.commit_ref
          or new.build_number is distinct from old.build_number
          or new.target_env is distinct from old.target_env
          or new.environment_fingerprint is distinct from old.environment_fingerprint) then
    raise exception 'a build that has been submitted keeps its commit, number and environment: raise a new build'
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists deliverable_details_freeze_lineage on projects.deliverable_details;
create trigger deliverable_details_freeze_lineage before update on projects.deliverable_details
  for each row execute function projects.freeze_build_lineage();

create or replace function projects.m3_verified_paid(p_project_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_actor uuid := (select auth.uid());
  v_service boolean := coalesce((select auth.role()), '') = 'service_role';
begin
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_org is null then return false; end if;
  if not v_service and (v_actor is null or v_org is distinct from (select core.current_organization_id())) then
    return false;
  end if;
  return exists (
    select 1
      from projects.milestones m
      join finance.invoices i on i.milestone_id = m.id and i.status <> 'void'
     where m.project_id = p_project_id
       and m.id = (select m3.id from projects.milestones m3 where m3.project_id = p_project_id and m3.amount_minor is not null order by m3.position, m3.created_at offset 2 limit 1)
       and i.organization_id = v_org
       and i.status = 'paid'
       and i.verified_minor >= i.total_minor
  );
end $$;
revoke all on function projects.m3_verified_paid(uuid) from public, anon;
grant execute on function projects.m3_verified_paid(uuid) to authenticated, service_role;

-- Independent QA verdict and Admin decision on a development build (same shape as the prototype's, different kind).
create or replace function projects.record_build_qa_verdict(p_deliverable_id uuid, p_outcome text, p_note text default null, p_evidence_url text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_row   projects.deliverables;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_url   text := nullif(btrim(coalesce(p_evidence_url, '')), '');
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text; return; end if;
  if p_outcome not in ('passed', 'changes_required') then return query select 'bad_outcome'::text; return; end if;
  if p_outcome = 'changes_required' and v_note is null then return query select 'note_required'::text; return; end if;
  if (v_note is not null and length(v_note) > 1000) or (v_url is not null and v_url !~ '^https://') then return query select 'invalid'::text; return; end if;
  select * into v_row from projects.deliverables d where d.id = p_deliverable_id and d.organization_id = v_org for update;
  if v_row.id is null then return query select 'not_found'::text; return; end if;
  if v_row.kind <> 'build' then return query select 'wrong_kind'::text; return; end if;
  -- creator != validator: whoever produced the build cannot pass it
  if v_row.created_by is not null and v_row.created_by = v_actor then return query select 'self_review'::text; return; end if;
  if v_row.status not in ('draft', 'changes_requested') then return query select 'not_reviewable'::text; return; end if;

  insert into projects.deliverable_details as dd (deliverable_id, organization_id, project_id, qa_status, qa_decided_by, qa_decided_at, qa_note, qa_evidence_url)
  values (v_row.id, v_org, v_row.project_id, p_outcome, v_actor, now(), v_note, v_url)
  on conflict (deliverable_id) do update
    set qa_status = excluded.qa_status, qa_decided_by = excluded.qa_decided_by, qa_decided_at = excluded.qa_decided_at,
        qa_note = excluded.qa_note, qa_evidence_url = excluded.qa_evidence_url, updated_at = now();

  perform core.record_audit(v_org, 'deliverable.build_qa_recorded', 'deliverable', v_row.id, null,
    jsonb_build_object('projectId', v_row.project_id, 'outcome', p_outcome));
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_build_qa_verdict(uuid, text, text, text) from public, anon;
grant execute on function projects.record_build_qa_verdict(uuid, text, text, text) to authenticated;

create or replace function projects.decide_build_admin(p_deliverable_id uuid, p_decision text, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_row   projects.deliverables;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_qa    text;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision not in ('approved', 'changes_required') then return query select 'bad_decision'::text; return; end if;
  if p_decision = 'changes_required' and v_note is null then return query select 'note_required'::text; return; end if;
  if v_note is not null and length(v_note) > 1000 then return query select 'too_long'::text; return; end if;
  select * into v_row from projects.deliverables d where d.id = p_deliverable_id and d.organization_id = v_org for update;
  if v_row.id is null then return query select 'not_found'::text; return; end if;
  if v_row.kind <> 'build' then return query select 'wrong_kind'::text; return; end if;
  if v_row.status not in ('draft', 'changes_requested') then return query select 'not_reviewable'::text; return; end if;
  -- Only an exact build that passed QA reaches the Admin's approval: ADMIN APPROVES WHAT QA PASSED.
  select dd.qa_status into v_qa from projects.deliverable_details dd where dd.deliverable_id = v_row.id;
  if p_decision = 'approved' and v_qa is distinct from 'passed' then return query select 'not_qa_passed'::text; return; end if;

  insert into projects.deliverable_details as dd (deliverable_id, organization_id, project_id, admin_status, admin_decided_by, admin_decided_at, admin_note)
  values (v_row.id, v_org, v_row.project_id, p_decision, v_actor, now(), v_note)
  on conflict (deliverable_id) do update
    set admin_status = excluded.admin_status, admin_decided_by = excluded.admin_decided_by,
        admin_decided_at = excluded.admin_decided_at, admin_note = excluded.admin_note, updated_at = now();

  perform core.record_audit(v_org, 'deliverable.build_admin_decided', 'deliverable', v_row.id, null,
    jsonb_build_object('projectId', v_row.project_id, 'decision', p_decision, 'noted', v_note is not null));
  return query select 'decided'::text;
end $$;
revoke all on function projects.decide_build_admin(uuid, text, text) from public, anon;
grant execute on function projects.decide_build_admin(uuid, text, text) to authenticated;

CREATE OR REPLACE FUNCTION projects.submit_deliverable(p_deliverable_id uuid, p_requested_by uuid DEFAULT NULL::uuid, p_summary text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, request_id uuid, status text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_row      projects.deliverables;
  v_approval record;
  v_blocking int;
  v_gate     record;
begin
  select d.* into v_row
    from projects.deliverables d
   where d.id = p_deliverable_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  if v_row.status in ('approved', 'superseded') then
    return query select 'settled'::text, v_row.approval_request_id, v_row.status;
    return;
  end if;

  if v_row.status = 'in_review' then
    return query select 'already_in_review'::text, v_row.approval_request_id, v_row.status;
    return;
  end if;

  -- W4 (PDF SCR-037): a prototype build goes to the client on the normal path
  -- only when QA passed it AND Admin approved it. `send_prototype_for_client_review`
  -- is the one door that may override, and it does so as the owner with a reason
  -- on the audit trail.
  -- Phase 5: a DEVELOPMENT BUILD goes to the client on the same terms, with NO override door, and only when it resolves to an exact
  -- commit ("a review/client build must always resolve back to an exact commit").
  if v_row.kind = 'build' and not exists (
       select 1 from projects.deliverable_details dd where dd.deliverable_id = v_row.id and nullif(btrim(dd.commit_ref), '') is not null) then
    return query select 'no_commit'::text, null::uuid, v_row.status;
    return;
  end if;

  if (v_row.kind = 'build'
      or (v_row.kind = 'prototype' and coalesce(current_setting('app.prototype_send_override', true), '') <> 'on')) then
    select * into v_gate from projects.prototype_send_gate(v_row.id);
    if not coalesce(v_gate.qa_passed, false) then
      return query select 'not_qa_passed'::text, null::uuid, v_row.status;
      return;
    end if;
    if not coalesce(v_gate.admin_approved, false) then
      return query select 'not_admin_approved'::text, null::uuid, v_row.status;
      return;
    end if;
  end if;

  -- ARCHITECTURE.md §4.8. Checked under the same lock that will write the
  -- status, so a blocker raised while somebody was clicking submit still
  -- stops it.
  select count(*) into v_blocking from qa.blocking_defects(p_deliverable_id);

  if v_blocking > 0 then
    return query select 'blocked'::text, null::uuid, v_row.status;
    return;
  end if;

  select * into v_approval
    from approvals.request_approval(
      v_row.organization_id, 'deliverable', v_row.id,
      case when p_requested_by is null then 'system' else 'user' end,
      p_requested_by,
      coalesce(p_summary, v_row.kind || ' v' || v_row.version || ' — ' || v_row.title),
      jsonb_build_object(
        'kind', v_row.kind, 'version', v_row.version, 'title', v_row.title,
        'artifact_url', v_row.artifact_url, 'known_issues', v_row.known_issues
      ),
      null, 'client', null
    );

  if v_approval.outcome = 'no_policy' then
    return query select 'no_policy'::text, null::uuid, v_row.status;
    return;
  end if;

  update projects.deliverables
     set status = 'in_review',
         approval_request_id = v_approval.request_id
   where projects.deliverables.id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'deliverable.submitted', 'deliverable', v_row.id,
    to_jsonb(v_row),
    jsonb_build_object('status', 'in_review', 'approval_request_id', v_approval.request_id)
  );

  -- ── the one addition: a generic, kind-agnostic event ────────────────────
  perform core.emit_event(
    v_row.organization_id, 'project.deliverable_submitted', 'deliverable', v_row.id,
    jsonb_build_object('kind', v_row.kind, 'version', v_row.version, 'projectId', v_row.project_id)
  );

  return query select 'submitted'::text, v_approval.request_id, 'in_review'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.phase_readiness(p_project_id uuid, p_phase integer)
 RETURNS TABLE(outcome text, missing text[], facts jsonb)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
    -- Phase 5 Definition of Done: a locked baseline, no unverified blocker/major defect, and the FINAL development build is the
    -- client-approved one (a newer build that nobody approved means the approved one is no longer the final one).
    if exists (select 1 from projects.phase_four p4 where p4.project_id = p_project_id)
       and not exists (select 1 from projects.development_baselines b where b.project_id = p_project_id) then
      v_missing := array_append(v_missing, 'No locked development baseline.');
    end if;
    if not exists (select 1 from projects.deliverables d where d.project_id = p_project_id and d.kind = 'build' and d.status = 'approved') then
      v_missing := array_append(v_missing, 'No client-approved development build.');
    elsif exists (
      select 1 from projects.deliverables d
       where d.project_id = p_project_id and d.kind = 'build' and d.status not in ('superseded')
         and d.version > (select max(a.version) from projects.deliverables a where a.project_id = p_project_id and a.kind = 'build' and a.status = 'approved')
    ) then
      v_missing := array_append(v_missing, 'A newer development build exists than the one the client approved.');
    end if;
    select count(*) into v_blockers
      from qa.defects d
     where d.project_id = p_project_id and d.status in ('open', 'fixed', 'needs_evidence', 'not_reproduced') and d.severity in ('blocker', 'major');
    if v_blockers > 0 then
      v_missing := array_append(v_missing, format('%s blocker or major defect%s not verified fixed.', v_blockers, case when v_blockers = 1 then ' is' else 's are' end));
    end if;
    v_m2 := projects.m2_verified_paid(p_project_id);
    if not v_m2 then
      v_missing := array_append(v_missing, 'M2 not verified paid');
    end if;
    return query select case when cardinality(v_missing) = 0 then 'ready' else 'not_ready' end::text,
                        v_missing,
                        jsonb_build_object('developmentTasks', v_total, 'openDevelopmentTasks', v_open, 'm2VerifiedPaid', v_m2, 'unverifiedBlockingDefects', v_blockers);
    return;
  end if;

  -- Phase 6
  if not exists (select 1 from projects.phase_completions c where c.project_id = p_project_id and c.phase = 5) then
    v_missing := array_append(v_missing, 'Phase 5 is not complete yet.');
  end if;
  -- Phase 6 is financially available ONLY when M3 is Admin-verified paid in full.
  if not projects.m3_verified_paid(p_project_id) then
    v_missing := array_append(v_missing, 'M3 not verified paid');
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
   where d.project_id = p_project_id and d.status in ('open', 'fixed', 'needs_evidence', 'not_reproduced') and d.severity in ('blocker', 'major');
  if v_blockers > 0 then
    v_missing := array_append(v_missing, format('%s blocker or major defect%s not verified fixed.', v_blockers, case when v_blockers = 1 then ' is' else 's are' end));
  end if;

  return query select case when cardinality(v_missing) = 0 then 'ready' else 'not_ready' end::text,
                      v_missing,
                      jsonb_build_object('testRuns', v_runs, 'suitesWithFailures', v_failing, 'openBlockingDefects', v_blockers);
end;
$function$;

revoke all on function projects.submit_deliverable(uuid, uuid, text) from public, anon;
grant execute on function projects.submit_deliverable(uuid, uuid, text) to authenticated, service_role;
revoke all on function projects.phase_readiness(uuid, integer) from public, anon;
grant execute on function projects.phase_readiness(uuid, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
