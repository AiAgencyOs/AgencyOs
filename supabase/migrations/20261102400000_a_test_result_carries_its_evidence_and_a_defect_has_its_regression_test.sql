-- Test Automation spec (P10 §16, §17, §20, §28): a machine-readable result carries what a person needs to act on it (duration, failure message, log,
-- what requirement/feature/task it covers, its layer, WHY it failed), a failure is classified and an UNKNOWN class is never a pass, a blocked test is
-- a state of its own, an escaped defect gets a permanent regression test linked to the defective and the fixed build, and an acceptance criterion
-- with no passing test is a visible gap.

-- ── 1. the result row ────────────────────────────────────────────────────
alter table qa.test_run_cases
  add column if not exists duration_ms int,
  add column if not exists failure_message text,
  add column if not exists log_ref text,
  add column if not exists task_id uuid references projects.tasks(id) on delete set null,
  add column if not exists feature_id uuid references projects.features(id) on delete set null,
  add column if not exists requirement_version_id uuid references crm.requirement_versions(id) on delete set null,
  add column if not exists layer text,
  add column if not exists failure_class text;

alter table qa.test_run_cases drop constraint if exists test_run_cases_status_check;
alter table qa.test_run_cases add constraint test_run_cases_status_check check (status in ('passed', 'failed', 'skipped', 'flaky', 'blocked'));
alter table qa.test_run_cases drop constraint if exists test_run_cases_duration_ms_check;
alter table qa.test_run_cases add constraint test_run_cases_duration_ms_check check (duration_ms is null or duration_ms >= 0);
alter table qa.test_run_cases drop constraint if exists test_run_cases_failure_message_cap;
alter table qa.test_run_cases add constraint test_run_cases_failure_message_cap check (failure_message is null or length(failure_message) <= 4000);
alter table qa.test_run_cases drop constraint if exists test_run_cases_log_ref_https;
alter table qa.test_run_cases add constraint test_run_cases_log_ref_https check (log_ref is null or (log_ref ~ '^https://[^ ]+$' and length(log_ref) <= 500));
alter table qa.test_run_cases drop constraint if exists test_run_cases_layer_known;
alter table qa.test_run_cases add constraint test_run_cases_layer_known
  check (layer is null or layer in ('unit', 'component', 'api', 'database', 'integration', 'e2e', 'ui', 'security', 'performance', 'other'));
alter table qa.test_run_cases drop constraint if exists test_run_cases_failure_class_known;
alter table qa.test_run_cases add constraint test_run_cases_failure_class_known
  check (failure_class is null or failure_class in ('PRODUCT_DEFECT', 'TEST_DEFECT', 'FIXTURE_DEFECT', 'ENVIRONMENT_FAILURE', 'PROVIDER_FAILURE', 'CONTRACT_MISMATCH', 'UNKNOWN'));
-- a class describes a FAILURE: no case that passed carries one (an UNKNOWN cause is never a pass), and a blocked case says what blocked it
alter table qa.test_run_cases drop constraint if exists test_run_cases_class_is_a_failure;
alter table qa.test_run_cases add constraint test_run_cases_class_is_a_failure check (failure_class is null or status <> 'passed');
alter table qa.test_run_cases drop constraint if exists test_run_cases_blocked_says_why;
alter table qa.test_run_cases add constraint test_run_cases_blocked_says_why check (status <> 'blocked' or (failure_message is not null and length(btrim(failure_message)) > 0));

revoke all on qa.test_run_cases from public, anon;
revoke insert, update, delete on qa.test_run_cases from authenticated;
create index if not exists test_run_cases_task_idx on qa.test_run_cases (task_id) where task_id is not null;

do $m$
declare r record;
begin
  for r in select * from (values ('task_id', 'projects.tasks'), ('feature_id', 'projects.features'), ('requirement_version_id', 'crm.requirement_versions')) as t(col, parent) loop
    execute format('drop trigger if exists %I on qa.test_run_cases', 'test_run_cases_parent_org_' || r.col);
    execute format('create trigger %I before insert or update of %I on qa.test_run_cases for each row execute function core.enforce_parent_org(%L, %L)',
                   'test_run_cases_parent_org_' || r.col, r.col, r.col, r.parent);
  end loop;
