-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 6 QA specialists (STUB-PROVEN): a specialist run can only PROPOSE. This drives the real doors on a scratch Postgres:
--   qa.request_specialist_run -> qa.record_specialist_finding (service role) -> qa.accept_specialist_finding / qa.reject_specialist_finding,
-- and proves that a proposal is never a result, that independence (requester != accepter) is enforced in the database, and that acceptance goes
-- through the EXISTING qa.record_case_result door as the accepting person.
-- No model, browser, device, load or security tool ran: the proposals below are what a specialist run WOULD hand the door.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase6-specialists.sql        (rolls back)
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
create or replace function pg_temp.refused(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when restrict_violation or check_violation then return position(needle in sqlerrm) > 0; end $$;
grant execute on function pg_temp.refused(text, text) to public;
create or replace function pg_temp.denied(stmt text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when insufficient_privilege then return true; end $$;
grant execute on function pg_temp.denied(text) to public;
-- what a specialist run hands the one door (service role); the organization is the JOB's
create or replace function pg_temp.propose(p_req uuid, p_agent text, p_kind text, p_case uuid, p_result text, p_reason text, p_refs text[], p_commit text default 'abc1234', p_env text default null, p_org uuid default '00000000-0000-4000-8000-000000000001', p_detail text default null)
returns text language sql as $$
  select outcome from qa.record_specialist_finding(p_req, p_org, p_agent, p_kind, p_case, p_result, p_reason, p_detail, p_refs, p_commit, p_env) $$;
grant execute on function pg_temp.propose(uuid, text, text, uuid, text, text, text[], text, text, uuid, text) to public;
create or replace function pg_temp.fid(p_req uuid, p_case uuid) returns uuid language sql as $$
  select id from qa.specialist_findings where request_id = p_req and case_id is not distinct from p_case order by created_at desc limit 1 $$;
grant execute on function pg_temp.fid(uuid, uuid) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000006b7'
\set OWNER '00000000-0000-4000-8000-00000000f611'
\set ACC '00000000-0000-4000-8000-00000000f612'
\set BUILDER '00000000-0000-4000-8000-00000000f613'
\set RO '00000000-0000-4000-8000-00000000f614'
\set FIN '00000000-0000-4000-8000-00000000f615'
\set UB '00000000-0000-4000-8000-00000000f616'
insert into core.organizations (id, name, slug) values (:'ORGB', 'P6S Other Agency', 'p6s-other-agency') on conflict do nothing;
insert into auth.users (id, email) values (:'OWNER', 'p6s-owner@example.test'), (:'ACC', 'p6s-acc@example.test'), (:'BUILDER', 'p6s-builder@example.test'), (:'RO', 'p6s-ro@example.test'), (:'FIN', 'p6s-fin@example.test'), (:'UB', 'p6s-b@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'p6s-owner@example.test', 'P6S Owner'), (:'ACC', 'p6s-acc@example.test', 'P6S Accepter'), (:'BUILDER', 'p6s-builder@example.test', 'P6S Builder'), (:'RO', 'p6s-ro@example.test', 'P6S RO'), (:'FIN', 'p6s-fin@example.test', 'P6S Fin'), (:'UB', 'p6s-b@example.test', 'P6S B') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner'), (:'ORG', :'ACC', 'ops_admin'), (:'ORG', :'BUILDER', 'member'), (:'ORG', :'RO', 'contractor'), (:'ORG', :'FIN', 'finance'), (:'ORGB', :'UB', 'owner') on conflict do nothing;
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p6s client') returning id \gset A_
insert into core.client_accounts (organization_id, name) values (:'ORGB', 'zztest p6s client b') returning id \gset AB_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p6s', 'ZP6-S') returning id \gset P_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORGB', :'AB_id', 'zztest p6s other', 'ZP6-SB') returning id \gset PB_
-- the build the builder made, at the plan's exact commit
insert into projects.deliverables (organization_id, project_id, kind, version, title, created_by) values (:'ORG', :'P_id', 'build', 1, 'zztest p6s build', :'BUILDER') returning id \gset D_
insert into projects.deliverable_details (deliverable_id, organization_id, project_id, commit_ref) values (:'D_id', :'ORG', :'P_id', 'abc1234');
-- the Phase 6 spine is its own verifier's business (scripts/verify-phase-four-e2e.sql drives it through the real doors); here its OUTPUT is the fixture:
-- an intake, an APPROVED plan over all nine categories, cases, and the QA jobs the real scheduler makes
set local session_replication_role = replica;
insert into projects.qa_intakes (organization_id, project_id, phase_six_id, phase_five_handoff_id, build_deliverable_id, commit_ref, artifact_sha256, status, m3_verified)
  values (:'ORG', :'P_id', gen_random_uuid(), gen_random_uuid(), :'D_id', 'abc1234', repeat('a', 64), 'valid', true) returning id \gset I_
insert into qa.master_test_plans (organization_id, project_id, intake_id, version, status, commit_ref, required_categories, environments, approved_by, approved_at)
  values (:'ORG', :'P_id', :'I_id', 1, 'approved', 'abc1234', array['functional', 'ui_e2e', 'api', 'integration', 'database', 'security', 'performance', 'compatibility', 'regression'], array['staging'], :'OWNER', now()) returning id \gset MP_
insert into qa.phase6_cases (organization_id, project_id, plan_id, title, acceptance_criterion, category, priority) values (:'ORG', :'P_id', :'MP_id', 'critical pay', 'a paid order shows a receipt', 'functional', 'critical') returning id \gset C1_
insert into qa.phase6_cases (organization_id, project_id, plan_id, title, acceptance_criterion, category, priority) values (:'ORG', :'P_id', :'MP_id', 'cart total', 'the total is right', 'functional', 'medium') returning id \gset C2_
insert into qa.phase6_cases (organization_id, project_id, plan_id, title, acceptance_criterion, category, priority) values (:'ORG', :'P_id', :'MP_id', 'cart rounding', 'rounding is to the paisa', 'functional', 'high') returning id \gset C3_
insert into qa.phase6_cases (organization_id, project_id, plan_id, title, acceptance_criterion, category, priority) values (:'ORG', :'P_id', :'MP_id', 'refund blocked', 'a refund needs approval', 'functional', 'medium') returning id \gset C4_
insert into qa.phase6_cases (organization_id, project_id, plan_id, title, acceptance_criterion, category, priority) values (:'ORG', :'P_id', :'MP_id', 'unlisted', 'not tested', 'functional', 'low') returning id \gset C5_
insert into qa.phase6_cases (organization_id, project_id, plan_id, title, acceptance_criterion, category, priority) values (:'ORG', :'P_id', :'MP_id', 'page speed', 'meets the project target', 'performance', 'medium') returning id \gset CP_
insert into qa.phase6_cases (organization_id, project_id, plan_id, title, acceptance_criterion, category, priority) values (:'ORG', :'P_id', :'MP_id', 'safari', 'works on the declared safari', 'compatibility', 'medium') returning id \gset CC_
insert into qa.phase6_cases (organization_id, project_id, plan_id, title, acceptance_criterion, category, priority) values (:'ORG', :'P_id', :'MP_id', 'tenant isolation', 'another tenant cannot read', 'security', 'high') returning id \gset CS_
set local session_replication_role = origin;
update ai.agents set enabled = true, disabled_reason = null where key in ('functional_test', 'ui_journey_test', 'api_integration_test', 'database_test', 'security_test', 'performance_test', 'compatibility_test', 'regression_test', 'release_readiness');
select pg_temp.as_service();
set local role service_role;
select outcome as o from qa.schedule_plan_jobs(:'MP_id') \gset SJ_
select pg_temp.check(:'SJ_o' = 'scheduled' and (select count(*) from qa.qa_jobs where plan_id = :'MP_id' and status = 'routed') = 9, 'fixture: the real scheduler routes nine jobs to the nine enabled specialists');
reset role;
select id as "JF" from qa.qa_jobs where plan_id = :'MP_id' and category = 'functional' \gset
select id as "JP" from qa.qa_jobs where plan_id = :'MP_id' and category = 'performance' \gset
select id as "JC" from qa.qa_jobs where plan_id = :'MP_id' and category = 'compatibility' \gset
select id as "JS" from qa.qa_jobs where plan_id = :'MP_id' and category = 'security' \gset
select id as "JU" from qa.qa_jobs where plan_id = :'MP_id' and category = 'ui_e2e' \gset
-- compatibility has no device or browser available: its job is HELD (held jobs are how the QA queue says "this did not run")
update qa.qa_jobs set status = 'held', code = 'agent_disabled', reason = 'no device or browser available' where id = :'JC';
-- a cancelled job
update qa.qa_jobs set status = 'cancelled' where id = :'JU';
insert into qa.release_candidates (organization_id, project_id, plan_id, intake_id, version, status, commit_ref, build_deliverable_id, artifact_sha256, created_by)
  values (:'ORG', :'P_id', :'MP_id', :'I_id', 1, 'draft', 'abc1234', :'D_id', repeat('a', 64), :'OWNER') returning id \gset RC_
-- another organization's own job, plan and candidate-free fixture, for the tenancy checks
set local session_replication_role = replica;
insert into projects.qa_intakes (organization_id, project_id, phase_six_id, phase_five_handoff_id, build_deliverable_id, commit_ref, status) values (:'ORGB', :'PB_id', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'zzz9999', 'valid') returning id \gset IB_
insert into qa.master_test_plans (organization_id, project_id, intake_id, version, status, commit_ref, required_categories, approved_by, approved_at)
  values (:'ORGB', :'PB_id', :'IB_id', 1, 'approved', 'zzz9999', array['functional'], :'UB', now()) returning id \gset MPB_
insert into qa.qa_jobs (organization_id, project_id, plan_id, category, specialist, execution_mode, status, reason) values (:'ORGB', :'PB_id', :'MPB_id', 'functional', 'functional_test', 'parallel', 'routed', 'x') returning id \gset JB_
set local session_replication_role = origin;

-- @@MUTATE@@

-- ═════════ 1. asking: a person with delivery rights, recorded by name ═════════
select pg_temp.as_user(:'BUILDER', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from qa.request_specialist_run(:'JF', null)) = 'not_authorized', 'a plain member cannot ask a specialist (delivery rights do)');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from qa.request_specialist_run(null, null)) = 'name_one_subject', 'a request names exactly one subject');
select pg_temp.check((select outcome from qa.request_specialist_run(:'JF', :'RC_id')) = 'name_one_subject', 'a request cannot name a job and a candidate together');
select pg_temp.check((select outcome from qa.request_specialist_run(:'JU', null)) = 'job_cancelled', 'a cancelled job is not asked about');
select pg_temp.check((select outcome from qa.request_specialist_run(:'JB_id', null)) = 'not_found', 'another organization''s job is not found');
select request_id as rq from qa.request_specialist_run(:'JF', null) \gset RF_
select request_id as rq from qa.request_specialist_run(:'JP', null) \gset RP_
select request_id as rq from qa.request_specialist_run(:'JC', null) \gset RC_
select request_id as rq from qa.request_specialist_run(:'JS', null) \gset RS_
select request_id as rq from qa.request_specialist_run(null, :'RC_id') \gset RR_
reset role;
select pg_temp.check((select agent_key = 'functional_test' and requested_by = :'OWNER' from qa.specialist_requests where id = :'RF_rq'), 'the request records the job''s own category agent and who asked');
select pg_temp.check((select agent_key = 'release_readiness' and candidate_id = :'RC_id' and job_id is null from qa.specialist_requests where id = :'RR_rq'), 'a release candidate is asked about by release_readiness only');
select pg_temp.check((select count(*) from audit.audit_log where action = 'qa.specialist_requested') >= 5, 'every request is audited');
select pg_temp.check(pg_temp.refused(format('update qa.specialist_requests set requested_by = %L where id = %L', :'ACC', :'RF_rq'), 'history'), 'a request is history: its requester is never edited');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.denied(format('insert into qa.specialist_requests (organization_id, project_id, agent_key, job_id, requested_by) values (%L, %L, ''functional_test'', %L, %L)', :'ORG', :'P_id', :'JF', :'OWNER')), 'a person cannot type a request row');
reset role;
\echo 1. requests OK

