-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4, Task 2 - UI design to approved prototype, to the Phase 5 gate - driven through the REAL doors on a scratch Postgres.
-- (The workflows - the AI calls - are not run here; each step the workflow would take is the door call it makes. The AI side is
-- covered by the stub-model runner in scripts/verify-phase-three-e2e.mjs's sibling when a PostgREST stack is available.)
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-four-e2e.sql          (rolls back)
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
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true); end $$;
grant execute on function pg_temp.as_service() to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set OWNER '00000000-0000-4000-8000-00000000f521'

insert into auth.users (id, email) values (:'OWNER', 'p4e2e-owner@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'p4e2e-owner@example.test', 'P4 E2E Owner') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner') on conflict do nothing;
-- the Admin decides UI-version and prototype reviews: an owner policy for each (no policy is never permission)
insert into approvals.approval_policies (organization_id, subject_type, required_role, sla_hours, audience)
  values (:'ORG', 'ui_version', 'owner', 24, 'internal') on conflict do nothing;
insert into approvals.approval_policies (organization_id, subject_type, required_role, sla_hours, audience)
  values (:'ORG', 'deliverable', 'owner', 24, 'client') on conflict do nothing;

-- ── fixture: a project that has finished Phase 3 (the handoff row is what Phase 3's lock writes) ──
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p4 e2e client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p4 e2e', 'ZP4-E2E') returning id \gset P_
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'P_id', 'M1', 1, 50000, 'INR');
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'P_id', 'M2', 2, 100000, 'INR') returning id \gset MS2_

-- 1. Phase 4 start before Phase 3 complete (NEGATIVE: no handoff exists)
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.start_phase_four(:'P_id')) = 'not_ready', 'Phase 4 cannot start before Phase 3 hands off');
reset role;

set local session_replication_role = replica;
insert into projects.phase_three_handoffs (organization_id, project_id, phase_three_id, screen_baseline_id, theme_option_id, color_option_id, client_decision_id, figma_node_id, payload, phase_four_ready, locked_at)
  values (:'ORG', :'P_id', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '1:2',
          '{"screenBaseline":{"screens":[{"screenKey":"home"},{"screenKey":"checkout"}]}}', true, now()) returning id \gset H_
set local session_replication_role = origin;

-- 2. Task 2 starts once; a duplicate Task2Started is idempotent
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.start_phase_four(:'P_id')) = 'started', 'Task 2 starts from the locked Phase 3 handoff');
select pg_temp.check((select outcome from projects.start_phase_four(:'P_id')) = 'already_started', 'a duplicate Task2Started returns the existing workspace');
select pg_temp.check((select count(*) from projects.phase_four where project_id = :'P_id') = 1, 'exactly one workspace');
select pg_temp.check(exists (select 1 from core.outbox_events where type = 'project.phase_four_started' and subject_id = (select id from projects.phase_four where project_id = :'P_id')), 'Phase4Started was emitted');
reset role;
select id as "F_id" from projects.phase_four where project_id = :'P_id' \gset


-- ═════════ UI stage ═════════
-- helpers: the door each workflow step calls
create or replace function pg_temp.ver(p_f uuid, p_n int) returns uuid language sql as $$ select id from projects.ui_versions where phase_four_id = p_f and version = p_n $$;
grant execute on function pg_temp.ver(uuid, int) to public;

-- 3. coverage + the complete UI is drafted (workflow: ui_designer:draftUIVersion)
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_ui_version_draft(:'F_id', '[{"screenKey":"home"},{"screenKey":"checkout"}]')) = 'drafted', 'the Designer drafts the complete UI (v1)');
select pg_temp.check((select outcome from projects.record_ui_version_draft(:'F_id', '[{"screenKey":"home"}]')) = 'already_drafted', 'the same event drafts nothing twice (no duplicate AI work)');