end $m$;

-- ── 2. the ingest door accepts and checks them ───────────────────────────
-- Patched on the LIVE definition (two later migrations already changed it); each anchor must be found or the migration stops.
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('qa.ingest_test_report(uuid,text,jsonb,text)'::regprocedure);

  n := replace(d, '  v_prev_run uuid; v_prev_passed int; v_prev_failed int;', '  v_prev_run uuid; v_prev_passed int; v_prev_failed int;
  v_blocked int;');
  if n = d then raise exception 'ingest_test_report: declare anchor not found'; end if;
  d := n;

  n := replace(d, '(e->>''status'') not in (''passed'', ''failed'', ''skipped'', ''flaky'')', '(e->>''status'') not in (''passed'', ''failed'', ''skipped'', ''flaky'', ''blocked'')');
  if n = d then raise exception 'ingest_test_report: status anchor not found'; end if;
  d := n;

  n := replace(d, '  -- the header, when present, must agree with the tests: counts are computed, never trusted', $r$
  -- an UNKNOWN cause is never counted as a pass: a test that passed has nothing to classify
  if exists (select 1 from jsonb_array_elements(v_tests) e where (e->>'status') = 'passed' and (e->>'failure_class') = 'UNKNOWN') then
    return query select 'unknown_cannot_pass'::text, null::uuid, 0, 0, 0; return;
  end if;
  -- per-test metadata (Test Automation spec section 16): every field is optional, and every one that is present is checked
  if exists (select 1 from jsonb_array_elements(v_tests) e where
       (coalesce(jsonb_typeof(e->'duration_ms'), 'null') <> 'null' and (jsonb_typeof(e->'duration_ms') <> 'number' or (e->>'duration_ms') !~ '^[0-9]{1,9}$'))
    or (coalesce(jsonb_typeof(e->'failure_message'), 'null') <> 'null' and (jsonb_typeof(e->'failure_message') <> 'string' or length(e->>'failure_message') > 4000))
    or (coalesce(jsonb_typeof(e->'log_ref'), 'null') <> 'null' and (jsonb_typeof(e->'log_ref') <> 'string' or (e->>'log_ref') !~ '^https://[^ ]+$' or length(e->>'log_ref') > 500))
    or (coalesce(jsonb_typeof(e->'layer'), 'null') <> 'null' and (jsonb_typeof(e->'layer') <> 'string'
         or (e->>'layer') not in ('unit', 'component', 'api', 'database', 'integration', 'e2e', 'ui', 'security', 'performance', 'other')))
    or (coalesce(jsonb_typeof(e->'failure_class'), 'null') <> 'null' and (jsonb_typeof(e->'failure_class') <> 'string'
         or (e->>'failure_class') not in ('PRODUCT_DEFECT', 'TEST_DEFECT', 'FIXTURE_DEFECT', 'ENVIRONMENT_FAILURE', 'PROVIDER_FAILURE', 'CONTRACT_MISMATCH', 'UNKNOWN')))
    -- a class describes a failure
    or ((e->>'failure_class') is not null and (e->>'status') = 'passed')
    -- a blocked test says what blocked it
    or ((e->>'status') = 'blocked' and coalesce(btrim(e->>'failure_message'), '') = '')
    or (coalesce(jsonb_typeof(e->'task_id'), 'null') <> 'null' and (jsonb_typeof(e->'task_id') <> 'string' or (e->>'task_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    or (coalesce(jsonb_typeof(e->'feature_id'), 'null') <> 'null' and (jsonb_typeof(e->'feature_id') <> 'string' or (e->>'feature_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    or (coalesce(jsonb_typeof(e->'requirement_version_id'), 'null') <> 'null' and (jsonb_typeof(e->'requirement_version_id') <> 'string' or (e->>'requirement_version_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))) then
    return query select 'malformed_report'::text, null::uuid, 0, 0, 0; return;
  end if;
  -- a failure message is a document: no secret value is written into it
  if exists (select 1 from jsonb_array_elements(v_tests) e where coalesce(e->>'failure_message', '') ~* '(api[_-]?key|secret|token|passwd|password|authorization|bearer)["'' ]*[:=]\s*["'']?[A-Za-z0-9_\-\.]{12,}'
       or coalesce(e->>'failure_message', '') ~ '(sk-[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})') then
    return query select 'secret_in_report'::text, null::uuid, 0, 0, 0; return;
  end if;
  -- what a result says it covers belongs to THIS build's project and organization
  if exists (select 1 from jsonb_array_elements(v_tests) e where (e->>'task_id') is not null
       and not exists (select 1 from projects.tasks x where x.id = (e->>'task_id')::uuid and x.organization_id = v_row.organization_id and x.project_id = v_row.project_id))
     or exists (select 1 from jsonb_array_elements(v_tests) e where (e->>'feature_id') is not null
       and not exists (select 1 from projects.features x where x.id = (e->>'feature_id')::uuid and x.organization_id = v_row.organization_id and x.project_id = v_row.project_id))
     or exists (select 1 from jsonb_array_elements(v_tests) e where (e->>'requirement_version_id') is not null
       and not exists (select 1 from crm.requirement_versions x where x.id = (e->>'requirement_version_id')::uuid and x.organization_id = v_row.organization_id)) then
    return query select 'foreign_reference'::text, null::uuid, 0, 0, 0; return;
  end if;
  select count(*) filter (where e->>'status' = 'blocked') into v_blocked from jsonb_array_elements(v_tests) e;
  -- the header, when present, must agree with the tests: counts are computed, never trusted$r$);
  if n = d then raise exception 'ingest_test_report: header anchor not found'; end if;
  d := n;

  n := replace(d, 'failed, skipped, evidence_url, executed_by,', 'failed, skipped, blocked, evidence_url, executed_by,');
  if n = d then raise exception 'ingest_test_report: run column anchor not found'; end if;
  d := n;
  n := replace(d, 'v_failed + v_flaky, v_skipped, p_evidence_url,', 'v_failed + v_flaky, v_skipped, v_blocked, p_evidence_url,');
  if n = d then raise exception 'ingest_test_report: run values anchor not found'; end if;
  d := n;

  n := replace(d, $r$  insert into qa.test_run_cases (organization_id, test_run_id, name, status, retries)
  select v_row.organization_id, v_run, e->>'name', e->>'status', coalesce((e->>'retries')::int, 0) from jsonb_array_elements(v_tests) e;$r$,
$r$  insert into qa.test_run_cases (organization_id, test_run_id, name, status, retries, duration_ms, failure_message, log_ref, task_id, feature_id, requirement_version_id, layer, failure_class)
  select v_row.organization_id, v_run, e->>'name', e->>'status', coalesce((e->>'retries')::int, 0), (e->>'duration_ms')::int, e->>'failure_message', e->>'log_ref',
         (e->>'task_id')::uuid, (e->>'feature_id')::uuid, (e->>'requirement_version_id')::uuid, e->>'layer', e->>'failure_class'
    from jsonb_array_elements(v_tests) e;$r$);
  if n = d then raise exception 'ingest_test_report: case insert anchor not found'; end if;
  d := n;

  execute d;
end $m$;

-- ── 3. a defect's permanent regression test ──────────────────────────────
create table if not exists qa.regression_links (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references core.organizations(id) on delete cascade,
  project_id               uuid not null references projects.projects(id) on delete cascade,
  defect_id                uuid not null references qa.defects(id) on delete restrict,
  defective_deliverable_id uuid references projects.deliverables(id) on delete restrict,
  test_case_name           text not null check (length(btrim(test_case_name)) > 0 and length(test_case_name) <= 300),
  state                    text not null default 'linked' check (state in ('linked', 'verified')),
  fix_deliverable_id       uuid references projects.deliverables(id) on delete restrict,
  verification_run_id      uuid references qa.test_runs(id) on delete restrict,
  verification_evidence    text check (verification_evidence is null or verification_evidence ~ '^https://[^ ]+$'),
  linked_by                uuid references core.users(id) on delete set null,
  verified_at              timestamptz,
  created_at               timestamptz not null default now(),
  unique (defect_id, test_case_name),
  -- "the test fails on the defective build and passes on the fix build": a verified link names the fix build and the run that proves it
  check (state = 'linked' or (fix_deliverable_id is not null and verification_run_id is not null and verified_at is not null)),
  check (fix_deliverable_id is null or fix_deliverable_id is distinct from defective_deliverable_id)
);
alter table qa.regression_links enable row level security;
drop policy if exists regression_links_read on qa.regression_links;
create policy regression_links_read on qa.regression_links for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on qa.regression_links from public, anon;
revoke insert, update, delete on qa.regression_links from authenticated;
grant select on qa.regression_links to authenticated;
grant all on qa.regression_links to service_role;
do $m$
declare r record;
begin
  for r in select * from (values ('project_id', 'projects.projects'), ('defect_id', 'qa.defects'), ('defective_deliverable_id', 'projects.deliverables'),
                                 ('fix_deliverable_id', 'projects.deliverables'), ('verification_run_id', 'qa.test_runs')) as t(col, parent) loop
    execute format('drop trigger if exists %I on qa.regression_links', 'regression_links_parent_org_' || r.col);
    execute format('create trigger %I before insert or update of %I on qa.regression_links for each row execute function core.enforce_parent_org(%L, %L)',
                   'regression_links_parent_org_' || r.col, r.col, r.col, r.parent);
  end loop;
end $m$;
drop trigger if exists freeze_org_regression_links on qa.regression_links;
create trigger freeze_org_regression_links before update of organization_id on qa.regression_links for each row execute function core.freeze_organization_id();

-- a regression test is permanent: a link is never deleted and a verified link is never rewritten
create or replace function qa.regression_links_permanent() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a regression test is permanent: its link is never deleted' using errcode = 'restrict_violation'; end if;
  if old.state = 'verified' then raise exception 'a verified regression link is a record: it is never rewritten' using errcode = 'restrict_violation'; end if;
  return new;
end $$;
drop trigger if exists regression_links_permanent on qa.regression_links;
create trigger regression_links_permanent before update or delete on qa.regression_links for each row execute function qa.regression_links_permanent();

-- link a defect to the automated test that will keep it fixed (a person who can write, or the Test Automation runner)
create or replace function qa.link_regression_test(p_defect_id uuid, p_test_case_name text, p_defective_deliverable_id uuid default null)
returns table (outcome text, link_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_def qa.defects; v_build projects.deliverables; v_id uuid;
begin
  if v_actor is null and not v_service then return query select 'no_actor'::text, null::uuid; return; end if;
  if v_actor is not null and not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_def from qa.defects d where d.id = p_defect_id;
  if v_def.id is null or (v_actor is not null and v_def.organization_id is distinct from (select core.current_organization_id())) then return query select 'not_found'::text, null::uuid; return; end if;
  if p_test_case_name is null or length(btrim(p_test_case_name)) = 0 or length(p_test_case_name) > 300 then return query select 'bad_name'::text, null::uuid; return; end if;
  if p_defective_deliverable_id is not null then
    select * into v_build from projects.deliverables b where b.id = p_defective_deliverable_id;
    if v_build.id is null or v_build.organization_id <> v_def.organization_id or v_build.project_id <> v_def.project_id or v_build.kind <> 'build' then
      return query select 'bad_build'::text, null::uuid; return;
    end if;
  end if;
  insert into qa.regression_links (organization_id, project_id, defect_id, defective_deliverable_id, test_case_name, linked_by)
  values (v_def.organization_id, v_def.project_id, v_def.id, p_defective_deliverable_id, btrim(p_test_case_name), v_actor)
  on conflict (defect_id, test_case_name) do nothing returning id into v_id;
  if v_id is null then
    select l.id into v_id from qa.regression_links l where l.defect_id = v_def.id and l.test_case_name = btrim(p_test_case_name);
    return query select 'already_linked'::text, v_id; return;
  end if;
  return query select 'linked'::text, v_id;
end $$;
revoke all on function qa.link_regression_test(uuid, text, uuid) from public, anon;
grant execute on function qa.link_regression_test(uuid, text, uuid) to authenticated, service_role;

-- the fix build's run is the verification evidence: the named test must have PASSED in a run of that build (never a flaky retry, never a skip)
create or replace function qa.verify_regression_link(p_link_id uuid, p_fix_deliverable_id uuid, p_test_run_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_link qa.regression_links; v_run qa.test_runs;
begin
  if v_actor is null and not v_service then return query select 'no_actor'::text; return; end if;
  if v_actor is not null and not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_link from qa.regression_links l where l.id = p_link_id for update;
  if v_link.id is null or (v_actor is not null and v_link.organization_id is distinct from (select core.current_organization_id())) then return query select 'not_found'::text; return; end if;
  if v_link.state = 'verified' then return query select 'already_verified'::text; return; end if;
  select * into v_run from qa.test_runs r where r.id = p_test_run_id;
  if v_run.id is null or v_run.organization_id <> v_link.organization_id or v_run.project_id <> v_link.project_id then return query select 'not_found'::text; return; end if;
  if v_run.deliverable_id is distinct from p_fix_deliverable_id then return query select 'run_is_for_another_build'::text; return; end if;
  if p_fix_deliverable_id is not distinct from v_link.defective_deliverable_id then return query select 'fix_build_is_the_defective_build'::text; return; end if;
  if not exists (select 1 from qa.test_run_cases c where c.test_run_id = v_run.id and c.name = v_link.test_case_name and c.status = 'passed') then
    return query select 'test_did_not_pass'::text; return;
  end if;
  update qa.regression_links
     set state = 'verified', fix_deliverable_id = p_fix_deliverable_id, verification_run_id = v_run.id, verification_evidence = v_run.evidence_url, verified_at = now()
   where id = v_link.id;
  return query select 'verified'::text;
end $$;
revoke all on function qa.verify_regression_link(uuid, uuid, uuid) from public, anon;
grant execute on function qa.verify_regression_link(uuid, uuid, uuid) to authenticated, service_role;

-- ── 4. acceptance criteria that nothing passing covers ───────────────────
-- A task that states acceptance criteria, whose criteria no passing test covers: either a run linked to the task passed whole, or a passed case
-- names the task. Visible as a gap, never as a silent zero. (Invoker rights: the tables' own internal-only policies decide who sees it.)
create or replace function qa.coverage_gaps(p_project_id uuid)
returns table (task_id uuid, title text, acceptance_criteria text, reason text)
language sql stable set search_path = '' as $$
  select t.id, t.title, t.acceptance_criteria,
         case when exists (select 1 from projects.task_test_evidence e where e.task_id = t.id)
                or exists (select 1 from qa.test_run_cases c where c.task_id = t.id)
              then 'no_passing_test' else 'no_linked_test' end
    from projects.tasks t
   where t.project_id = p_project_id and t.status <> 'cancelled' and t.archived_at is null
     and t.acceptance_criteria is not null and length(btrim(t.acceptance_criteria)) > 0
     and not exists (
       select 1 from projects.task_test_evidence e join qa.test_runs r on r.id = e.test_run_id
        where e.task_id = t.id and r.failed = 0 and r.passed > 0 and coalesce(r.blocked, 0) = 0)
     and not exists (select 1 from qa.test_run_cases c where c.task_id = t.id and c.status = 'passed')
   order by t.title
$$;
revoke all on function qa.coverage_gaps(uuid) from public, anon;
grant execute on function qa.coverage_gaps(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
