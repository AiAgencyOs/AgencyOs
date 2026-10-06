-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 Test Automation + Integration specs: a test result carries its evidence and its failure class (an UNKNOWN cause is never a pass, a blocked
-- test is its own state), an escaped defect has a permanent regression test linked to the defective and the fixed build, an acceptance criterion
-- nothing passing covers is a visible gap; every integration check is a logged fact, an integration failure blocks ONLY the tasks that depend on
-- it and they resume when it verifies again; the Test Automation and Documentation agents can leave drafts and nothing else.
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase5-test-integration.sql      (rolls back)
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAILED: %', what; end if; raise notice 'ok  %', what; end $$;
grant execute on function pg_temp.check(boolean, text) to public;
create or replace function pg_temp.as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
  'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true); end $$;
grant execute on function pg_temp.as_user(uuid, uuid, text) to public;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true); end $$;
grant execute on function pg_temp.as_service() to public;
-- a statement that must be refused by a guard or a constraint, and the refusal must name what it should
create or replace function pg_temp.refused(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when restrict_violation or check_violation then return position(needle in sqlerrm) > 0; end $$;
grant execute on function pg_temp.refused(text, text) to public;
-- a statement the caller has no privilege to run at all
create or replace function pg_temp.denied(stmt text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when insufficient_privilege then return true; end $$;
grant execute on function pg_temp.denied(text) to public;
-- a task's status, by id
create or replace function pg_temp.task_status(p_id uuid) returns text language sql as $$ select status from projects.tasks where id = p_id $$;
grant execute on function pg_temp.task_status(uuid) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000000b7'
\set U '00000000-0000-4000-8000-00000000f571'
\set RO '00000000-0000-4000-8000-00000000f572'
\set UB '00000000-0000-4000-8000-00000000f573'
insert into core.organizations (id, name, slug) values (:'ORGB', 'P5TI Other Agency', 'p5ti-other-agency') on conflict do nothing;
insert into auth.users (id, email) values (:'U', 'p5ti-member@example.test'), (:'RO', 'p5ti-contractor@example.test'), (:'UB', 'p5ti-b@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'U', 'p5ti-member@example.test', 'P5TI Member'), (:'RO', 'p5ti-contractor@example.test', 'P5TI Contractor'), (:'UB', 'p5ti-b@example.test', 'P5TI B') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'U', 'member'), (:'ORG', :'RO', 'contractor'), (:'ORGB', :'UB', 'owner') on conflict do nothing;
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p5ti client') returning id \gset A_
insert into core.client_accounts (organization_id, name) values (:'ORGB', 'zztest p5ti client b') returning id \gset AB_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p5ti', 'ZP5-TI') returning id \gset P_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORGB', :'AB_id', 'zztest p5ti other', 'ZP5-TIB') returning id \gset PB_
insert into projects.deliverables (organization_id, project_id, kind, version, title) values (:'ORG', :'P_id', 'build', 1, 'zztest defective build') returning id \gset D1_
insert into projects.deliverables (organization_id, project_id, kind, version, title) values (:'ORG', :'P_id', 'build', 2, 'zztest fix build') returning id \gset D2_
insert into projects.deliverables (organization_id, project_id, kind, version, title) values (:'ORGB', :'PB_id', 'build', 1, 'zztest other build') returning id \gset DB_
insert into projects.modules (organization_id, project_id, name) values (:'ORG', :'P_id', 'zztest p5ti module') returning id \gset MOD_
insert into projects.features (organization_id, project_id, module_id, name) values (:'ORG', :'P_id', :'MOD_id', 'zztest checkout') returning id \gset FEAT_
insert into projects.tasks (organization_id, project_id, title, status, acceptance_criteria) values (:'ORG', :'P_id', 'zztest t1 pay', 'todo', 'the customer can pay by card') returning id \gset T1_
insert into projects.tasks (organization_id, project_id, title, status, acceptance_criteria) values (:'ORG', :'P_id', 'zztest t2 refund', 'todo', 'a refund returns the money') returning id \gset T2_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORG', :'P_id', 'zztest t3 no criteria', 'todo') returning id \gset T3_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORG', :'P_id', 'zztest t4 unrelated', 'in_progress') returning id \gset T4_
insert into projects.tasks (organization_id, project_id, title, status, acceptance_criteria) values (:'ORG', :'P_id', 'zztest t5 nothing links it', 'todo', 'an invoice is emailed') returning id \gset T5_
insert into projects.tasks (organization_id, project_id, title, status, acceptance_criteria) values (:'ORG', :'P_id', 'zztest t5b cancelled', 'cancelled', 'a cancelled task needs no test') returning id \gset T5B_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORG', :'P_id', 'zztest t6 maps', 'todo') returning id \gset T6_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORG', :'P_id', 'zztest t7 whatsapp in progress', 'in_progress') returning id \gset T7_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORG', :'P_id', 'zztest t8 whatsapp done', 'done') returning id \gset T8_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORG', :'P_id', 'zztest t9 whatsapp already blocked', 'blocked') returning id \gset T9_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORG', :'P_id', 'zztest t10 both', 'in_review') returning id \gset T10_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORG', :'P_id', 'zztest t11 late dependency', 'todo') returning id \gset T11_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORGB', :'PB_id', 'zztest other org task', 'todo') returning id \gset TB_
insert into qa.defects (organization_id, project_id, deliverable_id, severity, title, reproduction, reported_by)
  values (:'ORG', :'P_id', :'D1_id', 'major', 'checkout crashes on pay', 'tap pay', :'U') returning id \gset X_

