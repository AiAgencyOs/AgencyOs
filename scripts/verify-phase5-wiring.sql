-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 follow-up: the Orchestrator's writers have callers. Driven for real on a scratch Postgres:
--   1. start_task claims a concurrency lease (a project with a phase_five workspace), refuses an overlap as 'path_lease_conflict', and a lease ends
--      when its task leaves in_progress;
--   2. a QA result on a planned task is an event (project.dev_task_qa_failed / project.dev_task_qa_passed), written where the fact is written.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase5-wiring.sql
-- Rolls back. Any failed check raises.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void
language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok  %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to public;

create or replace function pg_temp.as_user(p_sub uuid, p_org uuid, p_role text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_sub, 'role', 'authenticated',
      'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true);
end $$;
grant execute on function pg_temp.as_user(uuid, uuid, text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set U '00000000-0000-4000-8000-00000000f5b1'

insert into auth.users (id, email) values (:'U', 'p5wire-owner@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'U', 'p5wire-owner@example.test', 'Wire Owner') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'U', 'owner') on conflict do nothing;

-- ── fixtures (as the table owner) ───────────────────────────────────────────
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest wire client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest wire p5', 'ZWIRE-5') returning id \gset P_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest wire plain', 'ZWIRE-N') returning id \gset Q_
-- a Phase 5 workspace for P (the phase_four row it hangs from is not what is under test; FKs are skipped for this one insert)
set local session_replication_role = replica;
insert into projects.phase_five (organization_id, project_id, phase_four_id) values (:'ORG', :'P_id', gen_random_uuid());
set local session_replication_role = origin;

-- a task starts only when it traces to a requirement: a requirement_version_id (the row itself is not under test, so FKs are skipped for these inserts)
set local session_replication_role = replica;
insert into crm.requirement_versions (organization_id, conversation_id, version, source) values (:'ORG', gen_random_uuid(), 1, 'human') returning id \gset RV_
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'P_id', 'zztest cart ui', 'todo', 'frontend_developer', '{src/cart}') returning id \gset T1_
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'P_id', 'zztest cart total', 'todo', 'backend_developer', '{src/cart/total.ts}') returning id \gset T2_
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'P_id', 'zztest other files', 'todo', 'backend_developer', '{src/other}') returning id \gset T3_
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'P_id', 'zztest no paths', 'todo', 'backend_developer', '{}') returning id \gset T4_
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'Q_id', 'zztest plain project', 'todo', 'backend_developer', '{src/cart}') returning id \gset TQ_
update projects.tasks set requirement_version_id = :'RV_id' where project_id in (:'P_id', :'Q_id');
set local session_replication_role = origin;

-- ── 1. leases ───────────────────────────────────────────────────────────────
select pg_temp.as_user(:'U', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_task(:'T1_id')) = 'started', 'a task with affected files starts');
reset role;
select pg_temp.check((select count(*) from projects.concurrency_leases where task_id = :'T1_id' and state = 'active') = 1, 'starting it claimed exactly one active lease');
select pg_temp.check((select agent_key = 'frontend_developer' and file_scope = '{src/cart}' and expires_at > now() + interval '23 hours' from projects.concurrency_leases where task_id = :'T1_id'),
  'the lease is the task''s specialist, its affected files, and a day');
select pg_temp.check(exists (select 1 from audit.audit_log where action = 'orchestrator.lease_claimed' and subject_id = (select id from projects.concurrency_leases where task_id = :'T1_id')), 'the claim is audited');

select pg_temp.as_user(:'U', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_task(:'T2_id')) = 'path_lease_conflict', 'a second task on files inside the leased ones is refused: path_lease_conflict');
reset role;
select pg_temp.check((select status from projects.tasks where id = :'T2_id') = 'todo', 'the refused task stays todo');
select pg_temp.check(not exists (select 1 from projects.concurrency_leases where task_id = :'T2_id'), 'the refused task holds no lease');

select pg_temp.as_user(:'U', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_task(:'T3_id')) = 'started', 'a task on other files starts beside it');
select pg_temp.check((select outcome from projects.start_task(:'T4_id')) = 'started', 'a task that names no files starts');
reset role;
select pg_temp.check((select count(*) from projects.concurrency_leases where task_id = :'T4_id') = 0, 'a task with no affected files holds no lease (nothing to protect)');

