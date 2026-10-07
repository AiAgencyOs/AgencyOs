-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 7b: the Phase 7 journey of verify-phase-seven.sql (repeated here because every later check needs a COMPLETED pipeline project), with the client portal acceptance REQUEST in place of two staff-typed records, and the Phase 7b checks added.
--
--   entry gate (M4 + the exact candidate) -> deployment plan -> readiness -> Admin approval (creator != approver) -> deployment RECORD (service-role door only,
--   honest blocker when the executor is not configured) -> smoke failure -> incident -> Admin-approved rollback -> re-validation -> config recovery
--   -> ProductionValidated -> change after Phase 6 (config-only re-smoke, code change -> new candidate) -> handover package (versioned, secrets refused) ->
--   Admin review (edit -> new version) -> delivery -> client acceptance of the EXACT version -> final financial clearance -> completion gate -> ONE immutable
--   completion record and a frozen Customer Success intake.
--
-- NOTHING IS DEPLOYED. The real deployment executor needs production credentials (an owner binding); every "runner" call below is the service-role door a real
-- executor WOULD call, made by this script. Upstream Phase 6 evidence (the approved candidate, its gates) is seeded with triggers off; every Phase 7 rule is exercised live.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-seven.sql          (rolls back)
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
create or replace function pg_temp.as_client(p_sub uuid, p_org uuid, p_account uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
  'app_metadata', jsonb_build_object('organization_id', p_org, 'role', 'client_member', 'client_account_id', p_account))::text, true); end $$;
grant execute on function pg_temp.as_client(uuid, uuid, uuid) to public;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true); end $$;
grant execute on function pg_temp.as_service() to public;
-- a statement a rule must refuse (restrict / check violation); the needle is part of the rule's own message
create or replace function pg_temp.refused(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when restrict_violation or check_violation then return position(needle in sqlerrm) > 0; end $$;
grant execute on function pg_temp.refused(text, text) to public;
create or replace function pg_temp.denied(stmt text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when insufficient_privilege then return true; end $$;
grant execute on function pg_temp.denied(text) to public;
-- the doors set a transaction-local flag; in ONE test transaction it would still be on, so a raw-write test resets it first
create or replace function pg_temp.door_off() returns void language plpgsql as $$
begin perform set_config('projects.p7_door', '', true); end $$;
grant execute on function pg_temp.door_off() to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORG2 '00000000-0000-4000-8000-0000000000b2'
\set OWNER '00000000-0000-4000-8000-00000000a701'
\set DL '00000000-0000-4000-8000-00000000a702'
\set QA '00000000-0000-4000-8000-00000000a703'
\set OTHER '00000000-0000-4000-8000-00000000a704'
\set OPS '00000000-0000-4000-8000-00000000a705'
\set H1 '1111111111111111111111111111111111111111111111111111111111111111'
\set H2 '2222222222222222222222222222222222222222222222222222222222222222'
\set HX '9999999999999999999999999999999999999999999999999999999999999999'

insert into core.organizations (id, name, slug) values (:'ORG2', 'zztest p7 other org', 'zztest-p7-other') on conflict do nothing;
insert into auth.users (id, email) values (:'OWNER', 'p7-owner@example.test'), (:'DL', 'p7-dl@example.test'), (:'QA', 'p7-qa@example.test'), (:'OTHER', 'p7-other@example.test'), (:'OPS', 'p7-ops@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'p7-owner@example.test', 'P7 Owner'), (:'DL', 'p7-dl@example.test', 'P7 Delivery Lead'), (:'QA', 'p7-qa@example.test', 'P7 QA'), (:'OTHER', 'p7-other@example.test', 'P7 Other'), (:'OPS', 'p7-ops@example.test', 'P7 Ops Admin') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner'), (:'ORG', :'DL', 'delivery_lead'), (:'ORG', :'QA', 'member'), (:'ORG2', :'OTHER', 'owner'), (:'ORG', :'OPS', 'ops_admin') on conflict do nothing;

insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p7 client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code, status) values (:'ORG', :'A_id', 'zztest p7', 'ZP7-E2E', 'active') returning id \gset P_
insert into projects.projects (organization_id, client_account_id, name, project_code, status) values (:'ORG', :'A_id', 'zztest p7 legacy', 'ZP7-LEGACY', 'active') returning id \gset L_
select set_config('p7.p', :'P_id', false), set_config('p7.legacy', :'L_id', false), set_config('p7.org', :'ORG', false);
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'P_id', 'M1', 1, 50000, 'INR'), (:'ORG', :'P_id', 'M2', 2, 100000, 'INR'), (:'ORG', :'P_id', 'M3', 3, 100000, 'INR');
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'P_id', 'M4', 4, 100000, 'INR') returning id \gset MS4_

-- the Phase 6 evidence a candidate needs to satisfy every hard gate (seeded with triggers off: Phase 6 itself is proven by verify-phase-four-e2e.sql)

-- ═════════ the extra actors this verifier needs: three portal clients (two in the project's account, one in another) and a contact for the Phase 8 gate ═════════
\set CL1 '00000000-0000-4000-8000-00000000a781'
\set CL2 '00000000-0000-4000-8000-00000000a782'
\set CL3 '00000000-0000-4000-8000-00000000a783'
insert into auth.users (id, email) values (:'CL1', 'p7b-cl1@example.test'), (:'CL2', 'p7b-cl2@example.test'), (:'CL3', 'p7b-cl3@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'CL1', 'p7b-cl1@example.test', 'Asha Verma'), (:'CL2', 'p7b-cl2@example.test', 'Ravi Menon'), (:'CL3', 'p7b-cl3@example.test', 'Other Client') on conflict do nothing;
update core.users set full_name = case id when :'CL1' then 'Asha Verma' when :'CL2' then 'Ravi Menon' else 'Other Client' end where id in (:'CL1', :'CL2', :'CL3');
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p7b other client account') returning id \gset A2_
insert into crm.contacts (organization_id, client_account_id, full_name, email) values (:'ORG', :'A_id', 'Asha Verma', 'asha@client.example.test');
create or replace function pg_temp.seed_candidate(p_org uuid, p_project uuid, p_commit text, p_version int, p_hash text, p_owner uuid) returns uuid language plpgsql as $$
declare v_del uuid; v_plan uuid; v_c uuid;
begin
  update qa.release_candidates set status = 'superseded' where project_id = p_project and status = 'approved';
  update qa.master_test_plans set status = 'superseded' where project_id = p_project and status = 'approved';
  insert into projects.deliverables (organization_id, project_id, kind, version, title, status) values (p_org, p_project, 'build', p_version, 'build v' || p_version, 'approved') returning id into v_del;
  insert into projects.deliverable_details (deliverable_id, organization_id, project_id, commit_ref, admin_status, admin_decided_at, qa_status, qa_decided_at) values (v_del, p_org, p_project, p_commit, 'approved', now(), 'passed', now());
  insert into qa.master_test_plans (organization_id, project_id, intake_id, version, status, commit_ref, required_categories, approved_by, approved_at) values (p_org, p_project, gen_random_uuid(), p_version, 'approved', p_commit, array['security'], p_owner, now()) returning id into v_plan;
  insert into qa.phase6_cases (organization_id, project_id, plan_id, title, acceptance_criterion, category, priority, status, result_commit, evidence_ref, executed_by, executed_at) values (p_org, p_project, v_plan, 'login works', 'a user can log in', 'security', 'critical', 'pass', p_commit, 'https://ci.example.test/case/1', p_owner, now());
  insert into projects.build_runs (organization_id, project_id, deliverable_id, commit_ref, environment, status, artifact_sha256, stages, fingerprint) values (p_org, p_project, v_del, p_commit, 'review', 'succeeded', p_hash, '[{"stage": "build"}]', '{"node": "22"}');
  insert into qa.release_candidates (organization_id, project_id, plan_id, intake_id, version, status, commit_ref, build_deliverable_id, artifact_sha256, config_version, rollback_plan, rollback_owner, observability_notes, known_limitations, approved_by, approved_at)
  values (p_org, p_project, v_plan, gen_random_uuid(), p_version, 'approved', p_commit, v_del, p_hash, 'cfg-' || p_version, 'redeploy the previous artifact', 'ops lead', 'error rate and latency dashboards', '["Export is slow above 10k rows", "Safari 15 is untested"]', p_owner, now()) returning id into v_c;
  insert into qa.category_results (organization_id, candidate_id, category, status, commit_ref, evidence_ref) values (p_org, v_c, 'security', 'pass', p_commit, 'https://ci.example.test/security/' || p_version);
  return v_c;
end $$;
grant execute on function pg_temp.seed_candidate(uuid, uuid, text, int, text, uuid) to public;

-- triggers off for the Phase 6 FIXTURE only (a top-level SET: a function may not set the parameter on a non-superuser connection)
set local session_replication_role = replica;
select pg_temp.seed_candidate(:'ORG', :'P_id', 'abc1234', 1, :'H1', :'OWNER') as c \gset C1_
set local session_replication_role = origin;
select set_config('p7.c1', :'C1_c', false);
select pg_temp.check((select count(*) = 0 from qa.evaluate_hard_gates(:'C1_c'::uuid) where not satisfied), 'the seeded Phase 6 candidate satisfies every hard gate (the fixture is honest)');
set local session_replication_role = replica;
insert into projects.phase_completions (organization_id, project_id, phase, completed_by) values (:'ORG', :'P_id', 6, :'OWNER') returning id \gset PC_
insert into projects.phase_six_handoffs (organization_id, project_id, phase_completion_id, candidate_id, commit_ref, artifact_sha256, payload)
  values (:'ORG', :'P_id', :'PC_id', :'C1_c', 'abc1234', :'H1', jsonb_build_object('knownLimitations', jsonb_build_array('Export is slow above 10k rows', 'Safari 15 is untested'), 'scopeVersionId', gen_random_uuid(), 'readiness', jsonb_build_object('score', 90, 'band', 'strong')));
set local session_replication_role = origin;

-- ═════════ 1. the entry gate: Phase6Completed + the exact candidate + M4 verified ═════════
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.open_phase_seven(:'L_id')) = 'phase_six_incomplete', 'NEGATIVE: a project that never completed Phase 6 cannot open Phase 7');
select pg_temp.check((select outcome from projects.open_phase_seven(:'P_id')) = 'waiting_m4_verification', 'P701-T001: M4 not verified - Phase 7 is created but BLOCKED (WAITING_M4_VERIFICATION)');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.phase_seven_ready' and subject_id = (select id from projects.phase_seven where project_id = :'P_id')) = 0, 'no Phase7Ready is emitted while M4 is pending');
select pg_temp.check((select count(*) = 2 from projects.p7_known_limitations where project_id = :'P_id' and source = 'phase6_intake'), 'the Phase 6 intake''s known limitations are carried into Phase 7');
reset role;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.create_deployment_plan(:'P_id', 'prod-app-1', '{"none": true, "reason": "no schema change"}')) = 'phase_seven_not_ready', 'a deployment plan cannot be created while Phase 7 is not ready');
reset role;

-- M4 is invoiced, paid and verified in full through the real finance doors
select pg_temp.as_service();
set local role service_role;
select invoice_id as i from finance.create_milestone_invoice(:'ORG', :'A_id', :'P_id', :'MS4_id', 'ZP7-M4-1', 'INR', 100000, 0, 100000, '[{"position":0,"description":"M4 - 20%","quantity":1,"unit_price_minor":100000,"amount_minor":100000,"tax_rate_bp":0}]', now() + interval '7 days', null, null) \gset I4_
select finance.issue_invoice(:'I4_i', now() + interval '7 days');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(not projects.m4_verified_paid(:'P_id'), 'M4 issued but unpaid: the financial gate is closed');
select payment_id as pid from finance.record_manual_payment(:'I4_i', 'UTR-P7-M4', 100000, now(), 'upi') \gset PY4_
select pg_temp.check(not projects.m4_verified_paid(:'P_id'), 'a recorded payment that nobody verified does not open the gate');
select finance.verify_payment(:'PY4_pid', :'OWNER');
select pg_temp.check(projects.m4_verified_paid(:'P_id'), 'M4 verified paid in full by the owner');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.open_phase_seven(:'P_id')) = 'ready', 'Phase 7 is READY once M4 is verified and the exact candidate is current');
select pg_temp.check((select outcome from projects.open_phase_seven(:'P_id')) = 'already_started', 'a duplicate Phase7Ready is idempotent');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.phase_seven_ready' and subject_id = (select id from projects.phase_seven where project_id = :'P_id')) = 1, 'exactly one Phase7Ready event exists');
select pg_temp.check((select state = 'phase7_ready' and candidate_id = :'C1_c'::uuid and commit_ref = 'abc1234' from projects.phase_seven where project_id = :'P_id'), 'the workspace is bound to the exact Phase 6 candidate');
reset role;
select pg_temp.as_user(:'OTHER', :'ORG2', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.open_phase_seven(:'P_id')) in ('no_actor', 'unknown_project', 'forbidden'), 'cross-tenant: another organization cannot open or touch this Phase 7');
select pg_temp.check((select count(*) from projects.phase_seven) = 0, 'cross-tenant: another organization reads no Phase 7 workspace');
reset role;

-- ═════════ 2. the deployment plan (exact candidate, readiness by name, Admin approval) ═════════
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.create_deployment_plan(:'P_id', 'prod-app-1', '{"steps": [{"order": 2, "name": "b", "reversible": true}, {"order": 1, "name": "a", "reversible": true}]}')) = 'bad_migration_plan', 'a migration plan with steps out of order is refused');
select pg_temp.check((select outcome from projects.create_deployment_plan(:'P_id', 'prod-app-1', '{"steps": [{"order": 1, "name": "drop old column", "reversible": false}]}')) = 'bad_migration_plan', 'an irreversible step without a stated backup is refused');
select pg_temp.check((select outcome from projects.create_deployment_plan(:'P_id', 'https://deploy:' || 'hunter2pass@prod.example.test', '{"none": true, "reason": "no schema change"}')) = 'contains_secret', 'P704-T003: a target that carries a credential is refused, never stored');
select pg_temp.check((select outcome from projects.create_deployment_plan(:'P_id', 'prod-app-1', '{"none": true, "reason": "no schema change"}', 'redeploy the previous artifact', null, 'ops lead', 'dashboards and alerting')) = 'created', 'the plan is created for the exact candidate (no rollback target yet)');
reset role;
select id as "PL1_id" from projects.p7_deployment_plans where project_id = :'P_id' and status = 'draft' \gset
select pg_temp.check((select commit_ref = 'abc1234' and artifact_sha256 = :'H1' and candidate_id = :'C1_c'::uuid and status = 'draft' from projects.p7_deployment_plans where id = :'PL1_id'), 'P701-T002: the plan''s commit and artifact are RESOLVED from the Phase 6 candidate, never typed');
select pg_temp.check((select state = 'deployment_planning' from projects.phase_seven where project_id = :'P_id'), 'Phase 7 is DEPLOYMENT_PLANNING');

-- ═════════ 2b. readiness by NAME, the Admin decision, creator != approver ═════════
create or replace function pg_temp.ready_plan(p_plan uuid) returns void language plpgsql as $$
begin
  perform projects.record_readiness_item(p_plan, 'environment', 'production host', 'ready', 'https://runbook.example.test/env/prod');
  perform projects.record_readiness_item(p_plan, 'config_ref', 'DATABASE_URL', 'ready', 'present in the production secret store (name only)');
  perform projects.record_readiness_item(p_plan, 'secret_ref', 'STRIPE_SECRET_KEY', 'ready', 'present in the production secret store (name only)');
  perform projects.record_readiness_item(p_plan, 'monitoring', 'uptime probe', 'ready', 'https://monitor.example.test/probe/1');
  perform projects.record_readiness_item(p_plan, 'manual_dns', 'apex domain', 'ready', 'https://tickets.example.test/dns/77', 'client', 'the client points the A record at the production host');