-- @@MUTATE@@

-- ═════════ 1. the result row: metadata, failure class, a blocked state ═════════
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from qa.ingest_test_report(:'D1_id', 'functional', '{"tests":[{"name":"legacy.a","status":"passed"},{"name":"legacy.b","status":"flaky","retries":1}]}', 'https://ci.example.test/legacy')) = 'ingested', 'a report with none of the new fields still ingests (every existing outcome name works)');
select pg_temp.check((select outcome from qa.ingest_test_report(:'D1_id', 'functional', '{"tests":[{"name":"legacy.a","status":"passed"},{"name":"legacy.b","status":"flaky","retries":1}]}', 'https://ci.example.test/legacy')) = 'already_ingested', 'a redelivered report is still answered with the run it made');
select pg_temp.check((select outcome from qa.ingest_test_report(:'D1_id', 'functional', '{"tests":[{"name":"a","status":"mostly"}]}', 'https://ci.example.test/x')) = 'malformed_report', 'an unknown status is still refused');
select pg_temp.check((select outcome from qa.ingest_test_report(:'D1_id', 'functional', '{"tests":[]}', 'https://ci.example.test/x')) = 'empty_report', 'an empty report is still refused');

select pg_temp.check((select outcome from qa.ingest_test_report(:'D1_id', 'api', '{"tests":[{"name":"a","status":"passed","failure_class":"UNKNOWN"}]}', 'https://ci.example.test/x')) = 'unknown_cannot_pass', 'an UNKNOWN failure class on a test counted as a pass is refused');
select pg_temp.check((select outcome from qa.ingest_test_report(:'D1_id', 'api', '{"tests":[{"name":"a","status":"passed","failure_class":"PRODUCT_DEFECT"}]}', 'https://ci.example.test/x')) = 'malformed_report', 'any failure class on a pass is contradictory and refused');
select pg_temp.check((select outcome from qa.ingest_test_report(:'D1_id', 'api', '{"tests":[{"name":"a","status":"failed","failure_class":"WHATEVER"}]}', 'https://ci.example.test/x')) = 'malformed_report', 'a class outside the closed set is refused');
select pg_temp.check((select outcome from qa.ingest_test_report(:'D1_id', 'api', '{"tests":[{"name":"a","status":"blocked"}]}', 'https://ci.example.test/x')) = 'malformed_report', 'a BLOCKED test says what blocked it');
select pg_temp.check((select outcome from qa.ingest_test_report(:'D1_id', 'api', '{"tests":[{"name":"a","status":"passed","duration_ms":-5}]}', 'https://ci.example.test/x')) = 'malformed_report', 'a negative duration is refused');
select pg_temp.check((select outcome from qa.ingest_test_report(:'D1_id', 'api', '{"tests":[{"name":"a","status":"failed","log_ref":"http://insecure.example.test/log"}]}', 'https://ci.example.test/x')) = 'malformed_report', 'a log reference is https');
select pg_temp.check((select outcome from qa.ingest_test_report(:'D1_id', 'api', '{"tests":[{"name":"a","status":"passed","layer":"astral"}]}', 'https://ci.example.test/x')) = 'malformed_report', 'a layer outside the closed set is refused');
select pg_temp.check((select outcome from qa.ingest_test_report(:'D1_id', 'api', jsonb_build_object('tests', jsonb_build_array(jsonb_build_object('name', 'a', 'status', 'failed', 'failure_message', repeat('x', 5000)))), 'https://ci.example.test/x')) = 'malformed_report', 'a failure message is length-capped');
select pg_temp.check((select outcome from qa.ingest_test_report(:'D1_id', 'api', jsonb_build_object('tests', jsonb_build_array(jsonb_build_object('name', 'a', 'status', 'failed', 'failure_message', 'config api_key=' || repeat('a', 20)))), 'https://ci.example.test/x')) = 'secret_in_report', 'a secret value in a failure message is refused');
select pg_temp.check((select outcome from qa.ingest_test_report(:'D1_id', 'api', jsonb_build_object('tests', jsonb_build_array(jsonb_build_object('name', 'a', 'status', 'failed', 'task_id', 'not-a-uuid'))), 'https://ci.example.test/x')) = 'malformed_report', 'a task reference that is not an id is refused');
select pg_temp.check((select outcome from qa.ingest_test_report(:'D1_id', 'api', jsonb_build_object('tests', jsonb_build_array(jsonb_build_object('name', 'a', 'status', 'failed', 'task_id', :'TB_id'))), 'https://ci.example.test/x')) = 'foreign_reference', 'a task of ANOTHER organization cannot be what a result covers');
select pg_temp.check((select outcome from qa.ingest_test_report(:'D1_id', 'api', jsonb_build_object('tests', jsonb_build_array(jsonb_build_object('name', 'a', 'status', 'failed', 'feature_id', gen_random_uuid()))), 'https://ci.example.test/x')) = 'foreign_reference', 'a feature that does not exist is refused');
select pg_temp.check((select outcome from qa.ingest_test_report(:'D1_id', 'api', jsonb_build_object('tests', jsonb_build_array(jsonb_build_object('name', 'a', 'status', 'failed', 'requirement_version_id', gen_random_uuid()))), 'https://ci.example.test/x')) = 'foreign_reference', 'a requirement version that does not exist is refused');
select pg_temp.check((select count(*) from qa.test_runs where deliverable_id = :'D1_id' and suite = 'api') = 0, 'a refused report leaves no run behind');