-- 4. Design QA finds a controlled defect; the Designer fixes; QA retests
select projects.record_ui_version_qa_verdict(pg_temp.ver(:'F_id',1), 'qa_changes_required', '[{"defect":"checkout has no error state"}]');
select pg_temp.check((select outcome from projects.request_ui_version_admin_review(pg_temp.ver(:'F_id',1))) = 'wrong_state', 'a QA-failed UI cannot reach Admin review');
select pg_temp.check((select outcome from projects.revise_ui_version(:'F_id', '[{"screenKey":"home"},{"screenKey":"checkout","states":["error"]}]')) = 'revised', 'the Designer fixes the exact defect (v2)');
select projects.record_ui_version_qa_verdict(pg_temp.ver(:'F_id',2), 'qa_pass', '[]');
select pg_temp.check((select status from projects.ui_versions where id = pg_temp.ver(:'F_id',2)) = 'qa_pass', 'QA retest passes v2 (v1 keeps its failure)');

-- 5. Admin review; Admin returns EDIT once
select pg_temp.check((select outcome from projects.request_ui_version_admin_review(pg_temp.ver(:'F_id',2))) = 'requested', 'only a QA-passed UI reaches Admin');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.share_ui_version_with_client(pg_temp.ver(:'F_id',2), 'x')) <> 'shared', 'NEGATIVE: the client cannot be shown a UI the Admin has not approved');
select request_id as "R2_id" from (select id as request_id from approvals.approval_requests where subject_type = 'ui_version' and subject_id = pg_temp.ver(:'F_id',2)) q \gset
select pg_temp.check((select outcome from approvals.decide_approval(:'R2_id', 'changes_requested', 'make the header sticky', null, null)) in ('decided','changes_requested'), 'the Admin returns EDIT');
select projects.sync_ui_version_decision(pg_temp.ver(:'F_id',2));
select pg_temp.check((select status from projects.ui_versions where id = pg_temp.ver(:'F_id',2)) = 'admin_edit', 'v2 is admin_edit - it never reached the client');
reset role;

-- 6. the Designer applies the Admin revision; QA; Admin approves
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.revise_ui_version(:'F_id', '[{"screenKey":"home","sticky":true},{"screenKey":"checkout","states":["error"]}]')) = 'revised', 'the Designer applies the Admin revision (v3)');
select pg_temp.check((select ui_revision_count from projects.phase_four where id = :'F_id') = 1 and (select ui_qa_fix_count from projects.phase_four where id = :'F_id') = 1, 'one client-budget round (the Admin edit) and one QA fix are counted apart');
select projects.record_ui_version_qa_verdict(pg_temp.ver(:'F_id',3), 'qa_pass', '[]');
select pg_temp.check((select outcome from projects.request_ui_version_admin_review(pg_temp.ver(:'F_id',3))) = 'requested', 'v3 reaches the Admin again');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select id as "R3_id" from approvals.approval_requests where subject_type = 'ui_version' and subject_id = pg_temp.ver(:'F_id',3) \gset
select approvals.decide_approval(:'R3_id', 'approved', 'good', null, null);
select projects.sync_ui_version_decision(pg_temp.ver(:'F_id',3));
select pg_temp.check((select status from projects.ui_versions where id = pg_temp.ver(:'F_id',3)) = 'admin_approved', 'the Admin approves v3');

-- 7. PM shares the exact version; the client asks for one allowed visual revision
select pg_temp.check((select outcome from projects.share_ui_version_with_client(pg_temp.ver(:'F_id',3), 'whatsapp:msg-1')) = 'shared', 'the PM shares the EXACT admin-approved version');
select pg_temp.check((select outcome from projects.record_ui_version_client_decision(pg_temp.ver(:'F_id',2), 'final_confirmed', 'looks good', 'whatsapp:msg-0', null)) <> 'recorded', 'NEGATIVE: an approval cannot be tied to a version the client was not shown (v2)');
select pg_temp.check((select outcome from projects.record_ui_version_client_decision(pg_temp.ver(:'F_id',3), 'change_requested', 'make the buy button green', 'whatsapp:msg-2', null)) = 'recorded', 'the client requests one visual revision of v3');
select pg_temp.check((select status from projects.ui_versions where id = pg_temp.ver(:'F_id',3)) = 'client_change', 'v3 is client_change');
reset role;

