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
create or replace function pg_temp.refused(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when restrict_violation then return position(needle in sqlerrm) > 0; end $$;
grant execute on function pg_temp.refused(text, text) to public;
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
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.start_phase_five(:'P_id')) = 'm2_not_verified', 'NEGATIVE: the Phase 5 workspace is refused before M2 is verified (invoice issued is not enough)');
select pg_temp.check((select count(*) from projects.phase_five where project_id = :'P_id') = 0, 'and no workspace or baseline exists');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
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

-- 17. Phase 5 READY: the workspace locks the exact baseline
insert into projects.scope_versions (organization_id, project_id, version, status, frozen_at, source) values (:'ORG', :'P_id', 1, 'active', now(), 'onboarding');
select pg_temp.check((select outcome from projects.start_task(:'TASK_id')) = 'no_baseline', 'M2 verified but no baseline yet: a development task still cannot start against "the latest design"');
select pg_temp.as_service();
set local role service_role;
select outcome as o, phase_five_id as f5 from projects.start_phase_five(:'P_id') \gset P5_
select pg_temp.check(:'P5_o' = 'started', 'Phase 5 starts (Phase 4 complete + M2 verified)');
select pg_temp.check((select outcome from projects.start_phase_five(:'P_id')) = 'already_started', 'a duplicate Phase5Started starts nothing twice');
select pg_temp.check((select count(*) from projects.development_baselines where project_id = :'P_id') = 1, 'exactly one baseline');
select pg_temp.check((select ui_version_id from projects.development_baselines where project_id = :'P_id') = pg_temp.ver(:'F_id',4), 'the baseline names the EXACT locked UI version (v4), not the latest');
select pg_temp.check((select prototype_deliverable_id from projects.development_baselines where project_id = :'P_id') = :'B4_d', 'and the EXACT client-approved prototype build (build 4)');
select pg_temp.check(exists (select 1 from core.outbox_events where type = 'project.phase_five_started' and subject_id = :'P5_f5'), 'Phase5Started was emitted');
select pg_temp.check(pg_temp.refused(format('update projects.development_baselines set base_commit = ''abc'' where project_id = %L', :'P_id'), 'never edited'), 'a locked baseline cannot be edited');
select pg_temp.check((select count(*) from projects.phase_five_agent_state where project_id = :'P_id') = 11, 'every specialist has a recorded state when Phase 5 starts');
select pg_temp.check((select state = 'not_required' and length(reason) > 0 from projects.phase_five_agent_state where project_id = :'P_id' and agent_key = 'mobile_developer'), 'a web project: the Mobile Developer is NOT_REQUIRED, with the reason recorded');
select pg_temp.check((select state = 'not_required' and length(reason) > 0 from projects.phase_five_agent_state where project_id = :'P_id' and agent_key = 'refactor_performance'), 'no approved need: Refactor/Performance is NOT_REQUIRED, with the reason recorded');
do $$ begin
  begin
    update projects.phase_five_agent_state set reason = null where agent_key = 'mobile_developer';
    raise exception 'FAILED: NOT_REQUIRED without a reason was accepted';
  exception when check_violation then raise notice 'ok  NOT_REQUIRED cannot lose its reason (a CHECK)'; end;
end $$;
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_task(:'TASK_id')) not in ('m2_not_verified', 'no_baseline'), 'with the baseline locked, the task start moves on to its ordinary checks');
select pg_temp.check((select outcome from projects.set_phase_five_agent_state(:'P_id', 'mobile_developer', 'not_required', null)) = 'reason_required', 'the Admin cannot mark a specialist NOT_REQUIRED without saying why');
select pg_temp.check((select outcome from projects.set_phase_five_agent_state(:'P_id', 'mobile_developer', 'required', null)) = 'set', 'the Admin can turn a conditional specialist on (the client added a mobile app)');
reset role;
select pg_temp.check((select count(*) from core.outbox_events where type = 'invoice.paid' and subject_id = :'I1_i') = 1, 'the verified-payment event (the Task 3 start trigger) fired exactly once');