-- the rich report, on the DEFECTIVE build
select outcome as o, run_id as r, passed as p, failed as f, flaky as k from qa.ingest_test_report(:'D1_id', 'regression', jsonb_build_object('total', 6, 'tests', jsonb_build_array(
  jsonb_build_object('name', 'pay.card', 'status', 'passed', 'duration_ms', 120, 'layer', 'api', 'task_id', :'T1_id'),
  jsonb_build_object('name', 'refund.full', 'status', 'failed', 'duration_ms', 340, 'failure_message', 'expected 200 got 500', 'log_ref', 'https://ci.example.test/logs/refund', 'failure_class', 'PRODUCT_DEFECT', 'task_id', :'T2_id', 'feature_id', :'FEAT_id', 'layer', 'e2e'),
  jsonb_build_object('name', 'device.farm', 'status', 'blocked', 'failure_message', 'device farm offline', 'failure_class', 'ENVIRONMENT_FAILURE'),
  jsonb_build_object('name', 'slow.query', 'status', 'flaky', 'retries', 2, 'failure_class', 'TEST_DEFECT'),
  jsonb_build_object('name', 'mystery', 'status', 'failed', 'failure_class', 'UNKNOWN'),
  jsonb_build_object('name', 'skipme', 'status', 'skipped'))), 'https://ci.example.test/rich-d1') \gset RICH_
select pg_temp.check(:'RICH_o' = 'ingested' and :'RICH_p'::int = 1 and :'RICH_f'::int = 3 and :'RICH_k'::int = 1, 'the rich report ingests: 1 passed; failed, flaky and UNKNOWN count against it (3 failed of which 1 flaky)');
select pg_temp.check((select total = 6 and passed = 1 and failed = 3 and skipped = 1 and blocked = 1 from qa.test_runs where id = :'RICH_r'), 'the run counts BLOCKED as its own column and the totals add up');
select pg_temp.check((select duration_ms = 340 and failure_message = 'expected 200 got 500' and log_ref = 'https://ci.example.test/logs/refund' and failure_class = 'PRODUCT_DEFECT' and task_id = :'T2_id' and feature_id = :'FEAT_id' and layer = 'e2e'
                        from qa.test_run_cases where test_run_id = :'RICH_r' and name = 'refund.full'), 'duration, failure message, log, class, refs and layer are stored on the case');
select pg_temp.check((select status = 'blocked' and failure_class = 'ENVIRONMENT_FAILURE' from qa.test_run_cases where test_run_id = :'RICH_r' and name = 'device.farm'), 'a blocked case is stored as blocked with its class');
select pg_temp.check((select status = 'failed' and failure_class = 'UNKNOWN' from qa.test_run_cases where test_run_id = :'RICH_r' and name = 'mystery'), 'an UNKNOWN cause is a failure awaiting triage, never a pass');
reset role;

-- coverage gaps, before the fix build exists: what has a passing test, what only a failing one, what nothing
select pg_temp.as_user(:'U', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from qa.coverage_gaps(:'P_id') where task_id = :'T1_id') = 0, 'T1 has a passing test (pay.card): covered');
select pg_temp.check((select reason from qa.coverage_gaps(:'P_id') where task_id = :'T2_id') = 'no_passing_test', 'T2 has a test but it FAILED: a gap, "no passing test"');
select pg_temp.check((select reason from qa.coverage_gaps(:'P_id') where task_id = :'T5_id') = 'no_linked_test', 'T5 has nothing linked at all: a gap, "no linked test"');
select pg_temp.check((select count(*) from qa.coverage_gaps(:'P_id')) = 2, 'tasks with no acceptance criteria and cancelled tasks are not gaps: exactly T2 and T5');
reset role;