end $$;
grant execute on function pg_temp.ready_plan(uuid) to public;

select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select not satisfied from projects.deployment_gate(:'PL1_id') where gate = 'rollback_ready'), 'P706-T003: an unknown rollback target blocks the deployment gate');
select pg_temp.check((select outcome from projects.request_deployment_approval(:'PL1_id')) = 'not_ready', 'approval cannot be requested while a gate is unsatisfied');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select plan_id as pl from projects.create_deployment_plan(:'P_id', 'prod-app-1', '{"none": true, "reason": "no schema change"}', 'redeploy the previous artifact', 'v0-previous-stable', 'ops lead', 'dashboards and alerting') \gset PL2_
select pg_temp.check((select status = 'superseded' from projects.p7_deployment_plans where id = :'PL1_id') and (select version = 2 from projects.p7_deployment_plans where id = :'PL2_pl'), 'a new plan supersedes the old one (one live plan)');
select pg_temp.check((select outcome from projects.record_readiness_item(:'PL2_pl', 'environment', 'production host', 'ready', null)) = 'evidence_required', 'ready is evidence, not an assertion');
select pg_temp.check((select outcome from projects.record_readiness_item(:'PL2_pl', 'config_ref', 'x=y', 'ready', 'e')) = 'bad_name', 'a configuration reference is a NAME, not a value');
select pg_temp.check((select outcome from projects.record_readiness_item(:'PL2_pl', 'secret_ref', 'STRIPE_SECRET_KEY', 'ready', 'present', null, null, 'rotated ' || 'sk-' || repeat('a', 24))) = 'contains_secret', 'P704-T003: a secret VALUE in a readiness note is refused, never stored');
select pg_temp.check((select outcome from projects.record_readiness_item(:'PL2_pl', 'manual_dns', 'apex domain', 'blocked_manual_external', null, 'client')) = 'instruction_required', 'a manual external step carries its exact instruction');
select pg_temp.ready_plan(:'PL2_pl');
select projects.record_readiness_item(:'PL2_pl', 'manual_dns', 'apex domain', 'blocked_manual_external', null, 'client', 'the client points the A record at the production host');
select pg_temp.check((select array_to_string(missing, '|') like '%manual_external_steps%' from projects.request_deployment_approval(:'PL2_pl')), 'P704-T010: a pending DNS step is BLOCKED_MANUAL_EXTERNAL and blocks approval');
select pg_temp.check((select count(*) = 9 and count(*) filter (where satisfied) = 8 from projects.deployment_gate(:'PL2_pl')), 'nine gates, eight satisfied (all but the manual external step)');
select projects.record_readiness_item(:'PL2_pl', 'manual_dns', 'apex domain', 'ready', 'https://tickets.example.test/dns/77', 'client', 'the client points the A record at the production host');
select pg_temp.check((select count(*) = 9 and bool_and(satisfied) from projects.deployment_gate(:'PL2_pl')), 'every deployment gate is satisfied');
select pg_temp.check((select outcome from projects.request_deployment_approval(:'PL2_pl')) = 'requested', 'approval is requested for the exact candidate');
select pg_temp.check((select outcome from projects.request_deployment_approval(:'PL2_pl')) = 'already_requested', 'a duplicate request changes nothing');
select pg_temp.check((select outcome from projects.record_readiness_item(:'PL2_pl', 'environment', 'staging mirror', 'ready', 'https://x.example.test/1')) = 'plan_frozen', 'a plan sent for approval is frozen');
select pg_temp.check((select outcome from projects.decide_deployment_plan(:'PL2_pl', 'approve')) = 'creator_cannot_approve', 'the person who built the plan cannot approve it (creator != approver)');
reset role;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_deployment_plan(:'PL2_pl', 'approve')) = 'not_authorized', 'a delivery lead cannot approve a deployment: an Admin decides');
reset role;
select pg_temp.as_user(:'OPS', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_deployment_plan(:'PL2_pl', 'request_changes')) = 'note_required', 'a request for changes says what to change');
select pg_temp.check((select outcome from projects.decide_deployment_plan(:'PL2_pl', 'request_changes', 'name the on-call owner in the monitoring plan')) = 'sent_back', 'the Admin sends the plan back');
reset role;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.request_deployment_approval(:'PL2_pl')) = 'requested', 'the plan is requested again after the change');
reset role;
select pg_temp.as_user(:'OPS', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_deployment_plan(:'PL2_pl', 'approve', 'reviewed')) = 'approved', 'an Admin approves deployment of the EXACT commit and artifact');
select pg_temp.check((select commit_ref = 'abc1234' and artifact_sha256 = :'H1' and decision = 'approve' from projects.p7_deployment_approvals where plan_id = :'PL2_pl' and decision = 'approve'), 'the approval names the exact commit and artifact');
select pg_temp.check((select count(*) = 1 from core.outbox_events where type = 'project.deployment_approved' and subject_id = :'PL2_pl'::uuid), 'DeploymentApproved was emitted once');
select pg_temp.check(projects.p7_deployment_approved(:'PL2_pl'), 'the approval holds while the candidate is the current approved one');
reset role;

-- raw writes are refused: the plan, the approval and the deployment record change only through their doors
select pg_temp.door_off();
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(pg_temp.refused(format('update projects.p7_deployment_plans set commit_ref = %L where id = %L', 'zzz9999', :'PL2_pl'), 'through its doors'), 'a deployment plan is not edited by a direct statement');
select pg_temp.check(pg_temp.refused(format('insert into projects.p7_deployments (organization_id, project_id, phase_seven_id, plan_id, candidate_id, commit_ref, artifact_sha256, environment, attempt, idempotency_key, status) select organization_id, project_id, phase_seven_id, id, candidate_id, commit_ref, artifact_sha256, environment, 9, %L, %L from projects.p7_deployment_plans where id = %L', 'raw', 'approved', :'PL2_pl'), 'service-role runner door'), 'a deployment record cannot be fabricated by a direct insert');
select pg_temp.check(pg_temp.refused(format('delete from projects.p7_deployment_approvals where plan_id = %L', :'PL2_pl'), 'history'), 'an approval is history');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.denied(format('insert into projects.p7_deployments (organization_id, project_id, phase_seven_id, plan_id, candidate_id, commit_ref, artifact_sha256, environment, attempt, idempotency_key) values (%L, %L, %L, %L, %L, %L, %L, %L, 1, %L)', :'ORG', :'P_id', gen_random_uuid(), :'PL2_pl', :'C1_c', 'abc1234', :'H1', 'production', 'x')), 'even the owner has no write grant on a deployment record');
reset role;
-- the exact-candidate rule on the plan row itself (the door flag is on here, so only the rule can refuse)
select set_config('projects.p7_door', 'on', true);
select pg_temp.check(pg_temp.refused(format('insert into projects.p7_deployment_plans (organization_id, project_id, phase_seven_id, candidate_id, version, status, commit_ref, artifact_sha256, environment, target_ref, migration_plan) select organization_id, project_id, id, candidate_id, 77, %L, %L, artifact_sha256, %L, %L, %L::jsonb from projects.phase_seven where project_id = %L', 'superseded', 'zzz9999', 'production', 'prod', '{"none": true, "reason": "x"}', :'P_id'), 'exactly the Phase 6 approved candidate'), 'P701-T002: a plan for a different commit than the approved candidate cannot exist');
select pg_temp.door_off();

-- ═════════ 3. the deployment RECORD: service-role runner door only; the executor is NOT configured, so it records a blocker ═════════
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check(pg_temp.denied(format('select projects.request_deployment(%L, %L)', :'PL2_pl', 'k1')), 'a person cannot write a deployment record: the door is the runner''s');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.request_deployment(:'PL1_id', 'old')) = 'not_approved', 'a superseded plan cannot be deployed');
select outcome as o, deployment_id as d from projects.request_deployment(:'PL2_pl', 'k1') \gset D1_
select pg_temp.check(:'D1_o' = 'requested', 'the runner records a deployment of the approved plan');
select pg_temp.check((select outcome from projects.request_deployment(:'PL2_pl', 'k1')) = 'already_requested', 'P704-T011: a duplicate deployment request creates no second deployment');
select pg_temp.check((select outcome from projects.request_deployment(:'PL2_pl', 'k2')) = 'deployment_in_progress', 'a different key while one is live creates no second deployment either');
select pg_temp.check((select status = 'approved' and executor = 'not_configured' from projects.p7_deployments where id = :'D1_d'), 'the deployment is APPROVED and no executor is configured');
select pg_temp.check((select outcome from projects.record_deployment_blocker(:'D1_d', 'executor_not_configured', 'no production executor is bound: needs the owner''s production credentials')) = 'blocked', 'the not-configured executor records an honest blocker');
select pg_temp.check((select status = 'approved' and blocker_code = 'executor_not_configured' from projects.p7_deployments where id = :'D1_d'), 'the status did NOT move: nothing was deployed');
select pg_temp.check((select count(*) = 1 from projects.p7_deployment_events where deployment_id = :'D1_d' and kind = 'blocker' and blocker_code = 'executor_not_configured'), 'the blocker is in the run log');
select pg_temp.check((select outcome from projects.record_deployment_blocker(:'D1_d', 'credential_missing', 'token=' || 'abcdef123456')) = 'contains_secret', 'a blocker detail never carries a secret');
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D1_d', 'succeeded_pending_validation', 'https://ci.example.test/deploy/1', null, null, :'H1')) = 'bad_transition', 'a deployment cannot report success without having started');
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D1_d', 'started', null, null, :'DL', :'HX')) = 'wrong_artifact', 'P704-T001: a wrong artifact is blocked');
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D1_d', 'started', null, null, :'DL', :'H1')) = 'recorded', 'the runner records DeploymentStarted');
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D1_d', 'started', null, null, :'DL', :'H1')) = 'already_recorded', 'a duplicate command callback is a no-op');
select pg_temp.check((select state = 'deploying' from projects.phase_seven where project_id = :'P_id'), 'Phase 7 is DEPLOYING');
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D1_d', 'succeeded_pending_validation', null, null, :'DL', :'H1')) = 'evidence_required', 'success needs evidence');
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D1_d', 'succeeded_pending_validation', 'https://ci.example.test/deploy/1', null, :'DL', :'HX')) = 'wrong_artifact', 'success must name the candidate''s own artifact, byte for byte');
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D1_d', 'succeeded_pending_validation', 'https://ci.example.test/deploy/1', 'deployed', :'DL', :'H1')) = 'recorded', 'DeploymentSucceeded is recorded: pending live validation');
select pg_temp.check((select status = 'succeeded_pending_validation' from projects.p7_deployments where id = :'D1_d'), 'the status is SUCCEEDED_PENDING_VALIDATION, not "validated"');
select pg_temp.check((select state = 'post_deployment_validation' from projects.phase_seven where project_id = :'P_id'), 'Phase 7 is POST_DEPLOYMENT_VALIDATION');
select pg_temp.check(pg_temp.denied(format('select projects.open_validation_run(%L, %L)', :'D1_d', 'smoke')), 'P705-T010: a service-role caller (the deploy agent) cannot validate production');
select pg_temp.check((select count(*) = 0 from projects.p7_production_validation(:'P_id')), 'P704-T008: nothing declares ProductionValidated from a deployment claim');
reset role;

-- ═════════ 4. production validation: independent, evidenced, truth states, a failure PAUSES completion ═════════
create or replace function pg_temp.pass_all(p_run uuid, p_fail text default null) returns void language plpgsql as $$
declare k text;
begin
  foreach k in array array['app_starts', 'critical_routes', 'authentication', 'core_api', 'database', 'primary_workflow', 'monitoring_logging', 'no_critical_runtime_error'] loop
    if p_fail is not null and k = p_fail then perform projects.record_validation_check(p_run, k, 'failed', null, k || ' failed in production');
    else perform projects.record_validation_check(p_run, k, 'passed', 'https://smoke.example.test/' || p_run || '/' || k); end if;
  end loop;
end $$;
grant execute on function pg_temp.pass_all(uuid, text) to public;

select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.open_validation_run(:'D1_d', 'smoke')) = 'not_independent', 'the person who executed the deployment does not validate it');
reset role;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.open_validation_run(:'D1_d', 'post_rollback')) = 'deployment_not_rolled_back', 'a post-rollback run is only for a rolled-back deployment');
select run_id as r from projects.open_validation_run(:'D1_d', 'smoke') \gset V1_
select pg_temp.check((select outcome from projects.open_validation_run(:'D1_d', 'smoke')) = 'already_running', 'a duplicate smoke job is deduplicated onto the running run');
select pg_temp.check((select outcome from projects.record_validation_check(:'V1_r', 'app_starts', 'passed')) = 'evidence_required', 'a pass is evidence, not an assertion');
select pg_temp.check((select outcome from projects.record_validation_check(:'V1_r', 'critical_routes', 'failed')) = 'detail_required', 'a failure says what failed');
select pg_temp.check((select outcome from projects.record_validation_check(:'V1_r', 'database', 'passed', 'e', null, false)) = 'core_check_is_required', 'a core check cannot be marked optional');
select projects.record_validation_check(:'V1_r', 'app_starts', 'passed', 'https://smoke.example.test/1/start');
select projects.record_validation_check(:'V1_r', 'authentication', 'passed', 'https://smoke.example.test/1/auth');
select projects.record_validation_check(:'V1_r', 'monitoring_logging', 'not_tested', null, 'the monitoring endpoint was unreachable');
select pg_temp.check((select outcome = 'finished' and status = 'blocked' and cardinality(missing) = 6 from projects.finish_validation_run(:'V1_r')), 'P705-T006: unrecorded or not-tested required checks leave validation BLOCKED, never passed');
select pg_temp.check((select count(*) = 0 from projects.p7_incidents where project_id = :'P_id') and (select not completion_paused from projects.phase_seven where project_id = :'P_id'), 'a blocked run is incomplete validation, not a failure: no incident yet');
select pg_temp.check((select outcome from projects.record_validation_check(:'V1_r', 'database', 'passed', 'e')) = 'run_finished', 'a finished run is frozen');
-- a real failure: the critical routes return 500
select run_id as r from projects.open_validation_run(:'D1_d', 'smoke') \gset V2_
select pg_temp.pass_all(:'V2_r', 'critical_routes');
select pg_temp.check((select outcome = 'finished' and status = 'failed' from projects.finish_validation_run(:'V2_r', 'critical routes returned 500')), 'P705-T002: a required check failed - the run FAILS');
reset role;
select id as "INC1_id" from projects.p7_incidents where deployment_id = :'D1_d' and incident_type = 'runtime_failure' \gset
select pg_temp.check((select count(*) = 1 from projects.p7_incidents where deployment_id = :'D1_d' and state <> 'closed'), 'P706-T001: the failed smoke raised ONE incident');
select pg_temp.check((select completion_paused and paused_reason like '%incident%' from projects.phase_seven where project_id = :'P_id'), 'a failed production check PAUSES completion');
select pg_temp.check((select count(*) = 1 from core.outbox_events where type = 'project.production_validation_failed' and subject_id = :'D1_d'::uuid), 'DeploymentValidationFailed was emitted');
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select run_id as r from projects.open_validation_run(:'D1_d', 'smoke') \gset V3_
select pg_temp.pass_all(:'V3_r', 'authentication');
select projects.finish_validation_run(:'V3_r');
reset role;
select pg_temp.check((select count(*) = 1 from projects.p7_incidents where deployment_id = :'D1_d' and incident_type = 'runtime_failure') and (select count(*) >= 2 from projects.p7_incident_events where incident_id = :'INC1_id' and kind = 'signal'), 'P706-T010: a duplicate failure signal is recorded on the ONE canonical incident');
select pg_temp.check((select count(*) = 0 from projects.p7_production_validation(:'P_id')), 'production is not validated');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome = 'gate_not_satisfied' and array_to_string(missing, '|') like '%production_validated%' and array_to_string(missing, '|') like '%no_open_incident%' from projects.complete_phase_seven(:'P_id')), 'P701-T010: project completion attempted before production validation is DENIED');
select pg_temp.check((select outcome from projects.create_handover_package(:'P_id')) = 'production_not_validated', 'handover waits for ProductionValidated');
reset role;
select pg_temp.door_off();
select pg_temp.check(pg_temp.refused(format('update projects.p7_validation_runs set status = %L where id = %L', 'passed', :'V2_r'), 'validation'), 'a failed validation run cannot be rewritten into a pass');
select pg_temp.check(pg_temp.refused(format('update projects.p7_incidents set state = %L where id = %L', 'closed', :'INC1_id'), 'doors'), 'an incident is not closed by a direct statement');
select pg_temp.check(pg_temp.refused(format('update projects.projects set status = %L where id = %L', 'completed', :'P_id'), 'Phase 7'), 'deployment alone cannot complete a project in the pipeline: a direct status edit is refused');
select pg_temp.check(pg_temp.refused(format('update projects.projects set status = %L, completion_override_reason = %L where id = %L', 'completed', 'the client is in a hurry', :'P_id'), 'Phase 7'), 'and an override reason does not bypass the Phase 7 completion gate');

