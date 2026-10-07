-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 -> Phase 6: the QA intake (Phase5Handoff).
--
-- At Phase 5 completion, a frozen snapshot is written in the SAME transaction as the completion fact: the exact final build and commit,
-- the locked baseline, the independent reviews of that commit, the latest test run per suite, the defect history, the integration health
-- (with every integration that is NOT verified named as a known limitation and a manual dependency), and the areas Phase 6 should inspect
-- first. `independent_verification_required` is a CHECK that is always true: Phase 6 does not trust Phase 5's results.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.phase_five_handoffs (
  id                          uuid primary key default gen_random_uuid(),
  organization_id             uuid not null references core.organizations(id) on delete cascade,
  project_id                  uuid not null references projects.projects(id) on delete cascade,
  phase_completion_id         uuid not null references projects.phase_completions(id) on delete restrict,
  final_build_deliverable_id  uuid not null references projects.deliverables(id) on delete restrict,
  final_commit_ref            text not null,
  baseline_id                 uuid references projects.development_baselines(id) on delete restrict,
  payload                     jsonb not null,
  independent_verification_required boolean not null default true check (independent_verification_required),
  created_at                  timestamptz not null default now(),
  unique (project_id)
);
alter table projects.phase_five_handoffs enable row level security;
drop policy if exists phase_five_handoffs_read on projects.phase_five_handoffs;
create policy phase_five_handoffs_read on projects.phase_five_handoffs for select to authenticated
  using (organization_id = (select core.current_organization_id()));
grant select on projects.phase_five_handoffs to authenticated;
grant all on projects.phase_five_handoffs to service_role;
do $$
declare r record;
begin
  for r in select * from (values ('project_id', 'projects.projects'), ('phase_completion_id', 'projects.phase_completions'),
                                 ('final_build_deliverable_id', 'projects.deliverables'), ('baseline_id', 'projects.development_baselines')) as t(col, parent) loop
    execute format('drop trigger if exists %I on projects.phase_five_handoffs', 'phase_five_handoffs_parent_org_' || r.col);
    execute format('create trigger %I before insert or update of %I on projects.phase_five_handoffs for each row execute function core.enforce_parent_org(%L, %L)',
                   'phase_five_handoffs_parent_org_' || r.col, r.col, r.col, r.parent);
  end loop;
end $$;
drop trigger if exists freeze_org_phase_five_handoffs on projects.phase_five_handoffs;
create trigger freeze_org_phase_five_handoffs before update of organization_id on projects.phase_five_handoffs for each row execute function core.freeze_organization_id();

create or replace function projects.phase_five_handoffs_frozen()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'a Phase 5 handoff is a snapshot of what was handed over and is never edited' using errcode = 'restrict_violation';
end $$;
drop trigger if exists phase_five_handoffs_frozen on projects.phase_five_handoffs;
create trigger phase_five_handoffs_frozen before update on projects.phase_five_handoffs for each row execute function projects.phase_five_handoffs_frozen();