select pg_temp.as_user(:'U', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_task(:'TQ_id')) = 'started', 'a project outside Phase 5 still starts its task');
reset role;
select pg_temp.check((select count(*) from projects.concurrency_leases where task_id = :'TQ_id') = 0, 'a project with no phase_five row claims no lease');

-- a lease nobody can call as a person: the internal claim is not granted to any request role
select pg_temp.check(not has_function_privilege('authenticated', 'projects.claim_lease_internal(uuid,text,text[],integer)', 'execute')
                 and not has_function_privilege('service_role', 'projects.claim_lease_internal(uuid,text,text[],integer)', 'execute'), 'the lease claim without a role gate is callable by no request role');

-- (the hand-off and acceptance rules are not under test: they are switched off for these status moves, inside this rolled-back transaction)
alter table projects.tasks disable trigger refuse_review_without_hand_off;
alter table projects.tasks disable trigger tasks_require_acceptance_to_finish;
-- release: in_review frees the files for the task that was refused
update projects.tasks set status = 'in_review' where id = :'T1_id';
select pg_temp.check((select state = 'released' and release_reason like 'task left in_progress: in_review%' from projects.concurrency_leases where task_id = :'T1_id'), 'leaving in_progress for in_review releases the lease');
select pg_temp.check(exists (select 1 from audit.audit_log where action = 'orchestrator.lease_released' and subject_id = (select id from projects.concurrency_leases where task_id = :'T1_id')), 'the release is audited');
select pg_temp.as_user(:'U', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_task(:'T2_id')) = 'started', 'the refused task starts once the files are free');
reset role;
update projects.tasks set status = 'cancelled', cancel_reason = 'zztest superseded' where id = :'T3_id';
select pg_temp.check((select state = 'released' from projects.concurrency_leases where task_id = :'T3_id'), 'cancelling a started task releases its lease');
update projects.tasks set status = 'in_review' where id = :'T2_id';
select pg_temp.check((select state = 'released' from projects.concurrency_leases where task_id = :'T2_id'), 'a second task''s lease also ends at review');
update projects.tasks set status = 'done' where id = :'T2_id';
select pg_temp.check((select state = 'released' from projects.concurrency_leases where task_id = :'T2_id'), 'finishing a task releases its lease');
select pg_temp.check((select count(*) from projects.concurrency_leases where state = 'active' and project_id = :'P_id') = 0, 'no lease is left active once every task has left in_progress');

-- a lease on todo work (an agent claimed first) also stops a start: the lease, not only an in_progress task, is what is checked
set local session_replication_role = replica;
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'P_id', 'zztest holder', 'todo', 'backend_developer', '{src/pay}') returning id \gset TH_
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'P_id', 'zztest wants pay', 'todo', 'backend_developer', '{src/pay/x.ts}') returning id \gset TW_
update projects.tasks set requirement_version_id = :'RV_id' where id in (:'TH_id', :'TW_id');
set local session_replication_role = origin;
set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true);
select outcome as o_h from projects.claim_concurrency_lease(:'TH_id', 'backend_developer', array['src/pay']) \gset
reset role;
select pg_temp.check(:'o_h' = 'claimed', 'an agent claims src/pay for a task that has not started');
select pg_temp.as_user(:'U', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_task(:'TW_id')) = 'path_lease_conflict', 'a task on src/pay/x.ts is refused while that lease is live, though nothing is in_progress');
reset role;

-- ── 2. QA events ────────────────────────────────────────────────────────────
-- a planned task (plan_id set; the plan row is not what is under test), a closed failing run, a closed passing run, an open run, a run for an unplanned task
set local session_replication_role = replica;
insert into projects.tasks (organization_id, project_id, title, status, plan_id) values (:'ORG', :'P_id', 'zztest qa planned', 'todo', gen_random_uuid()) returning id \gset QT_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORG', :'P_id', 'zztest qa unplanned', 'todo') returning id \gset QU_
insert into qa.test_runs (organization_id, project_id, deliverable_id, suite, total, passed, failed, skipped, blocked, status, started_at, ended_at, executed_by_agent, evidence_url)
  values (:'ORG', :'P_id', gen_random_uuid(), 'functional', 4, 3, 1, 0, 0, 'closed', now(), now(), 'test_automation', 'https://ci.example.test/1') returning id \gset RF_
