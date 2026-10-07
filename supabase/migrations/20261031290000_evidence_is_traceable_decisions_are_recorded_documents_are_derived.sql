-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5: evidence that is traceable, decisions that are recorded, documentation that is derived.
--
--  1. REQUIREMENT -> ACCEPTANCE CRITERION -> TASK -> TEST -> BUILD -> RESULT (Test Automation spec): `task_test_evidence` links a task to the test
--     runs that cover it; `task_test_gaps` names the planned tasks with no PASSING linked run; Phase 5 does not complete while any exists.
--  2. Routing decisions (Orchestrator spec, "execution trace"): every routed / held / refused decision is stored, append-only, with its reason.
--  3. Documentation (Documentation spec, "NO IMAGINARY DOCS, NO STALE DOCS"): documents are DERIVED from rows that exist (integration health,
--     build runs, test runs, defects), carry the commit they describe, and are STALE the moment a newer build exists.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.task_test_evidence (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  task_id          uuid not null references projects.tasks(id) on delete cascade,
  test_run_id      uuid not null references qa.test_runs(id) on delete restrict,
  linked_by        uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (task_id, test_run_id)
);
alter table projects.task_test_evidence enable row level security;
drop policy if exists task_test_evidence_read on projects.task_test_evidence;
create policy task_test_evidence_read on projects.task_test_evidence for select to authenticated using (organization_id = (select core.current_organization_id()));
grant select on projects.task_test_evidence to authenticated;
grant all on projects.task_test_evidence to service_role;
do $$
declare r record;
begin
  for r in select * from (values ('project_id', 'projects.projects'), ('task_id', 'projects.tasks'), ('test_run_id', 'qa.test_runs')) as t(col, parent) loop
    execute format('drop trigger if exists %I on projects.task_test_evidence', 'task_test_evidence_parent_org_' || r.col);
    execute format('create trigger %I before insert or update of %I on projects.task_test_evidence for each row execute function core.enforce_parent_org(%L, %L)',
                   'task_test_evidence_parent_org_' || r.col, r.col, r.col, r.parent);
  end loop;
end $$;
drop trigger if exists freeze_org_task_test_evidence on projects.task_test_evidence;
create trigger freeze_org_task_test_evidence before update of organization_id on projects.task_test_evidence for each row execute function core.freeze_organization_id();

create or replace function projects.link_task_test_run(p_task_id uuid, p_test_run_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_task projects.tasks; v_run qa.test_runs; v_service boolean := coalesce((select auth.role()), '') = 'service_role';
begin
  if v_actor is null and not v_service then return query select 'no_actor'::text; return; end if;
  if v_actor is not null and not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_task from projects.tasks t where t.id = p_task_id;
  select * into v_run from qa.test_runs r where r.id = p_test_run_id;
  if v_task.id is null or v_run.id is null or (v_actor is not null and v_task.organization_id <> v_org) then return query select 'not_found'::text; return; end if;
  if v_run.project_id is distinct from v_task.project_id then return query select 'wrong_project'::text; return; end if;
  insert into projects.task_test_evidence (organization_id, project_id, task_id, test_run_id, linked_by) values (v_task.organization_id, v_task.project_id, v_task.id, v_run.id, v_actor)
    on conflict (task_id, test_run_id) do nothing;
  if not found then return query select 'already_linked'::text; return; end if;
  return query select 'linked'::text;
end $$;
revoke all on function projects.link_task_test_run(uuid, uuid) from public, anon;
grant execute on function projects.link_task_test_run(uuid, uuid) to authenticated, service_role;

-- a planned, live task with no linked run that RAN something and failed nothing
create or replace function projects.task_test_gaps(p_project_id uuid)
returns table (task_id uuid, title text)
language sql stable set search_path = '' as $$
  select t.id, t.title
    from projects.tasks t
   where t.project_id = p_project_id and t.plan_id is not null and t.status <> 'cancelled' and t.archived_at is null
     and not exists (
       select 1 from projects.task_test_evidence e join qa.test_runs r on r.id = e.test_run_id
        where e.task_id = t.id and r.failed = 0 and r.passed > 0 and coalesce(r.blocked, 0) = 0)
$$;
revoke all on function projects.task_test_gaps(uuid) from public, anon;
grant execute on function projects.task_test_gaps(uuid) to authenticated, service_role;

create table if not exists projects.routing_decisions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  plan_id          uuid references projects.development_plans(id) on delete restrict,
  task_id          uuid not null references projects.tasks(id) on delete cascade,
  to_agent         text,
  outcome          text not null check (outcome in ('routed', 'held', 'refused')),
  code             text not null default '',
  reason           text not null,
  decided_at       timestamptz not null default now(),
  unique (task_id, outcome, code)
);
alter table projects.routing_decisions enable row level security;
drop policy if exists routing_decisions_read on projects.routing_decisions;
create policy routing_decisions_read on projects.routing_decisions for select to authenticated using (organization_id = (select core.current_organization_id()));
grant select on projects.routing_decisions to authenticated;
grant all on projects.routing_decisions to service_role;
do $$
declare r record;
begin
  for r in select * from (values ('project_id', 'projects.projects'), ('plan_id', 'projects.development_plans'), ('task_id', 'projects.tasks')) as t(col, parent) loop
    execute format('drop trigger if exists %I on projects.routing_decisions', 'routing_decisions_parent_org_' || r.col);
    execute format('create trigger %I before insert or update of %I on projects.routing_decisions for each row execute function core.enforce_parent_org(%L, %L)',
                   'routing_decisions_parent_org_' || r.col, r.col, r.col, r.parent);
  end loop;
