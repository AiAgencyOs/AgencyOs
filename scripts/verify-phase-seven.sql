-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 7 (Production Launch & Handover) - driven through the REAL doors on a scratch Postgres.
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
select pg_temp.check((select outcome from projects.close_incident(:'INC1_id', 'r', 't', 'a')) = 'not_authorized', 'a delivery lead cannot close an incident: closing is an Admin act');
select pg_temp.as_user(:'OPS', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from projects.close_incident(:'INC1_id', 'r', 't', 'a')) = 'not_classified', 'an unclassified incident cannot be closed');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
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
select pg_temp.as_user(:'OPS', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from projects.close_incident(:'INC1_id', 'bad route table', 'smoke failed, rolled back', 'add a route test')) = 'recovery_not_verified', 'P706-T008: rollback succeeded but the re-smoke FAILED: the incident stays open');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
reset role;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select run_id as r from projects.open_validation_run(:'D1_d', 'post_rollback', :'INC1_id') \gset V5_
select pg_temp.pass_all(:'V5_r');
select pg_temp.check((select outcome = 'finished' and status = 'passed' from projects.finish_validation_run(:'V5_r')), 'the restored version passes the re-smoke');
reset role;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.as_user(:'OPS', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from projects.close_incident(:'INC1_id', '', 't', '')) = 'review_required', 'an incident closes with a root cause and corrective actions, not with silence');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.as_user(:'OPS', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from projects.close_incident(:'INC1_id', 'route table shipped without the checkout route', 'smoke failed, rolled back, re-smoked', 'add a route test to the pipeline')) = 'closed', 'the incident closes only after the verified recovery AND a review');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
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
select pg_temp.as_user(:'OPS', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from projects.close_incident(:'INC3_id', 'missing environment variable', 'failed then config fixed', 'add the variable to the readiness checklist')) = 'closed', 'the config incident closes after the verified re-smoke');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select completion_paused from projects.phase_seven where project_id = :'P_id'), 'completion stays paused: another incident is still open');
select pg_temp.as_user(:'OPS', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from projects.close_incident(:'INC2_id', 'rounding defect', 'fixed in a new build', 'add a rounding test')) = 'recovery_not_verified', 'the code incident closes only after a PASSED run on the NEW commit');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
reset role;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select run_id as r from projects.open_validation_run(:'D3_d', 'smoke', :'INC2_id') \gset V7_
select pg_temp.pass_all(:'V7_r');
select projects.finish_validation_run(:'V7_r');
reset role;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.as_user(:'OPS', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from projects.close_incident(:'INC2_id', 'rounding defect', 'fixed in a new build', 'add a rounding test')) = 'closed', 'the code incident closes after the new commit is validated in production');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
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
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.deliver_handover_package(:'PK1_pk', 'portal')) = 'not_admin_approved', 'the superseded version cannot be delivered');
select pg_temp.check((select outcome from projects.deliver_handover_package(:'PK2_pk', '')) = 'channel_required', 'delivery names the channel');
select pg_temp.check((select outcome from projects.deliver_handover_package(:'PK2_pk', 'client portal')) = 'delivered', 'the Admin-approved package is delivered');
select pg_temp.check((select state = 'client_handover_review' from projects.phase_seven where project_id = :'P_id'), 'Phase 7 is CLIENT_HANDOVER_REVIEW');
reset role;
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
select pg_temp.check((select outcome from projects.record_client_acceptance(:'PK2_pk', 'changes_requested', 'email_reply', 'https://mail.example.test/t/1', 'Asha', 'the admin guide misses the refund screen')) = 'recorded', 'the client asks for a correction (formally, with evidence)');
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
select pg_temp.check((select outcome from projects.record_client_acceptance(:'PK3_pk', 'accepted', 'signed_document', 'https://sign.example.test/doc/2', 'Asha Verma', 'accepted version 3')) = 'recorded', 'P708 E2E: the client''s formal acceptance of the EXACT version 3 is recorded, with evidence');
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
select pg_temp.check((select commit_ref = 'def5678' and package_id = :'PK3_pk'::uuid and payload #>> '{release,commit}' = 'def5678' and payload #>> '{handover,version}' = '3' and payload #>> '{acceptance,evidenceKind}' = 'signed_document'
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

-- ═════════ 13. structure: tenancy, RLS, grants, the exact-candidate and completion guards are in the live schema ═════════
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select count(*) = 0 from core.unguarded_org_fks() where child like 'projects.p7\_%' or child like 'projects.phase\_seven%'), 'every org-scoped foreign key of the Phase 7 tables is tenancy-guarded');
select pg_temp.check((select count(*) = 0 from core.unfrozen_org_tables() where org_table like 'projects.p7\_%' or org_table like 'projects.phase\_seven%'), 'every Phase 7 table has a frozen organization_id');
reset role;
select pg_temp.check((select count(*) = 24 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'projects' and c.relkind = 'r' and (c.relname like 'p7\_%' or c.relname like 'phase\_seven%') and c.relrowsecurity), 'all 24 Phase 7 tables have row level security on');
select pg_temp.check((select count(*) = 0 from information_schema.role_table_grants g where g.grantee = 'authenticated' and g.table_schema = 'projects' and (g.table_name like 'p7\_%' or g.table_name like 'phase\_seven%') and g.privilege_type <> 'SELECT'), 'authenticated holds SELECT only on every Phase 7 table');
select pg_temp.check((select count(*) = 0 from information_schema.role_table_grants g where g.grantee in ('anon', 'public') and g.table_schema = 'projects' and (g.table_name like 'p7\_%' or g.table_name like 'phase\_seven%')), 'anon and public hold nothing on a Phase 7 table');
select pg_temp.check((select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.prosecdef and p.proname in ('request_deployment', 'record_deployment_progress', 'record_deployment_blocker') and has_function_privilege('authenticated', p.oid, 'execute')), 'the deployment-record doors are not executable by a signed-in person');
select pg_temp.check((select count(*) = 3 from ai.agents where key in ('deployment_agent', 'release_qa', 'incident_recovery') and not enabled), 'the three Phase 7 agents exist and are DISABLED');
select pg_temp.check((select count(*) = 3 from ai.agent_handoff_targets where from_agent in ('deployment_agent', 'release_qa', 'incident_recovery') and to_agent = 'quality_assurance'), 'and each hands off only to QA');

rollback;
\echo Phase 7 (production launch and handover): every gate, door and record verified - OK