-- the table itself holds the same lines
select pg_temp.check(pg_temp.refused(format('insert into qa.test_run_cases (organization_id, test_run_id, name, status, failure_class) values (%L, %L, ''direct.pass'', ''passed'', ''UNKNOWN'')', :'ORG', :'RICH_r'), 'test_run_cases_class_is_a_failure'), 'a direct write cannot make an UNKNOWN class a pass either');
select pg_temp.check(pg_temp.refused(format('insert into qa.test_run_cases (organization_id, test_run_id, name, status) values (%L, %L, ''direct.blocked'', ''blocked'')', :'ORG', :'RICH_r'), 'test_run_cases_blocked_says_why'), 'a direct blocked case without a reason is refused');
select pg_temp.check(pg_temp.refused(format('insert into qa.test_run_cases (organization_id, test_run_id, name, status, task_id) values (%L, %L, ''direct.foreign'', ''failed'', %L)', :'ORG', :'RICH_r', :'TB_id'), 'tenancy'), 'a case naming another organization''s task is refused by the tenancy guard');
select pg_temp.as_user(:'U', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(pg_temp.denied(format('insert into qa.test_run_cases (organization_id, test_run_id, name, status) values (%L, %L, ''person.write'', ''passed'')', :'ORG', :'RICH_r')), 'a signed-in person cannot write a result row');
select pg_temp.check((select count(*) from qa.test_run_cases where test_run_id = :'RICH_r') = 6, 'staff read the cases');
reset role;
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from qa.test_run_cases) = 0, 'another organization sees none of them');
reset role;

-- ═════════ 2. regression links and coverage gaps ═════════
select pg_temp.as_user(:'U', :'ORG', 'member');
set local role authenticated;
select outcome as o, link_id as l from qa.link_regression_test(:'X_id', 'checkout.pay regression', :'D1_id') \gset LNK_
select pg_temp.check(:'LNK_o' = 'linked', 'a defect is linked to the test that will keep it fixed');
select pg_temp.check((select outcome from qa.link_regression_test(:'X_id', 'checkout.pay regression', :'D1_id')) = 'already_linked', 'linking twice links once');
select pg_temp.check((select outcome from qa.link_regression_test(:'X_id', '   ', :'D1_id')) = 'bad_name', 'a link names its test');
select pg_temp.check((select outcome from qa.link_regression_test(:'X_id', 'other', :'DB_id')) = 'bad_build', 'the defective build must be a build of the same project');
select pg_temp.check((select outcome from qa.link_regression_test(gen_random_uuid(), 'other', null)) = 'not_found', 'an unknown defect is not found');
select pg_temp.check((select state = 'linked' and fix_deliverable_id is null from qa.regression_links where id = :'LNK_l'), 'a new link is linked, not verified');
reset role;
select pg_temp.as_user(:'RO', :'ORG', 'contractor');
set local role authenticated;
select pg_temp.check((select outcome from qa.link_regression_test(:'X_id', 'contractor.attempt', null)) = 'not_authorized', 'a person who cannot write cannot link');
reset role;
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from qa.link_regression_test(:'X_id', 'other.org', null)) = 'not_found', 'another organization''s defect is not found');
select pg_temp.check((select count(*) from qa.regression_links) = 0, 'and its links are not visible');
reset role;

-- runs of the fix build: the test passes in one, fails in another, is flaky in a third
select pg_temp.as_service();
set local role service_role;
select run_id as r from qa.ingest_test_report(:'D1_id', 'regression', '{"tests":[{"name":"checkout.pay regression","status":"passed"}]}', 'https://ci.example.test/reg-d1-pass') \gset RD1_
select run_id as r from qa.ingest_test_report(:'D2_id', 'regression', '{"tests":[{"name":"checkout.pay regression","status":"failed","failure_class":"PRODUCT_DEFECT"}]}', 'https://ci.example.test/reg-d2-fail') \gset RD2F_
select run_id as r from qa.ingest_test_report(:'D2_id', 'smoke', '{"tests":[{"name":"checkout.pay regression","status":"flaky","retries":1}]}', 'https://ci.example.test/reg-d2-flaky') \gset RD2K_
select run_id as r from qa.ingest_test_report(:'D2_id', 'functional', jsonb_build_object('tests', jsonb_build_array(
  jsonb_build_object('name', 'checkout.pay regression', 'status', 'passed', 'layer', 'e2e'),
  jsonb_build_object('name', 'refund.full', 'status', 'passed', 'task_id', :'T2_id'))), 'https://ci.example.test/reg-d2-pass') \gset RD2P_