end $$;
drop trigger if exists freeze_org_routing_decisions on projects.routing_decisions;
create trigger freeze_org_routing_decisions before update of organization_id on projects.routing_decisions for each row execute function core.freeze_organization_id();
create or replace function projects.routing_decisions_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'a routing decision is a record of what was decided and why' using errcode = 'restrict_violation'; end $$;
drop trigger if exists routing_decisions_append_only on projects.routing_decisions;
create trigger routing_decisions_append_only before update on projects.routing_decisions for each row execute function projects.routing_decisions_append_only();

-- Documentation derived from rows that exist
alter table projects.technical_documents
  add column if not exists derived boolean not null default false,
  add column if not exists source_commit text;

create or replace function projects.stale_documents(p_project_id uuid)
returns table (document_id uuid, title text)
language sql stable set search_path = '' as $$
  select d.id, d.title
    from projects.technical_documents d
   where d.project_id = p_project_id and d.derived and d.status <> 'deprecated'
     and d.source_commit is distinct from (
       select dd.commit_ref
         from projects.deliverables b join projects.deliverable_details dd on dd.deliverable_id = b.id
        where b.project_id = p_project_id and b.kind = 'build' and b.status <> 'superseded'
        order by b.version desc limit 1)
$$;
revoke all on function projects.stale_documents(uuid) from public, anon;
grant execute on function projects.stale_documents(uuid) to authenticated, service_role;

create or replace function projects.derive_phase_five_documents(p_project_id uuid)
returns table (outcome text, documents int)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid; v_actor uuid := (select auth.uid()); v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_commit text; v_n int := 0; v_run record; v_body text; v_failed int; v_unverified text; v_defects int;
  ic record;