-- ═════════ 5. incident -> controlled rollback -> re-validation -> close ═════════
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.close_incident(:'INC1_id', 'r', 't', 'a')) = 'not_classified', 'an unclassified incident cannot be closed');
select pg_temp.check((select outcome from projects.classify_incident(:'INC1_id', 'rollback', 'the smoke failure needs the previous version back')) = 'classified', 'the incident is classified (rollback path)');
select pg_temp.check((select outcome from projects.decide_rollback(:'INC1_id', 'v0-previous-stable', 'low', 'approve')) = 'not_authorized', 'a delivery lead cannot approve a rollback');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D1_d', 'rolled_back', 'https://ops.example.test/rb/1')) = 'rollback_not_approved', 'a rollback nobody approved is refused (controlled, not blind)');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_rollback(:'INC1_id', '', 'low', 'approve')) = 'target_unknown', 'P706-T003: an unknown rollback target blocks');
select pg_temp.check((select outcome from projects.decide_rollback(:'INC1_id', 'v0-previous-stable', 'low: no migration ran', 'approve')) = 'approved', 'an Admin approves the rollback to a NAMED target');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D1_d', 'rolled_back')) = 'evidence_required', 'a rollback is recorded with evidence');
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D1_d', 'rolled_back', 'https://ops.example.test/rb/1', 'restored v0')) = 'recorded', 'the approved rollback is recorded');
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D1_d', 'rolled_back', 'https://ops.example.test/rb/1')) = 'already_recorded', 'a duplicate rollback callback is a no-op');
select pg_temp.check((select state = 'rollback_in_progress' from projects.phase_seven where project_id = :'P_id'), 'Phase 7 is ROLLBACK_IN_PROGRESS');
reset role;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select run_id as r from projects.open_validation_run(:'D1_d', 'post_rollback', :'INC1_id') \gset V4_
select pg_temp.pass_all(:'V4_r', 'app_starts');
select projects.finish_validation_run(:'V4_r');
reset role;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.close_incident(:'INC1_id', 'bad route table', 'smoke failed, rolled back', 'add a route test')) = 'recovery_not_verified', 'P706-T008: rollback succeeded but the re-smoke FAILED: the incident stays open');
reset role;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select run_id as r from projects.open_validation_run(:'D1_d', 'post_rollback', :'INC1_id') \gset V5_
select pg_temp.pass_all(:'V5_r');
select pg_temp.check((select outcome = 'finished' and status = 'passed' from projects.finish_validation_run(:'V5_r')), 'the restored version passes the re-smoke');
reset role;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.close_incident(:'INC1_id', '', 't', '')) = 'review_required', 'an incident closes with a root cause and corrective actions, not with silence');
select pg_temp.check((select outcome from projects.close_incident(:'INC1_id', 'route table shipped without the checkout route', 'smoke failed, rolled back, re-smoked', 'add a route test to the pipeline')) = 'closed', 'the incident closes only after the verified recovery AND a review');
select pg_temp.check((select not completion_paused and state = 'deployment_planning' from projects.phase_seven where project_id = :'P_id'), 'completion is un-paused and the rolled-back candidate awaits a new deployment');
reset role;
select pg_temp.door_off();
select pg_temp.check(pg_temp.refused(format('update projects.p7_incidents set root_cause = %L where id = %L', 'rewritten', :'INC1_id'), 'doors'), 'P706-T012: incident history is not edited');

-- ═════════ 6. a code defect never goes back through a deploy retry; a new candidate is required ═════════
select pg_temp.as_service();
set local role service_role;
select outcome as o, deployment_id as d from projects.request_deployment(:'PL2_pl', 'k3') \gset D2_
select pg_temp.check(:'D2_o' = 'requested', 'REDEPLOY of the SAME approved candidate: a new deployment (attempt 2) is recorded');
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D2_d', 'started', null, null, :'DL', :'H1')) = 'recorded', 'attempt 2 starts');
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D2_d', 'failed')) = 'reason_required', 'a failed deployment says why');
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D2_d', 'failed', null, 'checkout rounds 0.5 the wrong way', null, null, 'runner', 'config_failure')) = 'recorded', 'P704-T005: the deployment FAILED');
reset role;
select id as "INC2_id" from projects.p7_incidents where deployment_id = :'D2_d' \gset
select pg_temp.check((select state = 'deployment_failed' from projects.phase_seven where project_id = :'P_id') and (select completion_paused from projects.phase_seven where project_id = :'P_id'), 'Phase 7 is DEPLOYMENT_FAILED and completion is paused');
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D2_d', 'recovered_pending_validation', 'https://ops.example.test/fix/1', null, null, :'H1')) = 'incident_path_is_not_config_recovery', 'an unclassified incident cannot be "recovered" by a retry');
reset role;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.classify_incident(:'INC2_id', 'code', 'a rounding defect in checkout')) = 'classified', 'the incident is a CODE defect');
select pg_temp.check((select count(*) = 1 from projects.p7_change_records where project_id = :'P_id' and kind = 'code_change' and status = 'open'), 'a code change record is opened');
select pg_temp.check((select status = 'superseded' from projects.p7_deployment_plans where id = :'PL2_pl'), 'the approved plan is voided: the code it approved is not what will run');
select pg_temp.check((select outcome from projects.create_deployment_plan(:'P_id', 'prod-app-1', '{"none": true, "reason": "x"}')) = 'code_change_open', 'no new plan until a new approved candidate exists');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D2_d', 'recovered_pending_validation', 'https://ops.example.test/fix/1', null, null, :'H1')) = 'incident_path_is_not_config_recovery', 'P706-T006 / P703-T009: a code defect routed to deploy-retry is refused; it needs a new build and revalidation');
select pg_temp.check((select outcome from projects.request_deployment(:'PL2_pl', 'k4')) = 'not_approved', 'the voided approval cannot deploy anything');
select pg_temp.check((select outcome from projects.rebind_phase_seven_candidate(:'P_id')) = 'unchanged', 'no new candidate exists yet: nothing to rebind');
reset role;
-- Phase 6 raises a NEW governed candidate on the fixed build; first its evidence is incomplete
set local session_replication_role = replica;
select pg_temp.seed_candidate(:'ORG', :'P_id', 'def5678', 2, :'H2', :'OWNER') as c \gset C2_
set local session_replication_role = origin;
set local session_replication_role = replica;
update qa.category_results set status = 'fail', reason = 'regression found', evidence_ref = null where candidate_id = :'C2_c';
set local session_replication_role = origin;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.rebind_phase_seven_candidate(:'P_id')) = 'not_revalidated', 'P701-T005: a new candidate whose Phase 6 gates are not all satisfied is NOT bound');
reset role;
set local session_replication_role = replica;
update qa.category_results set status = 'pass', reason = null, evidence_ref = 'https://ci.example.test/security/2' where candidate_id = :'C2_c';
set local session_replication_role = origin;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.rebind_phase_seven_candidate(:'P_id')) = 'rebound', 'the new candidate (new build, every Phase 6 gate satisfied, Admin-approved) is bound');
select pg_temp.check((select commit_ref = 'def5678' and candidate_id = :'C2_c'::uuid and artifact_sha256 = :'H2' from projects.phase_seven where project_id = :'P_id'), 'Phase 7 now carries the NEW exact candidate');
select pg_temp.check((select status = 'revalidated' and resulting_candidate_id = :'C2_c'::uuid from projects.p7_change_records where project_id = :'P_id' and kind = 'code_change'), 'the code change is closed by the new candidate');
select pg_temp.check((select outcome from projects.rebind_phase_seven_candidate(:'P_id')) = 'unchanged', 'a replayed rebind changes nothing');
reset role;

-- ═════════ 7. the new plan, a stale approval, a config-only recovery, and ProductionValidated ═════════
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select plan_id as pl from projects.create_deployment_plan(:'P_id', 'prod-app-1', '{"steps": [{"order": 1, "name": "add invoice index", "reversible": true}]}', 'redeploy v1 artifact', 'v1-previous-stable', 'ops lead', 'dashboards and alerting') \gset PL3_
select pg_temp.check((select commit_ref = 'def5678' and artifact_sha256 = :'H2' from projects.p7_deployment_plans where id = :'PL3_pl'), 'the new plan carries the NEW candidate''s commit and artifact');
select pg_temp.ready_plan(:'PL3_pl');
select pg_temp.check((select not satisfied from projects.deployment_gate(:'PL3_pl') where gate = 'migration_ready'), 'P704-T004: a migration plan with steps needs a ready ordering/dependency check');
select projects.record_readiness_item(:'PL3_pl', 'migration', 'migration order checked', 'ready', 'https://ci.example.test/migrations/dry-run/1');
select pg_temp.check((select outcome from projects.request_deployment_approval(:'PL3_pl')) = 'requested', 'approval requested for the new candidate');
select pg_temp.check((select outcome from projects.decide_deployment_plan(:'PL3_pl', 'approve')) = 'creator_cannot_approve', 'the creator still cannot approve');
reset role;
select pg_temp.as_user(:'OPS', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_deployment_plan(:'PL3_pl', 'approve', 'reviewed against the new candidate')) = 'approved', 'an Admin approves the new plan');
reset role;
select pg_temp.as_service();
set local role service_role;
select outcome as o, deployment_id as d from projects.request_deployment(:'PL3_pl', 'k5') \gset D3_
select pg_temp.check(:'D3_o' = 'requested', 'a deployment of the new candidate is recorded');
reset role;
-- the source changes after approval: the approval no longer holds
set local session_replication_role = replica;
update projects.deliverable_details set commit_ref = 'zzz9999' where deliverable_id = (select build_deliverable_id from qa.release_candidates where id = :'C2_c');
set local session_replication_role = origin;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(not projects.p7_deployment_approved(:'PL3_pl'), 'a source change after approval voids the approval');
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D3_d', 'started', null, null, :'DL', :'H2')) = 'approval_no_longer_valid', 'P701-T002: the changed build is NOT deployed: execution re-checks the approval');
reset role;
set local session_replication_role = replica;
update projects.deliverable_details set commit_ref = 'def5678' where deliverable_id = (select build_deliverable_id from qa.release_candidates where id = :'C2_c');
set local session_replication_role = origin;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D3_d', 'started', null, null, :'DL', :'H2')) = 'recorded', 'with the build restored the approved candidate deploys');
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D3_d', 'failed', null, 'DATABASE_URL was not set in the production environment', null, null, 'runner', 'config_failure')) = 'recorded', 'a config failure');
reset role;
select id as "INC3_id" from projects.p7_incidents where deployment_id = :'D3_d' \gset
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.classify_incident(:'INC3_id', 'config', 'the variable was missing')) = 'classified', 'this incident is a config-only failure');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D3_d', 'recovered_pending_validation', null, null, null, :'H2')) = 'evidence_required', 'a recovery needs evidence');
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D3_d', 'recovered_pending_validation', 'https://ops.example.test/fix/2', null, null, :'HX')) = 'wrong_artifact', 'a recovery is of the SAME candidate artifact');
select pg_temp.check((select outcome from projects.record_deployment_progress(:'D3_d', 'recovered_pending_validation', 'https://ops.example.test/fix/2', 'set the variable', null, :'H2')) = 'recorded', 'P701-T004: a config-only recovery of the same candidate is recorded as pending re-validation');
reset role;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select run_id as r from projects.open_validation_run(:'D3_d', 'post_recovery', :'INC3_id') \gset V6_
select pg_temp.pass_all(:'V6_r');
select pg_temp.check((select status = 'passed' from projects.finish_validation_run(:'V6_r')), 'the same candidate is re-smoked and passes');
select pg_temp.check((select count(*) = 0 from projects.p7_production_validation(:'P_id')), 'but production is NOT validated while the earlier code incident is still open');
reset role;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.close_incident(:'INC3_id', 'missing environment variable', 'failed then config fixed', 'add the variable to the readiness checklist')) = 'closed', 'the config incident closes after the verified re-smoke');
select pg_temp.check((select completion_paused from projects.phase_seven where project_id = :'P_id'), 'completion stays paused: another incident is still open');
select pg_temp.check((select outcome from projects.close_incident(:'INC2_id', 'rounding defect', 'fixed in a new build', 'add a rounding test')) = 'recovery_not_verified', 'the code incident closes only after a PASSED run on the NEW commit');
reset role;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select run_id as r from projects.open_validation_run(:'D3_d', 'smoke', :'INC2_id') \gset V7_
select pg_temp.pass_all(:'V7_r');
select projects.finish_validation_run(:'V7_r');
reset role;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.close_incident(:'INC2_id', 'rounding defect', 'fixed in a new build', 'add a rounding test')) = 'closed', 'the code incident closes after the new commit is validated in production');
select pg_temp.check((select state = 'production_validated' and not completion_paused from projects.phase_seven where project_id = :'P_id'), 'PRODUCTION_VALIDATED: no incident, not paused');
select pg_temp.check((select deployment_id = :'D3_d'::uuid from projects.p7_production_validation(:'P_id')), 'ProductionValidated names the exact deployment');
select pg_temp.check((select count(*) = 1 from core.outbox_events where type = 'project.production_validated' and subject_id = (select id from projects.phase_seven where project_id = :'P_id')), 'ProductionValidated was emitted once');
-- a config-only change after validation needs a re-smoke of the SAME candidate
select pg_temp.check((select outcome from projects.record_production_change(:'P_id', 'config_only', 'rotate the analytics key')) = 'recorded', 'a config-only production change is recorded');
select pg_temp.check((select outcome from projects.record_production_change(:'P_id', 'config_only', 'another')) = 'change_already_open', 'one open change at a time');
select pg_temp.check((select count(*) = 0 from projects.p7_production_validation(:'P_id')), 'while a change is open, production is not validated');
reset role;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select run_id as r from projects.open_validation_run(:'D3_d', 'smoke') \gset V8_
select pg_temp.pass_all(:'V8_r');
select projects.finish_validation_run(:'V8_r');
select pg_temp.check((select count(*) = 1 from projects.p7_production_validation(:'P_id')) and (select status = 'revalidated' from projects.p7_change_records where project_id = :'P_id' and kind = 'config_only'), 'the re-smoke of the same candidate closes the change and production is validated again');
reset role;