-- ═════════ Phase 5: development builds, the client-test gate, DoD, and the Phase 6 financial gate ═════════
-- 17b. PLAN before code: acceptance criteria, a named specialist, full scope coverage, no unsequenced work on the same files, an Admin's approval
select id as sv from projects.scope_versions where project_id = :'P_id' and status = 'active' \gset SC_
insert into projects.features (organization_id, project_id, module_id, name) values (:'ORG', :'P_id', :'MOD_id', 'zztest cart') returning id \gset FEAT_
-- (a frozen scope version refuses new items by design; the fixture adds the item as the table owner)
set local session_replication_role = replica;
insert into projects.scope_items (organization_id, scope_version_id, feature_id, title, inclusion, position) values (:'ORG', :'SC_sv', :'FEAT_id', 'The customer can pay', 'included', 0);
set local session_replication_role = origin;
insert into projects.tasks (organization_id, project_id, title, feature_id, module_id, status) values (:'ORG', :'P_id', 'zztest pay screen', :'FEAT_id', :'MOD_id', 'todo') returning id \gset T2_
insert into projects.tasks (organization_id, project_id, title, feature_id, module_id, status) values (:'ORG', :'P_id', 'zztest pay api', :'FEAT_id', :'MOD_id', 'todo') returning id \gset T3_
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_task(:'T2_id')) = 'no_approved_plan', 'NEGATIVE: with a baseline but no approved plan, development does not start');
select plan_id as pl from projects.create_development_plan(:'P_id', 'Build the checkout', 'payment provider sandbox', 'unit + API + E2E', 'revert the release') \gset PL_
select pg_temp.check(exists (select 1 from projects.check_development_plan(:'PL_pl') c where c.problem = 'The plan has no tasks.'), 'an empty plan names its problem');
select pg_temp.check((select outcome from projects.plan_task(:'TASK_id', :'PL_pl', 'the module task works', 'backend_developer', 'low', '{}')) = 'planned', 'a task is planned with criteria, a specialist and a risk');
select pg_temp.check(exists (select 1 from projects.check_development_plan(:'PL_pl') c where c.problem like 'Scope not covered: feature "zztest cart"%'), 'a feature with an included scope item and no task is NOT covered');
select pg_temp.check((select outcome from projects.plan_task(:'T2_id', :'PL_pl', null, 'refactor_performance', 'high', '{src/cart.ts}')) = 'planned', 'task two planned with no criteria and a NOT_REQUIRED specialist');
select pg_temp.check((select outcome from projects.plan_task(:'T3_id', :'PL_pl', 'the pay API returns 200 and a receipt', 'backend_developer', 'high', '{src/cart.ts}')) = 'planned', 'task three planned on the same file');
select pg_temp.check(exists (select 1 from projects.check_development_plan(:'PL_pl') c where c.problem like 'Task "zztest pay screen" has no acceptance criteria.'), 'a task with no acceptance criteria is a problem');
select pg_temp.check(exists (select 1 from projects.check_development_plan(:'PL_pl') c where c.problem like '%refactor_performance, which is NOT_REQUIRED%'), 'work cannot be given to a specialist recorded NOT_REQUIRED');
select pg_temp.check(exists (select 1 from projects.check_development_plan(:'PL_pl') c where c.problem like '%touch the same files and are not sequenced%'), 'two tasks on the same files with no dependency is a problem');
select pg_temp.check((select outcome from projects.approve_development_plan(:'PL_pl')) = 'not_approvable', 'a plan with problems cannot be approved');
select pg_temp.check((select outcome from projects.plan_task(:'T2_id', :'PL_pl', 'the pay screen shows totals and a pay button', 'frontend_developer', 'medium', '{src/cart.ts}')) = 'planned', 'task two re-planned properly');
select pg_temp.check((select outcome from projects.add_task_dependency(:'T3_id', :'T2_id')) = 'added', 'the API depends on the screen: sequenced');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000f522', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.approve_development_plan(:'PL_pl')) = 'not_authorized', 'a delivery person (the PM) cannot approve the plan: an Admin does');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(not exists (select 1 from projects.check_development_plan(:'PL_pl')), 'the plan now has no problems');
select pg_temp.check((select outcome from projects.approve_development_plan(:'PL_pl')) = 'approved', 'the Admin approves the plan');
select pg_temp.check((select outcome from projects.approve_development_plan(:'PL_pl')) = 'already_approved', 'a duplicate approval changes nothing');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.development_plan_approved' and subject_id = :'PL_pl') = 1, 'the approval is announced exactly once, for the Orchestrator to route');
select pg_temp.check((select outcome from projects.plan_task(:'T2_id', :'PL_pl', 'changed after approval', 'frontend_developer', 'low', '{}')) = 'plan_not_draft', 'an approved plan is not edited by re-planning its tasks');
reset role;
-- the shape of the handoff the Orchestrator's routing handler writes: accepted for a declared specialist, refused for anyone else
insert into ai.handoffs (organization_id, correlation_id, from_agent, to_agent, project_id, task_id, subject_type, subject_id, objective, context)
  values (:'ORG', :'PL_pl', 'orchestrator', 'backend_developer', :'P_id', :'T3_id', 'development_task', :'T3_id', 'Development task: pay api', '{"envelope":{"idempotencyKey":"t:p:1"}}');