-- ═════════ 2. the finding door: what a specialist run may hand over ═════════
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.denied(format('select * from qa.record_specialist_finding(%L, %L, ''functional_test'', ''case_result'', %L, ''blocked'', ''x'', null, ''{}'', ''abc1234'')', :'RF_rq', :'ORG', :'C2_id')), 'the finding door is not callable by a signed-in person: it is the service role''s');
select pg_temp.check(pg_temp.denied(format('insert into qa.specialist_findings (organization_id, project_id, request_id, job_id, plan_id, case_id, category, agent_key, kind, proposed_result, reason, commit_ref, requested_by) values (%L, %L, %L, %L, %L, %L, ''functional'', ''functional_test'', ''case_result'', ''blocked'', ''x'', ''abc1234'', %L)', :'ORG', :'P_id', :'RF_rq', :'JF', :'MP_id', :'C2_id', :'OWNER')), 'a person cannot type a finding row either');
reset role;
-- even if the grant were widened, the door itself checks that the caller is the service role
grant execute on function qa.record_specialist_finding(uuid, uuid, text, text, uuid, text, text, text, text[], text, text) to authenticated;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from qa.record_specialist_finding(:'RF_rq', :'ORG', 'functional_test', 'case_result', :'C2_id', 'blocked', 'x', null, '{}', 'abc1234', null)) = 'not_authorized', 'and the door refuses a signed-in caller by itself, grant or no grant');
reset role;
revoke execute on function qa.record_specialist_finding(uuid, uuid, text, text, uuid, text, text, text, text[], text, text) from authenticated;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(pg_temp.propose(:'RF_rq', 'functional_test', 'case_result', :'C2_id', 'pass', 'total matches the cart', array['run:ci-1'], 'abc1234', null, :'ORGB') = 'wrong_organization', 'REFUSED: a job run for another organization');
select pg_temp.check(pg_temp.propose(:'RF_rq', 'security_test', 'case_result', :'C2_id', 'pass', 'total matches the cart', array['run:ci-1']) = 'wrong_agent', 'REFUSED: an agent that is not the job''s category agent');
select pg_temp.check(pg_temp.propose(:'RF_rq', 'functional_test', 'case_result', :'C2_id', 'pass', 'total matches the cart', array['run:ci-1'], 'def5678') = 'wrong_commit', 'REFUSED: a commit that is not the plan''s');
select pg_temp.check(pg_temp.propose(:'RF_rq', 'functional_test', 'case_result', :'C2_id', 'pass', 'total matches the cart', '{}') = 'evidence_required', 'REFUSED: a proposed pass with no evidence references');
select pg_temp.check(pg_temp.propose(:'RF_rq', 'functional_test', 'case_result', :'C2_id', 'pass', 'total matches the cart', array['  ']) = 'evidence_required', 'REFUSED: a proposed pass whose evidence is blank');
select pg_temp.check(pg_temp.propose(:'RF_rq', 'functional_test', 'case_result', :'C1_id', 'pass', 'a receipt is shown', array['run:ci-1']) = 'critical_pass_is_a_persons', 'REFUSED: a pass on a critical case - a person records it');
select pg_temp.check(pg_temp.propose(:'RF_rq', 'functional_test', 'case_result', :'CP_id', 'pass', 'x', array['run:ci-1']) = 'case_not_in_job', 'REFUSED: a case of another category');
select pg_temp.check(pg_temp.propose(:'RF_rq', 'functional_test', 'case_result', :'C2_id', 'pass', 'config api_key=' || repeat('x', 20), array['run:ci-1']) = 'secret_in_text', 'REFUSED: a secret value in the reason');
select pg_temp.check(pg_temp.propose(:'RF_rq', 'functional_test', 'case_result', :'C2_id', 'pass', 'ok', array['token=' || repeat('q', 24)]) = 'secret_in_text', 'REFUSED: a secret value in an evidence reference');
select pg_temp.check(pg_temp.propose(:'RF_rq', 'functional_test', 'case_result', :'C2_id', 'pass', 'ok', array['sk-' || repeat('a', 24)]) = 'secret_in_text', 'REFUSED: a key-shaped value (sk-...) with no label in an evidence reference');
select pg_temp.check(pg_temp.propose(:'RF_rq', 'functional_test', 'case_result', :'C2_id', 'passed', 'ok', array['run:ci-1']) = 'bad_result', 'REFUSED: a result outside the closed set');
select pg_temp.check(pg_temp.propose(:'RF_rq', 'functional_test', 'gate_summary', null, null, 'gates look fine', '{}') = 'kind_not_for_this_agent', 'REFUSED: a gate summary from an agent that is not release_readiness');
select pg_temp.check(pg_temp.propose(:'RR_rq', 'release_readiness', 'case_result', :'C2_id', 'pass', 'x', array['run:ci-1']) = 'kind_not_for_this_agent', 'REFUSED: release_readiness proposing a case result');
select pg_temp.check((select count(*) from qa.specialist_findings) = 0, 'nothing was written by any refused proposal');
-- allowed proposals
select pg_temp.check(pg_temp.propose(:'RF_rq', 'functional_test', 'case_result', :'C2_id', 'pass', 'total matches the cart', array['run:ci-1']) = 'proposed', 'a proposed pass WITH evidence on a non-critical case is recorded as a proposal');
select pg_temp.check(pg_temp.propose(:'RF_rq', 'functional_test', 'case_result', :'C2_id', 'pass', 'total matches the cart', array['run:ci-1']) = 'already_proposed', 'a redelivered run proposes nothing twice');
select pg_temp.check(pg_temp.propose(:'RF_rq', 'functional_test', 'case_result', :'C3_id', 'fail', 'rounds to the rupee', array['run:ci-2']) = 'proposed', 'a proposed fail');
select pg_temp.check(pg_temp.propose(:'RF_rq', 'functional_test', 'case_result', :'C4_id', 'blocked', 'the refund sandbox is down', '{}') = 'proposed', 'a proposed blocked needs a reason, not evidence');
select pg_temp.check(pg_temp.propose(:'RF_rq', 'functional_test', 'case_result', :'C5_id', 'not_tested', 'out of time', '{}') = 'proposed', 'a proposed not_tested');
select pg_temp.check(pg_temp.propose(:'RF_rq', 'functional_test', 'case_result', :'C1_id', 'fail', 'no receipt shown', array['run:ci-3']) = 'proposed', 'a FAIL on a critical case may be proposed (only a pass is a person''s)');
-- environments: a held job never had one; a routed one must name one the plan lists
select pg_temp.check(pg_temp.propose(:'RC_rq', 'compatibility_test', 'case_result', :'CC_id', 'pass', 'safari renders', array['shot:1'], 'abc1234', 'staging') = 'job_is_held', 'REFUSED: a device/browser pass for a job that is HELD for lack of the environment');
select pg_temp.check(pg_temp.propose(:'RC_rq', 'compatibility_test', 'case_result', :'CC_id', 'fail', 'safari broken', array['shot:1'], 'abc1234', 'staging') = 'job_is_held', 'REFUSED: and a device/browser FAIL for the same held job');
select pg_temp.check(pg_temp.propose(:'RC_rq', 'compatibility_test', 'case_result', :'CC_id', 'blocked', 'no device available for the declared safari', '{}') = 'proposed', 'a held job may only propose BLOCKED');
select pg_temp.check(pg_temp.propose(:'RP_rq', 'performance_test', 'case_result', :'CP_id', 'pass', 'p95 within the project target', array['run:load-1']) = 'environment_required', 'REFUSED: a load result that names no environment');
select pg_temp.check(pg_temp.propose(:'RP_rq', 'performance_test', 'case_result', :'CP_id', 'pass', 'p95 within the project target', array['run:load-1'], 'abc1234', 'prod-like-lab') = 'environment_not_available', 'REFUSED: a load result for an environment the plan does not list');
select pg_temp.check(pg_temp.propose(:'RP_rq', 'performance_test', 'case_result', :'CP_id', 'pass', 'p95 within the project target', array['run:load-1'], 'abc1234', 'staging') = 'proposed', 'a load result in a listed environment is a proposal');
-- security: weakness and fix, never the exploit
select pg_temp.check(pg_temp.propose(:'RS_rq', 'security_test', 'case_result', :'CS_id', 'fail', 'reads another tenant: id=1'' or 1=1 --', array['run:sec-1']) = 'exploit_detail_refused', 'REFUSED: raw exploit detail in a security finding');
select pg_temp.check(pg_temp.propose(:'RS_rq', 'security_test', 'case_result', :'CS_id', 'fail', 'the cart endpoint returns another tenant''s cart when the id is changed; scope the query by organization', array['run:sec-1']) = 'proposed', 'a security finding that names the weakness is a proposal');
-- release_readiness: summaries and exception REQUESTS
select pg_temp.check(pg_temp.propose(:'RR_rq', 'release_readiness', 'gate_summary', null, null, 'seven of nine categories have accepted results; two are open', array['plan:' || :'MP_id'], 'abc1234', null, :'ORG', 'Open: compatibility, performance.') = 'proposed', 'release_readiness proposes a gate summary');
select pg_temp.check(pg_temp.propose(:'RR_rq', 'release_readiness', 'exception_request', null, null, 'request a time-boxed exception for the compatibility gate: no device lab until Friday', '{}', 'abc1234') = 'proposed', 'release_readiness proposes an exception REQUEST');
select pg_temp.check(pg_temp.propose(:'RR_rq', 'release_readiness', 'gate_summary', null, null, 'summary', '{}', 'def5678') = 'wrong_commit', 'REFUSED: a readiness summary about another commit');
reset role;
-- a proposal is never a result
select pg_temp.check((select count(*) from qa.phase6_cases where plan_id = :'MP_id' and status <> 'planned') = 0, 'NO case row changed: a proposal is never a result');
select pg_temp.check((select count(*) from qa.phase6_result_history where case_id in (select id from qa.phase6_cases where plan_id = :'MP_id')) = 0, 'and no result history was written');
select pg_temp.check((select count(*) from qa.release_exceptions where candidate_id = :'RC_id') = 0 and (select status from qa.release_candidates where id = :'RC_id') = 'draft', 'an exception REQUEST proposal files no exception and approves no candidate');
select pg_temp.check((select bool_and(status = 'proposed') from qa.specialist_findings), 'every finding is proposed and only proposed');
select pg_temp.check(pg_temp.refused(format('update qa.specialist_findings set reason = ''edited'' where id = %L', pg_temp.fid(:'RF_rq', :'C2_id')), 'history'), 'a finding is append-only: never edited');
select pg_temp.check(pg_temp.refused(format('delete from qa.specialist_findings where id = %L', pg_temp.fid(:'RF_rq', :'C2_id')), 'history'), 'a finding is never deleted');
select pg_temp.check(pg_temp.refused(format('update qa.specialist_findings set status = ''accepted'' where id = %L', pg_temp.fid(:'RF_rq', :'C3_id')), 'history'), 'a finding''s status is not edited to accepted');
select pg_temp.check(pg_temp.refused(format('insert into qa.specialist_findings (organization_id, project_id, request_id, job_id, plan_id, case_id, category, agent_key, kind, proposed_result, reason, commit_ref, requested_by, status) values (%L, %L, %L, %L, %L, %L, ''functional'', ''functional_test'', ''case_result'', ''blocked'', ''x'', ''abc1234'', %L, ''accepted'')', :'ORG', :'P_id', :'RF_rq', :'JF', :'MP_id', :'C5_id', :'OWNER'), 'status'), 'a finding can only be INSERTED as proposed');
select pg_temp.check(pg_temp.refused(format('insert into qa.specialist_findings (organization_id, project_id, request_id, job_id, plan_id, case_id, category, agent_key, kind, proposed_result, reason, commit_ref, requested_by) values (%L, %L, %L, %L, %L, %L, ''functional'', ''functional_test'', ''case_result'', ''pass'', ''x'', ''abc1234'', %L)', :'ORG', :'P_id', :'RF_rq', :'JF', :'MP_id', :'C5_id', :'OWNER'), 'check'), 'a pass with no evidence is refused by the table itself, not only by the door');
\echo 2. findings OK