-- 8. designer -> QA -> Admin -> PM -> client again
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.revise_ui_version(:'F_id', '[{"screenKey":"home","sticky":true},{"screenKey":"checkout","states":["error"],"buyButton":"green"}]')) = 'revised', 'the Designer applies the client revision (v4)');
select projects.record_ui_version_qa_verdict(pg_temp.ver(:'F_id',4), 'qa_pass', '[]');
select projects.request_ui_version_admin_review(pg_temp.ver(:'F_id',4));
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select id as "R4_id" from approvals.approval_requests where subject_type = 'ui_version' and subject_id = pg_temp.ver(:'F_id',4) \gset
select approvals.decide_approval(:'R4_id', 'approved', 'good', null, null);
select projects.sync_ui_version_decision(pg_temp.ver(:'F_id',4));
select pg_temp.check((select outcome from projects.lock_ui_version(pg_temp.ver(:'F_id',4))) <> 'locked', 'NEGATIVE: a UI cannot be locked before the client confirms the exact version');
select projects.share_ui_version_with_client(pg_temp.ver(:'F_id',4), 'whatsapp:msg-3');
select pg_temp.check((select outcome from projects.record_ui_version_client_decision(pg_temp.ver(:'F_id',4), 'final_confirmed', 'yes, v4 is approved', 'whatsapp:msg-4', null)) = 'recorded', 'the client explicitly approves the exact UI (v4)');
select pg_temp.check((select outcome from projects.lock_ui_version(pg_temp.ver(:'F_id',4))) = 'locked', 'the UI is locked');
select pg_temp.check((select outcome from projects.lock_ui_version(pg_temp.ver(:'F_id',4))) in ('locked','already_locked'), 'a replayed lock is idempotent');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select ui_revision_count from projects.phase_four where id = :'F_id') = 2, 'two client-budget rounds were used, none above the limit');
reset role;
select pg_temp.check(exists (select 1 from core.outbox_events where type = 'project.ui_version_locked' and subject_id = pg_temp.ver(:'F_id',4)), 'UIVersionLocked was emitted: it is the Prototype Agent''s ONLY trigger');
select pg_temp.check((select count(*) from projects.prototype_artifacts where project_id = :'P_id') = 0, 'no prototype exists before the lock');

-- ═════════ Prototype stage ═════════
select pg_temp.as_service();
set local role service_role;
-- 9. the Prototype Agent builds only from the EXACT locked UI version
select pg_temp.check((select outcome from projects.record_prototype_build(pg_temp.ver(:'F_id',3), '[{"screenKey":"home"}]')) <> 'built', 'NEGATIVE: no prototype from a UI version that is not the locked one (v3)');
select pg_temp.check((select count(*) from projects.prototype_artifacts where project_id = :'P_id') = 0, 'and nothing was built');
select outcome, prototype_artifact_id as b1, deliverable_id as d1 from projects.record_prototype_build(pg_temp.ver(:'F_id',4), '[{"screenKey":"home"},{"screenKey":"checkout"}]') \gset B1_
select pg_temp.check(:'B1_outcome' = 'built', 'the Prototype Agent builds the exact locked UI version (build 1)');
select pg_temp.check((select outcome from projects.record_prototype_build(pg_temp.ver(:'F_id',4), '[{"screenKey":"home"},{"screenKey":"checkout"}]')) = 'already_built', 'a duplicate build event builds nothing twice');

-- 10. Prototype QA finds a broken route; the Prototype Agent fixes; QA retests
select projects.record_prototype_qa_verdict(:'B1_b1', 'qa_changes_required', '[{"defect":"checkout button routes nowhere"}]');
select pg_temp.check((select status from projects.prototype_artifacts where id = :'B1_b1') = 'qa_changes_required', 'Prototype QA finds the broken route');
select outcome, prototype_artifact_id as b, deliverable_id as d from projects.revise_prototype_build(pg_temp.ver(:'F_id',4), '[{"screenKey":"home"},{"screenKey":"checkout","fixed":true}]') \gset B2_
select pg_temp.check(:'B2_outcome' = 'revised', 'the Prototype Agent fixes it as a NEW build (build 2)');
select pg_temp.check((select status from projects.prototype_artifacts where id = :'B2_b') = 'draft', 'the old QA failure is not inherited: build 2 is unreviewed');
select projects.record_prototype_qa_verdict(:'B2_b', 'qa_pass', '[]');
select pg_temp.check((select qa_passed from projects.prototype_send_gate(:'B2_d')) and not (select admin_approved from projects.prototype_send_gate(:'B2_d')), 'build 2 passed QA but is not Admin-approved: the send gate is still closed');
reset role;

