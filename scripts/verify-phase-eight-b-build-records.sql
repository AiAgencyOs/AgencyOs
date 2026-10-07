-- ═══════════════════════════════════════════════════════════════════════════
-- 8B: BuildCreated and MigrationPrepared are recorded by a person against the exact commit. Rolls back.
-- driven through the REAL doors on a scratch Postgres. No model, repository, deployment or payment provider ran.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-eight-b.sql        (rolls back)
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
begin execute stmt; return false; exception when insufficient_privilege then return true; end $$;
grant execute on function pg_temp.denied(text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000008b7'
\set OWNER '00000000-0000-4000-8000-00000000f811'
\set ADM '00000000-0000-4000-8000-00000000f812'
\set DEV '00000000-0000-4000-8000-00000000f813'
\set QA '00000000-0000-4000-8000-00000000f814'
\set LEAD '00000000-0000-4000-8000-00000000f815'
\set UB '00000000-0000-4000-8000-00000000f816'
\set C1 '1111111111111111111111111111111111111111'
\set C2 '2222222222222222222222222222222222222222'
insert into core.organizations (id, name, slug) values (:'ORGB', 'P8B Other Agency', 'p8b-other') on conflict do nothing;
insert into auth.users (id, email) values (:'OWNER','p8b-o@example.test'),(:'ADM','p8b-a@example.test'),(:'DEV','p8b-d@example.test'),(:'QA','p8b-q@example.test'),(:'LEAD','p8b-l@example.test'),(:'UB','p8b-b@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER','p8b-o@example.test','O'),(:'ADM','p8b-a@example.test','A'),(:'DEV','p8b-d@example.test','D'),(:'QA','p8b-q@example.test','Q'),(:'LEAD','p8b-l@example.test','L'),(:'UB','p8b-b@example.test','B') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG',:'OWNER','owner'),(:'ORG',:'ADM','ops_admin'),(:'ORG',:'DEV','member'),(:'ORG',:'QA','member'),(:'ORG',:'LEAD','delivery_lead'),(:'ORGB',:'UB','owner') on conflict do nothing;

-- fixture (triggers off: the spine that makes these is other verifiers' business)
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p8b client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p8b', 'ZP8-B') returning id \gset P_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p8b nohandover', 'ZP8-N') returning id \gset PN_
set local session_replication_role = replica;
insert into projects.handovers (organization_id, project_id, status) values (:'ORG', :'P_id', 'delivered');
insert into projects.maintenance_items (organization_id, client_account_id, project_id, title, coverage) values (:'ORG', :'A_id', :'P_id', 'covered ticket', 'maintenance') returning id \gset T_
insert into projects.maintenance_items (organization_id, client_account_id, project_id, title, coverage) values (:'ORG', :'A_id', :'P_id', 'feature ticket', 'change_request') returning id \gset TF_
insert into qa.defects (organization_id, project_id, severity, title, reproduction, found_commit) values (:'ORG', :'P_id', 'major', 'prod bug', 'steps', :'C1') returning id \gset D_
insert into projects.scope_versions (organization_id, project_id, version) values (:'ORG', :'P_id', 1) returning id \gset SV_
insert into projects.change_requests (organization_id, project_id, scope_version_id, requested, classification, status) values (:'ORG', :'P_id', :'SV_id', 'small tweak', 'free_change', 'approved') returning id \gset CR_
insert into projects.change_requests (organization_id, project_id, scope_version_id, requested, classification, status) values (:'ORG', :'P_id', :'SV_id', 'new report', 'new_project', 'classified') returning id \gset CRN_
set local session_replication_role = origin;

-- ═════════ work items: never free scope ═════════
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.open_maintenance_work(:'P_id','patch','backend','x')) = 'unauthorized_work', 'work with no ticket, defect or change request is refused');
select pg_temp.check((select outcome from projects.open_maintenance_work(:'P_id','enhancement','backend','x', null, :'T_id')) = 'enhancement_needs_a_change_request', 'an enhancement needs a change request');
select pg_temp.check((select outcome from projects.open_maintenance_work(:'P_id','patch','backend','x', null, :'TF_id')) = 'out_of_scope_needs_a_change_request', 'a feature filed as a maintenance ticket is refused');
select pg_temp.check((select outcome from projects.open_maintenance_work(:'P_id','enhancement','backend','x', null, null, null, :'CRN_id')) = 'new_project_is_not_maintenance', 'a new-project change request is not maintenance');
select pg_temp.check((select outcome from projects.open_maintenance_work(:'PN_id','patch','backend','x', null, :'T_id')) = 'no_handover', 'no delivered handover: no post-launch work');
select pg_temp.check((select outcome from projects.open_maintenance_work(:'P_id','hotfix','backend','x', null, null, :'D_id', null, true)) = 'emergency_needs_an_admin', 'an emergency is authorized by an Admin only');
select outcome, work_item_id as id from projects.open_maintenance_work(:'P_id','hotfix','backend','Fix prod bug', null, null, :'D_id') \gset W_
select pg_temp.check(:'W_outcome' = 'opened', 'a hotfix tied to a defect opens');
select pg_temp.check((select outcome from projects.open_maintenance_work(:'P_id','hotfix','backend','again', null, null, :'D_id')) = 'already_open', 'the same defect is not worked twice (duplicate event safe)');
select pg_temp.check(pg_temp.denied($$update projects.maintenance_work_items set status = 'released'$$), 'no direct write for a signed-in user');
reset role;
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_work_items set status = 'qa_passed' where id = %L$$, :'W_id'), 'moves through its doors'), 'even a service-level write cannot move status');
select pg_temp.check(pg_temp.refused(format($$delete from projects.maintenance_work_items where id = %L$$, :'W_id'), 'never deleted'), 'work is never deleted');

