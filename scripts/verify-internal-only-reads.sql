-- ═══════════════════════════════════════════════════════════════════════════
-- Internal records stay internal: a portal CLIENT of the same organization reads none of the Phase 5 / Phase 6 internal tables; staff read them;
-- another organization's staff read none.   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-internal-only-reads.sql   (rolls back)
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

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000000b2'
\set STAFF '00000000-0000-4000-8000-00000000f601'
\set CLIENT '00000000-0000-4000-8000-00000000f602'
insert into core.organizations (id, name, slug) values (:'ORGB', 'Other Agency (reads)', 'other-agency-reads') on conflict (id) do nothing;
insert into auth.users (id, email) values (:'STAFF', 'ro-staff@example.test'), (:'CLIENT', 'ro-client@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'STAFF', 'ro-staff@example.test', 'RO Staff'), (:'CLIENT', 'ro-client@example.test', 'RO Client') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'STAFF', 'member') on conflict do nothing;

-- one row in each internal table (fixtures as the table owner; FK history is not what is under test)
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest ro client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest ro', 'ZP-RO') returning id \gset P_
insert into projects.integration_connections (organization_id, project_id, kind, name) values (:'ORG', :'P_id', 'email', 'zztest mail');
insert into projects.technical_documents (organization_id, project_id, kind, title, status) values (:'ORG', :'P_id', 'other', 'zztest doc', 'partial');
insert into qa.flaky_tests (organization_id, project_id, test_key) values (:'ORG', :'P_id', 'zztest.flaky');

create temp table internal_tables (sch text, tbl text);
insert into internal_tables values
  ('projects','phase_five'),('projects','development_baselines'),('projects','code_reviews'),('projects','build_feedback'),('projects','integration_connections'),
  ('projects','phase_five_agent_state'),('projects','phase_five_handoffs'),('projects','development_plans'),('projects','build_runs'),('projects','task_test_evidence'),
  ('projects','routing_decisions'),('projects','technical_documents'),('qa','flaky_tests'),('qa','test_run_cases'),
  ('projects','phase_six'),('projects','qa_intakes'),('projects','phase_six_handoffs'),('qa','master_test_plans'),('qa','risk_items'),('qa','phase6_cases'),
  ('qa','phase6_result_history'),('qa','release_candidates'),('qa','category_results'),('qa','category_result_history'),('qa','readiness_assessments'),
  ('qa','release_exceptions'),('qa','admin_qa_reviews'),('qa','qa_jobs');
grant select on internal_tables to public;

-- every internal table has exactly the internal-only read policy
select pg_temp.check((select count(*) from internal_tables t join pg_policies p on p.schemaname = t.sch and p.tablename = t.tbl and p.cmd = 'SELECT'
                       where p.qual like '%is_internal%') = (select count(*) from internal_tables), 'every internal table has a read policy that requires is_internal()');

-- a client reads none of the rows that exist
select pg_temp.as_user(:'CLIENT', :'ORG', 'client');
set local role authenticated;
select pg_temp.check((select count(*) from projects.integration_connections) = 0, 'a portal client cannot read integration health');
select pg_temp.check((select count(*) from projects.technical_documents) = 0, 'a portal client cannot read technical documents');
select pg_temp.check((select count(*) from qa.flaky_tests) = 0, 'a portal client cannot read flaky tests');
reset role;
-- staff of the same organization can
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.integration_connections) = 1, 'staff can read integration health');
select pg_temp.check((select count(*) from projects.technical_documents) = 1, 'staff can read technical documents');
select pg_temp.check((select count(*) from qa.flaky_tests) = 1, 'staff can read flaky tests');
reset role;
-- another organization's staff cannot
select pg_temp.as_user(:'STAFF', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.integration_connections) = 0, 'another organization sees none');
reset role;
rollback;
\echo ALL INTERNAL-ONLY READ CHECKS PASSED