-- 11. NEGATIVE: the client cannot be sent a build the Admin has not approved
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select outcome as o from projects.send_prototype_for_client_review(:'B2_d', null, 'build 2') \gset S2_
select pg_temp.check(:'S2_o' = 'not_admin_approved', 'NEGATIVE: build 2 is not sent to the client before Admin approval (the gate says why)');
-- Admin returns one prototype edit
select pg_temp.check((select outcome from projects.decide_prototype_admin(:'B2_d', 'changes_required', 'tighten the spacing')) = 'decided', 'the Admin returns EDIT on build 2');
select pg_temp.check(exists (select 1 from core.outbox_events where type = 'project.prototype_admin_decided' and subject_id = :'B2_d'), 'the Admin edit is an event the Prototype Agent acts on (it used to be a dead end)');
reset role;
select pg_temp.as_service();
set local role service_role;
select outcome, prototype_artifact_id as b, deliverable_id as d from projects.revise_prototype_build(pg_temp.ver(:'F_id',4), '[{"screenKey":"home","spaced":true},{"screenKey":"checkout","fixed":true}]') \gset B3_
select pg_temp.check(:'B3_outcome' = 'revised', 'the Prototype Agent applies the Admin edit (build 3)');
select pg_temp.check((select status from projects.deliverables where id = :'B2_d') = 'superseded', 'the Admin-rejected build is superseded: it was never shown to the client');
select projects.record_prototype_qa_verdict(:'B3_b', 'qa_pass', '[]');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select projects.decide_prototype_admin(:'B3_d', 'approved', 'ok');
select outcome as o from projects.send_prototype_for_client_review(:'B3_d', null, 'build 3') \gset S3_
select pg_temp.check(:'S3_o' = 'submitted', 'QA PASS + ADMIN APPROVED: the PM shares the exact build (build 3)');
select id as "RB3_id" from approvals.approval_requests where subject_type = 'deliverable' and subject_id = :'B3_d' \gset
select approvals.decide_approval(:'RB3_id', 'changes_requested', 'logo too small', 'whatsapp:msg-10', null);
select projects.sync_deliverable_decision(:'B3_d');
select pg_temp.check((select status from projects.deliverables where id = :'B3_d') = 'changes_requested', 'the client asks for one allowed correction on build 3');
reset role;

select pg_temp.as_service();
set local role service_role;
select outcome, prototype_artifact_id as b, deliverable_id as d from projects.revise_prototype_build(pg_temp.ver(:'F_id',4), '[{"screenKey":"home","spaced":true,"logo":"large"},{"screenKey":"checkout","fixed":true}]') \gset B4_
select pg_temp.check(:'B4_outcome' = 'revised', 'the Prototype Agent applies the client correction (build 4)');
select projects.record_prototype_qa_verdict(:'B4_b', 'qa_pass', '[]');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select projects.decide_prototype_admin(:'B4_d', 'approved', 'ok');
select outcome as o from projects.send_prototype_for_client_review(:'B4_d', null, 'build 4') \gset S4_
select pg_temp.check(:'S4_o' = 'submitted', 'the PM re-shares the exact corrected build (build 4)');
select id as "RB4_id" from approvals.approval_requests where subject_type = 'deliverable' and subject_id = :'B4_d' \gset
select approvals.decide_approval(:'RB4_id', 'approved', 'build 4 approved', 'whatsapp:msg-11', null);
select projects.sync_deliverable_decision(:'B4_d');
select pg_temp.check((select status from projects.deliverables where id = :'B4_d') = 'approved', 'the client explicitly approves the exact final build (build 4)');
reset role;