-- ═════════ 7b-1. the Orchestrator's Phase 7 routing is RECORDED, and the database refuses what the rules forbid (P703) ═════════
select pg_temp.check((select count(*) = 3 from ai.agent_handoff_targets where from_agent = 'orchestrator' and to_agent in ('deployment_agent', 'release_qa', 'incident_recovery')), 'P703: the Orchestrator has a declared handoff edge to each of the three Phase 7 agents');
select pg_temp.check((select count(*) = 3 from ai.agents where key in ('deployment_agent', 'release_qa', 'incident_recovery') and not enabled), 'and all three are still DISABLED (an edge is a route, not an activation)');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check(pg_temp.denied(format('select projects.record_phase_seven_routing(%L, %L, %L, %L, %L, %L, %L, %L, %L::jsonb, null)', :'ORG', :'P_id', 'readiness_review', 'k-person', 'held', 'agent_disabled', 'deployment_agent', 'x', '[]')), 'a person cannot record a routing decision: the door is the runner''s');
select pg_temp.check(pg_temp.denied('insert into projects.p7b_routing_decisions (organization_id, project_id, task_type, decision_key, outcome, code, to_agent, reason) select organization_id, project_id, ''readiness_review'', ''raw'', ''held'', ''x'', ''deployment_agent'', ''x'' from projects.phase_seven limit 1'), 'and has no write grant on the decisions table');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_phase_seven_routing(:'ORG', :'L_id', 'readiness_review', 'k1', 'held', 'agent_disabled', 'deployment_agent', 'disabled', '[]', null)) = 'not_in_phase_seven', 'a project outside the Phase 7 pipeline gets no Phase 7 routing record');
select pg_temp.check((select outcome from projects.record_phase_seven_routing(:'ORG2', :'P_id', 'readiness_review', 'k1', 'held', 'agent_disabled', 'deployment_agent', 'disabled', '[]', null)) = 'not_in_phase_seven', 'the organization is the JOB''s: a project of another organization is not routable');
select pg_temp.check((select outcome from projects.record_phase_seven_routing(:'ORG', :'P_id', 'readiness_review', 'k1', 'held', 'agent_disabled', 'release_qa', 'disabled', '[]', null)) = 'wrong_agent_for_task', 'a readiness review goes to the Deployment agent and to nobody else');
select pg_temp.check((select outcome from projects.record_phase_seven_routing(:'ORG', :'P_id', 'smoke_validation', 'k1', 'held', 'agent_disabled', 'deployment_agent', 'disabled', '[]', null)) = 'wrong_agent_for_task', 'a smoke validation is never routed to the agent that deployed (validator != deployer)');
select pg_temp.check((select outcome from projects.record_phase_seven_routing(:'ORG', :'P_id', 'client_update', 'k1', 'routed', 'routed', 'project_manager', 'x', '[]', null)) = 'handled_by_events_not_handoff', 'the PM acts through its event handlers, not through an agent handoff');
select pg_temp.check((select outcome from projects.record_phase_seven_routing(:'ORG', :'P_id', 'readiness_review', 'k1', 'event_handled', 'x', 'deployment_agent', 'x', '[]', null)) = 'handled_by_events_not_handoff', 'an agent task is never marked event_handled');
select pg_temp.check((select outcome from projects.record_phase_seven_routing(:'ORG', :'P_id', 'readiness_review', 'k1', 'held', 'agent_disabled', 'deployment_agent', 'token=' || 'abcdef123456', '[]', null)) = 'contains_secret', 'a decision never carries a secret');
select pg_temp.check((select outcome from projects.record_phase_seven_routing(:'ORG', :'P_id', 'readiness_review', 'k1', 'routed', 'routed', 'deployment_agent', 'x', '[]', null)) = 'agent_not_enabled', 'HELD WHEN DISABLED is a database rule too: a disabled agent cannot be recorded as routed');
select pg_temp.check((select outcome from projects.record_phase_seven_routing(:'ORG', :'P_id', 'readiness_review', 'k1', 'held', 'agent_disabled', 'deployment_agent', 'the Deployment agent is installed but not enabled', '[{"agent": "deployment_agent", "eligible": false, "rejected": "installed but not enabled"}]', '{"taskType": "readiness_review"}')) = 'recorded', 'a held decision is recorded with its explained candidates');
select pg_temp.check((select outcome from projects.record_phase_seven_routing(:'ORG', :'P_id', 'readiness_review', 'k1', 'held', 'agent_disabled', 'deployment_agent', 'again', '[]', null)) = 'already_recorded', 'a replayed decision records nothing twice');
select pg_temp.check((select outcome from projects.record_phase_seven_routing(:'ORG', :'P_id', 'client_update', 'k2', 'event_handled', 'pm_event_handler', 'project_manager', 'PM7 announces through its handler', '[]', null)) = 'recorded', 'a PM task is recorded as event_handled');
select pg_temp.check((select outcome from projects.record_phase_seven_routing(:'ORG', :'P_id', 'rollback_coordination', 'k3', 'refused', 'no_route', null, 'a refusal names no agent', '[]', null)) = 'recorded', 'a refusal is recorded with no agent');
reset role;
-- the agents are enabled FOR THIS ROLLED-BACK TEST only (a top-level SET: a function may not set the parameter on a non-superuser connection)
set local session_replication_role = replica;
update ai.agents set enabled = true, disabled_reason = null where key in ('deployment_agent', 'release_qa', 'incident_recovery');
set local session_replication_role = origin;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_phase_seven_routing(:'ORG', :'P_id', 'deployment_execution', 'k4', 'routed', 'routed', 'deployment_agent', 'x', '[]', jsonb_build_object('planId', :'PL1_id'))) = 'deployment_not_approved', 'P703: a deployment is not routed for a superseded plan');
select pg_temp.check((select outcome from projects.record_phase_seven_routing(:'ORG', :'P_id', 'deployment_execution', 'k4', 'routed', 'routed', 'deployment_agent', 'x', '[]', null)) = 'deployment_not_approved', 'nor for a task that names no plan');
select pg_temp.check((select outcome from projects.record_phase_seven_routing(:'ORG', :'P_id', 'deployment_execution', 'k4', 'routed', 'routed', 'deployment_agent', 'the approved plan for the exact candidate', '[]', jsonb_build_object('planId', :'PL3_pl'))) = 'recorded', 'a deployment IS routed for the plan whose Admin approval still holds');
select pg_temp.check((select outcome from projects.record_phase_seven_routing(:'ORG', :'P_id', 'rollback_coordination', 'k5', 'routed', 'routed', 'incident_recovery', 'x', '[]', null, :'INC3_id')) = 'rollback_not_approved', 'P706: a rollback is not coordinated for an incident with no Admin rollback decision');
select pg_temp.check((select outcome from projects.record_phase_seven_routing(:'ORG', :'P_id', 'rollback_coordination', 'k5', 'routed', 'routed', 'incident_recovery', 'the Admin approved this rollback', '[]', null, :'INC1_id')) = 'recorded', 'a rollback IS coordinated against the Admin-approved decision');
reset role;
-- the edge is the authorization: with it removed, even an enabled agent cannot be routed to
delete from ai.agent_handoff_targets where from_agent = 'orchestrator' and to_agent = 'release_qa';
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_phase_seven_routing(:'ORG', :'P_id', 'smoke_validation', 'k6', 'routed', 'routed', 'release_qa', 'x', '[]', null)) = 'no_declared_route', 'no declared edge, no route: the database mirrors the registry rule');
reset role;
insert into ai.agent_handoff_targets (from_agent, to_agent) values ('orchestrator', 'release_qa');
set local session_replication_role = replica;
update ai.agents set enabled = false, disabled_reason = 'restored after the routing rehearsal' where key in ('deployment_agent', 'release_qa', 'incident_recovery');
set local session_replication_role = origin;
select pg_temp.check((select count(*) = 5 from projects.p7b_routing_decisions where project_id = :'P_id'), 'exactly the five decisions that were allowed are recorded');
select pg_temp.door_off();
select pg_temp.check(pg_temp.refused(format('update projects.p7b_routing_decisions set outcome = %L where project_id = %L', 'routed', :'P_id'), 'never edited'), 'a routing decision is history: it is not edited');
select pg_temp.check(pg_temp.refused(format('delete from projects.p7b_routing_decisions where project_id = %L', :'P_id'), 'never edited'), 'and never deleted');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_project_archive(:'P_id')) = 'not_completed', 'P711: a project that has not completed Phase 7 is not archived (the Admin is asked for it before any policy)');
reset role;
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) = 0 from projects.p7b_routing_decisions), 'a portal client reads no routing decision');
reset role;

-- ═════════ 8. the handover package: contractual, structured, versioned; credentials by REFERENCE ═════════
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.create_handover_package(:'P_id')) = 'contract_deliverables_missing', 'handover needs the contractual deliverable list');
select pg_temp.check((select outcome from projects.record_contract_deliverable(:'P_id', 'training', 'Training sessions', false)) = 'exclusion_reason_required', 'a contract exclusion says why');
select pg_temp.check((select outcome from projects.record_contract_deliverable(:'P_id', 'api_docs', 'API docs', true, null)) = 'recorded', 'a required deliverable is recorded');
select projects.record_contract_deliverable(:'P_id', 'source_repository', 'Source repository ownership', true);
select projects.record_contract_deliverable(:'P_id', 'deployment_docs', 'Deployment and configuration guide', true);
select projects.record_contract_deliverable(:'P_id', 'db_docs', 'Database and schema notes', true);
select projects.record_contract_deliverable(:'P_id', 'admin_guide', 'Admin guide', true);
select projects.record_contract_deliverable(:'P_id', 'user_guide', 'User guide', true);
select projects.record_contract_deliverable(:'P_id', 'invoices_receipts', 'Final invoice and receipt', true);
select pg_temp.check((select outcome from projects.record_contract_deliverable(:'P_id', 'training', 'Training sessions', false, 'training is not in this contract')) = 'recorded', 'P707-T002: the contract excludes training - recorded as NOT_REQUIRED with its reason');
select package_id as pk from projects.create_handover_package(:'P_id', 'https://app.example.test', null, null, null) \gset PK1_
select pg_temp.check(:'PK1_pk' is not null, 'the package is created for the exact validated release');
select pg_temp.check((select package_id = :'PK1_pk'::uuid and outcome = 'already_exists' from projects.create_handover_package(:'P_id')), 'P707-T010: a duplicate package event keeps ONE canonical active version');
select pg_temp.check((select version = 1 and status = 'draft' and commit_ref = 'def5678' and deployment_id = :'D3_d'::uuid from projects.p7_handover_packages where id = :'PK1_pk'), 'the package carries the exact release and deployment');
select pg_temp.check((select count(*) = 14 and count(*) filter (where status = 'not_required') = 1 from projects.p7_handover_items where package_id = :'PK1_pk'), 'six standing items plus eight contract items; the excluded one is NOT_REQUIRED');
select pg_temp.check((select state = 'handover_preparing' from projects.phase_seven where project_id = :'P_id'), 'Phase 7 is HANDOVER_PREPARING');
select pg_temp.check((select outcome = 'incomplete' and array_to_string(missing, '|') like '%contract_items%' and array_to_string(missing, '|') like '%access_transfer%' and array_to_string(missing, '|') like '%support_warranty%' from projects.submit_handover_for_review(:'PK1_pk')), 'P701-T007 / P707-T001: missing source, access documentation and support terms BLOCK the package');
select pg_temp.check((select outcome from projects.set_handover_item(:'PK1_pk', 'source_repository', 'ready', 'https://u:' || 'pw1234x@git.example.test/repo')) = 'contains_secret', 'a reference carrying a credential is refused');
select pg_temp.check((select outcome from projects.set_handover_item(:'PK1_pk', 'deployment_docs', 'ready', 'https://docs.example.test/deploy', null, 'password: ' || 'hunter2xyz9')) = 'contains_secret', 'P707-T003: a raw password in a package note is refused');
select pg_temp.check((select outcome from projects.set_handover_item(:'PK1_pk', 'training', 'ready', 'https://x.example.test/t')) = 'item_not_required_by_contract', 'an item the contract excludes cannot be marked ready');
select pg_temp.check((select outcome from projects.set_handover_item(:'PK1_pk', 'source_repository', 'ready')) = 'artifact_ref_required', 'ready needs an artifact reference');
select pg_temp.check((select outcome from projects.update_handover_package(:'PK1_pk', 'https://app.example.test', 'warranty ' || 'token=' || 'abcdef123456', current_date + 90, 'ops lead')) = 'contains_secret', 'support terms never carry a secret');
select pg_temp.check((select outcome from projects.update_handover_package(:'PK1_pk', 'https://app.example.test', 'Ninety days of bug-fix warranty for defects in the delivered scope; new features are a change request', current_date + 90, 'ops lead: ops@example.test')) = 'updated', 'support/warranty terms and emergency contacts are recorded');
select projects.set_handover_item(:'PK1_pk', 'scope', 'ready', 'https://docs.example.test/scope/final');
select projects.set_handover_item(:'PK1_pk', 'release', 'ready', 'https://docs.example.test/release/def5678');
select projects.set_handover_item(:'PK1_pk', 'production_url', 'ready', 'https://app.example.test');
select projects.set_handover_item(:'PK1_pk', 'known_limitations', 'ready', 'https://docs.example.test/limitations');
select projects.set_handover_item(:'PK1_pk', 'support_warranty', 'ready', 'https://docs.example.test/support');
select projects.set_handover_item(:'PK1_pk', 'emergency_contacts', 'ready', 'https://docs.example.test/contacts');
select projects.set_handover_item(:'PK1_pk', 'source_repository', 'ready', 'https://git.example.test/org/repo');
select projects.set_handover_item(:'PK1_pk', 'deployment_docs', 'ready', 'https://docs.example.test/deploy');
select projects.set_handover_item(:'PK1_pk', 'db_docs', 'ready', 'https://docs.example.test/db');
select projects.set_handover_item(:'PK1_pk', 'api_docs', 'ready', 'https://docs.example.test/api');
select projects.set_handover_item(:'PK1_pk', 'admin_guide', 'ready', 'https://docs.example.test/admin');
select projects.set_handover_item(:'PK1_pk', 'user_guide', 'ready', 'https://docs.example.test/user');
select projects.set_handover_item(:'PK1_pk', 'invoices_receipts', 'ready', 'https://docs.example.test/receipts');
-- access transfer: a RECEIPT (method, status, evidence reference), never the value
select pg_temp.check((select outcome from projects.record_access_transfer(:'PK1_pk', 'GitHub organization', 'repository_ownership', 'ownership_transfer', 'completed')) = 'evidence_required', 'a transfer is complete only with evidence');
select pg_temp.check((select outcome from projects.record_access_transfer(:'PK1_pk', 'Hosting account', 'hosting_account', 'password_manager_share', 'in_progress', null, null, null, false, false, false, 'the login is ' || 'password=' || 'Tr0ub4dor&3')) = 'contains_secret', 'the access-transfer record has no place for a secret value');
select pg_temp.check((select outcome from projects.record_access_transfer(:'PK1_pk', 'Hosting account', 'hosting_account', 'password_manager_share', 'completed', 'agency', 'client', 'https://vault.example.test/share/abc', true, true, true)) = 'support_access_needs_admin_authorization', 'support access is retained only when an Admin authorizes it');
select pg_temp.check((select outcome from projects.record_access_transfer(:'PK1_pk', 'GitHub organization', 'repository_ownership', 'ownership_transfer', 'completed', 'agency', 'client', 'https://tickets.example.test/transfer/9', true)) = 'recorded', 'repository ownership transfer is recorded by reference, with the temporary credentials rotated');
select pg_temp.check((select outcome from projects.record_access_transfer(:'PK1_pk', 'Hosting account', 'hosting_account', 'password_manager_share', 'in_progress', 'agency', 'client')) = 'recorded', 'a second transfer is in progress');
select pg_temp.check((select outcome = 'incomplete' and array_to_string(missing, '|') like '%access_transfer%' from projects.submit_handover_for_review(:'PK1_pk')), 'a transfer still in progress blocks the package');
select projects.record_access_transfer(:'PK1_pk', 'Hosting account', 'hosting_account', 'password_manager_share', 'completed', 'agency', 'client', 'https://vault.example.test/share/abc', true);
select pg_temp.check((select outcome from projects.submit_handover_for_review(:'PK1_pk')) = 'submitted', 'a complete package is submitted for Admin review');
select pg_temp.check((select state = 'admin_handover_review' from projects.phase_seven where project_id = :'P_id') and (select count(*) = 1 from core.outbox_events where type = 'project.handover_admin_review_requested' and subject_id = :'PK1_pk'::uuid), 'Phase 7 is ADMIN_HANDOVER_REVIEW and the exact package is presented');
select pg_temp.check((select outcome from projects.set_handover_item(:'PK1_pk', 'scope', 'pending')) = 'package_frozen', 'a package under review is not edited');
select pg_temp.check((select outcome from projects.deliver_handover_package(:'PK1_pk', 'portal')) = 'not_admin_approved', 'P707-T007: a version the Admin has not approved cannot go to the client');
select pg_temp.check((select outcome from projects.record_known_limitation(:'P_id', 'Report export times out above 50k rows', 'found during production validation', 'production_validation')) = 'recorded', 'production found a new limitation after the package was assembled');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_handover_package(:'PK1_pk', 'approve')) = 'incomplete', 'P707-T005: a package that omits a known limitation cannot be approved');
select pg_temp.check((select outcome from projects.decide_handover_package(:'PK1_pk', 'edit_requested')) = 'note_required', 'a request for edits says what to edit');
select pg_temp.check((select outcome from projects.decide_handover_package(:'PK1_pk', 'edit_requested', 'disclose the export limit and name the on-call owner')) = 'edit_requested', 'P701-T008: the Admin requests an edit');
reset role;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select package_id as pk from projects.revise_handover_package(:'PK1_pk') \gset PK2_
select pg_temp.check((select status = 'superseded' from projects.p7_handover_packages where id = :'PK1_pk') and (select version = 2 and status = 'draft' and supersedes_id = :'PK1_pk'::uuid from projects.p7_handover_packages where id = :'PK2_pk'), 'P707-T006: the edit is a NEW version; the old one is preserved, superseded, not overwritten');
select pg_temp.check((select count(*) = 14 from projects.p7_handover_items where package_id = :'PK2_pk') and (select count(*) = 2 from projects.p7_access_transfers where package_id = :'PK2_pk'), 'the items and the access-transfer records carry over');
select pg_temp.check((select outcome from projects.submit_handover_for_review(:'PK2_pk')) = 'submitted', 'version 2 is submitted (it discloses every limitation, including the new one)');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_handover_package(:'PK2_pk', 'approve', 'reviewed version 2')) = 'approved', 'the Admin approves the exact package version');
select pg_temp.check((select state = 'handover_ready' from projects.phase_seven where project_id = :'P_id') and (select count(*) = 2 from projects.p7_handover_reviews where project_id = :'P_id'), 'Phase 7 is HANDOVER_READY; both review decisions are recorded');
reset role;