select pg_temp.check((select count(*) from ai.handoffs where subject_type = 'development_task' and subject_id = :'T3_id') = 1, 'the Orchestrator can hand a planned task to the specialist the plan names');
do $$ begin
  begin
    insert into ai.handoffs (organization_id, correlation_id, from_agent, to_agent, project_id, subject_type, subject_id, objective)
      values ('00000000-0000-4000-8000-000000000001', gen_random_uuid(), 'orchestrator', 'finance', (select id from projects.projects where project_code = 'ZP4-E2E'), 'development_task', gen_random_uuid(), 'route development to Finance');
    raise exception 'FAILED: the Orchestrator handed development work to Finance';
  exception when others then
    if sqlerrm like 'FAILED:%' then raise; end if;
    raise notice 'ok  the database refuses a route the registry does not declare (orchestrator -> finance)';
  end;
end $$;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_task(:'T3_id')) = 'dependencies_open', 'the API waits for the screen');
select pg_temp.check((select outcome from projects.start_task(:'T2_id')) = 'started', 'the first planned task starts, stamped with the baseline');
select pg_temp.check((select baseline_id is not null from projects.tasks where id = :'T2_id'), 'the task carries its baseline');
reset role;
-- a task that is planned but touches the files of a task in progress with no sequencing cannot start beside it
insert into projects.tasks (organization_id, project_id, title, feature_id, module_id, status, plan_id, affected_paths)
  values (:'ORG', :'P_id', 'zztest hotfix cart', :'FEAT_id', :'MOD_id', 'todo', :'PL_pl', '{src/cart.ts}') returning id \gset T6_
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_task(:'T6_id')) = 'path_conflict', 'two agents are not put on the same files without sequencing');
reset role;
select pg_temp.check(pg_temp.refused(format('update projects.development_plans set summary = ''rewritten'' where id = %L', :'PL_pl'), 'never edited'), 'an approved plan cannot be edited: a change is a new version');

-- 18. a development build must resolve to an exact commit, be QA'd independently, and be Admin-approved before the client sees it
select pg_temp.as_service();
set local role service_role;
select deliverable_id as bd from projects.add_deliverable(:'P_id', 'build', 'Development build 1', 'https://builds.example.test/1', 'initial', null, '00000000-0000-4000-8000-00000000f522', null, null) \gset BD1_
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select outcome as o from projects.submit_deliverable(:'BD1_bd', :'OWNER', 'build 1') \gset X1_
select pg_temp.check(:'X1_o' = 'no_commit', 'NEGATIVE: a build with no exact commit cannot be sent to the client');
select pg_temp.check((select outcome from projects.set_deliverable_details(:'BD1_bd', 'web', 'abc1234', 'build-1', null, null)) is not null, 'the build records its exact commit and number');
select outcome as o from projects.submit_deliverable(:'BD1_bd', :'OWNER', 'build 1') \gset XB0_
select pg_temp.check(:'XB0_o' = 'no_build_run', 'NEGATIVE: an exact commit with no recorded build run (stages, fingerprint, hash) is not sent');
reset role;
-- the CI runner (service role) records its runs
select pg_temp.as_service();
set local role service_role;
select outcome as o, run_id as r from projects.record_build_run(:'BD1_bd', 'review', 'failed', 'test_failed', '[{"name":"test","status":"failed"}]', '{"node":"22"}', null, null) \gset BR1_
select pg_temp.check(:'BR1_o' = 'recorded', 'a failed run is recorded with its failure class');
select pg_temp.check((select outcome from projects.record_build_run(:'BD1_bd', 'review', 'failed', 'test_failed', '[]', '{}', null, :'BR1_r')) = 'not_retryable', 'a deterministic failure is not retried: it goes back to the specialist');
select outcome as o, run_id as r from projects.record_build_run(:'BD1_bd', 'review', 'failed', 'infra_transient', '[{"name":"install","status":"failed"}]', '{"node":"22"}', null, null) \gset BR2_
select outcome as o, run_id as r from projects.record_build_run(:'BD1_bd', 'review', 'failed', 'infra_transient', '[]', '{}', null, :'BR2_r') \gset BR3_
select pg_temp.check(:'BR3_o' = 'recorded', 'a transient infrastructure failure may be retried (attempt 2)');
select outcome as o, run_id as r from projects.record_build_run(:'BD1_bd', 'review', 'failed', 'infra_transient', '[]', '{}', null, :'BR3_r') \gset BR4_
select pg_temp.check((select outcome from projects.record_build_run(:'BD1_bd', 'review', 'failed', 'infra_transient', '[]', '{}', null, :'BR4_r')) = 'retries_exhausted', 'retries are bounded: the fourth attempt is refused');
select pg_temp.check((select outcome from projects.record_build_run(:'BD1_bd', 'production', 'succeeded', null, '[{"name":"build","status":"ok"}]', '{"node":"22"}', repeat('a', 64), null)) = 'bad_environment', 'a production environment is refused in Phase 5');
do $$ begin
  begin
    perform projects.record_build_run((select id from projects.deliverables where title = 'Development build 1'), 'review', 'succeeded', null, '[{"name":"build","status":"ok"}]', '{"env":"API_KEY=sk-abcdefghijklmnopqrstuvwx"}', repeat('a', 64), null);
    raise exception 'FAILED: a secret value was stored in a build run';
  exception when restrict_violation then raise notice 'ok  a build run cannot carry a secret value'; end;
