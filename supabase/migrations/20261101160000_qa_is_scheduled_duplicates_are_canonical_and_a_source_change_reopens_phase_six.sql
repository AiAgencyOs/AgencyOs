-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 6 remaining tasks (P601 §28, §42, §45; P603; P612).
--
--  1. QA Orchestrator scheduling: an approved Master Test Plan is scheduled category by category to the QA specialists, with the safe-parallelism rules
--     of P601 §55 - the database suite runs SERIAL (destructive), performance runs EXCLUSIVE, regression waits for functional and end-to-end, the rest run in
--     parallel - HELD with the reason while a specialist is not enabled (never recorded as started). Idempotent; the decision is stored.
--  2. Canonical defects: a duplicate points at ONE canonical defect in the same project, keeps its own evidence on the canonical, and leaves the gates.
--  3. Source change after approval: `reopen_on_source_change` marks the approved candidate STALE, blocks Phase 6 with the reason and invalidates the
--     evidence, so Phase 7 cannot deploy code the QA never tested. `phase_seven_candidate_current` is the question Phase 7 asks.
--  4. The intake records the supported platform (from the build's own details, never inferred) and the project's change-request history.
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.qa_intakes
  add column if not exists supported_platforms text[] not null default '{}',
  add column if not exists change_request_history jsonb not null default '[]'::jsonb check (jsonb_typeof(change_request_history) = 'array');

alter table qa.defects add column if not exists duplicate_of uuid references qa.defects(id) on delete set null;
alter table qa.defects drop constraint if exists defects_duplicate_names_canonical;
alter table qa.defects add constraint defects_duplicate_names_canonical check ((classification = 'duplicate') = (duplicate_of is not null) and duplicate_of is distinct from id);

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

-- ── QA job scheduling ──────────────────────────────────────────────────────
create table if not exists qa.qa_jobs (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  project_id          uuid not null references projects.projects(id) on delete cascade,
  plan_id             uuid not null references qa.master_test_plans(id) on delete cascade,
  category            text not null check (category in ('functional', 'ui_e2e', 'api', 'integration', 'database', 'security', 'performance', 'compatibility', 'regression')),
  specialist          text not null,
  execution_mode      text not null check (execution_mode in ('parallel', 'serial', 'exclusive')),
  depends_on          text[] not null default '{}',
  status              text not null check (status in ('routed', 'held', 'cancelled')),
  code                text not null default '',
  reason              text not null,
  handoff_id          uuid references ai.handoffs(id) on delete set null,
  envelope            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  unique (plan_id, category)
);
alter table qa.qa_jobs enable row level security;
drop policy if exists qa_jobs_read on qa.qa_jobs;
create policy qa_jobs_read on qa.qa_jobs for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
grant select on qa.qa_jobs to authenticated;
grant all on qa.qa_jobs to service_role;
do $$
declare r record;
begin
  for r in select * from (values ('project_id', 'projects.projects'), ('plan_id', 'qa.master_test_plans'), ('handoff_id', 'ai.handoffs')) as t(col, parent) loop
    execute format('drop trigger if exists %I on qa.qa_jobs', 'qa_jobs_parent_org_' || r.col);
    execute format('create trigger %I before insert or update of %I on qa.qa_jobs for each row execute function core.enforce_parent_org(%L, %L)', 'qa_jobs_parent_org_' || r.col, r.col, r.col, r.parent);
  end loop;
end $$;
drop trigger if exists freeze_org_qa_jobs on qa.qa_jobs;
create trigger freeze_org_qa_jobs before update of organization_id on qa.qa_jobs for each row execute function core.freeze_organization_id();

create or replace function qa.schedule_plan_jobs(p_plan_id uuid)
returns table (outcome text, routed int, held int)
language plpgsql security definer set search_path = '' as $$
declare
  v_service boolean := coalesce((select auth.role()), '') = 'service_role'; v_actor uuid := (select auth.uid());
  v_plan qa.master_test_plans; cat text; v_spec text; v_mode text; v_dep text[]; v_enabled boolean; v_status text; v_code text; v_reason text; v_handoff uuid; v_routed int := 0; v_held int := 0; v_cases int; v_new uuid;
begin
  if v_actor is null and not v_service then return query select 'no_actor'::text, 0, 0; return; end if;
  select * into v_plan from qa.master_test_plans p where p.id = p_plan_id;
  if v_plan.id is null or (v_actor is not null and v_plan.organization_id is distinct from (select core.current_organization_id())) then return query select 'not_found'::text, 0, 0; return; end if;
  if v_actor is not null and not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, 0, 0; return; end if;
  if v_plan.status <> 'approved' then return query select 'plan_not_approved'::text, 0, 0; return; end if;

  foreach cat in array v_plan.required_categories loop
    if exists (select 1 from qa.qa_jobs j where j.plan_id = p_plan_id and j.category = cat) then
      -- a job HELD for a disabled specialist is routed once that specialist is enabled (re-scheduling is how the wait ends); anything else is left alone
      if exists (select 1 from qa.qa_jobs j join ai.agents a on a.key = j.specialist where j.plan_id = p_plan_id and j.category = cat and j.status = 'held' and a.enabled) then
        select j.specialist, j.execution_mode, j.depends_on into v_spec, v_mode, v_dep from qa.qa_jobs j where j.plan_id = p_plan_id and j.category = cat;
        select count(*) into v_cases from qa.phase6_cases c where c.plan_id = p_plan_id and c.category = cat;
        insert into ai.handoffs (organization_id, correlation_id, from_agent, to_agent, project_id, subject_type, subject_id, objective, context)
        values (v_plan.organization_id, p_plan_id, 'quality_assurance', v_spec, v_plan.project_id, 'qa_job', p_plan_id, 'Run the ' || cat || ' tests of the Master Test Plan on commit ' || v_plan.commit_ref,
                jsonb_build_object('planId', p_plan_id, 'category', cat, 'commit', v_plan.commit_ref, 'cases', v_cases, 'executionMode', v_mode, 'dependsOn', to_jsonb(v_dep),
                                   'environments', to_jsonb(v_plan.environments), 'dataStrategy', v_plan.test_data_strategy, 'toolPermissions', '[]'::jsonb,
                                   'rules', jsonb_build_object('exactCommitOnly', true, 'independentOfTheBuilder', true, 'passNeedsEvidence', true, 'noProductionData', true)))
        returning id into v_handoff;
        update qa.qa_jobs set status = 'routed', code = '', reason = v_spec || ' is enabled now; the held work is routed', handoff_id = v_handoff where plan_id = p_plan_id and category = cat;
        v_routed := v_routed + 1;
      end if;
      continue;
    end if;
    v_spec := case cat when 'functional' then 'functional_test' when 'ui_e2e' then 'ui_journey_test' when 'api' then 'api_integration_test' when 'integration' then 'api_integration_test'
                       when 'database' then 'database_test' when 'security' then 'security_test' when 'performance' then 'performance_test'
                       when 'compatibility' then 'compatibility_test' else 'regression_test' end;
    -- safe parallelism (P601 §55): destructive database work is serial, load testing owns the environment, regression waits for what it protects
    v_mode := case cat when 'database' then 'serial' when 'performance' then 'exclusive' else 'parallel' end;
    v_dep := case cat when 'regression' then array['functional', 'ui_e2e'] else '{}' end;
    select count(*) into v_cases from qa.phase6_cases c where c.plan_id = p_plan_id and c.category = cat;
    select a.enabled into v_enabled from ai.agents a where a.key = v_spec;
    if coalesce(v_enabled, false) then
      v_status := 'routed'; v_code := ''; v_reason := v_spec || ' carries the category the approved plan requires';
      insert into ai.handoffs (organization_id, correlation_id, from_agent, to_agent, project_id, subject_type, subject_id, objective, context)
      values (v_plan.organization_id, p_plan_id, 'quality_assurance', v_spec, v_plan.project_id, 'qa_job', p_plan_id, 'Run the ' || cat || ' tests of the Master Test Plan on commit ' || v_plan.commit_ref,
              jsonb_build_object('planId', p_plan_id, 'category', cat, 'commit', v_plan.commit_ref, 'cases', v_cases, 'executionMode', v_mode, 'dependsOn', to_jsonb(v_dep),
                                 'environments', to_jsonb(v_plan.environments), 'dataStrategy', v_plan.test_data_strategy, 'toolPermissions', '[]'::jsonb,
                                 'rules', jsonb_build_object('exactCommitOnly', true, 'independentOfTheBuilder', true, 'passNeedsEvidence', true, 'noProductionData', true)))
      returning id into v_handoff;
      v_routed := v_routed + 1;
    else
      v_status := 'held'; v_code := 'agent_disabled'; v_reason := v_spec || ' is installed but not enabled; the work waits rather than pretending to run'; v_handoff := null; v_held := v_held + 1;
    end if;
    insert into qa.qa_jobs (organization_id, project_id, plan_id, category, specialist, execution_mode, depends_on, status, code, reason, handoff_id, envelope)
    values (v_plan.organization_id, v_plan.project_id, p_plan_id, cat, v_spec, v_mode, v_dep, v_status, v_code, v_reason, v_handoff,
            jsonb_build_object('commit', v_plan.commit_ref, 'cases', v_cases, 'executionMode', v_mode, 'dependsOn', to_jsonb(v_dep)))
    on conflict (plan_id, category) do nothing;
  end loop;
  return query select 'scheduled'::text, v_routed, v_held;
end $$;
revoke all on function qa.schedule_plan_jobs(uuid) from public, anon;
grant execute on function qa.schedule_plan_jobs(uuid) to authenticated, service_role;

-- ── a source change after approval ─────────────────────────────────────────
insert into core.event_types (type, description, canonical) values
  ('project.phase_six_evidence_stale', 'The source changed after a release candidate was approved: the approval and the evidence no longer describe the build. A new candidate and a new approval are required before production.', true)
on conflict (type) do nothing;

create or replace function qa.reopen_on_source_change(p_project_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_service boolean := coalesce((select auth.role()), '') = 'service_role'; v_actor uuid := (select auth.uid());
  v_c qa.release_candidates; v_commit text; v_org uuid;
begin
  if v_actor is null and not v_service then return query select 'no_actor'::text; return; end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id;
  if v_org is null or (v_actor is not null and (v_org is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false))) then return query select 'not_found'::text; return; end if;
  select * into v_c from qa.release_candidates c where c.project_id = p_project_id and c.status in ('approved', 'stale') order by c.version desc limit 1;
  if v_c.id is null then return query select 'no_approved_candidate'::text; return; end if;
  select dd.commit_ref into v_commit from projects.deliverable_details dd where dd.deliverable_id = v_c.build_deliverable_id;
  if v_commit is not distinct from v_c.commit_ref then return query select 'source_unchanged'::text; return; end if;
  if v_c.status = 'stale' then return query select 'already_stale'::text; return; end if;
  update qa.release_candidates set status = 'stale' where id = v_c.id;
  perform qa.invalidate_stale_results(p_project_id);
  update projects.phase_six set state = 'blocked', blocked_reason = 'The source changed after the release candidate was approved: a new candidate and a new Admin approval are required before production.'
   where project_id = p_project_id and state <> 'blocked';
  perform core.record_audit(v_org, 'release_candidate.stale', 'release_candidate', v_c.id, null, jsonb_build_object('projectId', p_project_id, 'approvedCommit', v_c.commit_ref, 'currentCommit', v_commit));
  perform core.emit_event(v_org, 'project.phase_six_evidence_stale', 'release_candidate', v_c.id, jsonb_build_object('projectId', p_project_id));
  return query select 'reopened'::text;
end $$;
revoke all on function qa.reopen_on_source_change(uuid) from public, anon;
grant execute on function qa.reopen_on_source_change(uuid) to authenticated, service_role;

-- the question Phase 7 asks before it deploys anything
create or replace function projects.phase_seven_candidate_current(p_project_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from qa.release_candidates c join projects.deliverable_details dd on dd.deliverable_id = c.build_deliverable_id
     where c.project_id = p_project_id and c.status = 'approved' and dd.commit_ref = c.commit_ref
       and (coalesce((select auth.role()), '') = 'service_role' or c.organization_id = (select core.current_organization_id())))
$$;
revoke all on function projects.phase_seven_candidate_current(uuid) from public, anon;
grant execute on function projects.phase_seven_candidate_current(uuid) to authenticated, service_role;

CREATE OR REPLACE FUNCTION projects.validate_qa_intake(p_project_id uuid)
 RETURNS TABLE(outcome text, status text, blockers jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_six projects.phase_six;
  v_h projects.phase_five_handoffs;
  v_base projects.development_baselines;
  v_intake projects.qa_intakes;
  v_blockers jsonb := '[]'::jsonb;
  v_external jsonb;
  v_status text := 'valid';
  v_latest record;
  v_commit text;
  v_hash text;
  v_scope uuid;
  v_ui_status text;
  v_m3 boolean;
  v_platforms text[];
  v_crs jsonb;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::text, '[]'::jsonb; return;
  end if;
  select s.* into v_six from projects.phase_six s where s.project_id = p_project_id for update;
  if v_six.id is null then return query select 'no_workspace'::text, null::text, '[]'::jsonb; return; end if;
  if v_actor is not null and (v_six.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::text, '[]'::jsonb; return;
  end if;
  v_m3 := projects.m3_verified_paid(p_project_id);
  if v_six.state = 'waiting_m3_verified' or not v_m3 then
    return query select 'waiting_m3_verified'::text, 'blocked_finance'::text,
      jsonb_build_array(jsonb_build_object('type', 'finance', 'owner', 'admin', 'resumeCondition', 'An Admin verifies the M3 payment in full', 'detail', 'M3 is not verified paid'));
    return;
  end if;

  select h.* into v_h from projects.phase_five_handoffs h where h.id = v_six.phase_five_handoff_id;
  select b.* into v_base from projects.development_baselines b where b.project_id = p_project_id;

  -- the build the client approved must be THE build handed over, and its commit must still be the handed-over commit
  select d.id, d.version, dd.commit_ref into v_latest
    from projects.deliverables d left join projects.deliverable_details dd on dd.deliverable_id = d.id
   where d.project_id = p_project_id and d.kind = 'build' and d.status = 'approved' order by d.version desc limit 1;
  if v_latest.id is null then
    v_blockers := v_blockers || jsonb_build_object('type', 'build', 'owner', 'delivery_lead', 'resumeCondition', 'The client approves an exact build', 'detail', 'no client-approved build');
    v_status := 'blocked_build';
  elsif v_latest.id is distinct from v_h.final_build_deliverable_id then
    v_blockers := v_blockers || jsonb_build_object('type', 'build', 'owner', 'delivery_lead', 'resumeCondition', 'Hand over the build the client approved, or have the client approve this one', 'detail', 'the client approval is tied to a different build than the one handed over');
    v_status := 'blocked_build';
  end if;
  select dd.commit_ref into v_commit from projects.deliverable_details dd where dd.deliverable_id = v_h.final_build_deliverable_id;
  if v_commit is distinct from v_h.final_commit_ref then
    v_blockers := v_blockers || jsonb_build_object('type', 'build', 'owner', 'delivery_lead', 'resumeCondition', 'Restore the handed-over commit or create a new release candidate', 'detail', 'the build''s commit no longer matches the handed-over commit');
    v_status := 'blocked_build';
  end if;
  select br.artifact_sha256 into v_hash from projects.build_runs br
   where br.deliverable_id = v_h.final_build_deliverable_id and br.commit_ref = v_h.final_commit_ref and br.status = 'succeeded' and br.artifact_sha256 is not null
   order by br.created_at desc limit 1;
  if v_hash is null then
    v_blockers := v_blockers || jsonb_build_object('type', 'build', 'owner', 'devops_build', 'resumeCondition', 'A successful build run with an artifact hash exists for the handed-over commit', 'detail', 'no verified artifact for the exact commit');
    v_status := 'blocked_build';
  end if;

  -- scope and UI must still be the ones the baseline locked
  select s.id into v_scope from projects.scope_versions s where s.project_id = p_project_id and s.status = 'active' order by s.version desc limit 1;
  if v_base.id is not null and v_scope is distinct from v_base.scope_version_id then
    v_blockers := v_blockers || jsonb_build_object('type', 'scope', 'owner', 'project_manager', 'resumeCondition', 'Re-baseline through an approved Change Request', 'detail', 'the active scope is no longer the scope Phase 5 built against');
    if v_status = 'valid' then v_status := 'blocked_scope'; end if;
  end if;
  if v_base.id is not null then
    select u.status into v_ui_status from projects.ui_versions u where u.id = v_base.ui_version_id;
    if v_ui_status is distinct from 'locked' then
      v_blockers := v_blockers || jsonb_build_object('type', 'scope', 'owner', 'ui_designer', 'resumeCondition', 'The approved UI is locked again', 'detail', 'the baseline UI version is no longer locked');
      if v_status = 'valid' then v_status := 'blocked_scope'; end if;
    end if;
  end if;

  -- unverified integrations are EXPLICIT external dependencies: tests that need them are BLOCKED with a reason, never silently skipped
  select coalesce(jsonb_agg(jsonb_build_object('type', 'external', 'name', c.name, 'kind', c.kind, 'health', c.health, 'mock', c.is_mock,
           'owner', 'admin', 'resumeCondition', 'Provide credentials and pass an adapter check', 'detail', c.name || ' is ' || c.health || ' and not verified') order by c.name), '[]'::jsonb)
    into v_external from projects.integration_connections c where c.project_id = p_project_id and c.health <> 'verified';

  -- the supported platform is read from the build's recorded details, never inferred; the change-request history is read from the project's own requests
  select coalesce(array_agg(distinct dd.platform) filter (where dd.platform is not null), '{}') into v_platforms from projects.deliverable_details dd where dd.deliverable_id = v_h.final_build_deliverable_id;
  select coalesce(jsonb_agg(jsonb_build_object('id', cr.id, 'status', cr.status, 'classification', cr.classification, 'requested', left(cr.requested, 200)) order by cr.created_at), '[]'::jsonb) into v_crs from projects.change_requests cr where cr.project_id = p_project_id;

  insert into projects.qa_intakes (organization_id, project_id, phase_six_id, phase_five_handoff_id, build_deliverable_id, commit_ref, artifact_sha256, scope_version_id, ui_version_id,
                                   status, blockers, external_dependencies, m3_verified, validated_at, supported_platforms, change_request_history)
  values (v_six.organization_id, p_project_id, v_six.id, v_h.id, v_h.final_build_deliverable_id, v_h.final_commit_ref, v_hash, v_base.scope_version_id, v_base.ui_version_id,
          v_status, v_blockers, v_external, v_m3, now(), v_platforms, v_crs)
  on conflict (project_id) do update
     set status = excluded.status, blockers = excluded.blockers, external_dependencies = excluded.external_dependencies,
         artifact_sha256 = excluded.artifact_sha256, m3_verified = excluded.m3_verified, validated_at = now(),
         supported_platforms = excluded.supported_platforms, change_request_history = excluded.change_request_history;

  if v_status = 'valid' then
    update projects.phase_six set state = case when state in ('ready', 'blocked') then 'intake_validating' else state end, blocked_reason = null where id = v_six.id;
  else
    update projects.phase_six set state = 'blocked', blocked_reason = 'QA intake is ' || v_status || ': ' || (v_blockers->0->>'detail') where id = v_six.id and state in ('ready', 'intake_validating', 'blocked');
  end if;

  perform core.record_audit(v_six.organization_id, 'project.qa_intake_validated', 'phase_six', v_six.id, null, jsonb_build_object('projectId', p_project_id, 'status', v_status));
  perform core.emit_event(v_six.organization_id, 'project.qa_intake_validated', 'phase_six', v_six.id, jsonb_build_object('projectId', p_project_id, 'status', v_status));
  return query select 'validated'::text, v_status, v_blockers;
end $function$;

revoke all on function projects.validate_qa_intake(uuid) from public, anon;
grant execute on function projects.validate_qa_intake(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