-- 12. Task 2 completes (the handler projects:completePhaseFourOnPrototypeApproval calls this door)
select pg_temp.as_service();
set local role service_role;
select outcome as o from projects.complete_phase_four(:'P_id') \gset C1_
select pg_temp.check(:'C1_o' = 'completed', 'Phase 4 completes only after the final approval');
select pg_temp.check((select outcome from projects.complete_phase_four(:'P_id')) = 'already_completed', 'a replayed completion changes nothing');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.phase_four_completed' and subject_id = :'P_id') = 1, 'Phase4Completed fired exactly once, even though the door was called twice');
reset role;

-- ═════════ Finance M2 and the Phase 5 gate ═════════
-- a development task Phase 5 will want to start (its module is what makes it a Phase 5 task)
insert into projects.modules (organization_id, project_id, name) values (:'ORG', :'P_id', 'zztest p5 module') returning id \gset MOD_
insert into projects.tasks (organization_id, project_id, title, module_id, status) values (:'ORG', :'P_id', 'zztest p5 task', :'MOD_id', 'todo') returning id \gset TASK_

insert into finance.payment_accounts (organization_id, kind, label) values (:'ORG', 'upi', 'zztest receiving account') returning id \gset PAY_

-- 13. Finance creates the M2 20% invoice - once
select pg_temp.as_service();
set local role service_role;
select outcome as o, invoice_id as i from finance.create_milestone_invoice(:'ORG', :'A_id', :'P_id', :'MS2_id', 'ZP4-M2-1', 'INR', 100000, 0, 100000, '[{"position":0,"description":"M2 - 20%","quantity":1,"unit_price_minor":100000,"amount_minor":100000,"tax_rate_bp":0}]', now() + interval '7 days', null, null) \gset I1_
select pg_temp.check(:'I1_o' = 'created', 'Finance creates the M2 invoice');
select outcome as o from finance.create_milestone_invoice(:'ORG', :'A_id', :'P_id', :'MS2_id', 'ZP4-M2-2', 'INR', 100000, 0, 100000, '[{"position":0,"description":"M2 - 20%","quantity":1,"unit_price_minor":100000,"amount_minor":100000,"tax_rate_bp":0}]', now() + interval '7 days', null, null) \gset I2_
select pg_temp.check(:'I2_o' = 'already_invoiced', 'a duplicate invoice event creates no second M2 invoice');
select pg_temp.check((select count(*) from finance.invoices where milestone_id = :'MS2_id' and status <> 'void') = 1, 'exactly one live M2 invoice');
select finance.issue_invoice(:'I1_i', now() + interval '7 days');
reset role;

-- 14. PHASE 5 STAYS BLOCKED at every step short of the Admin's verification
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_task(:'TASK_id')) = 'm2_not_verified', 'invoice issued: Phase 5 is still blocked');
select pg_temp.check((select outcome from projects.phase_five_gate_status(:'P_id')) = 'invoice_issued', 'and the panel says so');
reset role;
-- the client SAYS paid (a message; there is no row for a claim) - nothing to change; the next states are the real ones
insert into finance.payment_submissions (organization_id, invoice_id, account_id, amount_minor, currency, method, reference, status, submitted_at, submitted_by_agent)
  values (:'ORG', :'I1_i', :'PAY_id', 40000, 'INR', 'upi', 'UTR-AAA-1', 'pending_verification', now(), 'project_manager') returning id \gset S1_
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_task(:'TASK_id')) = 'm2_not_verified', 'payment SUBMITTED (proof uploaded): Phase 5 is still blocked');
reset role;
-- duplicate UTR
do $$ begin
  begin
    insert into finance.payment_submissions (organization_id, invoice_id, account_id, amount_minor, currency, method, reference, status, submitted_at, submitted_by_agent)
      values ('00000000-0000-4000-8000-000000000001', (select id from finance.invoices where number = 'ZP4-M2-1'), (select id from finance.payment_accounts where label = 'zztest receiving account'), 60000, 'INR', 'upi', 'utr-aaa-1', 'pending_verification', now(), 'project_manager');
    raise exception 'FAILED: a duplicate UTR was accepted';
  exception when unique_violation then raise notice 'ok  a duplicate UTR is refused (case-insensitively)'; end;
end $$;