end $$;
do $$ begin
  begin
    perform projects.record_build_run((select id from projects.deliverables where title = 'Development build 1'), 'review', 'succeeded', null, '[{"name":"build","status":"ok"}]', '{"node":"22"}', repeat('a', 63), null);
    raise exception 'FAILED: a malformed artifact hash was accepted';
  exception when check_violation then raise notice 'ok  an artifact hash must be a real sha256'; end;
end $$;
select outcome as o from projects.record_build_run(:'BD1_bd', 'review', 'succeeded', null, '[{"name":"lint","status":"ok"},{"name":"test","status":"ok"},{"name":"build","status":"ok"}]', '{"os":"linux","node":"22","lockfile":"sha256:abc"}', repeat('a', 64), null) \gset BR5_
select pg_temp.check(:'BR5_o' = 'recorded', 'the successful run records stages, fingerprint and the artifact hash');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select outcome as o from projects.submit_deliverable(:'BD1_bd', :'OWNER', 'build 1') \gset XR0_
select pg_temp.check(:'XR0_o' = 'review_missing', 'NEGATIVE: a built exact commit with no independent code review is not sent');
reset role;
-- independent code / security review of the exact commit
select pg_temp.as_user('00000000-0000-4000-8000-00000000f522', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_code_review(:'BD1_bd', 'passed')) = 'self_review', 'the developer cannot approve their own code');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000f523', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_code_review(:'BD1_bd', 'passed', '[{"severity":"high","title":"SQL built from user input"}]')) = 'blocking_finding', 'a review carrying a HIGH finding cannot pass');
select pg_temp.check((select outcome from projects.record_code_review(:'BD1_bd', 'passed', '[]', true, 'I rewrote the query myself')) = 'recorded', 'a reviewer who edited the code records a pass');
select pg_temp.check((select verdict from projects.build_review_status(:'BD1_bd')) = 'needs_second', 'but a reviewer who changed the code is not independent of it: a second reviewer is required');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_code_review(:'BD1_bd', 'passed', '[{"severity":"low","title":"naming"}]')) = 'recorded', 'a second independent reviewer passes the same commit');
select pg_temp.check((select verdict from projects.build_review_status(:'BD1_bd')) = 'passed', 'the review stands');
select projects.set_deliverable_details(:'BD1_bd', 'web', 'def5678', 'build-1', null, null);
select pg_temp.check((select verdict from projects.build_review_status(:'BD1_bd')) = 'stale', 'a changed commit makes the earlier review STALE');
select projects.set_deliverable_details(:'BD1_bd', 'web', 'abc1234', 'build-1', null, null);
select outcome as o from projects.submit_deliverable(:'BD1_bd', :'OWNER', 'build 1') \gset X2_
select pg_temp.check(:'X2_o' = 'not_qa_passed', 'NEGATIVE: an exact, reviewed build that has not passed QA is not sent');
reset role;
-- no production deployment in Phase 5 (a CHECK, not a convention)
do $$ begin
  begin
    update projects.deliverable_details set target_env = 'production' where deliverable_id = (select id from projects.deliverables where title = 'Development build 1');
    raise exception 'FAILED: a production target was accepted in Phase 5';
  exception when check_violation then raise notice 'ok  a Phase 5 build cannot target production'; end;