create or replace function projects.build_phase_five_handoff(p_project_id uuid, p_phase_completion_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project projects.projects;
  v_build   record;
  v_base    projects.development_baselines;
  v_payload jsonb;
  v_id      uuid;
begin
  select * into v_project from projects.projects p where p.id = p_project_id;
  select d.id, d.version, d.title, d.artifact_url, dd.commit_ref, dd.build_number, dd.target_env, dd.platform
    into v_build
    from projects.deliverables d
    left join projects.deliverable_details dd on dd.deliverable_id = d.id
   where d.project_id = p_project_id and d.kind = 'build' and d.status = 'approved'
   order by d.version desc limit 1;
  if v_build.id is null then
    raise exception 'phase 5 cannot hand over without a client-approved build' using errcode = 'check_violation';
  end if;
  select * into v_base from projects.development_baselines b where b.project_id = p_project_id;

  v_payload := jsonb_build_object(
    'build', jsonb_build_object('deliverableId', v_build.id, 'version', v_build.version, 'commit', v_build.commit_ref, 'buildNumber', v_build.build_number,
                                'targetEnvironment', v_build.target_env, 'platform', v_build.platform, 'artifactUrl', v_build.artifact_url),
    'baseline', case when v_base.id is null then null else jsonb_build_object('baselineId', v_base.id, 'uiVersionId', v_base.ui_version_id,
                  'prototypeDeliverableId', v_base.prototype_deliverable_id, 'scopeVersionId', v_base.scope_version_id) end,
    'reviews', coalesce((select jsonb_agg(jsonb_build_object('commit', r.commit_ref, 'verdict', r.verdict, 'reviewedAt', r.reviewed_at,
                  'findings', jsonb_array_length(r.findings), 'reviewerChangedCode', r.reviewer_changed_code) order by r.reviewed_at)
                  from projects.code_reviews r where r.deliverable_id = v_build.id), '[]'::jsonb),
    'tests', coalesce((select jsonb_agg(jsonb_build_object('suite', t.suite, 'total', t.total, 'passed', t.passed, 'failed', t.failed, 'executedAt', t.executed_at))
                  from (select distinct on (r.suite) r.suite, r.total, r.passed, r.failed, r.executed_at
                          from qa.test_runs r where r.project_id = p_project_id order by r.suite, r.executed_at desc, r.created_at desc) t), '[]'::jsonb),
    'defects', jsonb_build_object(
        'total', (select count(*) from qa.defects d where d.project_id = p_project_id),
        'verified', (select count(*) from qa.defects d where d.project_id = p_project_id and d.status = 'verified'),
        'unresolved', (select count(*) from qa.defects d where d.project_id = p_project_id and d.status in ('open', 'fixed', 'needs_evidence', 'not_reproduced')),
        'wontfix', (select count(*) from qa.defects d where d.project_id = p_project_id and d.status = 'wontfix')),
    'integrations', coalesce((select jsonb_agg(jsonb_build_object('kind', c.kind, 'name', c.name, 'health', c.health, 'mock', c.is_mock) order by c.kind, c.name)
                  from projects.integration_connections c where c.project_id = p_project_id), '[]'::jsonb),
    'knownLimitations', coalesce((select jsonb_agg(format('%s (%s) is %s, not verified%s', c.name, c.kind, c.health, case when c.is_mock then ' - only a mock exists' else '' end) order by c.name)
                  from projects.integration_connections c where c.project_id = p_project_id and c.health <> 'verified'), '[]'::jsonb),
    'manualDependencies', coalesce((select jsonb_agg(c.name order by c.name) from projects.integration_connections c where c.project_id = p_project_id and c.health in ('unknown', 'configured', 'blocked')), '[]'::jsonb),
    'highRiskAreas', (
        select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select 'integration not verified: ' || c.name as x from projects.integration_connections c where c.project_id = p_project_id and c.health <> 'verified'
          union all select 'builds after the first: ' || (count(*) - 1)::text from projects.deliverables d where d.project_id = p_project_id and d.kind = 'build' and d.status <> 'superseded' having count(*) > 1
          union all select 'reopened or re-fixed defects exist' where exists (select 1 from qa.defects d where d.project_id = p_project_id and d.fixed_at is not null and d.status = 'open')
          union all select 'change requests raised during testing: ' || count(*)::text from projects.change_requests cr where cr.project_id = p_project_id having count(*) > 0
        ) q),
    'independentVerificationRequired', true,
    'note', 'A claim to verify, not a result to trust: Phase 6 re-tests the exact build above independently.'
  );

  insert into projects.phase_five_handoffs (organization_id, project_id, phase_completion_id, final_build_deliverable_id, final_commit_ref, baseline_id, payload)
  values (v_project.organization_id, p_project_id, p_phase_completion_id, v_build.id, coalesce(v_build.commit_ref, 'unrecorded'), v_base.id, v_payload)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function projects.build_phase_five_handoff(uuid, uuid) from public, anon, authenticated;
grant execute on function projects.build_phase_five_handoff(uuid, uuid) to service_role;

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

  return query select 'completed'::text, '{}'::text[];
end;
$function$;

revoke all on function projects.complete_phase(uuid, integer) from public, anon;
grant execute on function projects.complete_phase(uuid, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
