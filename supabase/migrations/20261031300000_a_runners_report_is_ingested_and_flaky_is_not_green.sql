-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 Test Automation spec: machine-readable results, "FLAKY != PASS".
--
-- `qa.ingest_test_report` takes a runner's own report ({tests:[{name,status,retries}]}) and writes ONE test run plus one row per test:
--   * counts are computed from the tests, never trusted from a header (a report whose totals disagree is refused);
--   * a test that passed only on a retry (status 'flaky') is counted as FAILED in the run, never green, and is filed as a flaky test;
--   * a runner's report names the evidence it came from (the existing rule for agent-authored runs).
-- A CI runner (service role) or a QA person may ingest; the build tested must be a development build of the caller's organization.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists qa.test_run_cases (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  test_run_id      uuid not null references qa.test_runs(id) on delete cascade,
  name             text not null check (length(btrim(name)) > 0),
  status           text not null check (status in ('passed', 'failed', 'skipped', 'flaky')),
  retries          int not null default 0 check (retries >= 0),
  created_at       timestamptz not null default now(),
  unique (test_run_id, name)
);
alter table qa.test_run_cases enable row level security;
drop policy if exists test_run_cases_read on qa.test_run_cases;
create policy test_run_cases_read on qa.test_run_cases for select to authenticated using (organization_id = (select core.current_organization_id()));
grant select on qa.test_run_cases to authenticated;
grant all on qa.test_run_cases to service_role;
drop trigger if exists test_run_cases_parent_org_test_run_id on qa.test_run_cases;
create trigger test_run_cases_parent_org_test_run_id before insert or update of test_run_id on qa.test_run_cases for each row execute function core.enforce_parent_org('test_run_id', 'qa.test_runs');
drop trigger if exists freeze_org_test_run_cases on qa.test_run_cases;
create trigger freeze_org_test_run_cases before update of organization_id on qa.test_run_cases for each row execute function core.freeze_organization_id();

create or replace function qa.ingest_test_report(p_deliverable_id uuid, p_suite text, p_report jsonb, p_evidence_url text default null)
returns table (outcome text, run_id uuid, passed int, failed int, flaky int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_row projects.deliverables;
  v_tests jsonb;
  v_passed int; v_failed int; v_skipped int; v_flaky int; v_total int;
  v_run uuid;
  t record;
begin
  if v_actor is null and not v_service then return query select 'no_actor'::text, null::uuid, 0, 0, 0; return; end if;
  if v_actor is not null and not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid, 0, 0, 0; return; end if;
  if p_suite not in ('functional', 'ui', 'api', 'integration', 'e2e', 'regression', 'smoke', 'security', 'performance', 'compatibility') then
    return query select 'bad_suite'::text, null::uuid, 0, 0, 0; return;
  end if;
  select * into v_row from projects.deliverables d where d.id = p_deliverable_id;
  if v_row.id is null or (v_actor is not null and v_row.organization_id is distinct from (select core.current_organization_id())) then
    return query select 'not_found'::text, null::uuid, 0, 0, 0; return;
  end if;
  if v_row.kind <> 'build' then return query select 'not_a_build'::text, null::uuid, 0, 0, 0; return; end if;
  -- a runner's report names where it came from
  if v_actor is null and (p_evidence_url is null or length(btrim(p_evidence_url)) = 0 or p_evidence_url !~ '^https://') then
    return query select 'evidence_required'::text, null::uuid, 0, 0, 0; return;
  end if;

  if p_report is null or jsonb_typeof(p_report) <> 'object' or jsonb_typeof(p_report->'tests') <> 'array' or jsonb_array_length(p_report->'tests') = 0 then
    return query select 'empty_report'::text, null::uuid, 0, 0, 0; return;
  end if;
  v_tests := p_report->'tests';
  if exists (select 1 from jsonb_array_elements(v_tests) e where jsonb_typeof(e) <> 'object' or coalesce(btrim(e->>'name'), '') = '' or (e->>'status') not in ('passed', 'failed', 'skipped', 'flaky')) then
    return query select 'malformed_report'::text, null::uuid, 0, 0, 0; return;
  end if;
  if (select count(distinct e->>'name') from jsonb_array_elements(v_tests) e) <> jsonb_array_length(v_tests) then
    return query select 'duplicate_test_names'::text, null::uuid, 0, 0, 0; return;
  end if;

  select count(*) filter (where e->>'status' = 'passed'), count(*) filter (where e->>'status' = 'failed'),
         count(*) filter (where e->>'status' = 'skipped'), count(*) filter (where e->>'status' = 'flaky'), count(*)
    into v_passed, v_failed, v_skipped, v_flaky, v_total
    from jsonb_array_elements(v_tests) e;
  -- the header, when present, must agree with the tests: counts are computed, never trusted
  if p_report ? 'total' and (p_report->>'total')::int is distinct from v_total then
    return query select 'inconsistent_report'::text, null::uuid, 0, 0, 0; return;
  end if;

  -- FLAKY != PASS: a test that only passed on a retry is a FAILURE of this run
  insert into qa.test_runs (organization_id, project_id, deliverable_id, suite, total, passed, failed, skipped, evidence_url, executed_by, executed_by_agent, status, ended_at)
  values (v_row.organization_id, v_row.project_id, v_row.id, p_suite, v_total, v_passed, v_failed + v_flaky, v_skipped, p_evidence_url,
          v_actor, case when v_actor is null then 'test_automation' else null end, 'closed', now())
  returning id into v_run;

  insert into qa.test_run_cases (organization_id, test_run_id, name, status, retries)
  select v_row.organization_id, v_run, e->>'name', e->>'status', coalesce((e->>'retries')::int, 0) from jsonb_array_elements(v_tests) e;

  -- every flaky test is filed (or counted again) for an owner to quarantine or fix
  for t in select e->>'name' as name from jsonb_array_elements(v_tests) e where e->>'status' = 'flaky' loop
    perform qa.record_flaky_test(v_row.project_id, t.name, p_suite, 'passed only on retry in an ingested report');
  end loop;

  return query select 'ingested'::text, v_run, v_passed, v_failed + v_flaky, v_flaky;
end $$;
revoke all on function qa.ingest_test_report(uuid, text, jsonb, text) from public, anon;
grant execute on function qa.ingest_test_report(uuid, text, jsonb, text) to authenticated, service_role;

notify pgrst, 'reload schema';
