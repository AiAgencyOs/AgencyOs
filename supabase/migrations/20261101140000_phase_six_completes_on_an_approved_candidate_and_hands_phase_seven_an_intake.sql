-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 6 exit (P601 §40-§42, P613, P614): the frozen Phase 7 intake, the Definition of Done, candidate prerequisites, and the M4 gate.
--
--   * projects.phase_six_handoffs   written WITH Phase6Completed; `production_deployed` is a CHECK that is always false: Phase 6 deploys nothing
--   * phase_readiness(...,6)        replaces the older "a suite ran and nothing is open" check with the real DoD (Admin-approved exact candidate, every gate now)
--   * qa.set_candidate_prerequisites  rollback / monitoring / configuration, on a candidate that is not yet approved
--   * M4PaymentVerified             recorded once by the runner, only when the FOURTH priced milestone is verified paid in full; the Phase 7 financial gate
--                                   reads ONLY this. (An older owner override of an unverified final milestone exists in release_payment_overrides: it is
--                                   NOT consulted here, and conflicts with P601 §41 - see docs/phase-6-manual-actions.md.)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.phase_six_handoffs (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references core.organizations(id) on delete cascade,
  project_id           uuid not null references projects.projects(id) on delete cascade,
  phase_completion_id  uuid not null references projects.phase_completions(id) on delete restrict,
  candidate_id         uuid not null references qa.release_candidates(id) on delete restrict,
  commit_ref           text not null,
  artifact_sha256      text not null,
  payload              jsonb not null,
  production_deployed  boolean not null default false check (not production_deployed),
  created_at           timestamptz not null default now(),
  unique (project_id)
);
alter table projects.phase_six_handoffs enable row level security;
drop policy if exists phase_six_handoffs_read on projects.phase_six_handoffs;
create policy phase_six_handoffs_read on projects.phase_six_handoffs for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
grant select on projects.phase_six_handoffs to authenticated;
grant all on projects.phase_six_handoffs to service_role;
do $$
declare r record;
begin
  for r in select * from (values ('project_id', 'projects.projects'), ('phase_completion_id', 'projects.phase_completions'), ('candidate_id', 'qa.release_candidates')) as t(col, parent) loop
    execute format('drop trigger if exists %I on projects.phase_six_handoffs', 'phase_six_handoffs_parent_org_' || r.col);
    execute format('create trigger %I before insert or update of %I on projects.phase_six_handoffs for each row execute function core.enforce_parent_org(%L, %L)', 'phase_six_handoffs_parent_org_' || r.col, r.col, r.col, r.parent);
  end loop;
end $$;
drop trigger if exists freeze_org_phase_six_handoffs on projects.phase_six_handoffs;
create trigger freeze_org_phase_six_handoffs before update of organization_id on projects.phase_six_handoffs for each row execute function core.freeze_organization_id();
create or replace function projects.phase_six_handoffs_frozen()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'a Phase 7 intake is a snapshot of what was approved and is never edited' using errcode = 'restrict_violation'; end $$;
drop trigger if exists phase_six_handoffs_frozen on projects.phase_six_handoffs;
create trigger phase_six_handoffs_frozen before update on projects.phase_six_handoffs for each row execute function projects.phase_six_handoffs_frozen();