-- ═════════ 7b-2a. the client portal reads nothing of a handover that is not DELIVERED (P707 §8: only an Admin-approved package reaches the client) ═════════
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) = 0 from projects.client_handover_overview(:'P_id')) and (select count(*) = 0 from projects.client_handover_items(:'P_id')) and (select count(*) = 0 from projects.client_handover_access_receipts(:'P_id')), 'P707: an approved package that has not been delivered does not exist for the client');
reset role;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.deliver_handover_package(:'PK1_pk', 'portal')) = 'not_admin_approved', 'the superseded version cannot be delivered');
select pg_temp.check((select outcome from projects.deliver_handover_package(:'PK2_pk', '')) = 'channel_required', 'delivery names the channel');
select pg_temp.check((select outcome from projects.deliver_handover_package(:'PK2_pk', 'client portal')) = 'delivered', 'the Admin-approved package is delivered');
select pg_temp.check((select state = 'client_handover_review' from projects.phase_seven where project_id = :'P_id'), 'Phase 7 is CLIENT_HANDOVER_REVIEW');
reset role;

-- ═════════ 7b-2b. the client reads the DELIVERED version, access is logged, and the client ASKS (a request, never an acceptance) ═════════
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select version = 2 and acceptance_state = 'awaiting' and request_state = 'none' and portal_access = 'open' and not project_completed and support_terms like 'Ninety days%' from projects.client_handover_overview(:'P_id')), 'P707: the client reads the DELIVERED version 2: awaiting acceptance, portal open, not completed');
select pg_temp.check((select count(*) = 13 from projects.client_handover_items(:'P_id')) and (select count(*) = 0 from projects.client_handover_items(:'P_id') where kind = 'training'), 'only the 13 delivered (ready) items; the contract-excluded item is not shown');
select pg_temp.check((select count(*) = 2 and bool_and(status = 'completed') from projects.client_handover_access_receipts(:'P_id')), 'both access receipts are readable: system, method, status');
select pg_temp.check((select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.proname in ('client_handover_overview', 'client_handover_items', 'client_handover_access_receipts', 'client_completed_state')
                       and pg_get_function_result(p.oid) ~* '(evidence|note|reason|review|feedback|secret|credential_ref|created_by|decided_by|recorded_by|artifact_sha|commit)'), 'the client-safe functions have no column for evidence, notes, reasons, reviews, feedback, people, commits or hashes');
select pg_temp.check((select count(*) = 0 from projects.p7_handover_items) and (select count(*) = 0 from projects.p7_access_transfers) and (select count(*) = 0 from projects.p7_handover_packages) and (select count(*) = 0 from projects.p7b_portal_requests) and (select count(*) = 0 from projects.p7b_handover_access_log) and (select count(*) = 0 from projects.p7b_portal_request_settlements), 'the client reads NO internal table directly: every read goes through the safe functions');
select pg_temp.check((select outcome from projects.log_handover_access(:'PK2_pk', 'viewed')) = 'logged', 'a view of the delivered package is logged');
select pg_temp.check((select outcome from projects.log_handover_access(:'PK2_pk', 'item_opened', 'admin_guide')) = 'logged', 'opening an item is logged with its kind');
select pg_temp.check((select outcome from projects.log_handover_access(:'PK2_pk', 'item_opened', 'training')) = 'not_a_delivered_item', 'an item that was not delivered cannot be "opened"');
select pg_temp.check((select outcome from projects.log_handover_access(:'PK2_pk', 'viewed', 'admin_guide')) = 'bad_event', 'a view names no item');
select pg_temp.check((select outcome from projects.log_handover_access(:'PK1_pk', 'viewed')) = 'not_delivered', 'a superseded version is not logged as delivered');
select pg_temp.check(pg_temp.denied(format('insert into projects.p7b_handover_access_log (organization_id, project_id, client_account_id, package_id, package_version, event, actor_user) values (%L, %L, %L, %L, 2, %L, %L)', :'ORG', :'P_id', :'A_id', :'PK2_pk', 'viewed', :'CL1')), 'the client cannot write the access log directly');
select pg_temp.check((select outcome from projects.request_handover_acceptance(:'PK2_pk', 'changes_request')) = 'note_required', 'a change request says what to change');
select pg_temp.check((select outcome from projects.request_handover_acceptance(:'PK2_pk', 'changes_request', 'the login is ' || 'password=' || 'qwerty12345')) = 'contains_secret', 'a client''s secret is never stored in a request');
select pg_temp.check((select outcome from projects.request_handover_acceptance(:'PK2_pk', 'bogus', 'x')) = 'bad_kind', 'a request is an acceptance request or a change request');
select request_id as rq from projects.request_handover_acceptance(:'PK2_pk', 'changes_request', 'the admin guide misses the refund screen') \gset RQ1_
select pg_temp.check(:'RQ1_rq' is not null, 'P708: the client''s portal change request is recorded as a REQUEST');
select pg_temp.check((select outcome from projects.request_handover_acceptance(:'PK2_pk', 'changes_request', 'again')) = 'already_requested', 'a repeated request for the same version records nothing twice');
select pg_temp.check((select request_state = 'awaiting_confirmation' from projects.client_handover_overview(:'P_id')), 'the client sees that a person has not yet confirmed it');
select pg_temp.check((select count(*) = 0 from projects.p7_client_acceptances), 'and no acceptance exists: the portal wrote only a request');
select pg_temp.check((select outcome from projects.settle_portal_handover_request(:'RQ1_rq', 'confirmed', 'verified by phone with Asha')) = 'not_authorized', 'the client cannot confirm its own request');
select pg_temp.check((select outcome from projects.settle_portal_handover_request(:'RQ1_rq', 'declined', null, 'no thanks, I withdraw it')) = 'not_authorized', 'nor decline (and so bury) a request: only a person with delivery rights settles one');
reset role;
-- another account's client, another tenant's owner, and an agent
select pg_temp.as_client(:'CL3', :'ORG', :'A2_id');
set local role authenticated;
select pg_temp.check((select count(*) = 0 from projects.client_handover_overview(:'P_id')) and (select count(*) = 0 from projects.client_handover_items(:'P_id')) and (select count(*) = 0 from projects.client_handover_access_receipts(:'P_id')) and (select count(*) = 0 from projects.client_completed_state(:'P_id')), 'a client of ANOTHER account reads nothing of this project');
select pg_temp.check((select outcome from projects.log_handover_access(:'PK2_pk', 'viewed')) = 'not_found' and (select outcome from projects.request_handover_acceptance(:'PK2_pk', 'acceptance_request')) = 'not_found', 'and can neither log access nor request acceptance');
reset role;
select pg_temp.as_user(:'OTHER', :'ORG2', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) = 0 from projects.client_handover_overview(:'P_id')) and (select count(*) = 0 from projects.client_handover_items(:'P_id')) and (select count(*) = 0 from projects.p7b_portal_requests) and (select count(*) = 0 from projects.p7b_handover_access_log), 'P708-T012: another organization reads nothing');
select pg_temp.check((select outcome from projects.settle_portal_handover_request(:'RQ1_rq', 'declined', null, 'no')) = 'not_found', 'and cannot settle another organization''s request');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(pg_temp.denied(format('select projects.request_handover_acceptance(%L, %L, null)', :'PK2_pk', 'acceptance_request')) and pg_temp.denied(format('select projects.log_handover_access(%L, %L)', :'PK2_pk', 'viewed')), 'an agent (service role) can neither request nor log on a client''s behalf');
reset role;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.log_handover_access(:'PK2_pk', 'viewed')) = 'not_a_client' and (select outcome from projects.request_handover_acceptance(:'PK2_pk', 'acceptance_request')) = 'not_a_client', 'staff previewing the page are not the client: they are not logged as one and cannot request as one');
select pg_temp.check((select count(*) = 2 from projects.p7b_handover_access_log where package_id = :'PK2_pk') and (select count(*) = 1 from projects.p7b_portal_requests where package_id = :'PK2_pk'), 'staff read the access log (2 entries) and the open request');
select pg_temp.check((select outcome from projects.settle_portal_handover_request(:'RQ1_rq', 'confirmed', 'ok')) = 'verification_required', 'a confirmation needs a person''s own verification, in words');
reset role;
select pg_temp.door_off();
select pg_temp.check(pg_temp.refused(format('update projects.p7b_handover_access_log set event = %L where package_id = %L', 'viewed', :'PK2_pk'), 'never edited'), 'the access log is append-only');
select pg_temp.check(pg_temp.refused(format('update projects.p7b_portal_requests set kind = %L where id = %L', 'acceptance_request', :'RQ1_rq'), 'never edited'), 'a request is history');
select pg_temp.door_off();
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(pg_temp.refused(format('update projects.p7_handover_packages set support_terms = %L where id = %L', 'overwritten', :'PK2_pk'), 'through its doors'), 'P707-T012: a delivered package is not overwritten by a direct statement');
select pg_temp.check(pg_temp.refused(format('delete from projects.p7_handover_packages where id = %L', :'PK1_pk'), 'never deleted'), 'an old package version is never deleted');
select pg_temp.check(pg_temp.refused(format('update projects.p7_handover_packages set status = %L where id = %L', 'delivered', :'PK1_pk'), 'through its doors'), 'a package is not marked delivered by a raw edit');
reset role;
select set_config('projects.p7_door', 'on', true);
select pg_temp.check(pg_temp.refused(format('update projects.p7_handover_packages set support_terms = %L where id = %L', 'overwritten', :'PK2_pk'), 'new version'), 'with the door on, the package rule itself refuses an overwrite: an edit is a new version');
select pg_temp.check(pg_temp.refused(format('update projects.p7_handover_items set status = %L, reason = %L where package_id = %L and kind = %L', 'pending', 'x', :'PK2_pk', 'scope'), 'new version'), 'and the items of a delivered package are as delivered');
select pg_temp.door_off();