end $$;
-- duplicate build number
do $$ declare v uuid; begin
  insert into projects.deliverables (organization_id, project_id, kind, version, title) values ('00000000-0000-4000-8000-000000000001', (select project_id from projects.deliverables where title = 'Development build 1'), 'build', 99, 'dup') returning id into v;
  begin
    insert into projects.deliverable_details (deliverable_id, organization_id, project_id, build_number) select v, organization_id, project_id, 'build-1' from projects.deliverables where id = v;
    raise exception 'FAILED: a duplicate build number was accepted';
  exception when unique_violation then raise notice 'ok  a build number is unique within the project'; end;
end $$;

-- the builder (f522) cannot pass their own build; an independent person can
select pg_temp.as_user('00000000-0000-4000-8000-00000000f522', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_build_qa_verdict(:'BD1_bd', 'passed', 'looks fine')) = 'self_review', 'the builder cannot QA-pass their own build');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_build_admin(:'BD1_bd', 'approved', 'ok')) = 'not_qa_passed', 'NEGATIVE: the Admin cannot approve a build QA has not passed');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000f523', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_build_qa_verdict(:'BD1_bd', 'passed', 'smoke + regression green')) = 'recorded', 'an independent person records the QA pass');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_build_admin(:'BD1_bd', 'approved', 'ok')) = 'decided', 'the Admin approves the QA-passed build');
select outcome as o from projects.submit_deliverable(:'BD1_bd', :'OWNER', 'build 1') \gset X3_
select pg_temp.check(:'X3_o' = 'submitted', 'QA PASS + ADMIN APPROVED + exact commit: the PM shares the build');
select id as "RBD1_id" from approvals.approval_requests where subject_type = 'deliverable' and subject_id = :'BD1_bd' \gset
select pg_temp.check(exists (select 1 from projects.phase_readiness(:'P_id', 5) r, unnest(r.missing) m where m = 'No client-approved development build.'), 'DoD: shared is not approved - Phase 5 is not complete');
reset role;
-- a change to the shared build's commit is refused
do $$ begin
  begin
    update projects.deliverable_details set commit_ref = 'ffff999' where deliverable_id = (select id from projects.deliverables where title = 'Development build 1');
    raise exception 'FAILED: a shared build''s commit was rewritten';
  exception when restrict_violation then raise notice 'ok  a client-shared build''s commit cannot be rewritten'; end;
end $$;

-- 19. a defect found in the shared build: a FIX claim does not make the build final
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
insert into qa.defects (organization_id, project_id, deliverable_id, severity, title, reproduction, reported_by) values (:'ORG', :'P_id', :'BD1_bd', 'major', 'client found a crash', 'open the cart', :'OWNER') returning id \gset DF_
set local role authenticated;
select approvals.decide_approval(:'RBD1_id', 'approved', 'approved by client', 'whatsapp:msg-20', null);
select projects.sync_deliverable_decision(:'BD1_bd');
select pg_temp.check((select status from projects.deliverables where id = :'BD1_bd') = 'approved', 'the client approves the exact build (build 1)');
select pg_temp.check('major defect is not verified fixed.' = any (select regexp_replace(m, '^\d+ ', '') from unnest((select missing from projects.phase_readiness(:'P_id', 5))) m) or exists (select 1 from unnest((select missing from projects.phase_readiness(:'P_id', 5))) m where m like '%not verified fixed%'), 'DoD: an unverified major defect blocks Phase 5 completion');
reset role;
update qa.defects set status = 'fixed', resolution = 'patched' where id = :'DF_id';
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(exists (select 1 from projects.phase_readiness(:'P_id', 5) r, unnest(r.missing) m where m like '%not verified fixed%'), 'FIX_READY still blocks completion: only a verified fix counts');
reset role;