-- ═════════ exact commit, independent QA, release approval ═════════
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.submit_maintenance_fix(:'W_id','abc123','fix','undo','dev')) = 'exact_commit_required', 'a branch name or short sha is not an exact commit');
select pg_temp.check((select outcome from projects.submit_maintenance_fix(:'W_id',:'C1','fix',null,null)) = 'rollback_required', 'a rollback plan and owner are required');
select pg_temp.check((select outcome from projects.submit_maintenance_fix(:'W_id',:'C1','fix','revert the commit','dev')) = 'submitted', 'the developer submits the exact commit');
select pg_temp.check((select outcome from projects.record_maintenance_qa_result(:'W_id','targeted','pass',:'C1','run:1')) = 'self_review', 'the author cannot be the QA of the commit');
reset role;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_maintenance_qa_result(:'W_id','targeted','pass',:'C2','run:1')) = 'stale_commit', 'evidence for another commit is refused');
select pg_temp.check((select outcome from projects.record_maintenance_qa_result(:'W_id','targeted','pass',:'C1')) = 'evidence_required', 'a pass needs evidence');
select outcome, defect_id as defect from projects.record_maintenance_qa_result(:'W_id','regression','fail',:'C1',null,'checkout broke') \gset F_
select pg_temp.check(:'F_outcome' = 'recorded' and :'F_defect' <> '', 'a failing result is recorded and opens a QA defect');
reset role;
select pg_temp.check((select status from projects.maintenance_work_items where id = :'W_id') = 'changes_requested', 'failed QA returns the change to the developer');
select pg_temp.check((select found_commit from qa.defects where id = :'F_defect') = :'C1', 'the defect names the exact commit');
-- new commit invalidates everything before it
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.submit_maintenance_fix(:'W_id',:'C2','second try','revert','dev')) = 'submitted', 'a new commit is submitted');
reset role;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.evaluate_maintenance_gates(:'W_id') where gate in ('targeted_qa','regression_qa') and passed) = 0, 'earlier results do not count for the new commit');
select projects.record_maintenance_qa_result(:'W_id','targeted','pass',:'C2','run:2');
select projects.record_maintenance_qa_result(:'W_id','regression','pass',:'C2','run:3');
select pg_temp.check((select status from projects.maintenance_work_items where id = :'W_id') = 'qa_passed', 'QA passed on the exact commit');
select pg_temp.check((select outcome from projects.request_maintenance_release(:'W_id')) = 'gates_open', 'the linked defect is not verified and the QA defect is open: release cannot be requested');
reset role;
-- the Phase 6 loop: fixed by the developer, verified by an independent retest
set local session_replication_role = replica;
update qa.defects set status = 'fixed', fixed_by = :'DEV', fixed_at = now(), resolution = 'fixed', work_state = 'in_progress', assigned_to = :'DEV' where id in (:'D_id', :'F_defect');
set local session_replication_role = origin;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from qa.record_retest(:'D_id', true, :'C2', 'retest:1')) = 'verified', 'the Phase 6 retest verifies the linked defect');
select qa.record_retest(:'F_defect', true, :'C2', 'retest:2');
select pg_temp.check((select outcome from projects.request_maintenance_release(:'W_id')) = 'requested', 'release is requested once every gate holds');
reset role;
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_maintenance_release(:'W_id','approve')) = 'not_authorized', 'only an Admin decides a release');
reset role;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_maintenance_release(:'W_id','approve')) = 'not_authorized', 'a member cannot approve');
reset role;
-- the Admin who opened/built/requested is refused: here the creator is LEAD (a delivery_lead, not Admin) - make the creator an Admin to prove it
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select outcome, work_item_id as id from projects.open_maintenance_work(:'P_id','patch','dependency','bump lib', null, :'T_id') \gset W2_
select projects.submit_maintenance_fix(:'W2_id', :'C1', 'bump', 'revert', 'adm');
reset role;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select projects.record_maintenance_qa_result(:'W2_id','targeted','pass',:'C1','run:t');
select projects.record_maintenance_qa_result(:'W2_id','regression','pass',:'C1','run:r');
select pg_temp.check((select outcome from projects.request_maintenance_release(:'W2_id')) = 'requested', 'second item reaches release review');
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_maintenance_release(:'W2_id','approve')) = 'approver_is_the_author', 'creator != approver: the Admin who opened and built it cannot approve');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_maintenance_release(:'W2_id','reject')) = 'note_required', 'a rejection says why');
select pg_temp.check((select outcome from projects.decide_maintenance_release(:'W_id','approve')) = 'approved', 'an independent Admin approves the exact commit');
select pg_temp.check((select outcome from projects.submit_maintenance_fix(:'W_id',:'C1','x','y','z')) = 'commit_frozen', 'the approved commit is frozen');
select pg_temp.check((select outcome from projects.record_maintenance_release(:'W_id','','')) = 'evidence_required', 'released needs a deployment reference and smoke evidence');
select pg_temp.check((select outcome from projects.record_maintenance_release(:'W_id','deploy-1','smoke-1')) = 'released', 'a person records the release');
reset role;