-- ═════════ 3. deciding: an independent person, through the existing result door ═════════
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from qa.accept_specialist_finding(pg_temp.fid(:'RF_rq', :'C2_id'), 'looks right')) = 'self_acceptance', 'the person who asked for the run cannot accept its proposal');
select pg_temp.check((select outcome from qa.reject_specialist_finding(pg_temp.fid(:'RF_rq', :'C2_id'), 'no')) = 'self_acceptance', 'nor reject it');
reset role;
select pg_temp.as_user(:'RO', :'ORG', 'contractor');
set local role authenticated;
select pg_temp.check((select outcome from qa.accept_specialist_finding(pg_temp.fid(:'RF_rq', :'C2_id'), null)) = 'not_authorized', 'a contractor who cannot write cannot accept');
reset role;
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from qa.accept_specialist_finding(pg_temp.fid(:'RF_rq', :'C2_id'), null)) = 'not_found', 'another organization''s finding is not found');
reset role;
-- the builder is independent of the REQUESTER but the existing door still refuses a builder recording the result
select pg_temp.as_user(:'BUILDER', :'ORG', 'member');
set local role authenticated;
select outcome as o, case_outcome as co from qa.accept_specialist_finding(pg_temp.fid(:'RF_rq', :'C2_id'), null) \gset BA_
select pg_temp.check(:'BA_o' = 'refused_by_result_door' and :'BA_co' = 'self_review', 'the builder accepting is refused by the existing result door (self_review) and nothing is decided [' || :'BA_o' || '/' || :'BA_co' || ']');
reset role;
select pg_temp.check((select count(*) from qa.specialist_finding_decisions) = 0 and (select status from qa.phase6_cases where id = :'C2_id') = 'planned', 'a refused acceptance records no decision and changes no case');
select pg_temp.as_user(:'ACC', :'ORG', 'ops_admin');
set local role authenticated;
select outcome as o, case_outcome as co from qa.accept_specialist_finding(pg_temp.fid(:'RF_rq', :'C2_id'), 'verified against the cart screen') \gset AA_
select pg_temp.check(:'AA_o' = 'accepted' and :'AA_co' = 'recorded', 'an independent person accepts the proposed pass: it is recorded through qa.record_case_result [' || :'AA_o' || '/' || :'AA_co' || ']');
reset role;
select pg_temp.check((select status = 'pass' and executed_by = :'ACC' and result_commit = 'abc1234' and evidence_ref = 'run:ci-1' from qa.phase6_cases where id = :'C2_id'), 'the case is a pass executed BY THE ACCEPTOR (identity preserved) on the exact commit with the evidence');
select pg_temp.check((select recorded_by = :'ACC' from qa.phase6_result_history where case_id = :'C2_id'), 'the result history names the accepting person, not the agent');
select pg_temp.check((select decision = 'accepted' and decided_by = :'ACC' and recorded_outcome = 'recorded' from qa.specialist_finding_decisions where finding_id = pg_temp.fid(:'RF_rq', :'C2_id')), 'the decision is recorded with who and what');
select pg_temp.as_user(:'ACC', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from qa.accept_specialist_finding(pg_temp.fid(:'RF_rq', :'C2_id'), null)) = 'already_decided', 'a finding is decided once');
select pg_temp.check((select outcome from qa.reject_specialist_finding(pg_temp.fid(:'RF_rq', :'C2_id'), 'changed my mind')) = 'already_decided', 'an ACCEPTED finding cannot be rejected afterwards either');
select pg_temp.check((select outcome from qa.reject_specialist_finding(pg_temp.fid(:'RF_rq', :'C3_id'), '')) = 'reason_required', 'a rejection says why');
select pg_temp.check((select outcome from qa.reject_specialist_finding(pg_temp.fid(:'RF_rq', :'C3_id'), 'the rounding rule in the contract says rupee')) = 'rejected', 'an independent person rejects a proposal');
select pg_temp.check((select outcome from qa.accept_specialist_finding(pg_temp.fid(:'RF_rq', :'C3_id'), null)) = 'already_decided', 'a rejection is FINAL: it cannot be accepted afterwards');
reset role;
select pg_temp.check((select status from qa.phase6_cases where id = :'C3_id') = 'planned', 'a rejected proposal changes no case');
select pg_temp.check(pg_temp.refused(format('update qa.specialist_finding_decisions set decision = ''accepted'' where finding_id = %L', pg_temp.fid(:'RF_rq', :'C3_id')), 'history'), 'the decision row itself is append-only');
select pg_temp.check(pg_temp.refused(format('delete from qa.specialist_finding_decisions where finding_id = %L', pg_temp.fid(:'RF_rq', :'C3_id')), 'history'), 'and never deleted');
select pg_temp.as_user(:'ACC', :'ORG', 'ops_admin');
set local role authenticated;
select outcome as o, case_outcome as co from qa.accept_specialist_finding(pg_temp.fid(:'RF_rq', :'C1_id'), 'reproduced the missing receipt') \gset AF_
select pg_temp.check(:'AF_o' = 'accepted' and :'AF_co' = 'recorded', 'an accepted FAIL on a critical case goes through the result door');
select pg_temp.check((select outcome from qa.accept_specialist_finding(pg_temp.fid(:'RF_rq', :'C4_id'), null)) = 'accepted', 'an accepted BLOCKED is recorded with its reason');
select pg_temp.check((select case_outcome from qa.accept_specialist_finding(pg_temp.fid(:'RF_rq', :'C5_id'), null)) = 'nothing_to_record', 'an accepted not_tested is noted and records nothing');
reset role;
select pg_temp.check((select status = 'fail' and defect_id is not null and executed_by = :'ACC' from qa.phase6_cases where id = :'C1_id'), 'the FAIL opened its defect through the existing door, as the accepting person');
select pg_temp.check((select status = 'blocked' and reason = 'the refund sandbox is down' from qa.phase6_cases where id = :'C4_id'), 'the blocked case carries the specialist''s reason');
select pg_temp.check((select status = 'planned' from qa.phase6_cases where id = :'C5_id'), 'a not_tested proposal leaves the case planned');
-- a gate summary / exception request, accepted, only becomes a recorded note: nothing is approved
select pg_temp.as_user(:'ACC', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from qa.accept_specialist_finding((select id from qa.specialist_findings where request_id = :'RR_rq' and kind = 'exception_request'), 'noted; filing the exception myself')) = 'accepted', 'a person accepts an exception REQUEST as a note');
reset role;
select pg_temp.check((select count(*) from qa.release_exceptions where candidate_id = :'RC_id') = 0 and (select status from qa.release_candidates where id = :'RC_id') = 'draft', 'accepting it filed no exception and approved nothing: a person files it through the exception door');
-- the evidence rule of the existing door still decides: a forged finding with blank evidence is not recorded
set local session_replication_role = replica;
insert into qa.specialist_findings (organization_id, project_id, request_id, job_id, plan_id, case_id, category, agent_key, kind, proposed_result, reason, evidence_refs, commit_ref, requested_by)
  values (:'ORG', :'P_id', :'RP_rq', :'JP', :'MP_id', :'C5_id', 'performance', 'performance_test', 'case_result', 'pass', 'forged blank evidence', array['   '], 'abc1234', :'OWNER') returning id \gset FB_