-- ═════════ 9. client acceptance: staff record the CLIENT'S formal acceptance of the EXACT version ═════════
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_client_acceptance(:'PK2_pk', 'accepted', 'informal_chat', 'looks good', 'Asha')) = 'informal_is_not_acceptance', 'P701-T009 / P708-T002: "looks good" in a chat is not a formal acceptance');
select pg_temp.check((select outcome from projects.record_client_acceptance(:'PK2_pk', 'accepted', 'email_reply', '', 'Asha')) = 'evidence_required', 'acceptance needs evidence');
select pg_temp.check((select not satisfied from projects.p7_completion_gate(:'P_id') where gate = 'client_acceptance'), 'no formal acceptance is recorded: the gate says so');
select pg_temp.check((select outcome from projects.settle_portal_handover_request(:'RQ1_rq', 'confirmed', 'verified by email thread with Asha: the guide misses the refund screen', 'the admin guide misses the refund screen')) = 'confirmed', 'the client''s portal change request is confirmed by a person: recorded formally, with evidence (replaces the staff-typed record)');
select pg_temp.check((select decision = 'changes_requested' and evidence_kind = 'portal_confirmation' and package_version = 2 from projects.p7_client_acceptances where package_id = :'PK2_pk'), 'the formal record is a change request on the exact version 2');
select pg_temp.check((select status = 'changes_requested' from projects.p7_handover_packages where id = :'PK2_pk') and (select state = 'handover_preparing' from projects.phase_seven where project_id = :'P_id'), 'the package returns for correction');
select feedback_id as f, route as rt from projects.record_handover_feedback(:'PK2_pk', 'handover_correction', 'the admin guide misses the refund screen') \gset FB1_
select pg_temp.check(:'FB1_rt' = 'handover_revision', 'a missing agreed item is a handover CORRECTION');
select pg_temp.check((select route from projects.record_handover_feedback(:'PK2_pk', 'new_feature', 'please add a loyalty points module')) = 'change_request', 'P701-T011 / P708-T007: a new feature is a CHANGE REQUEST, never a warranty fix');
select pg_temp.check((select route from projects.record_handover_feedback(:'PK2_pk', 'support_question', 'how do I add a staff member?')) = 'customer_success', 'P708-T008: a training question goes to Customer Success');
select pg_temp.check((select route from projects.record_handover_feedback(:'PK2_pk', 'production_defect', 'the invoice PDF has a wrong total')) = 'support_bug', 'a production defect goes to Support/Bug');
select pg_temp.check((select outcome from projects.record_handover_feedback(:'PK2_pk', 'access_issue', 'cannot log in, my password is ' || 'password=' || 'qwerty12345')) = 'contains_secret', 'a client''s secret is never stored in feedback');
select pg_temp.check((select outcome from projects.record_handover_feedback(:'PK2_pk', 'bogus', 'x')) = 'bad_classification', 'feedback is classified');
select pg_temp.check((select not satisfied from projects.p7_completion_gate(:'P_id') where gate = 'no_blocking_issue'), 'an open correction and an open production defect block completion');
select package_id as pk from projects.revise_handover_package(:'PK2_pk') \gset PK3_
select pg_temp.check((select outcome from projects.set_handover_item(:'PK3_pk', 'admin_guide', 'ready', 'https://docs.example.test/admin-v2')) = 'recorded', 'the correction goes into the new version');
select pg_temp.check((select outcome from projects.submit_handover_for_review(:'PK3_pk')) = 'submitted', 'version 3 is submitted');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_handover_package(:'PK3_pk', 'approve')) = 'approved', 'the Admin approves version 3');
select pg_temp.check((select outcome from projects.deliver_handover_package(:'PK3_pk', 'client portal')) = 'delivered', 'version 3 is delivered');
reset role;

-- ═════════ 7b-2c. version 3 is delivered: a request is not an acceptance, a decline is recorded, a stale version cannot be requested ═════════
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select version = 3 and acceptance_state = 'awaiting' and request_state = 'none' from projects.client_handover_overview(:'P_id')), 'the client now reads version 3 (version 2 is superseded and gone from view)');
select pg_temp.check((select outcome from projects.request_handover_acceptance(:'PK2_pk', 'acceptance_request')) = 'package_superseded', 'P708-T001: a request against the OLD version is refused');
select pg_temp.check((select outcome from projects.record_client_acceptance(:'PK3_pk', 'accepted', 'portal_confirmation', 'I clicked accept in the portal', 'Asha Verma')) = 'not_authorized', 'a portal client calling the formal acceptance door directly is refused: the client accepts, a PERSON records it');
select request_id as rq from projects.request_handover_acceptance(:'PK3_pk', 'acceptance_request', 'looks complete to me') \gset RQ2_
select pg_temp.check(:'RQ2_rq' is not null, 'the client asks to accept version 3');
reset role;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select not satisfied from projects.p7_completion_gate(:'P_id') where gate = 'client_acceptance') and (select count(*) = 0 from projects.p7_client_acceptances where package_id = :'PK3_pk'), 'P708-T002: the REQUEST is not an acceptance: the completion gate still waits for a formal record');
select pg_temp.check((select outcome from projects.settle_portal_handover_request(:'RQ2_rq', 'declined')) = 'note_required', 'a decline says why');
select pg_temp.check((select outcome from projects.settle_portal_handover_request(:'RQ2_rq', 'declined', null, 'Asha has not signed the acceptance form yet; ask her to sign it')) = 'declined', 'a person declines the request, with a reason');
select pg_temp.check((select outcome from projects.settle_portal_handover_request(:'RQ2_rq', 'confirmed', 'verified by phone with Asha today')) = 'already_settled', 'a settled request is settled once');
select pg_temp.check((select count(*) = 0 from projects.p7_client_acceptances where package_id = :'PK3_pk'), 'declining recorded no acceptance');
reset role;
select pg_temp.as_client(:'CL2', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select request_state = 'none' from projects.client_handover_overview(:'P_id')), 'a second colleague''s view shows no open request of their own');
select request_id as rq from projects.request_handover_acceptance(:'PK3_pk', 'acceptance_request') \gset RQ3_
select pg_temp.check(:'RQ3_rq' is not null, 'a second client user asks to accept version 3');
reset role;
select pg_temp.check((select count(*) = 0 from projects.p7_client_acceptances where package_id = :'PK3_pk'), 'still no acceptance');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_client_acceptance(:'PK2_pk', 'accepted', 'signed_document', 'https://sign.example.test/doc/1', 'Asha')) = 'package_superseded', 'P708-T001: the client''s acceptance of an OLD version does not approve the newer one');
select pg_temp.check((select not satisfied from projects.p7_completion_gate(:'P_id') where gate = 'client_acceptance'), 'the gate still waits for the exact current version');
select pg_temp.check((select outcome from projects.approve_completion_exception(:'P_id', 'client_acceptance', 'client is travelling', 'accepting later')) = 'not_authorized', 'P708-T009: a completion exception without an Admin is denied');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.approve_completion_exception(:'P_id', 'production_validated', 'x', 'y')) = 'gate_not_exceptionable', 'production validation can never be excepted');
select pg_temp.check((select outcome from projects.approve_completion_exception(:'P_id', 'client_acceptance', '', 'y')) = 'reason_and_risk_required', 'an exception states the reason and the risk');
reset role;

-- ═════════ 10. final financial clearance is READ from finance rows, and Finance does not declare completion ═════════
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select count(*) = 5 and bool_and(satisfied) from projects.p7_financial_clearance(:'P_id')), 'M4 verified in full, a receipt, no balance, no refund, no dispute: financially CLEAR');
select pg_temp.check((select outcome from projects.open_financial_exception(:'P_id', 'dispute', 100000, 'the bank reports a dispute on the final payment')) = 'opened', 'a dispute is opened and stays visible');
select pg_temp.check((select not satisfied from projects.p7_financial_clearance(:'P_id') where gate = 'no_open_dispute') and (select not satisfied from projects.p7_completion_gate(:'P_id') where gate = 'financial_clearance'), 'P710-T003: an open dispute makes clearance NOT clear and blocks completion');
select exception_id as ex from projects.open_financial_exception(:'P_id', 'adjustment', 500, 'a credit note is being issued') \gset FX_
select pg_temp.check((select outcome from projects.decide_financial_exception(:'FX_ex', 'resolved', 'credit note issued')) = 'not_authorized', 'a delivery lead cannot resolve or waive money');
reset role;
select pg_temp.as_user(:'OPS', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_financial_exception(:'FX_ex', 'waived', 'waived by the owner')) = 'waiver_needs_evidence', 'P710-T004: a waiver is clear only with policy evidence');
select pg_temp.check((select outcome from projects.decide_financial_exception(:'FX_ex', 'waived', 'waived by the owner', 'https://policy.example.test/waiver/5')) = 'decided', 'an Admin waives with evidence');
select id as "FD_id" from projects.p7_financial_exceptions where project_id = :'P_id' and kind = 'dispute' \gset
select pg_temp.check((select outcome from projects.decide_financial_exception(:'FD_id', 'resolved', 'the bank closed the dispute in our favour')) = 'decided', 'the dispute is resolved');
select pg_temp.check((select bool_and(satisfied) from projects.p7_financial_clearance(:'P_id')), 'clearance is clear again');
reset role;
select pg_temp.door_off();
select pg_temp.check(pg_temp.refused(format('update projects.p7_financial_exceptions set status = %L where id = %L', 'open', :'FD_id'), 'doors'), 'P710-T010: a decided financial exception is not edited');
-- a reversal of the verified payment: the clearance and the gate re-evaluate
set local session_replication_role = replica;
update finance.invoices set verified_minor = 50000 where id = :'I4_i';
set local session_replication_role = origin;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select not satisfied from projects.p7_financial_clearance(:'P_id') where gate = 'm4_verified_in_full') and (select not satisfied from projects.p7_completion_gate(:'P_id') where gate = 'financial_clearance'), 'P710-T007: a payment reversal re-evaluates the clearance and the completion gate');
reset role;
set local session_replication_role = replica;
update finance.invoices set verified_minor = 100000 where id = :'I4_i';
set local session_replication_role = origin;

-- ═════════ 7b-3. the financial gate consults Phase 9 (P710): required only once a project has met it ═════════
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) = 5 and bool_and(satisfied) from projects.p7_financial_clearance(:'P_id')) and not finance.project_is_financially_closed(:'P_id'), 'a project that never met Phase 9 (no close, no blocking exception) is judged exactly as before: five rows, all clear');
select outcome as o, exception_id as ex from finance.open_finance_exception('overdue', 'the final invoice passed its due date', :'P_id', :'I4_i') \gset FXO_
select pg_temp.check(:'FXO_o' = 'opened', 'an overdue-invoice finance exception is opened (non-blocking by Phase 9''s own rule)');
select pg_temp.check((select count(*) = 5 and bool_and(satisfied) from projects.p7_financial_clearance(:'P_id')), 'a NON-blocking finance exception does not change the Phase 7 clearance');
select outcome as o, exception_id as ex from finance.open_finance_exception('chargeback', 'the bank reports a chargeback on the final payment', :'P_id') \gset FX9_
select pg_temp.check(:'FX9_o' = 'opened', 'a chargeback is opened as a Phase 9 finance exception (always blocking)');
select pg_temp.check((select count(*) = 5 from projects.p7_financial_clearance(:'P_id')) and (select not satisfied and detail like '%blocking finance exception%' from projects.p7_financial_clearance(:'P_id') where gate = 'no_open_dispute'), 'P710: an open BLOCKING finance exception makes the clearance NOT clear (still five rows)');
select pg_temp.check((select not satisfied from projects.p7_completion_gate(:'P_id') where gate = 'financial_clearance'), 'and the completion gate''s financial_clearance row reads it');
select pg_temp.check((select outcome = 'gate_not_satisfied' and array_to_string(missing, '|') like '%financial_clearance: %' from projects.complete_phase_seven(:'P_id')), 'completion is refused on the financial_clearance gate while a Phase 9 blocker stands');
reset role;
select pg_temp.as_user(:'OPS', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from finance.resolve_finance_exception(:'FX9_ex', 'resolved', 'the bank closed the chargeback in our favour')) = 'resolved', 'a different Admin resolves it (creator != resolver)');
select pg_temp.check((select count(*) = 5 and bool_and(satisfied) from projects.p7_financial_clearance(:'P_id')), 'resolved: the clearance is clear again');
reset role;
-- the project is financially closed (a Phase 9 close row: a fixture here, since Phase 9 itself is proven by verify-phase-nine.sql)
set local session_replication_role = replica;
insert into finance.financial_close_evaluations (organization_id, project_id, result, contract_minor, invoiced_minor, verified_net_minor, waived_minor, outstanding_minor, unverified_minor, expenses_minor, margin_minor, blockers, position, evaluated_by_system)
  values (:'ORG', :'P_id', 'clear', 350000, 350000, 350000, 0, 0, 0, 0, 350000, '[]', '{}', true) returning id \gset EV_
insert into finance.project_financial_closes (organization_id, project_id, evaluation_id, mode, closed_by, snapshot) values (:'ORG', :'P_id', :'EV_id', 'zero_balance', :'OWNER', '{}');
set local session_replication_role = origin;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(finance.project_is_financially_closed(:'P_id') and (select count(*) = 5 and bool_and(satisfied) from projects.p7_financial_clearance(:'P_id')) and (select detail like '%financially closed (Phase 9)%' from projects.p7_financial_clearance(:'P_id') where gate = 'no_open_dispute'), 'a project WITH a Phase 9 close reads as financially closed through the one fact Phase 9 exposes');
select outcome as o, exception_id as ex from finance.open_finance_exception('wrong_amount', 'a late credit note changes the final amount', :'P_id') \gset FX9B_
select pg_temp.check((select not satisfied from projects.p7_financial_clearance(:'P_id') where gate = 'no_open_dispute'), 'a blocking exception opened AFTER the close is not hidden by it');
reset role;
select pg_temp.as_user(:'OPS', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from finance.resolve_finance_exception(:'FX9B_ex', 'resolved', 'the credit note was applied and verified')) = 'resolved', 'resolved by an independent Admin');
select pg_temp.check((select count(*) = 5 and bool_and(satisfied) from projects.p7_financial_clearance(:'P_id')), 'clear again');
reset role;
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) = 0 from projects.p7_financial_clearance(:'P_id')) and not finance.project_is_financially_closed(:'P_id'), 'a portal client reads nothing of the financial clearance');
reset role;

-- ═════════ 11. feedback is resolved, the client accepts the exact version, the completion gate passes ═════════
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.complete_phase_seven(:'P_id')) = 'not_authorized', 'a delivery lead cannot complete a project');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome = 'gate_not_satisfied' and array_to_string(missing, '|') like '%client_acceptance%' and array_to_string(missing, '|') like '%no_blocking_issue%' from projects.complete_phase_seven(:'P_id')), 'deployment + payment + a delivered handover are not completion: acceptance and open items still block');
select id as "FB2_id" from projects.p7_handover_feedback where project_id = :'P_id' and classification = 'production_defect' \gset
select pg_temp.check((select outcome from projects.resolve_handover_feedback(:'FB1_f', 'the admin guide now covers refunds (version 3)')) = 'resolved', 'the correction is resolved');
select pg_temp.check((select outcome from projects.resolve_handover_feedback(:'FB2_id', 'the PDF total is fixed and verified in production')) = 'resolved', 'the production defect is resolved');
select pg_temp.check((select outcome from projects.resolve_handover_feedback(:'FB2_id', 'again')) = 'already_resolved', 'resolving twice changes nothing');
select pg_temp.check((select passed from projects.p7_completion_gate(:'P_id') where gate = 'no_blocking_issue'), 'no blocking handover/support issue remains (a new-feature request and a training question never block)');
reset role;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.settle_portal_handover_request(:'RQ3_rq', 'confirmed', 'verified by phone with Ravi Menon: he accepts version 3', 'accepted version 3')) = 'confirmed', 'P708: a PERSON confirms the portal request with their own verification: it becomes the formal acceptance');
select pg_temp.check((select decision = 'accepted' and evidence_kind = 'portal_confirmation' and package_version = 3 and client_name = 'Ravi Menon' and evidence_ref like 'portal request %: verified by phone%' and recorded_by = :'DL'::uuid from projects.p7_client_acceptances where package_id = :'PK3_pk'), 'the acceptance names the exact version, the portal evidence kind, the client and the person who verified it');
select pg_temp.check((select decision = 'confirmed' and acceptance_id = (select id from projects.p7_client_acceptances where package_id = :'PK3_pk') and decided_by = :'DL'::uuid from projects.p7b_portal_request_settlements where request_id = :'RQ3_rq'), 'the settlement links the request to the acceptance it produced');
select pg_temp.check((select state = 'client_accepted' from projects.phase_seven where project_id = :'P_id') and (select count(*) = 1 from core.outbox_events where type = 'project.client_handover_accepted' and subject_id = :'PK3_pk'::uuid), 'Phase 7 is CLIENT_ACCEPTED');
select pg_temp.check((select count(*) = 9 and bool_and(satisfied) from projects.p7_completion_gate(:'P_id')), 'every completion gate is satisfied');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(pg_temp.denied(format('select projects.record_client_acceptance(%L, %L, %L, %L, %L)', :'PK3_pk', 'accepted', 'signed_document', 'https://sign.example.test/x', 'Asha')), 'an agent (service role) can never record a client acceptance');
reset role;
select pg_temp.as_user(:'OTHER', :'ORG2', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.complete_phase_seven(:'P_id')) in ('not_authorized', 'not_found'), 'P708-T012: a user of another organization cannot complete this project');
select pg_temp.check((select outcome from projects.record_client_acceptance(:'PK3_pk', 'accepted', 'signed_document', 'https://sign.example.test/y', 'Eve')) in ('not_found', 'not_authorized'), 'cross-tenant: another organization cannot record acceptance');
select pg_temp.check((select count(*) = 0 from projects.p7_handover_packages) and (select count(*) = 0 from projects.p7_deployments) and (select count(*) = 0 from projects.p7_incidents), 'cross-tenant: another organization reads none of this Phase 7');
select pg_temp.check((select count(*) = 0 from projects.p7_completion_gate(:'P_id')) and (select count(*) = 0 from projects.p7_financial_clearance(:'P_id')), 'cross-tenant: the gate functions answer nothing for another organization');
reset role;
select pg_temp.as_client(:'OTHER', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) = 0 from projects.phase_seven) and (select count(*) = 0 from projects.p7_handover_packages) and (select count(*) = 0 from projects.p7_client_acceptances) and (select count(*) = 0 from projects.p7_completion_records), 'a portal client reads none of the internal Phase 7 records');
select pg_temp.check((select count(*) = 0 from projects.p7_completion_gate(:'P_id')) and (select count(*) = 0 from projects.p7_task_graph(:'P_id')), 'and the gate and task graph functions answer a portal client nothing');
reset role;