-- 19b. client feedback on the shared build is classified and routed; a new feature is never a free "bug"
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select feedback_id as fid from projects.record_build_feedback(:'BD1_bd', 'The cart page crashes when I tap pay', 'whatsapp:msg-30') \gset FB1_
select feedback_id as fid from projects.record_build_feedback(:'BD1_bd', 'Please also add a loyalty points programme', 'whatsapp:msg-31') \gset FB2_
select feedback_id as fid from projects.record_build_feedback(:'BD1_bd', 'Can the header be a bit friendlier?', 'whatsapp:msg-32') \gset FB3_
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.build_feedback_received' and subject_id in (:'FB1_fid', :'FB2_fid', :'FB3_fid')) = 3, 'each piece of feedback tells the PM (PM5-M03) and the event carries no client words');
select pg_temp.check(not exists (select 1 from core.outbox_events where type = 'project.build_feedback_received' and payload::text like '%loyalty%'), 'the event never carries the client''s words');
select pg_temp.check((select outcome from projects.classify_build_feedback(:'FB1_fid', 'bug')) = 'defect_raised', 'a BUG becomes a mandatory defect');
select pg_temp.check((select count(*) from qa.defects where deliverable_id = :'BD1_bd' and title like 'Client feedback (bug)%' and status = 'open') = 1, 'the defect is open against the exact build');
select pg_temp.check((select outcome from projects.classify_build_feedback(:'FB2_fid', 'new_feature')) = 'change_request_raised', 'a NEW_FEATURE becomes a Change Request');
select pg_temp.check((select count(*) from qa.defects where deliverable_id = :'BD1_bd' and title like '%loyalty%') = 0, 'and it is NOT raised as a defect to make it free');
select pg_temp.check((select outcome from projects.classify_build_feedback(:'FB2_fid', 'bug')) = 'already_classified', 'a routed new feature cannot be re-labelled as a bug');
select pg_temp.check((select outcome from projects.classify_build_feedback(:'FB3_fid', 'clarification')) = 'clarification_needed', 'a CLARIFICATION is resolved before implementation');
reset role;
select pg_temp.check(pg_temp.refused(format('update projects.build_feedback set classification = ''bug'' where id = %L', :'FB2_fid'), 'cannot be re-labelled'), 'the database refuses re-labelling a new feature as a bug');
do $$ begin
  begin
    update projects.build_feedback set defect_id = (select id from qa.defects where title like 'Client feedback (bug)%' limit 1) where classification = 'new_feature';
    raise exception 'FAILED: a new feature was linked to a defect';
  exception when check_violation then raise notice 'ok  scope-changing feedback can never carry a defect (a CHECK, not a prompt)'; end;
end $$;

-- 19b2. FLAKY != PASS, and documents never exceed their evidence
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select flaky_id as fl from qa.record_flaky_test(:'P_id', 'cart.pay.spec', 'e2e', 'timing') \gset FL_
select pg_temp.check((select outcome from qa.record_flaky_test(:'P_id', 'cart.pay.spec')) = 'seen_again', 'a test seen flaking again is counted, not re-filed');
select pg_temp.check(exists (select 1 from projects.phase_readiness(:'P_id', 5) r, unnest(r.missing) m where m like '%flaky test%'), 'an OPEN flaky test blocks Phase 5 completion (retrying until green is not a resolution)');
select pg_temp.check((select outcome from qa.resolve_flaky_test(:'FL_fl', 'quarantine', null, now() + interval '90 days')) = 'expiry_required_within_30_days', 'a quarantine needs an expiry within 30 days');
select pg_temp.check((select outcome from qa.resolve_flaky_test(:'FL_fl', 'quarantine', null, now() + interval '7 days')) = 'quarantined', 'a flaky test can be quarantined, owned and time-boxed');
select pg_temp.check(not exists (select 1 from projects.phase_readiness(:'P_id', 5) r, unnest(r.missing) m where m like '%flaky test%'), 'an owned, unexpired quarantine does not block');
reset role;
update qa.flaky_tests set expires_at = now() - interval '1 day' where id = :'FL_fl';
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(exists (select 1 from projects.phase_readiness(:'P_id', 5) r, unnest(r.missing) m where m like '%flaky test%'), 'an EXPIRED quarantine blocks again');
select pg_temp.check((select outcome from qa.resolve_flaky_test(:'FL_fl', 'resolve', null)) = 'resolution_required', 'a flaky test is resolved by saying what was fixed');
select pg_temp.check((select outcome from qa.resolve_flaky_test(:'FL_fl', 'resolve', 'removed the shared timer; fixed in abc1234')) = 'resolved', 'resolved with the root cause');
select pg_temp.check((select outcome from qa.record_flaky_test(:'P_id', 'cart.pay.spec')) = 'seen_again', 'a resolved test seen flaking again is recorded');
select pg_temp.check((select status from qa.flaky_tests where id = :'FL_fl') = 'open', 'and REOPENS: a fix claim was not a fix');
select pg_temp.check((select outcome from qa.resolve_flaky_test(:'FL_fl', 'resolve', 'really fixed this time: mocked the clock')) = 'resolved', 'resolved again');
-- documents
select connection_id as ic from projects.register_integration(:'P_id', 'payment', 'Razorpay') \gset IC_
select pg_temp.check((select outcome from projects.record_technical_document(:'P_id', 'integration', 'Razorpay payments', 'implemented', 'tests/pay.spec', :'IC_ic', 'configured in staging')) = 'refused', 'an integration cannot be documented IMPLEMENTED while it is not VERIFIED');
select pg_temp.check((select outcome from projects.record_technical_document(:'P_id', 'integration', 'Razorpay payments', 'partial', null, :'IC_ic', 'configured in staging; not yet verified')) = 'recorded', 'it can be documented as PARTIAL');
select pg_temp.check((select outcome from projects.record_technical_document(:'P_id', 'api', 'Cart API', 'implemented', null, null, 'POST /cart')) = 'invalid', 'IMPLEMENTED with no evidence is refused');
select pg_temp.check((select outcome from projects.record_technical_document(:'P_id', 'api', 'Cart API', 'implemented', 'src/cart/route.ts', null, 'POST /cart')) = 'recorded', 'IMPLEMENTED names the evidence it was derived from');
select pg_temp.check((select outcome from projects.record_technical_document(:'P_id', 'architecture', 'Config', 'implemented', 'docs/config.md', null, 'RAZORPAY_API_KEY=sk-abcdefghijklmnopqrstuvwx')) = 'refused', 'a secret value is never written into a document');
reset role;