select pg_temp.check((select outcome from qa.verify_regression_link(:'LNK_l', :'D2_id', :'RD1_r')) = 'run_is_for_another_build', 'a run of another build is not evidence that the FIX build passes');
select pg_temp.check((select outcome from qa.verify_regression_link(:'LNK_l', :'D1_id', :'RD1_r')) = 'fix_build_is_the_defective_build', 'the fix build is not the defective build');
select pg_temp.check((select outcome from qa.verify_regression_link(:'LNK_l', :'D2_id', :'RD2F_r')) = 'test_did_not_pass', 'a run in which the test FAILED does not verify the fix');
select pg_temp.check((select outcome from qa.verify_regression_link(:'LNK_l', :'D2_id', :'RD2K_r')) = 'test_did_not_pass', 'a run in which the test was only FLAKY does not verify the fix');
select pg_temp.check((select state from qa.regression_links where id = :'LNK_l') = 'linked', 'none of those moved the link');
select pg_temp.check((select outcome from qa.verify_regression_link(:'LNK_l', :'D2_id', :'RD2P_r')) = 'verified', 'the fix build''s passing run verifies the link');
select pg_temp.check((select outcome from qa.verify_regression_link(:'LNK_l', :'D2_id', :'RD2P_r')) = 'already_verified', 'a verified link is verified once');
reset role;
select pg_temp.check((select state = 'verified' and fix_deliverable_id = :'D2_id' and verification_run_id = :'RD2P_r' and verification_evidence = 'https://ci.example.test/reg-d2-pass' and defective_deliverable_id = :'D1_id' from qa.regression_links where id = :'LNK_l'), 'the link names the defective build, the fix build, the run and its evidence');
select pg_temp.check(pg_temp.refused(format('update qa.regression_links set test_case_name = ''renamed'' where id = %L', :'LNK_l'), 'never rewritten'), 'a verified link is never rewritten');
select pg_temp.check(pg_temp.refused(format('delete from qa.regression_links where id = %L', :'LNK_l'), 'permanent'), 'a regression test is permanent: its link is never deleted');
insert into qa.regression_links (organization_id, project_id, defect_id, test_case_name) values (:'ORG', :'P_id', :'X_id', 'second.link') returning id \gset L2_
select pg_temp.check(pg_temp.refused(format('update qa.regression_links set state = ''verified'' where id = %L', :'L2_id'), 'regression_links_check'), 'a link cannot be marked verified without the fix build and the run');

select pg_temp.as_user(:'U', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from qa.coverage_gaps(:'P_id') where task_id = :'T2_id') = 0, 'T2 (refund) now has a passing test (from the fix build), so it is no longer a gap');
select pg_temp.check((select reason from qa.coverage_gaps(:'P_id') where task_id = :'T5_id') = 'no_linked_test', 'T5 is still a gap: nothing is linked to it');
select pg_temp.check((select outcome from projects.link_task_test_run(:'T5_id', :'RICH_r')) = 'linked', 'a person links a run to T5 through the existing door: the run had failures');
select pg_temp.check((select reason from qa.coverage_gaps(:'P_id') where task_id = :'T5_id') = 'no_passing_test', 'a linked run that did not pass whole does not cover the criterion: still a gap');
select pg_temp.check((select outcome from projects.link_task_test_run(:'T5_id', :'RD2P_r')) = 'linked', 'a clean run of the fix build is linked too');
select pg_temp.check((select count(*) from qa.coverage_gaps(:'P_id') where task_id = :'T5_id') = 0, 'a linked run that passed whole covers the criterion too');
select pg_temp.check((select count(*) from qa.coverage_gaps(:'P_id')) = 0, 'no acceptance criterion is left without a passing test');
reset role;

-- ═════════ 3. integration observability and failure isolation ═════════
select pg_temp.as_user(:'U', :'ORG', 'member');
set local role authenticated;
select connection_id as c from projects.register_integration(:'P_id', 'whatsapp', 'WhatsApp Business') \gset W_
select connection_id as c from projects.register_integration(:'P_id', 'maps', 'Maps API') \gset M_
select connection_id as c from projects.register_integration(:'P_id', 'storage', 'Object storage') \gset G_
select pg_temp.check((select outcome from projects.set_integration_state(:'W_c', 'configured')) = 'set', 'WhatsApp is configured');
select pg_temp.check((select outcome from projects.set_integration_state(:'M_c', 'configured')) = 'set', 'Maps is configured');
select pg_temp.check((select outcome from projects.depend_task_on_integration(:'T1_id', :'W_c')) = 'recorded', 'T1 depends on WhatsApp');
select pg_temp.check((select outcome from projects.depend_task_on_integration(:'T1_id', :'W_c')) = 'already_depends', 'a dependency is recorded once');
select pg_temp.check((select outcome from projects.depend_task_on_integration(:'T7_id', :'W_c')) = 'recorded', 'T7 (in progress) depends on WhatsApp');
select pg_temp.check((select outcome from projects.depend_task_on_integration(:'T8_id', :'W_c')) = 'recorded', 'T8 (done) depends on WhatsApp');
select pg_temp.check((select outcome from projects.depend_task_on_integration(:'T9_id', :'W_c')) = 'recorded', 'T9 (already blocked by a person) depends on WhatsApp');
select pg_temp.check((select outcome from projects.depend_task_on_integration(:'T6_id', :'M_c')) = 'recorded', 'T6 depends on Maps');
select pg_temp.check((select outcome from projects.depend_task_on_integration(:'T10_id', :'W_c')) = 'recorded', 'T10 depends on WhatsApp...');
select pg_temp.check((select outcome from projects.depend_task_on_integration(:'T10_id', :'M_c')) = 'recorded', '...and on Maps');
select pg_temp.check((select outcome from projects.depend_task_on_integration(:'TB_id', :'W_c')) = 'not_found', 'another organization''s task cannot be made to depend on this integration');
select pg_temp.check(pg_temp.denied(format('insert into projects.task_integration_dependencies (organization_id, project_id, task_id, connection_id) values (%L, %L, %L, %L)', :'ORG', :'P_id', :'T4_id', :'W_c')), 'a dependency is written through the door only');
reset role;
select pg_temp.as_user(:'RO', :'ORG', 'contractor');
set local role authenticated;
select pg_temp.check((select outcome from projects.depend_task_on_integration(:'T4_id', :'W_c')) = 'not_authorized', 'a person who cannot write cannot declare a dependency');
reset role;