set local session_replication_role = origin;
select pg_temp.as_user(:'ACC', :'ORG', 'ops_admin');
set local role authenticated;
select outcome as o, case_outcome as co from qa.accept_specialist_finding(:'FB_id', null) \gset FE_
select pg_temp.check(:'FE_o' = 'refused_by_result_door' and :'FE_co' = 'evidence_required', 'the EXISTING evidence rule decides: blank evidence is refused and nothing is decided [' || :'FE_o' || '/' || :'FE_co' || ']');
reset role;
-- a plan whose commit moved on: the proposal is stale
set local session_replication_role = replica;
update qa.master_test_plans set commit_ref = 'moved99' where id = :'MP_id';
set local session_replication_role = origin;
select pg_temp.as_user(:'ACC', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from qa.accept_specialist_finding(:'FB_id', null)) = 'stale_finding', 'a proposal about a commit the plan no longer names is stale and cannot be accepted');
reset role;
\echo 3. decisions OK

-- ═════════ 4. who can read ═════════
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from qa.specialist_findings) >= 10, 'staff read the findings');
reset role;
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
set local role authenticated;
select pg_temp.check((select count(*) from qa.specialist_findings) = 0 and (select count(*) from qa.specialist_requests) = 0 and (select count(*) from qa.specialist_finding_decisions) = 0, 'a non-internal role reads no finding, request or decision');
reset role;
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from qa.specialist_findings) = 0, 'another organization reads none of them');
reset role;
\echo 4. reads OK
rollback;