-- 19c. Phase 5 completes only when the DoD holds, and hands Phase 6 a frozen intake
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.complete_phase(:'P_id', 5)) = 'not_ready', 'NEGATIVE: Phase 5 will not complete while defects are unverified and tasks are open');
select pg_temp.check((select outcome from projects.register_integration(:'P_id', 'whatsapp', 'WhatsApp Business')) = 'registered', 'an integration is registered (and is only UNKNOWN)');
reset role;
-- QA verifies the two defects: the first was a fix claim made earlier, the second is fixed by the developer and verified by QA
select pg_temp.as_user('00000000-0000-4000-8000-00000000f522', :'ORG', 'member');
update qa.defects set status = 'fixed', resolution = 'patched' where deliverable_id = :'BD1_bd' and title like 'Client feedback (bug)%';
select pg_temp.as_user('00000000-0000-4000-8000-00000000f523', :'ORG', 'ops_admin');
update qa.defects set status = 'verified', verified_by = '00000000-0000-4000-8000-00000000f523', verified_at = now() where deliverable_id = :'BD1_bd' and status = 'fixed';
select pg_temp.check((select count(*) from qa.defects where project_id = :'P_id' and status <> 'verified') = 0, 'every defect is VERIFIED by someone other than its fixer');
-- (the duplicate-number fixture build from step 18 was a stray draft; it is retired so the DoD sees only real builds)
set local session_replication_role = replica;
update projects.deliverables set status = 'superseded' where title = 'dup';
set local session_replication_role = origin;
-- the development task is done (the review path for tasks is its own, already-proven door; here its status is set as the table owner)
set local session_replication_role = replica;
update projects.tasks set status = 'done', completed_at = now() where project_id = :'P_id' and status <> 'cancelled';
set local session_replication_role = origin;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select outcome as o, array_to_string(missing, ' | ') as m from projects.complete_phase(:'P_id', 5) \gset CP_
select pg_temp.check(:'CP_o' = 'completed', 'with the DoD met, Phase 5 completes [' || :'CP_m' || ']');
select pg_temp.check((select outcome from projects.complete_phase(:'P_id', 5)) = 'already_completed', 'a duplicate Phase5Completed completes nothing twice');
select pg_temp.check((select count(*) from projects.phase_five_handoffs where project_id = :'P_id') = 1, 'exactly one Phase 6 intake exists');
select pg_temp.check((select payload->'build'->>'commit' from projects.phase_five_handoffs where project_id = :'P_id') = 'abc1234', 'the intake names the exact final commit');
select pg_temp.check((select independent_verification_required from projects.phase_five_handoffs where project_id = :'P_id'), 'Phase 6 is told to verify independently, not to trust Phase 5');
select pg_temp.check((select jsonb_array_length(payload->'knownLimitations') >= 1 from projects.phase_five_handoffs where project_id = :'P_id'), 'an unverified integration is a named known limitation');
select pg_temp.check((select payload->'defects'->>'unresolved' from projects.phase_five_handoffs where project_id = :'P_id') = '0', 'the intake records the defect history');
select pg_temp.check((select state from projects.phase_five where project_id = :'P_id') = 'completed', 'the Phase 5 workspace is completed');
reset role;
select pg_temp.check(pg_temp.refused(format('update projects.phase_five_handoffs set final_commit_ref = ''zzz'' where project_id = %L', :'P_id'), 'never edited'), 'the intake is frozen: it cannot be edited after the fact');
select pg_temp.check(exists (select 1 from core.outbox_events where type = 'project.phase_five_completed' and subject_id = :'P_id'), 'Phase5Completed was emitted (it triggers the M3 invoice)');