-- the log: append-only, written by the adapter runner only
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.log_integration_check(:'W_c', 'ok', 200, 100)) = 'noted', 'an ok check is logged with its status and latency');
select pg_temp.check((select outcome from projects.log_integration_check(:'W_c', 'ok', 200, 300)) = 'noted', 'another ok check');
select pg_temp.check((select outcome from projects.log_integration_check(:'W_c', 'server_error', 503, 50)) = 'noted', 'a server error is logged');
select pg_temp.check((select outcome from projects.log_integration_check(:'W_c', 'timeout')) = 'noted', 'a timeout is logged without a status');
select pg_temp.check((select outcome from projects.log_integration_check(:'W_c', 'no_target')) = 'noted', 'a check that asked nothing of the provider is logged');
select pg_temp.check((select outcome from projects.log_integration_check(:'W_c', 'banana')) = 'bad_class', 'an unknown class is refused');
select pg_temp.check((select outcome from projects.log_integration_check(:'W_c', 'ok', 999, 1)) = 'bad_measure', 'an impossible HTTP status is refused');
select pg_temp.check((select outcome from projects.log_integration_check(gen_random_uuid(), 'ok')) = 'not_found', 'an unknown connection is not found');
select pg_temp.check((select outcome from projects.note_integration_check(:'W_c', 'ok')) = 'noted', 'the existing note door still answers noted...');
reset role;
select pg_temp.check((select count(*) from projects.integration_check_log where connection_id = :'W_c') = 6, '...and what it noted is in the log too (6 rows)');
select pg_temp.check((select last_check_class from projects.integration_connections where id = :'W_c') = 'ok', 'the connection keeps its last-check summary');
select pg_temp.check(pg_temp.refused(format('update projects.integration_check_log set check_class = ''ok'' where connection_id = %L', :'W_c'), 'never rewritten'), 'a logged check is never rewritten');
select pg_temp.as_user(:'U', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(pg_temp.denied(format('select projects.log_integration_check(%L, ''ok'')', :'W_c')), 'a signed-in person cannot write the check log');
select pg_temp.check(pg_temp.denied(format('insert into projects.integration_check_log (organization_id, project_id, connection_id, check_class) values (%L, %L, %L, ''ok'')', :'ORG', :'P_id', :'W_c')), 'nor insert into it');
select pg_temp.check((select count(*) from projects.integration_check_log) = 6, 'staff read the log');
select checks_counted as n, error_rate as er, last_failure_class as fc, last_success_at is not null as ls, avg_latency_ms as al from projects.integration_observability(:'P_id', 20) where connection_id = :'W_c' \gset OBS_
select pg_temp.check(:'OBS_n'::int = 5 and :'OBS_er'::numeric = 0.4 and :'OBS_fc' = 'timeout' and :'OBS_ls' = 't', 'staff read: 5 counted checks (the no_target one is not a provider failure), 40% errors, last failure timeout, a last success');
select pg_temp.check(:'OBS_al'::int = 150, 'the average latency ignores a check that has none ((100+300+50)/3 = 150)');
select checks_counted as n, error_rate as er from projects.integration_observability(:'P_id', 2) where connection_id = :'W_c' \gset OBS2_
select pg_temp.check(:'OBS2_n'::int = 2 and :'OBS2_er'::numeric = 0.5, 'the error rate is over the LAST N counted checks (the timeout and the later ok: 50%)');
select pg_temp.check((select checks_counted from projects.integration_observability(:'P_id', 20) where connection_id = :'G_c') = 0 and (select error_rate is null from projects.integration_observability(:'P_id', 20) where connection_id = :'G_c'), 'an integration never checked has no rate, not a 0%');
reset role;
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.integration_check_log) = 0 and (select count(*) from projects.task_integration_dependencies) = 0, 'another organization sees neither the log nor the dependencies');
reset role;