-- Finance Agent / PM / ops_admin cannot verify: only the owner
select pg_temp.as_user('00000000-0000-4000-8000-00000000f522', :'ORG', 'member');
insert into auth.users (id, email) values ('00000000-0000-4000-8000-00000000f522', 'p4e2e-member@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values ('00000000-0000-4000-8000-00000000f522', 'p4e2e-member@example.test', 'P4 Member') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', '00000000-0000-4000-8000-00000000f522', 'member') on conflict do nothing;
insert into auth.users (id, email) values ('00000000-0000-4000-8000-00000000f523', 'p4e2e-opsadmin@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values ('00000000-0000-4000-8000-00000000f523', 'p4e2e-opsadmin@example.test', 'P4 Ops Admin') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', '00000000-0000-4000-8000-00000000f523', 'ops_admin') on conflict do nothing;
set local role authenticated;
select pg_temp.check((select outcome from finance.verify_payment_submission(:'S1_id', '00000000-0000-4000-8000-00000000f522', 'I say so', true)) = 'forbidden', 'a member (the PM / Finance staff role) cannot verify a payment');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000f523', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from finance.verify_payment_submission(:'S1_id', '00000000-0000-4000-8000-00000000f523', 'I say so', true)) = 'forbidden', 'an ops_admin cannot verify a payment either: the owner alone');
reset role;

-- 15. UNDERPAYMENT: the owner verifies 40,000 of 100,000 - the gate stays closed
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from finance.verify_payment_submission(:'S1_id', :'OWNER', 'bank statement line 3: 40,000 received', true)) = 'verified', 'the owner verifies the 40,000 received');
select pg_temp.check((select outcome from projects.start_task(:'TASK_id')) = 'm2_not_verified', 'a VERIFIED CLAIM is not yet money: the ledger has no payment, Phase 5 is still blocked');
select payment_id as pid from finance.record_manual_payment(:'I1_i', 'UTR-AAA-1', 40000, now(), 'upi') \gset PY1_
select pg_temp.check((select outcome from finance.verify_payment(:'PY1_pid', :'OWNER')) = 'verified', 'the owner confirms the 40,000 payment in the ledger');
select pg_temp.check((select outcome from projects.start_task(:'TASK_id')) = 'm2_not_verified', 'UNDERPAYMENT (40,000 of 100,000 verified): Phase 5 is still blocked');
select pg_temp.check((select outcome from projects.phase_five_gate_status(:'P_id')) <> 'verified', 'and the panel does not say verified');
reset role;

-- 16. the balance arrives and is verified
insert into finance.payment_submissions (organization_id, invoice_id, account_id, amount_minor, currency, method, reference, status, submitted_at, submitted_by_agent)
  values (:'ORG', :'I1_i', :'PAY_id', 60000, 'INR', 'upi', 'UTR-BBB-2', 'pending_verification', now(), 'project_manager') returning id \gset S2_
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from finance.verify_payment_submission(:'S2_id', :'OWNER', 'bank statement line 9: 60,000 received', true)) = 'verified', 'the owner verifies the balance');
select payment_id as pid from finance.record_manual_payment(:'I1_i', 'UTR-BBB-2', 60000, now(), 'upi') \gset PY2_
select pg_temp.check((select outcome from finance.verify_payment(:'PY2_pid', :'OWNER')) = 'verified', 'the owner confirms the balance in the ledger');
select pg_temp.check((select count(*) from finance.receipts where payment_id in (:'PY1_pid', :'PY2_pid')) = 2, 'a receipt exists per VERIFIED payment');
select pg_temp.check((select outcome from projects.phase_five_gate_status(:'P_id')) = 'verified', 'M2 is verified paid in full: the gate status says verified');
select pg_temp.check((select outcome from projects.start_task(:'TASK_id')) <> 'm2_not_verified', 'ONLY NOW the Phase 5 start gate is open (M2PaymentVerified)');
reset role;
select pg_temp.check((select count(*) from core.outbox_events where type = 'invoice.paid' and subject_id = :'I1_i') = 1, 'the verified-payment event (the Task 3 start trigger) fired exactly once');

rollback;
\echo PHASE 4 E2E OK