select status as "W2S" from projects.maintenance_work_items where id = :'W2_id' \gset
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_maintenance_build(:'W2_id', 'deploy', :'C1', 'b-1')) = 'invalid_kind', 'kind is build or migration');
select pg_temp.check((select outcome from projects.record_maintenance_build(:'W2_id', 'build', :'C1', ' ')) = 'reference_required', 'a reference is required');
select pg_temp.check((select outcome from projects.record_maintenance_build(:'W2_id', 'build', :'C1', 'api_key=' || repeat('a', 20))) = 'secret_refused', 'a pasted secret is refused');
select pg_temp.check((select outcome from projects.record_maintenance_build(:'W2_id', 'build', :'C2', 'b-1')) = 'commit_mismatch', 'a build of another commit is not this change''s build');
select pg_temp.check((select outcome from projects.record_maintenance_build(:'W_id', 'build', :'C1', 'b-1')) = 'not_in_progress', 'a released change takes no new build record');
select pg_temp.check((select outcome from projects.record_maintenance_build(:'W2_id', 'build', :'C1', 'ci-run-77')) = 'recorded', 'a person records the build of the exact commit');
select pg_temp.check((select outcome from projects.record_maintenance_build(:'W2_id', 'build', :'C1', 'ci-run-77')) = 'already_recorded', 'the same build is recorded once (duplicate-safe)');
select pg_temp.check((select outcome from projects.record_maintenance_build(:'W2_id', 'migration', :'C1', 'migration 20270101000000 prepared, not applied')) = 'recorded', 'a prepared migration is recorded');
select pg_temp.check(pg_temp.denied($$insert into projects.maintenance_build_records (organization_id, project_id, work_item_id, kind, commit_ref, ref, recorded_by) select organization_id, project_id, id, 'build', commit_ref, 'x', created_by from projects.maintenance_work_items limit 1$$), 'no direct write for a signed-in user');
reset role;
select pg_temp.check((select count(*) from core.outbox_events where organization_id = :'ORG' and type = 'project.maintenance_build_created' and subject_id = :'W2_id') = 1, 'BuildCreated emitted once');
select pg_temp.check((select count(*) from core.outbox_events where organization_id = :'ORG' and type = 'project.maintenance_migration_prepared' and subject_id = :'W2_id') = 1, 'MigrationPrepared emitted once');
select pg_temp.check((select status from projects.maintenance_work_items where id = :'W2_id') = :'W2S', 'recording moved no gate');
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_build_records set ref = 'z' where work_item_id = %L$$, :'W2_id'), 'never edited or deleted'), 'a build record is never edited');
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_maintenance_build(:'W2_id', 'build', :'C1', 'ci-run-78')) = 'not_authorized', 'a plain member cannot record one');
reset role;
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.maintenance_build_records) = 0, 'another organization reads none');
reset role;
select pg_temp.check(pg_get_functiondef('projects.record_maintenance_build(uuid,text,text,text,text)'::regprocedure) like '%commit_mismatch%', 'live definition holds the exact-commit branch');
rollback;
\echo VERIFIED