-- ═════════ 12. completion: ONE immutable record and a frozen Phase 8 intake ═════════
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select outcome as o, completion_record_id as rec from projects.complete_phase_seven(:'P_id') \gset CR_
select pg_temp.check(:'CR_o' = 'completed', 'the completion gate passes and the project completes');
reset role;
select pg_temp.check((select status = 'completed' from projects.projects where id = :'P_id'), 'the project is COMPLETED');
select pg_temp.check((select state = 'phase8_ready' and completed_at is not null from projects.phase_seven where project_id = :'P_id'), 'Phase 7 is PHASE8_READY');
select pg_temp.check((select commit_ref = 'def5678' and package_id = :'PK3_pk'::uuid and payload #>> '{release,commit}' = 'def5678' and payload #>> '{handover,version}' = '3' and payload #>> '{acceptance,evidenceKind}' = 'portal_confirmation'
                        and jsonb_array_length(payload -> 'knownLimitations') = 3 and payload #>> '{finance,status}' = 'closed' and payload #>> '{production,deploymentId}' = :'D3_d' from projects.p7_completion_records where project_id = :'P_id'),
  'the completion record snapshots the exact release, deployment, handover version, acceptance, limitations and finance');
select pg_temp.check((select phase8_ready and payload #>> '{productionVersion,commit}' = 'def5678' and payload #>> '{support,terms}' like 'Ninety days%' and jsonb_array_length(payload -> 'followUpSuggestions') = 3 from projects.phase_seven_handoffs where project_id = :'P_id'), 'the Customer Success intake carries the production version, the support/warranty terms and follow-up suggestions');
select pg_temp.check((select count(*) = 1 from core.outbox_events where type = 'project.completed' and subject_id = :'P_id'::uuid), 'ProjectCompleted was emitted once');
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome = 'already_completed' and completion_record_id = :'CR_rec'::uuid from projects.complete_phase_seven(:'P_id')), 'P701-T012: a completion replay returns the ONE canonical record');
reset role;
select pg_temp.check((select count(*) = 1 from projects.p7_completion_records where project_id = :'P_id') and (select count(*) = 1 from projects.phase_seven_handoffs where project_id = :'P_id') and (select count(*) = 1 from core.outbox_events where type = 'project.completed' and subject_id = :'P_id'::uuid), 'a replay created no second record, intake or event');
select pg_temp.door_off();
select pg_temp.check(pg_temp.refused(format('update projects.p7_completion_records set payload = %L where project_id = %L', '{}', :'P_id'), 'never edited'), 'P708-T011: the completion record is immutable');
select pg_temp.check(pg_temp.refused(format('delete from projects.p7_completion_records where project_id = %L', :'P_id'), 'never edited'), 'the completion record is never deleted');
select pg_temp.check(pg_temp.refused(format('update projects.phase_seven_handoffs set payload = %L where project_id = %L', '{}', :'P_id'), 'never edited'), 'the Customer Success intake is frozen');
select set_config('projects.p7_door', 'on', true);
select pg_temp.check(pg_temp.refused(format('update projects.phase_seven set state = %L where project_id = %L', 'deployment_planning', :'P_id'), 'does not return'), 'a completed project does not return to production work');
select pg_temp.door_off();
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_production_change(:'P_id', 'code_change', 'late tweak')) = 'project_completed', 'new work after completion is a separate workflow, not a change to the completed project');
select pg_temp.check((select outcome from projects.create_deployment_plan(:'P_id', 'prod-app-1', '{"none": true, "reason": "x"}')) = 'project_completed', 'and no new deployment plan is made for a completed project');
select pg_temp.check((select count(*) = 8 and bool_and(state = 'done') from projects.p7_task_graph(:'P_id')), 'the derived task graph shows every Phase 7 task done');
reset role;
-- a legacy project (no phase_seven row) is judged exactly as before: this rule never touches it
select pg_temp.check(pg_temp.refused(format('update projects.projects set status = %L where id = %L', 'completed', :'L_id'), 'not done'), 'a legacy project that never entered the pipeline still needs its legacy completion evidence');
update projects.projects set status = 'completed', completion_override_reason = 'legacy override with a stated reason' where id = :'L_id';
select pg_temp.check((select status = 'completed' from projects.projects where id = :'L_id'), 'and its legacy override path is unchanged');

-- ═════════ 7b-4. the Phase 7 -> Phase 8 SEAM: Phase 8's intake reads the frozen handoff (docs/phase-8a-manual-actions.md M-6) ═════════
select pg_temp.as_service();
set local role service_role;
select outcome as o, intake_id as i, intake_status as s from projects.fill_phase_eight_intake(:'ORG', :'P_id') \gset IN1_
reset role;
select pg_temp.check(:'IN1_o' = 'incomplete' and (select source = 'phase_seven_handoff' and phase_seven_handoff_ref = (select id::text from projects.phase_seven_handoffs where project_id = :'P_id') and completion_record_id is null and handover_id is null and build_ref = 'def5678' from projects.phase_eight_intake where id = :'IN1_i'),
  'the intake reads the FROZEN Phase 7 handoff: source = phase_seven_handoff, its id as the reference, the exact production build, and no legacy completion record');
select pg_temp.check((select jsonb_array_length(blockers) = 1 and blockers -> 0 ->> 'id' = 'P8-GATE-005' from projects.phase_eight_intake where id = :'IN1_i'), 'every gate reads true from the handoff except the one fact this fixture lacks (a real scope version): an honest blocker, not a guess');
select pg_temp.check((select (g ->> 'passed')::boolean from projects.phase_eight_intake i, jsonb_array_elements(i.gates) g where i.id = :'IN1_i' and g ->> 'id' = 'P8-GATE-001'), 'P8-GATE-001 (completed, with the approved build) passes from the handoff');
select pg_temp.check((select (g ->> 'passed')::boolean from projects.phase_eight_intake i, jsonb_array_elements(i.gates) g where i.id = :'IN1_i' and g ->> 'id' = 'P8-GATE-002'), 'P8-GATE-002 (a passed production verification) passes from the validated deployment');
select pg_temp.check((select (g ->> 'passed')::boolean and g ->> 'detail' like 'handover accepted%' from projects.phase_eight_intake i, jsonb_array_elements(i.gates) g where i.id = :'IN1_i' and g ->> 'id' = 'P8-GATE-003'), 'P8-GATE-003 (handover accepted) passes from the accepted exact version');
select pg_temp.check((select (g ->> 'passed')::boolean from projects.phase_eight_intake i, jsonb_array_elements(i.gates) g where i.id = :'IN1_i' and g ->> 'id' = 'P8-GATE-004'), 'P8-GATE-004 (final payment) passes from the Phase 7 financial clearance, read now');
select pg_temp.check((select package ->> 'knownLimitations' like '%Export is slow%' from projects.phase_eight_intake where id = :'IN1_i'), 'the Customer Success package carries the limitations Phase 7 disclosed');
-- a scope version now exists (the Phase 6 fixture named a random id)
set local session_replication_role = replica;
insert into projects.scope_versions (organization_id, project_id, version, status) values (:'ORG', :'P_id', 1, 'draft') returning id \gset SV_
update projects.phase_six_handoffs set payload = jsonb_set(payload, '{scopeVersionId}', to_jsonb(:'SV_id'::text)) where project_id = :'P_id';
set local session_replication_role = origin;
select pg_temp.as_service();
set local role service_role;
select outcome as o, intake_status as s from projects.fill_phase_eight_intake(:'ORG', :'P_id') \gset IN2_
reset role;
select pg_temp.check(:'IN2_o' = 'ready' and :'IN2_s' = 'ready' and (select count(*) = 1 from projects.phase_eight_intake where project_id = :'P_id'), 'with the scope version recorded the SAME intake row refreshes to READY (one row per project)');
-- a payment reversal after completion shows in the refreshed intake
set local session_replication_role = replica;
update finance.invoices set verified_minor = 50000 where id = :'I4_i';
set local session_replication_role = origin;
select pg_temp.as_service();
set local role service_role;
select outcome as o, intake_status as s from projects.fill_phase_eight_intake(:'ORG', :'P_id') \gset IN3_
reset role;
select pg_temp.check(:'IN3_s' = 'incomplete' and (select blockers -> 0 ->> 'id' = 'P8-GATE-004' from projects.phase_eight_intake where project_id = :'P_id'), 'a reversal of the verified payment after completion blocks P8-GATE-004: the money is re-read, not remembered');
set local session_replication_role = replica;
update finance.invoices set verified_minor = 100000 where id = :'I4_i';
set local session_replication_role = origin;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select intake_status from projects.fill_phase_eight_intake(:'ORG', :'P_id')) = 'ready', 'restored: ready again');
select pg_temp.check((select outcome from projects.fill_phase_eight_intake(:'ORG', :'L_id')) in ('incomplete', 'ready'), 'a LEGACY completed project (no Phase 7 row) is still evaluated');
reset role;
select pg_temp.check((select source = 'completion_record' and phase_seven_handoff_ref is null from projects.phase_eight_intake where project_id = :'L_id'), 'and it is judged exactly as before: from the legacy completion record, with no Phase 7 reference');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_phase_eight(:'P_id', current_date, current_date + 90, 'bug fixes in the delivered scope', 'new features and third-party changes', null, :'OWNER')) = 'started', 'Phase 8 starts from the Phase 7 intake');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.fill_phase_eight_intake(:'ORG', :'P_id')) = 'already_started', 'a replayed completion event after the start changes nothing (the intake is frozen)');
reset role;
select pg_temp.check((select source = 'phase_seven_handoff' from projects.phase_eight_intake where project_id = :'P_id') and (select count(*) = 1 from core.outbox_events where type = 'project.completed' and subject_id = :'P_id'::uuid), 'the intake keeps its source, and the completion event the subscriber reads was emitted exactly once');