-- verified, then it fails: ONLY the dependents of WhatsApp are blocked
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_integration_check(:'W_c', 'whatsapp-adapter', true, 'delivered test message')) = 'verified', 'the adapter verifies WhatsApp');
select pg_temp.check((select outcome from projects.record_integration_check(:'M_c', 'maps-adapter', true, 'geocode ok')) = 'verified', 'and Maps');
reset role;
select pg_temp.check(pg_temp.task_status(:'T1_id') = 'todo' and pg_temp.task_status(:'T7_id') = 'in_progress', 'while it is verified nothing is blocked');
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_integration_check(:'W_c', 'whatsapp-adapter', false, 'HTTP 503 from provider')) = 'degraded', 'WhatsApp degrades');
reset role;
select pg_temp.check(pg_temp.task_status(:'T1_id') = 'blocked' and pg_temp.task_status(:'T7_id') = 'blocked' and pg_temp.task_status(:'T10_id') = 'blocked', 'every task that depends on WhatsApp and was open is BLOCKED');
select pg_temp.check((select blocker_type = 'external_service' and blocked_reason like '%WhatsApp Business is degraded%' from projects.tasks where id = :'T1_id'), 'the block says what is wrong and names the integration');
select pg_temp.check(pg_temp.task_status(:'T8_id') = 'done', 'a finished task is not reopened');
select pg_temp.check(pg_temp.task_status(:'T9_id') = 'blocked', 'a task a person had blocked stays as it was');
select pg_temp.check(pg_temp.task_status(:'T6_id') = 'todo' and pg_temp.task_status(:'T4_id') = 'in_progress' and pg_temp.task_status(:'T3_id') = 'todo' and pg_temp.task_status(:'T2_id') = 'todo', 'tasks that do not depend on WhatsApp are untouched (Maps''s dependent, unrelated and criteria tasks)');
select pg_temp.check(pg_temp.task_status(:'TB_id') = 'todo', 'another organization''s task is untouched');
select pg_temp.check((select count(*) from projects.task_integration_dependencies where connection_id = :'W_c' and held) = 5, 'five dependencies are held (T1, T7, T8, T9, T10)');
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_integration_check(:'W_c', 'whatsapp-adapter', true, 'delivered test message 2')) = 'verified', 'WhatsApp verifies again');
reset role;
select pg_temp.check(pg_temp.task_status(:'T1_id') = 'todo' and pg_temp.task_status(:'T7_id') = 'in_progress' and pg_temp.task_status(:'T10_id') = 'in_progress', 'its dependents are back to the status they had (a task that was in review resumes as in progress)');
select pg_temp.check(pg_temp.task_status(:'T9_id') = 'blocked' and pg_temp.task_status(:'T8_id') = 'done', 'the person''s own block and the finished task are as they were');
select pg_temp.check((select blocked_reason is null and blocker_type is null from projects.tasks where id = :'T1_id'), 'the block''s reason is cleared with it');
select pg_temp.check((select count(*) from projects.task_integration_dependencies where held) = 0, 'no dependency is held any more');

-- two integrations hold one task: it resumes only when BOTH are verified
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_integration_check(:'W_c', 'whatsapp-adapter', false, 'outage')) = 'degraded', 'WhatsApp degrades again');
select pg_temp.check((select outcome from projects.record_integration_check(:'M_c', 'maps-adapter', false, 'quota exhausted')) = 'degraded', 'and Maps degrades');
reset role;
select pg_temp.check(pg_temp.task_status(:'T10_id') = 'blocked' and pg_temp.task_status(:'T6_id') = 'blocked', 'T10 (both) and T6 (Maps) are blocked');
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_integration_check(:'W_c', 'whatsapp-adapter', true, 'recovered')) = 'verified', 'WhatsApp recovers first');
reset role;
select pg_temp.check(pg_temp.task_status(:'T10_id') = 'blocked', 'T10 stays blocked: Maps still holds it');
select pg_temp.check(pg_temp.task_status(:'T1_id') = 'todo', 'T1, which only needed WhatsApp, resumes');
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_integration_check(:'M_c', 'maps-adapter', true, 'recovered')) = 'verified', 'Maps recovers');
reset role;
select pg_temp.check(pg_temp.task_status(:'T10_id') = 'in_progress' and pg_temp.task_status(:'T6_id') = 'todo', 'T10 resumes (in progress: review is entered only through a hand-off) and T6 to todo');

-- a person's BLOCKED state blocks dependents too; only a verification re-opens them
select pg_temp.as_user(:'U', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_integration_state(:'M_c', 'blocked', 'account suspended')) = 'set', 'a person marks Maps BLOCKED');
reset role;
select pg_temp.check(pg_temp.task_status(:'T6_id') = 'blocked', 'its dependent is blocked by that too');
select pg_temp.as_user(:'U', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_integration_state(:'M_c', 'configured', 'account restored')) = 'set', 'a person says it is configured again');
reset role;
select pg_temp.check(pg_temp.task_status(:'T6_id') = 'blocked', 'configured is not verified: the dependent stays blocked');
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_integration_check(:'M_c', 'maps-adapter', true, 'geocode ok')) = 'verified', 'the adapter verifies it');
reset role;
select pg_temp.check(pg_temp.task_status(:'T6_id') = 'todo', 'only the verification re-opens the dependent');