insert into qa.test_runs (organization_id, project_id, deliverable_id, suite, total, passed, failed, skipped, blocked, status, started_at, ended_at, executed_by_agent, evidence_url)
  values (:'ORG', :'P_id', gen_random_uuid(), 'functional', 4, 4, 0, 0, 0, 'closed', now(), now(), 'test_automation', 'https://ci.example.test/2') returning id \gset RP_
insert into qa.test_runs (organization_id, project_id, deliverable_id, suite, total, passed, failed, skipped, blocked, status, started_at, executed_by_agent, evidence_url)
  values (:'ORG', :'P_id', gen_random_uuid(), 'functional', 2, 2, 0, 0, 0, 'open', now(), 'test_automation', 'https://ci.example.test/3') returning id \gset RO_
insert into qa.test_runs (organization_id, project_id, deliverable_id, suite, total, passed, failed, skipped, blocked, status, started_at, ended_at, executed_by_agent, evidence_url)
  values (:'ORG', :'P_id', gen_random_uuid(), 'functional', 2, 1, 0, 0, 1, 'closed', now(), now(), 'test_automation', 'https://ci.example.test/4') returning id \gset RB_
set local session_replication_role = origin;

insert into projects.task_test_evidence (organization_id, project_id, task_id, test_run_id) values (:'ORG', :'P_id', :'QT_id', :'RF_id');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.dev_task_qa_failed' and subject_id = :'QT_id') = 1, 'a closed run with a failure linked to a planned task announces QA failed');
select pg_temp.check((select payload->>'taskId' = :'QT_id' and payload->>'projectId' = :'P_id' and payload->>'testRunId' = :'RF_id' from core.outbox_events where type = 'project.dev_task_qa_failed' and subject_id = :'QT_id'),
  'the event names the task, the project and the run');
insert into projects.task_test_evidence (organization_id, project_id, task_id, test_run_id) values (:'ORG', :'P_id', :'QT_id', :'RP_id');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.dev_task_qa_passed' and subject_id = :'QT_id') = 1, 'a closed run that passed everything announces QA passed');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.dev_task_qa_failed' and subject_id = :'QT_id') = 1, 'the pass did not announce a second failure');
insert into projects.task_test_evidence (organization_id, project_id, task_id, test_run_id) values (:'ORG', :'P_id', :'QT_id', :'RB_id');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.dev_task_qa_failed' and subject_id = :'QT_id') = 2, 'a run with a blocked case is a failure, never a pass');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.dev_task_qa_passed' and subject_id = :'QT_id') = 1, 'and it announced no pass');
insert into projects.task_test_evidence (organization_id, project_id, task_id, test_run_id) values (:'ORG', :'P_id', :'QT_id', :'RO_id');
select pg_temp.check((select count(*) from core.outbox_events where type in ('project.dev_task_qa_failed', 'project.dev_task_qa_passed') and subject_id = :'QT_id') = 3, 'an open run (counts not final) announces nothing');
insert into projects.task_test_evidence (organization_id, project_id, task_id, test_run_id) values (:'ORG', :'P_id', :'QU_id', :'RF_id');
select pg_temp.check(not exists (select 1 from core.outbox_events where subject_id = :'QU_id' and type like 'project.dev_task_qa_%'), 'a task outside a plan announces nothing');

insert into qa.defects (organization_id, project_id, task_id, severity, title, reproduction) values (:'ORG', :'P_id', :'QT_id', 'major', 'zztest total is wrong', 'add two items') returning id \gset D_
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.dev_task_qa_failed' and subject_id = :'QT_id') = 3 and
                     (select payload->>'defectId' = :'D_id' from core.outbox_events where type = 'project.dev_task_qa_failed' and subject_id = :'QT_id' order by id desc limit 1), 'a defect raised against a planned task announces QA failed, naming the defect');
insert into qa.defects (organization_id, project_id, severity, title, reproduction) values (:'ORG', :'P_id', 'minor', 'zztest not about a task', 'look');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.dev_task_qa_failed') = 3, 'a defect with no task announces nothing');
select pg_temp.check((select count(*) from core.event_types where type in ('project.dev_task_qa_failed', 'project.dev_task_qa_passed')) = 2, 'both event types are registered');

\echo PHASE 5 WIRING OK
rollback;