-- ═════════ 7b-5. archive and retention (P711): ARCHIVING -> ARCHIVED, an Admin-set policy, a frozen scope, a read-only portal, a sweep that deletes nothing ═════════
-- a task and a deliverable of the completed project, and a legacy project's own, as the subjects of the freeze
insert into projects.tasks (organization_id, project_id, title) values (:'ORG', :'P_id', 'zztest p7b scope task') returning id \gset T_
insert into projects.tasks (organization_id, project_id, title) values (:'ORG', :'L_id', 'zztest p7b legacy task') returning id \gset LT_
select id as "DEL_id" from projects.deliverables where project_id = :'P_id' limit 1 \gset
insert into projects.deliverables (organization_id, project_id, kind, version, title, status) values (:'ORG', :'P_id', 'document', 1, 'zztest p7b draft document', 'draft') returning id \gset DOC_
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_project_archive(:'P_id')) = 'not_authorized', 'archiving is an Admin''s act: a delivery lead cannot start it');
select pg_temp.check((select outcome from projects.set_retention_policy('financial_records', false, 3650, null, 'seven years plus margin')) = 'not_authorized', 'and a retention rule is an Admin''s decision');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome = 'no_retention_policy' and cardinality(missing) = 8 from projects.start_project_archive(:'P_id')), 'P711 §5: with no retention policy NOTHING is archived: the system holds no default period, and names the eight classes a person must decide');
select pg_temp.check((select outcome from projects.set_retention_policy('financial_records', true, 30, null, 'x')) = 'period_or_indefinite', 'a policy is a period OR indefinite, never both');
select pg_temp.check((select outcome from projects.set_retention_policy('financial_records', false, null, null, 'x')) = 'period_or_indefinite', 'and never neither');
select pg_temp.check((select outcome from projects.set_retention_policy('financial_records', false, 30, true, 'x')) = 'portal_policy_only_for_portal_access', 'only the portal class has a read-only opinion');
select pg_temp.check((select outcome from projects.set_retention_policy('client_portal_access', false, 1, null, 'x')) = 'portal_policy_only_for_portal_access', 'and the portal class must state it');
select pg_temp.check((select outcome from projects.set_retention_policy('financial_records', false, 10, null, '')) = 'reason_required', 'a policy states why');
select pg_temp.check((select outcome from projects.set_retention_policy('bogus', true, null, null, 'x')) = 'bad_record_class', 'a policy is for a known record class');
select pg_temp.check((select outcome from projects.set_retention_policy('contractual_documents', true, null, null, 'the owner keeps contracts indefinitely')) = 'set', 'contractual documents: indefinite');
select pg_temp.check((select outcome from projects.set_retention_policy('financial_records', false, 10, null, 'the owner decided ten days for this rehearsal')) = 'set', 'financial records: a stated period');
select pg_temp.check((select outcome from projects.set_retention_policy('source_build_references', true, null, null, 'kept with the repository')) = 'set', 'source and build references: indefinite');
select pg_temp.check((select outcome from projects.set_retention_policy('approvals_audit', true, null, null, 'approvals are never expired')) = 'set', 'approvals and audit: indefinite');
select pg_temp.check((select outcome from projects.set_retention_policy('support_warranty_records', false, 100, null, 'support records are reviewed after the warranty')) = 'set', 'support and warranty records: a stated period');
select pg_temp.check((select outcome from projects.set_retention_policy('handover_packages', false, 10, null, 'rehearsal period')) = 'set', 'handover packages: a stated period');
select pg_temp.check((select outcome from projects.set_retention_policy('completion_records', true, null, null, 'the completion record is permanent')) = 'set', 'completion records: indefinite');
select pg_temp.check((select outcome from projects.set_retention_policy('client_portal_access', false, 1, true, 'read-only on archive, closed after one day (rehearsal)')) = 'set', 'client portal access: read-only on archive, open for the stated period');
select pg_temp.check((select outcome from projects.set_retention_policy('financial_records', false, 12, null, 'a newer decision')) = 'set', 'a changed decision is accepted');
select pg_temp.check((select max(version) = 2 and count(*) = 2 from projects.p7b_retention_policies where record_class = 'financial_records' and organization_id = :'ORG'), 'and is a NEW version: the old one stands');
select pg_temp.check((select outcome from projects.set_retention_policy('financial_records', false, 10, null, 'back to the rehearsal period')) = 'set', 'financial records: back to ten days (version 3)');
select pg_temp.check((select count(*) = 0 from projects.p7b_archives where project_id = :'P_id') and (select archive_state is null from projects.phase_seven where project_id = :'P_id'), 'nothing is archived yet');
-- the completed project accepts a task edit until it is archived (the freeze belongs to the archive)
select pg_temp.check((select count(*) = 1 from projects.tasks where id = :'T_id'), 'the task exists');
select pg_temp.check((select outcome = 'started' from projects.start_project_archive(:'P_id')), 'with a policy for every class an Admin starts archiving (ARCHIVING)');
select pg_temp.check((select outcome = 'already_archiving' from projects.start_project_archive(:'P_id')), 'P711-T002: a replay starts no second archive');
select pg_temp.check((select state = 'archiving' and portal_read_only and policy_snapshot -> 'financial_records' ->> 'version' = '3' and policy_snapshot -> 'client_portal_access' ->> 'days' = '1' from projects.p7b_archives where project_id = :'P_id') and (select archive_state = 'archiving' from projects.phase_seven where project_id = :'P_id'), 'the archive snapshots the policy versions in force, and the workspace says ARCHIVING');
select pg_temp.check((select count(*) = 1 from core.outbox_events where type = 'project.archive_started' and subject_id = :'P_id'::uuid), 'ArchiveStarted was emitted once');
select pg_temp.check((select lifecycle = 'completed' and portal_access = 'read_only' and accepted_version = 3 and completed_at is not null and archived_at is null from projects.client_completed_state(:'P_id')), 'an Admin reads the state: completed, portal read-only, accepted version 3');
reset role;
select pg_temp.door_off();
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(pg_temp.refused(format('update projects.tasks set title = %L where id = %L', 'edited after archive', :'T_id'), 'archived'), 'P711-T003: a completed-and-archived project''s task is not edited (even by the service role)');
select pg_temp.check(pg_temp.refused(format('insert into projects.tasks (organization_id, project_id, title) values (%L, %L, %L)', :'ORG', :'P_id', 'new work smuggled into a completed project'), 'archived'), 'new work is not added to the archived project: it is a change request or a new project');
select pg_temp.check(pg_temp.refused(format('delete from projects.tasks where id = %L', :'T_id'), 'archived'), 'a task of an archived project is not deleted: archiving is not deletion');
select pg_temp.check(pg_temp.refused(format('delete from projects.deliverables where id = %L', :'DOC_id'), 'archived'), 'a deliverable of an archived project is not deleted');
select pg_temp.check(pg_temp.refused(format('insert into projects.deliverables (organization_id, project_id, kind, version, title, status) values (%L, %L, %L, 2, %L, %L)', :'ORG', :'P_id', 'document', 'a new version smuggled in', 'draft'), 'archived'), 'and gains no new version');
select pg_temp.check(pg_temp.refused(format('update projects.deliverable_details set platform = %L where deliverable_id = %L', 'rewritten', :'DEL_id'), 'archived'), 'nor the details of a deliverable');
select pg_temp.check(pg_temp.refused(format('update projects.p7b_archives set state = %L where project_id = %L', 'archiving', :'P_id'), 'Phase 7 door'), 'the archive record is not changed by a direct statement');
select set_config('projects.p7_door', 'on', true);
select pg_temp.check(pg_temp.refused(format('update projects.p7b_archives set state = %L, archived_at = null, archived_by = null where project_id = %L', 'archiving', :'P_id'), 'ARCHIVING -> ARCHIVED once'), 'and with the door on, the record itself refuses to move backwards');
select pg_temp.check(pg_temp.refused(format('update projects.p7b_archives set portal_read_only = false where project_id = %L', :'P_id'), 'ARCHIVING -> ARCHIVED once'), 'or to change its frozen policy');
select pg_temp.door_off();
select pg_temp.check(pg_temp.refused(format('delete from projects.p7b_archives where project_id = %L', :'P_id'), 'never deleted'), 'an archive record is never deleted');
select pg_temp.check(pg_temp.refused(format('update projects.p7b_retention_policies set retention_days = 1 where organization_id = %L', :'ORG'), 'never edited'), 'a retention policy is history: a change is a new version');
update projects.tasks set title = 'legacy edit still works' where id = :'LT_id';
select pg_temp.check((select title = 'legacy edit still works' from projects.tasks where id = :'LT_id'), 'a LEGACY project (no Phase 7 row, no archive) is not affected by the freeze');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.create_deployment_plan(:'P_id', 'prod-app-1', '{"none": true, "reason": "x"}')) = 'project_completed', 'ARCHIVING does not re-open the existing completed-project refusals: no deployment plan for it');
select pg_temp.check((select outcome from projects.finish_project_archive(:'L_id')) = 'not_archiving', 'a project that is not being archived cannot be finished');
select pg_temp.check((select outcome from projects.finish_project_archive(:'P_id')) = 'archived', 'an Admin finishes the archive (ARCHIVED)');
select pg_temp.check((select outcome from projects.finish_project_archive(:'P_id')) = 'already_archived', 'a replay finishes nothing twice');
select pg_temp.check((select state = 'archived' and archived_at is not null and archived_by = :'OWNER'::uuid from projects.p7b_archives where project_id = :'P_id') and (select archive_state = 'archived' and state = 'phase8_ready' from projects.phase_seven where project_id = :'P_id'), 'ARCHIVED: and the Phase 7 state is untouched (phase8_ready): the archive is its own state');
select pg_temp.check((select count(*) = 1 from core.outbox_events where type = 'project.archived' and subject_id = :'P_id'::uuid), 'Archived was emitted once');
select pg_temp.check((select count(*) = 1 from projects.projects where id = :'P_id' and status = 'completed') and (select count(*) = 1 from projects.p7b_archives where project_id = :'P_id'), 'P711-T009: an archived project stays searchable by an authorized Admin');
reset role;
-- the client: completed, read-only, the accepted version and the date - and no write
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select lifecycle = 'archived' and portal_access = 'read_only' and accepted_version = 3 and completed_at is not null and archived_at is not null and accepted_at is not null from projects.client_completed_state(:'P_id')), 'P711 §9: the client reads ARCHIVED, read-only, the accepted handover version 3 and the dates');
select pg_temp.check((select acceptance_state = 'accepted' and portal_access = 'read_only' and project_completed and version = 3 from projects.client_handover_overview(:'P_id')), 'the delivered handover is still readable after archive');
select pg_temp.check((select count(*) = 13 from projects.client_handover_items(:'P_id')) and (select outcome from projects.log_handover_access(:'PK3_pk', 'viewed')) = 'logged', 'its items are readable and reading is still logged');
select pg_temp.check((select outcome from projects.request_handover_acceptance(:'PK3_pk', 'changes_request', 'one more thing')) = 'portal_read_only', 'P711-T006: the portal accepts NO write once the policy says read-only');
reset role;
select pg_temp.as_client(:'CL3', :'ORG', :'A2_id');
set local role authenticated;
select pg_temp.check((select count(*) = 0 from projects.client_completed_state(:'P_id')), 'another account''s client reads no completed state');
reset role;
select pg_temp.as_user(:'OTHER', :'ORG2', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) = 0 from projects.client_completed_state(:'P_id')) and (select count(*) = 0 from projects.p7b_archives) and (select count(*) = 0 from projects.p7b_retention_policies) and (select count(*) = 0 from projects.p7b_retention_reviews), 'P711-T010: another organization reads no archive, policy or review');
select pg_temp.check((select outcome from projects.start_project_archive(:'P_id')) = 'not_found' and (select outcome from projects.set_retention_policy('financial_records', true, null, null, 'x')) = 'set', 'it can neither archive this project nor touch this organization''s policy (its own policy is its own)');
reset role;
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) = 0 from projects.p7b_archives) and (select count(*) = 0 from projects.p7b_retention_policies) and (select count(*) = 0 from projects.p7b_retention_reviews), 'a portal client reads none of the archive tables');
reset role;

-- ── the retention sweep: eligible for review, nothing deleted ──
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.denied('select projects.sweep_retention_reviews()'), 'a person cannot run the sweep: it is the runner''s door');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select marked = 0 from projects.sweep_retention_reviews()), 'nothing is due the moment it was archived');
reset role;
select count(*) as n from projects.tasks where project_id = :'P_id' \gset BEFORE_T_
select count(*) as n from projects.p7_handover_packages where project_id = :'P_id' \gset BEFORE_K_
select count(*) as n from finance.invoices where project_id = :'P_id' \gset BEFORE_I_
select count(*) as n from projects.p7_completion_records where project_id = :'P_id' \gset BEFORE_C_
-- the archive is 20 days old (a fixture: the archived time is moved back with triggers off)
set local session_replication_role = replica;
update projects.p7b_archives set archived_at = clock_timestamp() - interval '20 days', started_at = clock_timestamp() - interval '21 days' where project_id = :'P_id';
set local session_replication_role = origin;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select marked = 2 from projects.sweep_retention_reviews()), 'P711: the two stated periods that have passed (financial records, handover packages) are marked ELIGIBLE FOR REVIEW; indefinite classes and the 100-day class are not');
select pg_temp.check((select marked = 0 from projects.sweep_retention_reviews()), 'a replay marks nothing twice');
select pg_temp.check((select marked = 1 from projects.sweep_retention_reviews(clock_timestamp() + interval '200 days')), 'with the clock past 100 days the support records become eligible too (the injected clock)');
reset role;
select pg_temp.check((select count(*) = 3 and bool_and(status = 'eligible_for_review') and count(*) filter (where record_class in ('contractual_documents', 'source_build_references', 'approvals_audit', 'completion_records', 'client_portal_access')) = 0 from projects.p7b_retention_reviews where project_id = :'P_id'), 'only the stated-period classes are ever marked; the portal expiry is access, not a record');
select pg_temp.check((select count(*) = :'BEFORE_T_n'::int from projects.tasks where project_id = :'P_id') and (select count(*) = :'BEFORE_K_n'::int from projects.p7_handover_packages where project_id = :'P_id')
                       and (select count(*) = :'BEFORE_I_n'::int from finance.invoices where project_id = :'P_id') and (select count(*) = :'BEFORE_C_n'::int from projects.p7_completion_records where project_id = :'P_id'), 'P711-T008: the sweep DELETED NOTHING: tasks, packages, invoices and the completion record are all still there');
select pg_temp.check((select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.proname in ('sweep_retention_reviews', 'start_project_archive', 'finish_project_archive') and position('delete from' in lower(p.prosrc)) > 0), 'and no archive or retention function contains a DELETE statement');
select pg_temp.door_off();
select pg_temp.check(pg_temp.refused(format('delete from projects.p7b_retention_reviews where project_id = %L', :'P_id'), 'never edited'), 'a review marker is history');
-- the portal's Admin-set expiry: one day after the archive, the client's window is closed
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select lifecycle = 'archived' and portal_access = 'expired' from projects.client_completed_state(:'P_id')), 'past the Admin-set expiry the portal reports EXPIRED');
select pg_temp.check((select count(*) = 0 from projects.client_handover_overview(:'P_id')) and (select count(*) = 0 from projects.client_handover_items(:'P_id')) and (select count(*) = 0 from projects.client_handover_access_receipts(:'P_id')), 'and the handover is no longer readable through the portal');
select pg_temp.check((select outcome from projects.log_handover_access(:'PK3_pk', 'viewed')) = 'portal_access_expired', 'nor logged');
reset role;

-- ═════════ 7b-6. structure: every new table is tenancy-guarded, RLS-on, internal-read, door-written ═════════
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select count(*) = 0 from core.unguarded_org_fks() where child like 'projects.p7b\_%'), 'every org-scoped foreign key of the new tables (client_account_id included) is tenancy-guarded');
select pg_temp.check((select count(*) = 0 from core.unfrozen_org_tables() where org_table like 'projects.p7b\_%'), 'every new table has a frozen organization_id');
reset role;
select pg_temp.check((select count(*) = 7 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'projects' and c.relkind = 'r' and c.relname like 'p7b\_%' and c.relrowsecurity), 'all seven new tables have row level security on');
select pg_temp.check((select count(*) = 0 from information_schema.role_table_grants g where g.grantee = 'authenticated' and g.table_schema = 'projects' and g.table_name like 'p7b\_%' and g.privilege_type <> 'SELECT'), 'authenticated holds SELECT only on every new table');
select pg_temp.check((select count(*) = 0 from information_schema.role_table_grants g where g.grantee in ('anon', 'public') and g.table_schema = 'projects' and g.table_name like 'p7b\_%'), 'anon and public hold nothing on a new table');
select pg_temp.check((select count(*) = 7 from pg_policies p where p.schemaname = 'projects' and p.tablename like 'p7b\_%' and p.cmd = 'SELECT' and p.qual like '%is_internal%'), 'each new table has exactly its internal-only read policy (a client reads through the safe functions only)');
select pg_temp.check((select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.proname in ('record_phase_seven_routing', 'sweep_retention_reviews') and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))), 'the runner doors are not executable by a signed-in person or anon');
select pg_temp.check((select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.proname in ('set_retention_policy', 'start_project_archive', 'finish_project_archive', 'client_completed_state', 'client_handover_overview', 'client_handover_items', 'client_handover_access_receipts', 'log_handover_access', 'request_handover_acceptance', 'settle_portal_handover_request') and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))), 'no portal or archive door is executable by anon or public');
select pg_temp.check((select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.proname in ('p7b_portal_project', 'p7b_portal_access', 'p7b_policy_snapshot', 'p8_build_intake') and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))), 'the internal helpers (and the Phase 8 evaluation) stay unreachable except through their doors');
select pg_temp.check((select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.proname in ('record_phase_seven_routing', 'set_retention_policy', 'start_project_archive', 'finish_project_archive', 'client_completed_state', 'client_handover_overview', 'client_handover_items', 'client_handover_access_receipts', 'log_handover_access', 'request_handover_acceptance', 'settle_portal_handover_request', 'sweep_retention_reviews', 'p7b_archive_freeze')
                       and (not p.prosecdef or not coalesce(p.proconfig @> array['search_path=""'], false))), 'every new door is SECURITY DEFINER with search_path pinned to empty');
select pg_temp.check((select count(*) = 5 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'projects' and t.tgname like 'p7b\_archive\_freeze\_%' and not t.tgisinternal), 'the archive freeze is on tasks, modules, features, deliverables and deliverable details');
select pg_temp.check((select count(*) = 0 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'projects' and c.relname = 'projects' and t.tgname like 'p7b%'), 'and nothing of this migration touches the projects table itself');

rollback;
\echo Phase 7b (portal handover surface, archive and retention, routing, the Phase 8 seam and the Phase 9 financial gate): every gate, door and record verified - OK