begin
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_org is null then return query select 'not_found'::text, 0; return; end if;
  if v_actor is null and not v_service then return query select 'no_actor'::text, 0; return; end if;
  if v_actor is not null and (v_org is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then return query select 'not_authorized'::text, 0; return; end if;

  select dd.commit_ref into v_commit
    from projects.deliverables b join projects.deliverable_details dd on dd.deliverable_id = b.id
   where b.project_id = p_project_id and b.kind = 'build' and b.status <> 'superseded' order by b.version desc limit 1;
  if v_commit is null then return query select 'no_build'::text, 0; return; end if;
  perform set_config('projects.doc_derive', 'on', true);

  -- one document per integration, whose status can never exceed that integration's health
  for ic in select * from projects.integration_connections where project_id = p_project_id loop
    insert into projects.technical_documents (organization_id, project_id, kind, title, status, evidence_ref, integration_id, body, derived, source_commit)
    values (v_org, p_project_id, 'integration', ic.name,
            case ic.health when 'verified' then 'implemented' when 'configured' then 'partial' when 'degraded' then 'partial' when 'blocked' then 'blocked' when 'disabled' then 'not_required' else 'not_implemented' end,
            case when ic.health = 'verified' then 'adapter:' || coalesce(ic.verified_by_adapter, '') else null end,
            ic.id, format('%s (%s): health %s%s.', ic.name, ic.kind, ic.health, case when ic.is_mock then ', mock only' else '' end), true, v_commit)
    on conflict (project_id, kind, title) do update set status = excluded.status, evidence_ref = excluded.evidence_ref, body = excluded.body, derived = true, source_commit = excluded.source_commit;
    v_n := v_n + 1;
  end loop;

  -- the build record, from the newest succeeded run
  select br.id, br.commit_ref, br.environment, br.artifact_sha256, br.fingerprint into v_run
    from projects.build_runs br where br.project_id = p_project_id and br.status = 'succeeded' order by br.created_at desc limit 1;
  insert into projects.technical_documents (organization_id, project_id, kind, title, status, evidence_ref, body, derived, source_commit)
  values (v_org, p_project_id, 'build_run', 'Current build',
          case when v_run.id is not null and v_run.commit_ref = v_commit then 'implemented' else 'not_implemented' end,
          case when v_run.id is not null and v_run.commit_ref = v_commit then 'build_run:' || v_run.id else null end,
          case when v_run.id is not null then format('Commit %s built for %s; artifact sha256 %s; toolchain %s.', v_run.commit_ref, v_run.environment, v_run.artifact_sha256, v_run.fingerprint::text)
               else 'No successful build run is recorded for the current commit.' end, true, v_commit)
  on conflict (project_id, kind, title) do update set status = excluded.status, evidence_ref = excluded.evidence_ref, body = excluded.body, derived = true, source_commit = excluded.source_commit;
  v_n := v_n + 1;

  -- the test record, from the latest run of each suite
  select count(*) filter (where t.failed > 0) into v_failed from (select distinct on (r.suite) r.suite, r.failed from qa.test_runs r where r.project_id = p_project_id order by r.suite, r.executed_at desc, r.created_at desc) t;
  select coalesce(string_agg(format('%s: %s passed, %s failed', t.suite, t.passed, t.failed), '; ' order by t.suite), 'no test run recorded') into v_body
    from (select distinct on (r.suite) r.suite, r.passed, r.failed from qa.test_runs r where r.project_id = p_project_id order by r.suite, r.executed_at desc, r.created_at desc) t;
  insert into projects.technical_documents (organization_id, project_id, kind, title, status, evidence_ref, body, derived, source_commit)
  values (v_org, p_project_id, 'test', 'Latest test runs',
          case when v_body = 'no test run recorded' then 'not_implemented' when v_failed > 0 then 'partial' else 'implemented' end,
          case when v_body = 'no test run recorded' then null else 'qa.test_runs' end, v_body, true, v_commit)
  on conflict (project_id, kind, title) do update set status = excluded.status, evidence_ref = excluded.evidence_ref, body = excluded.body, derived = true, source_commit = excluded.source_commit;
  v_n := v_n + 1;

  -- known limitations: what is NOT verified and what is NOT fixed, stated as it is
  select coalesce(string_agg(format('%s is %s%s', c.name, c.health, case when c.is_mock then ' (mock only)' else '' end), '; ' order by c.name), '') into v_unverified
    from projects.integration_connections c where c.project_id = p_project_id and c.health <> 'verified';
  select count(*) into v_defects from qa.defects d where d.project_id = p_project_id and d.status in ('open', 'fixed', 'needs_evidence', 'not_reproduced');
  insert into projects.technical_documents (organization_id, project_id, kind, title, status, evidence_ref, body, derived, source_commit)
  values (v_org, p_project_id, 'known_limitations', 'Known limitations', 'implemented', 'integration health + qa.defects',
          format('Integrations not verified: %s. Defects not yet verified fixed: %s.', coalesce(nullif(v_unverified, ''), 'none'), v_defects), true, v_commit)
  on conflict (project_id, kind, title) do update set status = excluded.status, evidence_ref = excluded.evidence_ref, body = excluded.body, derived = true, source_commit = excluded.source_commit;
  v_n := v_n + 1;

  return query select 'derived'::text, v_n;
end $$;
revoke all on function projects.derive_phase_five_documents(uuid) from public, anon;
grant execute on function projects.derive_phase_five_documents(uuid) to authenticated, service_role;

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

revoke all on function projects.phase_readiness(uuid, integer) from public, anon;
grant execute on function projects.phase_readiness(uuid, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