-- a dependency declared on an integration that is already failing takes effect now; releasing it resumes the task
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_integration_check(:'W_c', 'whatsapp-adapter', false, 'outage 3')) = 'degraded', 'WhatsApp degrades a third time');
reset role;
select pg_temp.as_user(:'U', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.depend_task_on_integration(:'T11_id', :'W_c')) = 'recorded', 'T11 is made to depend on the failing integration');
reset role;
select pg_temp.check(pg_temp.task_status(:'T11_id') = 'blocked', 'it is blocked at once');
select pg_temp.as_user(:'U', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.release_task_integration_dependency(:'T11_id', :'W_c')) = 'released', 'the dependency is removed');
reset role;
select pg_temp.check(pg_temp.task_status(:'T11_id') = 'todo', 'removing it releases the task');
select pg_temp.check((select count(*) from projects.task_integration_dependencies where task_id = :'T11_id') = 0, 'and the dependency is gone');

-- ═════════ 4. what the Test Automation and Documentation agents may write ═════════
select count(*) as runs0 from qa.test_runs \gset DR_
select count(*) as cases0 from qa.test_run_cases \gset DC_
select pg_temp.as_user(:'U', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(pg_temp.denied(format('select projects.record_test_case_draft(%L, ''x'', ''api'', ''d'', ''[]'', ''e'')', :'T1_id')), 'a signed-in person cannot call the agent''s draft door');
select pg_temp.check(pg_temp.denied(format('select projects.record_documentation_draft(%L, ''api'', ''t'', ''b'')', :'P_id')), 'nor the documentation draft door');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_test_case_draft(:'T1_id', 'pays with a declined card', 'api', 'A declined card shows the reason', '["open checkout","enter a declined card"]'::jsonb, 'the page shows card declined', 'the customer can pay by card')) = 'recorded', 'the agent proposes a test case');
select pg_temp.check((select outcome from projects.record_test_case_draft(:'T1_id', 'pays with a declined card', 'api', 'again', '[]', 'x')) = 'already_drafted', 'the same proposal is recorded once');
select pg_temp.check((select outcome from projects.record_test_case_draft(:'T1_id', 'bad layer', 'astral', 'd', '[]', 'e')) = 'bad_input', 'a layer outside the closed set is refused');
select pg_temp.check((select outcome from projects.record_test_case_draft(gen_random_uuid(), 'n', 'api', 'd', '[]', 'e')) = 'not_found', 'a task that does not exist is not found');
reset role;
select pg_temp.check((select organization_id = :'ORG' and project_id = :'P_id' and status = 'draft' from projects.test_case_drafts where task_id = :'T1_id'), 'the draft takes its organization and project from the TASK and is a draft');
select pg_temp.check(pg_temp.refused(format('update projects.test_case_drafts set status = ''accepted'' where task_id = %L', :'T1_id'), 'test_case_drafts_status_check'), 'a draft cannot be marked anything but a draft by a write');
select pg_temp.check((select count(*) from qa.test_runs) = :'DR_runs0'::int and (select count(*) from qa.test_run_cases) = :'DC_cases0'::int, 'a proposed test case is never a run or a result: no evidence was created');
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.test_case_drafts) = 0, 'another organization cannot read the drafts');
reset role;

select pg_temp.as_user(:'U', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_technical_document(:'P_id', 'api', 'Checkout API', 'implemented', 'src/checkout/route.ts', null, 'the human-written page')) = 'recorded', 'a person documents an API as implemented, with its evidence');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_documentation_draft(:'P_id', 'architecture', 'Checkout architecture', 'The checkout calls the payment adapter.')) = 'recorded', 'the agent leaves a documentation draft');
select pg_temp.check((select outcome from projects.record_documentation_draft(:'P_id', 'api', 'Checkout API', 'the agent''s version')) = 'exists', 'it never overwrites a document that exists');
select pg_temp.check((select outcome from projects.record_documentation_draft(:'P_id', 'integration', 'WhatsApp', 'x')) = 'bad_kind', 'it cannot write a derived kind (integration / build_run / test)');
select pg_temp.check((select outcome from projects.record_documentation_draft(:'P_id', 'api', 'Secrets page', 'config api_key=' || repeat('b', 20))) = 'refused', 'the secret guard refuses a draft that carries a secret value');
select pg_temp.check((select outcome from projects.record_documentation_draft(gen_random_uuid(), 'api', 't', 'b')) = 'not_found', 'an unknown project is not found');
reset role;
select pg_temp.check((select status = 'partial' and evidence_ref is null and not derived and body like 'DRAFT%' from projects.technical_documents where project_id = :'P_id' and title = 'Checkout architecture'), 'the draft is PARTIAL with no evidence, not derived, and says DRAFT: it never claims to be implemented');
select pg_temp.check((select status = 'implemented' and body = 'the human-written page' from projects.technical_documents where project_id = :'P_id' and title = 'Checkout API'), 'the person''s document is untouched');
select pg_temp.check((select count(*) from projects.technical_documents where project_id = :'P_id' and status = 'implemented' and body like 'DRAFT%') = 0, 'no agent draft is marked implemented');

rollback;
\echo ALL PHASE 5 TEST + INTEGRATION CHECKS PASSED OK