-- 20. the Phase 6 financial gate: M3 verified paid in full, nothing less
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(not projects.m3_verified_paid(:'P_id'), 'M3 is not verified paid');
select pg_temp.check(exists (select 1 from projects.phase_readiness(:'P_id', 6) r, unnest(r.missing) m where m = 'M3 not verified paid'), 'Phase 6 readiness names the missing M3 payment');
reset role;

-- 21. M3 (30%): issued, submitted, verified; only the fully verified payment satisfies the gate
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'P_id', 'M3', 3, 150000, 'INR') returning id \gset MS3_
select pg_temp.as_service();
set local role service_role;
select invoice_id as i from finance.create_milestone_invoice(:'ORG', :'A_id', :'P_id', :'MS3_id', 'ZP4-M3-1', 'INR', 150000, 0, 150000, '[{"position":0,"description":"M3 - 30%","quantity":1,"unit_price_minor":150000,"amount_minor":150000,"tax_rate_bp":0}]', now() + interval '7 days', null, null) \gset I3_
select pg_temp.check((select outcome from finance.create_milestone_invoice(:'ORG', :'A_id', :'P_id', :'MS3_id', 'ZP4-M3-2', 'INR', 150000, 0, 150000, '[{"position":0,"description":"M3 - 30%","quantity":1,"unit_price_minor":150000,"amount_minor":150000,"tax_rate_bp":0}]', now() + interval '7 days', null, null)) = 'already_invoiced', 'a duplicate M3 invoice event creates no second invoice');
select finance.issue_invoice(:'I3_i', now() + interval '7 days');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(not projects.m3_verified_paid(:'P_id'), 'M3 issued: the Phase 6 financial gate is closed');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_m3_verified(:'P_id')) = 'not_verified', 'NEGATIVE: an issued M3 emits no M3PaymentVerified');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select payment_id as pid from finance.record_manual_payment(:'I3_i', 'UTR-M3-1', 100000, now(), 'upi') \gset PY3a_
select finance.verify_payment(:'PY3a_pid', :'OWNER');
select pg_temp.check(not projects.m3_verified_paid(:'P_id'), 'M3 underpaid (100,000 of 150,000 verified): still closed');
select payment_id as pid from finance.record_manual_payment(:'I3_i', 'UTR-M3-2', 50000, now(), 'upi') \gset PY3b_
select finance.verify_payment(:'PY3b_pid', :'OWNER');
select pg_temp.check(projects.m3_verified_paid(:'P_id'), 'M3 verified paid in full: the Phase 6 financial gate opens');
do $$ begin
  begin perform projects.record_m3_verified((select id from projects.projects where project_code = 'ZP4-E2E'));
        raise exception 'FAILED: a signed-in person called the runner-only M3 door';
  exception when insufficient_privilege then raise notice 'ok  a person cannot emit M3PaymentVerified: the runner-only door refuses them'; end;
end $$;
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_m3_verified(:'P_id')) = 'recorded', 'M3PaymentVerified is recorded by the runner once the payment is verified in full');
select pg_temp.check((select outcome from projects.record_m3_verified(:'P_id')) = 'already_recorded', 'a replay emits nothing a second time');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.m3_payment_verified' and subject_id = :'P_id') = 1, 'exactly one M3PaymentVerified event exists');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(not exists (select 1 from projects.phase_readiness(:'P_id', 6) r, unnest(r.missing) m where m = 'M3 not verified paid'), 'and Phase 6 readiness no longer names M3');
reset role;

rollback;
\echo PHASE 4 E2E OK