create or replace function projects.build_phase_six_handoff(p_project_id uuid, p_phase_completion_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_project projects.projects; v_c qa.release_candidates; v_a qa.readiness_assessments; v_payload jsonb; v_id uuid; v_base projects.development_baselines; v_plan qa.master_test_plans;
begin
  select * into v_project from projects.projects p where p.id = p_project_id;
  select * into v_c from qa.release_candidates c where c.project_id = p_project_id and c.status = 'approved';
  if v_c.id is null then raise exception 'phase 6 cannot hand over without an approved release candidate' using errcode = 'check_violation'; end if;
  select * into v_a from qa.readiness_assessments a where a.candidate_id = v_c.id order by a.evaluated_at desc limit 1;
  select * into v_base from projects.development_baselines b where b.project_id = p_project_id;
  select * into v_plan from qa.master_test_plans p where p.id = v_c.plan_id;

  v_payload := jsonb_build_object(
    'candidate', jsonb_build_object('id', v_c.id, 'version', v_c.version, 'commit', v_c.commit_ref, 'buildDeliverableId', v_c.build_deliverable_id, 'artifactSha256', v_c.artifact_sha256,
                                    'approvedBy', v_c.approved_by, 'approvedAt', v_c.approved_at),
    'scopeVersionId', v_base.scope_version_id,
    'uiVersionId', v_base.ui_version_id,
    'testPlan', jsonb_build_object('id', v_plan.id, 'version', v_plan.version, 'categories', to_jsonb(v_plan.required_categories)),
    'readiness', jsonb_build_object('score', v_a.score, 'band', v_a.band, 'dimensions', v_a.dimensions, 'gates', v_a.gates),
    'exceptions', coalesce((select jsonb_agg(jsonb_build_object('gate', e.gate, 'risk', e.risk, 'mitigation', e.mitigation, 'containment', e.containment_plan, 'owner', e.owner, 'expiresAt', e.expires_at, 'approvedBy', e.approved_by) order by e.gate)
                              from qa.release_exceptions e where e.candidate_id = v_c.id and e.status = 'approved'), '[]'::jsonb),
    'knownLimitations', v_c.known_limitations,
    'deployment', jsonb_build_object('configVersion', v_c.config_version, 'rollbackPlan', v_c.rollback_plan, 'rollbackOwner', v_c.rollback_owner, 'observability', v_c.observability_notes),
    'manualExternal', coalesce((select jsonb_agg(jsonb_build_object('name', ic.name, 'kind', ic.kind, 'health', ic.health) order by ic.name) from projects.integration_connections ic where ic.project_id = p_project_id and ic.health <> 'verified'), '[]'::jsonb),
    'defects', jsonb_build_object(
        'verified', (select count(*) from qa.defects d where d.project_id = p_project_id and d.phase6 and d.status = 'verified'),
        'unresolvedNonGating', (select count(*) from qa.unresolved_product_defects(p_project_id) u where u.s_level >= 2)),
    'productionDeployed', false,
    'note', 'Phase 7 deploys exactly this candidate, or raises a new governed candidate if the source changes. Phase 6 deployed nothing.'
  );
  insert into projects.phase_six_handoffs (organization_id, project_id, phase_completion_id, candidate_id, commit_ref, artifact_sha256, payload)
  values (v_project.organization_id, p_project_id, p_phase_completion_id, v_c.id, v_c.commit_ref, v_c.artifact_sha256, v_payload) returning id into v_id;
  return v_id;
end $$;
revoke all on function projects.build_phase_six_handoff(uuid, uuid) from public, anon, authenticated;
grant execute on function projects.build_phase_six_handoff(uuid, uuid) to service_role;

create or replace function qa.set_candidate_prerequisites(p_candidate_id uuid, p_config_version text, p_rollback_plan text, p_rollback_owner text, p_observability_notes text, p_known_limitations jsonb default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_c qa.release_candidates;
begin
  if (select auth.uid()) is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_c from qa.release_candidates c where c.id = p_candidate_id and c.organization_id = v_org for update;
  if v_c.id is null then return query select 'not_found'::text; return; end if;
  if v_c.status not in ('draft', 'blocked') then return query select 'candidate_not_editable'::text; return; end if;
  update qa.release_candidates set config_version = p_config_version, rollback_plan = p_rollback_plan, rollback_owner = p_rollback_owner, observability_notes = p_observability_notes,
         known_limitations = coalesce(p_known_limitations, known_limitations) where id = v_c.id;
  return query select 'set'::text;
end $$;
revoke all on function qa.set_candidate_prerequisites(uuid, text, text, text, text, jsonb) from public, anon;
grant execute on function qa.set_candidate_prerequisites(uuid, text, text, text, text, jsonb) to authenticated;

-- ── M4 ─────────────────────────────────────────────────────────────────────
create or replace function projects.m4_verified_paid(p_project_id uuid)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid; v_actor uuid := (select auth.uid()); v_service boolean := coalesce((select auth.role()), '') = 'service_role';
begin
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_org is null then return false; end if;
  if not v_service and (v_actor is null or v_org is distinct from (select core.current_organization_id())) then return false; end if;
  return exists (
    select 1 from projects.milestones m join finance.invoices i on i.milestone_id = m.id and i.status <> 'void'
     where m.project_id = p_project_id
       and m.id = (select m4.id from projects.milestones m4 where m4.project_id = p_project_id and m4.amount_minor is not null order by m4.position, m4.created_at offset 3 limit 1)
       and i.organization_id = v_org and i.status = 'paid' and i.verified_minor >= i.total_minor);
end $$;
revoke all on function projects.m4_verified_paid(uuid) from public, anon;
grant execute on function projects.m4_verified_paid(uuid) to authenticated, service_role;

insert into core.event_types (type, description, canonical) values
  ('project.m4_payment_verified',
   'The fourth priced milestone (M4, 20%) was verified paid IN FULL by an Admin. The Phase 7 financial gate reads this fact; a claim, a proof, a submission or a match never produces it.', true)
on conflict (type) do nothing;

create or replace function projects.record_m4_verified(p_project_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if (select auth.uid()) is not null or coalesce((select auth.role()), '') <> 'service_role' then return query select 'runner_only'::text; return; end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_org is null then return query select 'not_found'::text; return; end if;
  if not projects.m4_verified_paid(p_project_id) then return query select 'not_verified'::text; return; end if;
  perform 1 from projects.projects p where p.id = p_project_id for update;
  if exists (select 1 from core.outbox_events e where e.type = 'project.m4_payment_verified' and e.subject_id = p_project_id) then return query select 'already_recorded'::text; return; end if;
  update projects.phase_six set state = 'phase7_financially_ready' where project_id = p_project_id and state in ('m4_due', 'phase6_completed');
  perform core.record_audit(v_org, 'project.m4_payment_verified', 'project', p_project_id, null, jsonb_build_object('projectId', p_project_id));
  perform core.emit_event(v_org, 'project.m4_payment_verified', 'project', p_project_id, jsonb_build_object('projectId', p_project_id));
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_m4_verified(uuid) from public, anon, authenticated;
grant execute on function projects.record_m4_verified(uuid) to service_role;

-- the Phase 7 financial gate: ONLY a verified M4 opens it (never an invoice, a claim, a proof, a submission, a match, or an override)
create or replace function projects.phase_seven_gate_status(p_project_id uuid)
returns table (outcome text, m4_invoice_id uuid, m4_invoice_status text)
language sql stable security invoker set search_path = '' as $$
  select case when projects.m4_verified_paid(p_project_id) then 'verified' when i.id is not null then 'invoice_issued' when m.id is null then 'no_m4_milestone' else 'not_ready' end, i.id, i.status
    from (select 1) x
    left join lateral (select m4.* from projects.milestones m4 where m4.project_id = p_project_id and m4.amount_minor is not null order by m4.position, m4.created_at offset 3 limit 1) m on true
    left join finance.invoices i on i.milestone_id = m.id and i.status <> 'void'
   limit 1
$$;
revoke all on function projects.phase_seven_gate_status(uuid) from public, anon;
grant execute on function projects.phase_seven_gate_status(uuid) to authenticated, service_role;

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
    -- FLAKY != PASS: a flaky test is quarantined only with an owner and an expiry; an open or expired one is unresolved work.
    if exists (select 1 from qa.flaky_tests f where f.project_id = p_project_id and (f.status = 'open' or (f.status = 'quarantined' and f.expires_at <= now()))) then
      v_missing := array_append(v_missing, format('%s flaky test%s unresolved (open or quarantine expired).',
        (select count(*) from qa.flaky_tests f where f.project_id = p_project_id and (f.status = 'open' or (f.status = 'quarantined' and f.expires_at <= now()))),
        case when (select count(*) from qa.flaky_tests f where f.project_id = p_project_id and (f.status = 'open' or (f.status = 'quarantined' and f.expires_at <= now()))) = 1 then ' is' else 's are' end));
    end if;
    -- A document that claims more than the evidence is not documentation; none may be overclaimed at completion.
    if exists (select 1 from projects.technical_documents t where t.project_id = p_project_id and t.status = 'blocked') then
      v_missing := array_append(v_missing, 'A technical document is blocked.');
    end if;
    -- Requirement -> task -> TEST: every planned task that is not cancelled has a linked test run that actually passed.
    if exists (select 1 from projects.task_test_gaps(p_project_id)) then
      v_missing := array_append(v_missing, format('%s planned task%s no passing test evidence.', (select count(*) from projects.task_test_gaps(p_project_id)),
        case when (select count(*) from projects.task_test_gaps(p_project_id)) = 1 then ' has' else 's have' end));
    end if;
    -- NO STALE DOCS: a document derived from an older commit than the current build describes code that no longer exists.
    if exists (select 1 from projects.stale_documents(p_project_id)) then
      v_missing := array_append(v_missing, 'Derived documentation is stale (older than the current build).');
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

  -- Phase 6 (P601 §40): Phase6Completed needs an ADMIN-approved release candidate that is STILL the build under test, every hard gate satisfied NOW,
  -- a valid intake and an approved plan, no unresolved S0/S1, and every FIX_READY defect independently retested. A score is not consulted.
  declare
    v_cand qa.release_candidates;
    v_gate record;
    v_commit text;
    v_fixready int;
    v_score int;
  begin
    if not exists (select 1 from projects.phase_completions c where c.project_id = p_project_id and c.phase = 5) then
      v_missing := array_append(v_missing, 'Phase 5 is not complete yet.');
    end if;
    -- Phase 6 is financially available ONLY when M3 is Admin-verified paid in full.
    if not projects.m3_verified_paid(p_project_id) then
      v_missing := array_append(v_missing, 'M3 not verified paid');
    end if;
    if not exists (select 1 from projects.qa_intakes i where i.project_id = p_project_id and i.status = 'valid') then
      v_missing := array_append(v_missing, 'The QA intake is not valid.');
    end if;
    if not exists (select 1 from qa.master_test_plans p where p.project_id = p_project_id and p.status = 'approved') then
      v_missing := array_append(v_missing, 'There is no approved Master Test Plan.');
    end if;
    select * into v_cand from qa.release_candidates c where c.project_id = p_project_id and c.status = 'approved';
    if v_cand.id is null then
      v_missing := array_append(v_missing, 'No release candidate is approved by an Admin.');
    else
      select dd.commit_ref into v_commit from projects.deliverable_details dd where dd.deliverable_id = v_cand.build_deliverable_id;
      if v_commit is distinct from v_cand.commit_ref then
        v_missing := array_append(v_missing, 'The approved candidate is stale: the build changed after approval, so a new candidate and a new approval are needed.');
      end if;
      for v_gate in select * from qa.evaluate_hard_gates(v_cand.id) g where not g.satisfied loop
        v_missing := array_append(v_missing, format('Hard gate not satisfied: %s (%s).', v_gate.gate, v_gate.detail));
      end loop;
      select a.score into v_score from qa.readiness_assessments a where a.candidate_id = v_cand.id order by a.evaluated_at desc limit 1;
    end if;
    select count(*) into v_fixready from qa.defects d where d.project_id = p_project_id and d.phase6 and d.classification = 'product_defect' and d.status = 'fixed';
    if v_fixready > 0 then
      v_missing := array_append(v_missing, format('%s fixed defect%s still await independent retest.', v_fixready, case when v_fixready = 1 then '' else 's' end));
    end if;
    return query select case when cardinality(v_missing) = 0 then 'ready' else 'not_ready' end::text,
                        v_missing,
                        jsonb_build_object('candidateId', v_cand.id, 'candidateVersion', v_cand.version, 'commit', v_cand.commit_ref, 'readinessScore', v_score);
    return;
  end;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.complete_phase(p_project_id uuid, p_phase integer)
 RETURNS TABLE(outcome text, missing text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor   uuid := (select auth.uid());
  v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_org     uuid;
  v_project projects.projects;
  v_read    record;
  v_id      uuid;
begin
  if v_actor is null and not v_service then
    return query select 'no_actor'::text, '{}'::text[]; return;
  end if;
  if p_phase not in (5, 6) then
    return query select 'invalid_phase'::text, '{}'::text[]; return;
  end if;

  -- The project row is the lock: two completers serialise here, and the second
  -- finds the first one's fact.
  select * into v_project from projects.projects p where p.id = p_project_id and p.deleted_at is null for update;
  if v_project.id is null then
    return query select 'not_found'::text, '{}'::text[]; return;
  end if;

  if v_actor is not null then
    v_org := (select core.current_organization_id());
    -- project.write: owner, ops admin, delivery lead (primary or secondary role).
    if v_project.organization_id is distinct from v_org
       or not (coalesce((select core.is_admin()), false) or coalesce((select core.holds_role('delivery_lead')), false)) then
      return query select 'forbidden'::text, '{}'::text[]; return;
    end if;
  end if;

  select * into v_read from projects.phase_readiness(p_project_id, p_phase);
  if v_read.outcome = 'completed' then
    return query select 'already_completed'::text, '{}'::text[]; return;
  end if;
  if v_read.outcome <> 'ready' then
    return query select 'not_ready'::text, coalesce(v_read.missing, '{}'::text[]); return;
  end if;

  insert into projects.phase_completions (organization_id, project_id, phase, completed_by, basis)
  values (v_project.organization_id, p_project_id, p_phase, v_actor, v_read.facts)
  returning id into v_id;

  -- Phase 5 -> Phase 6: the QA intake is a frozen snapshot of what Phase 5 actually produced, written in the same transaction as the
  -- completion fact. Phase 6 reads it as a CLAIM to verify independently, never as a result to trust.
  if p_phase = 5 then
    perform projects.build_phase_five_handoff(p_project_id, v_id);
    update projects.phase_five set state = 'completed', completed_at = now() where project_id = p_project_id;
  end if;

  perform core.record_audit(
    v_project.organization_id,
    case p_phase when 5 then 'project.phase_five_completed' else 'project.phase_six_completed' end,
    'project', p_project_id, null,
    jsonb_build_object('projectId', p_project_id, 'phase', p_phase, 'basis', v_read.facts)
  );

  perform core.emit_event(
    v_project.organization_id,
    case p_phase when 5 then 'project.phase_five_completed' else 'project.phase_six_completed' end,
    'project', p_project_id,
    jsonb_build_object('projectId', p_project_id, 'phaseCompletionId', v_id, 'phase', p_phase)
  );

  -- Phase 6 -> Phase 7: the frozen deployment intake is written with the completion fact, and the workspace moves to M4_DUE. NOTHING IS DEPLOYED.
  if p_phase = 6 then
    perform projects.build_phase_six_handoff(p_project_id, v_id);
    update projects.phase_six set state = 'm4_due', completed_at = now() where project_id = p_project_id;
  end if;

  return query select 'completed'::text, '{}'::text[];
end;
$function$;

revoke all on function projects.phase_readiness(uuid, integer) from public, anon;
grant execute on function projects.phase_readiness(uuid, integer) to authenticated, service_role;
revoke all on function projects.complete_phase(uuid, integer) from public, anon;
grant execute on function projects.complete_phase(uuid, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
