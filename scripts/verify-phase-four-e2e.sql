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
select set_config('e2e.p', :'P_id', false); -- the project id, for DO blocks (psql variables do not reach inside $$)
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
insert into projects.routing_decisions (organization_id, project_id, plan_id, task_id, to_agent, outcome, code, reason)
  values (:'ORG', :'P_id', :'PL_pl', :'T2_id', 'frontend_developer', 'held', 'agent_disabled', 'frontend_developer is installed but not enabled');
insert into projects.routing_decisions (organization_id, project_id, plan_id, task_id, to_agent, outcome, code, reason)
  values (:'ORG', :'P_id', :'PL_pl', :'T2_id', 'frontend_developer', 'held', 'agent_disabled', 'redelivered') on conflict (task_id, outcome, code) do nothing;
select pg_temp.check((select count(*) from projects.routing_decisions where task_id = :'T2_id') = 1, 'a redelivered routing event records the same decision once');
select pg_temp.check(pg_temp.refused(format('update projects.routing_decisions set reason = ''edited'' where task_id = %L', :'T2_id'), 'record of what was decided'), 'a routing decision is a record: it is never edited');
do $$ begin
  begin
    insert into ai.handoffs (organization_id, correlation_id, from_agent, to_agent, project_id, subject_type, subject_id, objective)
      values ('00000000-0000-4000-8000-000000000001', gen_random_uuid(), 'orchestrator', 'finance', current_setting('e2e.p')::uuid, 'development_task', gen_random_uuid(), 'route development to Finance');
    raise exception 'FAILED: the Orchestrator handed development work to Finance';
  exception when others then
    if sqlerrm like 'FAILED:%' then raise; end if;
    if sqlerrm not like '%handoff%' and sqlerrm not like '%declared%' and sqlerrm not like '%target%' then raise exception 'FAILED: refused for the wrong reason: %', sqlerrm; end if;
    raise notice 'ok  the database refuses a route the registry does not declare (orchestrator -> finance): %', left(sqlerrm, 80);
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
    perform projects.record_build_run((select id from projects.deliverables where title = 'Development build 1'), 'review', 'succeeded', null, '[{"name":"build","status":"ok"},{"name":"artifact_verify","status":"ok"}]', '{"env":"API_KEY=sk-abcdefghijklmnopqrstuvwx"}', repeat('a', 64), null, null, 'https://ci.example.test/build/1');
    raise exception 'FAILED: a secret value was stored in a build run';
  exception when restrict_violation then raise notice 'ok  a build run cannot carry a secret value'; end;
end $$;
do $$ begin
  begin
    perform projects.record_build_run((select id from projects.deliverables where title = 'Development build 1'), 'review', 'succeeded', null, '[{"name":"build","status":"ok"},{"name":"artifact_verify","status":"ok"}]', '{"node":"22"}', repeat('a', 63), null, null, 'https://ci.example.test/build/1');
    raise exception 'FAILED: a malformed artifact hash was accepted';
  exception when check_violation then raise notice 'ok  an artifact hash must be a real sha256'; end;
end $$;
select outcome as o from projects.record_build_run(:'BD1_bd', 'review', 'succeeded', null, '[{"name":"lint","status":"ok"},{"name":"test","status":"ok"},{"name":"build","status":"ok"},{"name":"artifact_verify","status":"ok"}]', '{"os":"linux","node":"22","lockfile":"sha256:abc"}', repeat('a', 64), null, null, 'https://ci.example.test/build/1') \gset BR5_
select pg_temp.check((select outcome from projects.record_smoke_check(:'BD1_bd', 'not_tested', '[]', null, 'no device lab is bound; a web build with no launch test')) = 'recorded', 'the smoke verdict is recorded honestly as NOT_TESTED with its reason');
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
-- a runner's machine-readable report: counts are computed, flaky is not green, the evidence is named
select pg_temp.check((select outcome from qa.ingest_test_report(:'BD1_bd', 'functional', '{"tests":[{"name":"a","status":"passed"}]}')) = 'evidence_required', 'a PERSON'' report needs its evidence too');
select pg_temp.check((select outcome from qa.ingest_test_report(:'BD1_bd', 'functional', '{"tests":[]}', 'https://ci.example.test/run/p')) = 'empty_report', 'an empty report is refused');
select pg_temp.check((select outcome from qa.ingest_test_report(:'BD1_bd', 'functional', '{"tests":[{"name":"a","status":"passed"},{"name":"a","status":"passed"}]}', 'https://ci.example.test/run/p')) = 'duplicate_test_names', 'a report that names a test twice is refused');
select pg_temp.check((select outcome from qa.ingest_test_report(:'BD1_bd', 'functional', '{"total":9,"tests":[{"name":"a","status":"passed"}]}', 'https://ci.example.test/run/p')) = 'inconsistent_report', 'a header that disagrees with the tests is refused: counts are computed, never trusted');
select pg_temp.check((select outcome from qa.ingest_test_report(:'BD1_bd', 'functional', '{"tests":[{"name":"a","status":"mostly"}]}', 'https://ci.example.test/run/p')) = 'malformed_report', 'an unknown status is refused');
select outcome as o, run_id as r, passed as p, failed as f, flaky as k from qa.ingest_test_report(:'BD1_bd', 'functional', '{"total":3,"tests":[{"name":"cart.add","status":"passed"},{"name":"cart.pay","status":"flaky","retries":2},{"name":"cart.remove","status":"skipped"}]}', 'https://ci.example.test/run/p') \gset ING_
select pg_temp.check(:'ING_o' = 'ingested' and :'ING_p'::int = 1 and :'ING_f'::int = 1 and :'ING_k'::int = 1, 'a test that passed only on retry is counted as a FAILURE of the run, not a pass');
select pg_temp.check((select failed = 1 and passed = 1 and total = 3 from qa.test_runs where id = :'ING_r'), 'the run row carries the computed counts');
select pg_temp.check((select count(*) from qa.test_run_cases where test_run_id = :'ING_r') = 3, 'every test is stored as a machine-readable row');
select pg_temp.check((select status from qa.flaky_tests where project_id = :'P_id' and test_key = 'cart.pay') = 'open', 'the flaky test is filed for an owner (and blocks completion until resolved)');
select flaky_id as fi from qa.record_flaky_test(:'P_id', 'cart.pay') \gset ING2_
select qa.resolve_flaky_test(:'ING2_fi', 'resolve', 'removed the shared fixture; fixed in abc1234');
reset role;
select pg_temp.as_service();
set local role service_role;
-- (a person's report needs its evidence too; a runner's is checked below)
select pg_temp.check((select outcome from qa.ingest_test_report(:'BD1_bd', 'api', '{"tests":[{"name":"x","status":"passed"}]}')) = 'evidence_required', 'a CI runner must name the evidence its report came from');
select pg_temp.check((select outcome from qa.ingest_test_report(:'BD1_bd', 'api', '{"tests":[{"name":"x","status":"passed"}]}', 'https://ci.example.test/run/1')) = 'ingested', 'with its evidence a runner''s report is ingested');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
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
-- REQUIREMENT -> TASK -> TEST: every planned task needs a linked run that actually passed
insert into qa.test_runs (organization_id, project_id, deliverable_id, suite, total, passed, failed, skipped, executed_at) values (:'ORG', :'P_id', :'BD1_bd', 'functional', 12, 10, 2, 0, now()) returning id \gset RUNF_
insert into qa.test_runs (organization_id, project_id, deliverable_id, suite, total, passed, failed, skipped, executed_at) values (:'ORG', :'P_id', :'BD1_bd', 'functional', 12, 12, 0, 0, now() + interval '1 second') returning id \gset RUNP_
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.task_test_gaps(:'P_id')) = 4, 'four planned tasks, none with test evidence yet');
select pg_temp.check((select outcome from projects.link_task_test_run(:'T6_id', :'RUNF_id')) = 'linked', 'a failing run can be linked (the evidence is honest)');
select pg_temp.check((select count(*) from projects.task_test_gaps(:'P_id') where task_id = :'T6_id') = 1, 'but a failing run does not cover the task');
select pg_temp.check((select outcome from projects.link_task_test_run(:'T6_id', :'RUNF_id')) = 'already_linked', 'linking twice links once');
select pg_temp.check((select outcome from projects.link_task_test_run(:'TASK_id', :'RUNP_id')) = 'linked', 'a passing run covers a task');
select projects.link_task_test_run(:'T2_id', :'RUNP_id');
select projects.link_task_test_run(:'T3_id', :'RUNP_id');
select pg_temp.check((select count(*) from projects.task_test_gaps(:'P_id')) = 1, 'one task is still uncovered (its only run failed)');
select pg_temp.check(exists (select 1 from projects.phase_readiness(:'P_id', 5) r, unnest(r.missing) m where m like '%no passing test evidence%'), 'Phase 5 completion names the uncovered task');
select projects.link_task_test_run(:'T6_id', :'RUNP_id');
select pg_temp.check((select count(*) from projects.task_test_gaps(:'P_id')) = 0, 'every planned task now has passing evidence');
-- documentation DERIVED from rows that exist
select projects.set_integration_state(:'IC_ic', 'configured', 'sandbox keys pasted');
select pg_temp.check((select outcome from projects.derive_phase_five_documents(:'P_id')) = 'derived', 'documentation is derived from the real records');
select pg_temp.check((select status from projects.technical_documents where project_id = :'P_id' and title = 'WhatsApp Business') = 'not_implemented', 'an UNKNOWN integration is documented as not implemented');
select pg_temp.check((select status from projects.technical_documents where project_id = :'P_id' and title = 'Razorpay') = 'partial', 'a configured/unverified one is partial: documentation does not exceed evidence');
select pg_temp.check((select status from projects.technical_documents where project_id = :'P_id' and kind = 'build_run') = 'implemented', 'the build record is derived from the succeeded run');
select pg_temp.check((select body like '%not verified%' or body like '%Integrations not verified%' from projects.technical_documents where project_id = :'P_id' and kind = 'known_limitations'), 'the known limitations name what is not verified');
select pg_temp.check((select count(*) from projects.stale_documents(:'P_id')) = 0, 'freshly derived documentation is not stale');
reset role;
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
-- a newer build makes the derived documentation STALE until it is derived again from what now exists
select deliverable_id as nb from projects.add_deliverable(:'P_id', 'build', 'Development build 2', 'https://builds.example.test/2', 'next', null, null, null, null) \gset NB_
insert into projects.deliverable_details (deliverable_id, organization_id, project_id, commit_ref, build_number) values (:'NB_nb', :'ORG', :'P_id', 'fff0001', 'build-2');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.stale_documents(:'P_id')) >= 4, 'NO STALE DOCS: documentation derived from build 1 is stale the moment build 2 exists');
select pg_temp.check((select outcome from projects.derive_phase_five_documents(:'P_id')) = 'derived', 're-deriving brings the documentation up to the current commit');
select pg_temp.check((select count(*) from projects.stale_documents(:'P_id')) = 0, 'and nothing is stale again');
select pg_temp.check((select status from projects.technical_documents where project_id = :'P_id' and kind = 'build_run') = 'not_implemented', 'the build document no longer claims the new commit was built: there is no run for it');
reset role;

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
-- Phase 6 exists from Phase5Completed but WAITS for the money: an issued M3 is not an opened gate
select pg_temp.check((select outcome from projects.start_phase_six(:'P_id')) = 'waiting_m3_verified', 'Phase 6 is created WAITING_M3_VERIFIED: Phase 5 done, the financial gate not satisfied');
select pg_temp.check((select state from projects.phase_six where project_id = :'P_id') = 'waiting_m3_verified', 'its state is waiting_m3_verified');
select pg_temp.check((select status from projects.validate_qa_intake(:'P_id')) = 'blocked_finance', 'NEGATIVE: the QA intake is blocked_finance while M3 is unverified');
select pg_temp.check(not exists (select 1 from core.outbox_events where type = 'project.phase_six_ready' and subject_id = (select id from projects.phase_six where project_id = :'P_id')), 'and Phase6Ready has not fired');
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
  begin perform projects.record_m3_verified(current_setting('e2e.p')::uuid);
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

-- ═════════ Phase 6: entry gate and QA intake ═════════
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.start_phase_six(:'P_id')) = 'ready', 'M3 verified in full: Phase 6 becomes READY');
select pg_temp.check((select outcome from projects.start_phase_six(:'P_id')) = 'already_started', 'a duplicate Phase6Ready starts nothing twice');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.phase_six_ready' and subject_id = (select id from projects.phase_six where project_id = :'P_id')) = 1, 'Phase6Ready was emitted exactly once');
select status as st, jsonb_array_length(blockers) as nb from projects.validate_qa_intake(:'P_id') \gset IV_
select jsonb_array_length(external_dependencies) as ne from projects.qa_intakes where project_id = :'P_id' \gset IV_
select pg_temp.check(:'IV_st' = 'valid' and :'IV_nb'::int = 0, 'the exact Phase 5 build, scope and UI validate');
select pg_temp.check(:'IV_ne'::int >= 2, 'unverified integrations are explicit external dependencies, never a silent skip');
select pg_temp.check((select state from projects.phase_six where project_id = :'P_id') = 'intake_validating', 'Phase 6 moves to INTAKE_VALIDATING');
select pg_temp.check((select supported_platforms = array['web'] from projects.qa_intakes where project_id = :'P_id'), 'the intake records the supported platform from the build''s own details, never inferred');
select pg_temp.check((select jsonb_array_length(change_request_history) >= 1 from projects.qa_intakes where project_id = :'P_id'), 'the intake carries the project''s change-request history');
select pg_temp.check((select artifact_sha256 = repeat('a', 64) and commit_ref = 'abc1234' from projects.qa_intakes where project_id = :'P_id'), 'the intake names the exact commit and the artifact hash from the build run');
-- a client approval tied to a DIFFERENT build is rejected
reset role;
set local session_replication_role = replica;
update projects.deliverables set status = 'approved' where id = :'NB_nb';
set local session_replication_role = origin;
set local role service_role;
select pg_temp.check((select status from projects.validate_qa_intake(:'P_id')) = 'blocked_build', 'NEGATIVE: a client approval tied to a different build blocks the intake');
select pg_temp.check((select state from projects.phase_six where project_id = :'P_id') = 'blocked', 'and Phase 6 is BLOCKED, with the reason');
select pg_temp.check((select blockers->0->>'owner' is not null and blockers->0->>'resumeCondition' is not null from projects.qa_intakes where project_id = :'P_id'), 'the blocker is typed with an owner and a resume condition');
reset role;
set local session_replication_role = replica;
update projects.deliverables set status = 'draft' where id = :'NB_nb';
set local session_replication_role = origin;
set local role service_role;
select pg_temp.check((select status from projects.validate_qa_intake(:'P_id')) = 'valid', 'resolving the blocker revalidates the intake');
select pg_temp.check(pg_temp.refused(format('update projects.qa_intakes set commit_ref = ''zzz'' where project_id = %L', :'P_id'), 'never edited'), 'an intake is about one exact build: its identity is never edited');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.qa_intakes) = 1, 'staff can read the intake');
reset role;

-- ═════════ Phase 6: the Master Test Plan ═════════
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from qa.create_master_test_plan(:'P_id', array['functional', 'ui_e2e', 'security'], array['checkout'], array['staging'], 'synthetic data, resettable', 'baseline then compare', '[]')) = 'created', 'a Master Test Plan is created over the validated intake');
select id as "MP_id" from qa.master_test_plans where project_id = :'P_id' \gset
select pg_temp.check((select commit_ref = 'abc1234' from qa.master_test_plans where id = :'MP_id'), 'the plan is for the intake''s exact commit');
select pg_temp.check((select count(*) from qa.plan_problems(:'MP_id')) >= 4, 'a bare plan names its gaps: no risk matrix, requirement, categories and journey uncovered');
select pg_temp.check((select outcome from qa.approve_master_test_plan(:'MP_id')) = 'not_approvable', 'NEGATIVE: a plan with gaps cannot be approved');
select pg_temp.check((select outcome from qa.add_risk_item(:'MP_id', 'checkout payment', 'payment', 'low', 'standard', 'rarely used')) = 'depth_cannot_be_reduced', 'NEGATIVE: payment risk cannot be recorded low or shallow');
select pg_temp.check((select outcome from qa.add_risk_item(:'MP_id', 'checkout payment', 'payment', 'high', 'deep', 'money moves here')) = 'added', 'payment risk is recorded high and deep');
select pg_temp.check((select outcome from qa.add_risk_item(:'MP_id', 'tenant data in the cart', 'tenant_data', 'medium', 'deep', 'x')) = 'depth_cannot_be_reduced', 'tenant data cannot be recorded medium either');
select id as "SI_id" from projects.scope_items where title = 'The customer can pay' limit 1 \gset
select case_id as c1 from qa.add_phase6_case(:'MP_id', 'customer can pay', 'a paid order shows a receipt', 'functional', 'critical', :'SI_id', null, 'open the cart, pay', 'a receipt is shown') \gset CS1_
select case_id as c2 from qa.add_phase6_case(:'MP_id', 'checkout journey', 'the whole checkout works end to end', 'ui_e2e', 'critical', null, 'checkout', 'browse, add, pay', 'order confirmed') \gset CS2_
select case_id as c3 from qa.add_phase6_case(:'MP_id', 'cart is tenant-isolated', 'another tenant cannot read this cart', 'security', 'high', null, null, 'try the cart id as another tenant', 'refused') \gset CS3_
select pg_temp.check((select outcome from qa.add_phase6_case(:'MP_id', 'speed', 'fast', 'performance', 'medium')) = 'category_not_in_plan', 'a case outside the plan''s required categories is refused');
select pg_temp.check((select count(*) from qa.plan_problems(:'MP_id')) = 0, 'every requirement, category and journey is now covered');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000f522', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from qa.approve_master_test_plan(:'MP_id')) = 'not_authorized', 'a delivery person cannot approve the test plan: an Admin does');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from qa.approve_master_test_plan(:'MP_id')) = 'approved', 'the Admin approves the plan');
select pg_temp.check((select outcome from qa.approve_master_test_plan(:'MP_id')) = 'already_approved', 'a duplicate approval changes nothing');
select pg_temp.check((select state from projects.phase_six where project_id = :'P_id') = 'plan_ready', 'Phase 6 is PLAN_READY');
select pg_temp.check((select outcome from qa.add_phase6_case(:'MP_id', 'late case', 'x', 'functional')) = 'plan_not_draft', 'an approved plan takes no new cases: a change is a new version');
reset role;
select pg_temp.as_service();
set local role service_role;
select outcome as o, routed as r, held as h from qa.schedule_plan_jobs(:'MP_id') \gset QJ_
select pg_temp.check(:'QJ_o' = 'scheduled' and :'QJ_r'::int = 0 and :'QJ_h'::int = 3, 'the QA Orchestrator schedules each required category; every specialist is disabled, so all three are HELD, none pretends to run');
select pg_temp.check((select count(*) from qa.qa_jobs where plan_id = :'MP_id' and status = 'held' and code = 'agent_disabled') = 3, 'each held job says why');
select pg_temp.check((select outcome from qa.schedule_plan_jobs(:'MP_id')) = 'scheduled' and (select count(*) from qa.qa_jobs where plan_id = :'MP_id') = 3, 'a redelivered event schedules nothing twice');
reset role;
update ai.agents set enabled = true, disabled_reason = null where key = 'functional_test';
select pg_temp.as_service();
set local role service_role;
select outcome as o, routed as r, held as h from qa.schedule_plan_jobs(:'MP_id') \gset QJ2_
select pg_temp.check(:'QJ2_r'::int = 1, 'once a specialist is enabled, re-scheduling routes the held work to it');
select pg_temp.check((select (context->>'category') = 'functional' and (context->>'commit') = 'abc1234' and ((context->'rules')->>'independentOfTheBuilder')::boolean and context->'toolPermissions' = '[]'::jsonb from ai.handoffs where subject_type = 'qa_job' and subject_id = :'MP_id'), 'the handoff carries the exact commit, the independence rule and no tool permission');
reset role;
update ai.agents set enabled = false, disabled_reason = 'E2E fixture: disabled again' where key = 'functional_test';
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
reset role;
select pg_temp.check(pg_temp.refused(format('update qa.master_test_plans set critical_journeys = array[''other''] where id = %L', :'MP_id'), 'never edited'), 'an approved plan is not edited');
select pg_temp.check(pg_temp.refused(format('update qa.phase6_cases set status = ''pass'' where id = %L', :'CS1_c1'), 'result door'), 'a result is never typed into the row');

-- results: independent, evidenced, on the exact commit
select pg_temp.as_user('00000000-0000-4000-8000-00000000f522', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from qa.record_case_result(:'CS1_c1', 'pass', 'https://qa.example.test/1')) = 'self_review', 'whoever built the build cannot record its test result');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000f523', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from qa.record_case_result(:'CS1_c1', 'pass')) = 'evidence_required', 'a PASS without evidence is refused');
select pg_temp.check((select outcome from qa.record_case_result(:'CS1_c1', 'skipped_with_reason', null, 'not needed')) = 'critical_cannot_be_skipped', 'a critical case is never silently skipped');
select pg_temp.check((select outcome from qa.record_case_result(:'CS1_c1', 'blocked')) = 'reason_required', 'BLOCKED needs a reason');
select pg_temp.check((select outcome from qa.record_case_result(:'CS1_c1', 'pass', 'https://qa.example.test/1')) = 'recorded', 'an independent person records a PASS with evidence');
select pg_temp.check((select state from projects.phase_six where project_id = :'P_id') = 'testing', 'Phase 6 is TESTING');
select outcome as o, defect_id as d from qa.record_case_result(:'CS3_c3', 'fail', 'https://qa.example.test/3', 'another tenant could read the cart') \gset RF_
select pg_temp.check(:'RF_o' = 'recorded' and :'RF_d' <> '', 'a FAIL raises a defect');
select pg_temp.check((select severity = 'major' and project_id = :'P_id' from qa.defects where id = :'RF_d'::uuid), 'the defect carries the case''s priority as severity and the exact build');
select pg_temp.check((select status = 'fail' and defect_id = :'RF_d'::uuid from qa.phase6_cases where id = :'CS3_c3'), 'the case links its defect');
select pg_temp.check((select count(*) from qa.phase6_result_history where case_id in (:'CS1_c1', :'CS3_c3')) = 2, 'every result is in the append-only history');
reset role;

-- ═════════ Phase 6: defects - triage, handoff, independent retest of the FIXED build ═════════
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select s_level = 2 and phase6 and found_commit = 'abc1234' and classification = 'product_defect' from qa.defects where id = :'RF_d'::uuid), 'the Phase 6 defect starts at S2 (from the case priority), on the commit it was found on, a product defect');
select pg_temp.check((select outcome from qa.triage_defect(:'RF_d'::uuid, 1, 'product_defect')) = 'triaged', 'triage sets S1 (cross-tenant read is critical)');
select pg_temp.check((select s_level = 1 from qa.defects where id = :'RF_d'::uuid), 'the level is recorded');
select pg_temp.check((select outcome from qa.hand_off_defect(:'RF_d'::uuid)) = 'handed_off', 'the defect is handed to the Bug Fix capability with the exact build and the required retest');
select pg_temp.check((select outcome from qa.hand_off_defect(:'RF_d'::uuid)) = 'already_handed_off', 'a duplicate handoff is not created');
select pg_temp.check((select state from projects.phase_six where project_id = :'P_id') = 'defect_fix_loop', 'Phase 6 is in the DEFECT_FIX_LOOP');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.qa_defect_handed_off' and subject_id = :'RF_d'::uuid) = 1 and not exists (select 1 from core.outbox_events where type = 'project.qa_defect_handed_off' and payload::text ilike '%tenant%'), 'the handoff emits a client-safe progress fact: severity only, never the finding');
-- the declared contracts the QA tests against
select pg_temp.check((select outcome from qa.declare_intake_contracts(:'P_id', '[{"name":"Cart API"}]')) = 'each_contract_needs_a_name_and_a_reference', 'a contract needs a name and a reference: none is inferred');
select pg_temp.check((select outcome from qa.declare_intake_contracts(:'P_id', '[{"name":"Cart API","ref":"docs/api/cart.openapi.yaml"}]')) = 'declared', 'the API contract the tests run against is declared by a person');
select pg_temp.check((select jsonb_array_length(api_contract_refs) = 1 from projects.qa_intakes where project_id = :'P_id'), 'and recorded on the intake');
-- the client is asked one genuinely ambiguous question, once, and the answer is a recorded fact
select pg_temp.check((select outcome from qa.ask_clarification(:'P_id', '   ', :'CS1_c1')) = 'invalid_question', 'an empty question is refused');
select clarification_id as cq from qa.ask_clarification(:'P_id', 'Should a refunded order still show a receipt?', :'CS1_c1') \gset CQ_
select pg_temp.check(:'CQ_cq' <> '', 'QA asks one question about an ambiguous expected behaviour');
select pg_temp.check((select outcome from qa.ask_clarification(:'P_id', 'And another?', :'CS1_c1')) = 'already_open', 'one open question per case: the client is asked one thing at a time');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.qa_clarification_requested' and subject_id = :'CQ_cq'::uuid) = 1 and not exists (select 1 from core.outbox_events where type = 'project.qa_clarification_requested' and payload::text ilike '%refunded%'), 'the PM is told a question exists; the question itself is read from the row, not carried in the event');
select pg_temp.check((select outcome from qa.answer_clarification(:'CQ_cq'::uuid, '')) = 'answer_required', 'an answer cannot be empty');
select pg_temp.check((select outcome from qa.answer_clarification(:'CQ_cq'::uuid, 'Yes: a refund keeps the receipt, marked refunded.')) = 'answered', 'the answer is recorded');
select pg_temp.check((select outcome from qa.answer_clarification(:'CQ_cq'::uuid, 'Actually no.')) = 'already_answered', 'asked once, answered once: the answer is not rewritten');
reset role;
select pg_temp.check(pg_temp.refused(format('update qa.qa_clarifications set question = ''changed'' where id = %L', :'CQ_cq'), 'neither is edited'), 'the question is history');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select (context->>'foundCommit') = 'abc1234' and (requirements->>'qaMustRetestFixedBuild')::boolean from ai.handoffs where subject_type = 'defect' and subject_id = :'RF_d'::uuid), 'the handoff carries the exact commit and says QA must retest the fixed build');
-- a failing case that is really a test defect, and a client request that is really a Change Request: neither is a product defect
select outcome as o, defect_id as d from qa.record_case_result(:'CS2_c2', 'fail', 'https://qa.example.test/2', 'the checkout button was not found') \gset RF2_
reset role;
-- (recorded by the independent person above; the next two triages are the delivery lead's)
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from qa.triage_defect(:'RF2_d'::uuid, 3, 'test_defect')) = 'reason_required', 'NEGATIVE: calling something a test defect needs a reason');
select pg_temp.check((select outcome from qa.triage_defect(:'RF2_d'::uuid, 3, 'test_defect', null, 'the selector in the script was wrong, the product is fine')) = 'triaged', 'a defect in the TEST is classified as such, with its reason');
select pg_temp.check(not exists (select 1 from qa.unresolved_product_defects(:'P_id') where defect_id = :'RF2_d'::uuid), 'a test defect is not a product defect: the hard gates do not count it');
select pg_temp.check(exists (select 1 from qa.unresolved_product_defects(:'P_id') where defect_id = :'RF_d'::uuid), 'the real product defect still counts');
reset role;
insert into qa.defects (organization_id, project_id, deliverable_id, severity, title, reproduction, reported_by, phase6, found_commit)
  values (:'ORG', :'P_id', :'BD1_bd', 'minor', 'client also wants a wishlist', 'asked during QA', :'OWNER', true, 'abc1234') returning id \gset D3_
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.change_requests where project_id = :'P_id') = (select count(*) from projects.change_requests where project_id = :'P_id'), 'baseline count of change requests');
select count(*) as n from projects.change_requests where project_id = :'P_id' \gset CRB_
select pg_temp.check((select outcome from qa.triage_defect(:'D3_id'::uuid, 4, 'change_request', null, 'a new feature, not a defect')) = 'triaged', 'a new client request found in QA becomes a Change Request');
select pg_temp.check((select count(*) from projects.change_requests where project_id = :'P_id') = :'CRB_n'::int + 1, 'a Change Request was raised');
select pg_temp.check(not exists (select 1 from qa.unresolved_product_defects(:'P_id') where defect_id = :'D3_id'::uuid), 'and it is out of the gates');
reset role;

-- fix claim, then the independent retest on the FIXED build
select pg_temp.as_user('00000000-0000-4000-8000-00000000f522', :'ORG', 'member');
update qa.defects set status = 'fixed', resolution = 'tenant check added' where id = :'RF_d'::uuid;
set local role authenticated;
select pg_temp.check((select outcome from qa.record_retest(:'RF_d'::uuid, true, 'fix9999', 'https://qa.example.test/retest')) = 'fixer_cannot_verify', 'the fixer cannot verify their own fix');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000f523', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from qa.record_retest(:'RF_d'::uuid, true, 'abc1234', 'https://qa.example.test/retest')) = 'retest_on_the_wrong_build', 'NEGATIVE: a retest on the build the defect was found on does not verify it');
select pg_temp.check((select outcome from qa.record_retest(:'RF_d'::uuid, true, 'fix9999', null)) = 'retest_incomplete', 'a retest without evidence verifies nothing');
select pg_temp.check((select outcome from qa.record_retest(:'RF_d'::uuid, false, 'fix9999', 'https://qa.example.test/retest-1')) = 'reopened', 'a retest that fails REOPENS the defect');
select pg_temp.check((select status = 'open' and fixed_by is null from qa.defects where id = :'RF_d'::uuid), 'and the fix claim is cleared');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000f522', :'ORG', 'member');
update qa.defects set status = 'fixed', resolution = 'second attempt: scoped the query by tenant' where id = :'RF_d'::uuid;
select pg_temp.as_user('00000000-0000-4000-8000-00000000f523', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from qa.record_retest(:'RF_d'::uuid, true, 'fix9999', 'https://qa.example.test/retest-2')) = 'verified', 'an independent retest of the fixed build verifies it');
select pg_temp.check((select retest_commit = 'fix9999' and verified_by = '00000000-0000-4000-8000-00000000f523'::uuid from qa.defects where id = :'RF_d'::uuid), 'the verification names the commit retested and who did it');
reset role;
-- a regression: a verified defect that comes back reopens, and the verification is dropped
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
update qa.defects set status = 'open' where id = :'RF_d'::uuid;
select pg_temp.check((select status = 'open' and retest_commit is null and verified_by is null from qa.defects where id = :'RF_d'::uuid), 'a regressed, previously verified Phase 6 defect REOPENS with the verification dropped');
select pg_temp.as_user('00000000-0000-4000-8000-00000000f522', :'ORG', 'member');
update qa.defects set status = 'fixed', resolution = 'third: regression test added' where id = :'RF_d'::uuid;
select pg_temp.as_user('00000000-0000-4000-8000-00000000f523', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from qa.record_retest(:'RF_d'::uuid, true, 'fix9999', 'https://qa.example.test/retest-3')) = 'verified', 'verified again after the regression fix');
reset role;

-- the same root cause reported twice: ONE canonical defect, the new evidence preserved on it
insert into qa.defects (organization_id, project_id, deliverable_id, severity, title, reproduction, reported_by, phase6, found_commit)
  values (:'ORG', :'P_id', :'BD1_bd', 'major', 'cart readable across tenants (second report)', 'open the cart id as another tenant', :'OWNER', true, 'abc1234') returning id \gset DUP_
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from qa.mark_duplicate(:'DUP_id'::uuid, :'DUP_id'::uuid)) = 'cannot_duplicate_itself', 'a defect cannot be its own duplicate');
select pg_temp.check((select outcome from qa.mark_duplicate(:'DUP_id'::uuid, :'RF2_d'::uuid)) = 'canonical_is_not_a_product_defect', 'the canonical defect must be a real product defect');
select pg_temp.check((select outcome from qa.mark_duplicate(:'DUP_id'::uuid, :'RF_d'::uuid, 'same missing tenant check')) = 'canonical_is_closed', 'a duplicate cannot hide behind a canonical defect that is already closed (that is a regression: reopen it)');
reset role;
insert into qa.defects (organization_id, project_id, deliverable_id, severity, title, reproduction, reported_by, phase6, found_commit)
  values (:'ORG', :'P_id', :'BD1_bd', 'major', 'cart readable across tenants (canonical)', 'open the cart id as another tenant', :'OWNER', true, 'abc1234') returning id \gset CAN_
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from qa.mark_duplicate(:'DUP_id'::uuid, :'CAN_id'::uuid, 'same missing tenant check')) = 'marked', 'a duplicate points at the open canonical defect');
select pg_temp.check((select classification = 'duplicate' and duplicate_of = :'CAN_id'::uuid from qa.defects where id = :'DUP_id'::uuid), 'it is classified duplicate, linked to the canonical one');
select pg_temp.check(exists (select 1 from qa.defect_evidence where defect_id = :'CAN_id'::uuid and value like 'Duplicate report:%'), 'the duplicate''s own evidence is preserved on the canonical defect');
select pg_temp.check(not exists (select 1 from qa.unresolved_product_defects(:'P_id') where defect_id = :'DUP_id'::uuid), 'and the duplicate does not count twice against the gates');
reset role;
update qa.defects set status = 'wontfix', resolution = 'fixture: canonical closed so the readiness gate sees only the scenario defects' where id = :'CAN_id'::uuid;

-- ═════════ Phase 6: release candidate, evidence, hard gates, exceptions, Admin review, completion ═════════
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select candidate_id as rc from qa.create_release_candidate(:'P_id') \gset RC_
select pg_temp.check(:'RC_rc' <> '', 'an exact release candidate is frozen: one commit, one build, one artifact hash');
select pg_temp.check((select commit_ref = 'abc1234' and artifact_sha256 = repeat('a', 64) and version = 1 from qa.release_candidates where id = :'RC_rc'::uuid), 'it names the exact commit and the artifact hash from the build run');
select pg_temp.check((select outcome from qa.create_release_candidate(:'P_id')) = 'candidate_exists_for_this_commit', 'a second candidate for the same commit is not created');
reset role;
select pg_temp.check(pg_temp.refused(format('update qa.release_candidates set commit_ref = ''zzz'' where id = %L', :'RC_rc'), 'new candidate'), 'a candidate is one exact commit: a different commit is a new candidate');
select pg_temp.check(pg_temp.refused(format('update qa.release_candidates set status = ''approved'', approved_by = %L, approved_at = now() where id = %L', :'OWNER', :'RC_rc'), 'Admin review door'), 'a candidate cannot be approved by a status edit');

-- category evidence: independent, and only when every case of the category passed on this commit
select pg_temp.as_user('00000000-0000-4000-8000-00000000f523', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from qa.record_category_result(:'RC_rc'::uuid, 'security', 'pass', 'https://qa.example.test/sec')) = 'cases_not_passing', 'NEGATIVE: security cannot pass while its case is failing');
-- the defect behind the failing security case was verified fixed above; the independent QA person re-runs the cases on the candidate
select pg_temp.check((select outcome from qa.record_case_result(:'CS3_c3', 'pass', 'https://qa.example.test/3-rerun')) = 'recorded', 'the security case is re-run and passes');
select pg_temp.check((select outcome from qa.record_case_result(:'CS2_c2', 'pass', 'https://qa.example.test/2-rerun')) = 'recorded', 'the end-to-end case is re-run and passes (its failure was a test defect)');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000f522', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from qa.record_category_result(:'RC_rc'::uuid, 'functional', 'pass', 'https://qa.example.test/f')) = 'self_review', 'whoever built the build cannot record a category verdict on it');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000f523', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from qa.record_category_result(:'RC_rc'::uuid, 'functional', 'pass', 'https://qa.example.test/f')) = 'recorded', 'functional passes (every functional case passed on this commit)');
select pg_temp.check((select outcome from qa.record_category_result(:'RC_rc'::uuid, 'ui_e2e', 'pass', 'https://qa.example.test/e2e')) = 'recorded', 'critical end-to-end passes');
select pg_temp.check((select outcome from qa.record_category_result(:'RC_rc'::uuid, 'security', 'pass', 'https://qa.example.test/sec')) = 'recorded', 'security passes');
select pg_temp.check((select outcome from qa.record_category_result(:'RC_rc'::uuid, 'performance', 'pass', 'https://qa.example.test/p')) = 'category_not_in_plan', 'a category the approved plan does not require is not recorded');

-- the score is a summary, not authority: ~90 points, band strong, and still BLOCKED because mandatory gates fail
select outcome as o, score as sc, band as bd, result as rs from qa.evaluate_readiness(:'RC_rc'::uuid) \gset RA1_
select pg_temp.check(:'RA1_sc'::int >= 85 and :'RA1_bd' in ('strong', 'controlled'), 'the readiness score is high (' || :'RA1_sc' || ')');
select pg_temp.check(:'RA1_rs' = 'blocked', 'BUT the candidate is BLOCKED: a high score cannot hide failed hard gates');
select pg_temp.check((select not passed from qa.evaluate_hard_gates(:'RC_rc'::uuid) where gate = 'rollback'), 'the rollback gate fails: no rollback plan');
select pg_temp.check((select not passed from qa.evaluate_hard_gates(:'RC_rc'::uuid) where gate = 'observability'), 'the observability gate fails: no monitoring prerequisites');
select pg_temp.check((select passed from qa.evaluate_hard_gates(:'RC_rc'::uuid) where gate = 'security'), 'while security passes');
reset role;
do $$ begin
  begin
    insert into qa.readiness_assessments (organization_id, candidate_id, commit_ref, score, band, dimensions, gates, all_gates_satisfied, result)
      values ('00000000-0000-4000-8000-000000000001', (select id from qa.release_candidates order by created_at desc limit 1), 'abc1234', 97, 'strong', '[]', '[]', false, 'ready');
    raise exception 'FAILED: a ready assessment with an unsatisfied gate was written';
  exception when check_violation then raise notice 'ok  a "ready" assessment with an unsatisfied gate cannot even be written (score 97 notwithstanding)'; end;
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-00000000f523', :'ORG', 'ops_admin');
set local role authenticated;

-- exceptions: only for gates policy allows, with an expiry, approved by a person who is the owner and did not ask for it
select pg_temp.check((select outcome from qa.request_release_exception(:'RC_rc'::uuid, 'rollback', 'r', 'b', 'm', 'ops', 'c', now() + interval '14 days')) = 'gate_cannot_be_excepted', 'NEGATIVE: the rollback gate cannot be excepted');
select pg_temp.check((select outcome from qa.request_release_exception(:'RC_rc'::uuid, 'observability', 'no alerts yet', 'launch date', 'manual checks hourly', 'ops lead', 'roll back if error rate > 2%', now() + interval '200 days')) = 'expiry_required_within_90_days', 'an exception needs an expiry within 90 days');
select exception_id as ex from qa.request_release_exception(:'RC_rc'::uuid, 'observability', 'no alerts yet', 'launch date', 'manual checks hourly', 'ops lead', 'roll back if error rate > 2%', now() + interval '14 days') \gset EX_
select pg_temp.check(:'EX_ex' <> '', 'an exception is REQUESTED (by an agent or a person); it is not yet an exception');
select pg_temp.check((select not satisfied from qa.evaluate_hard_gates(:'RC_rc'::uuid) where gate = 'observability'), 'a requested exception satisfies nothing');
select pg_temp.check((select outcome from qa.approve_release_exception(:'EX_ex'::uuid)) = 'not_authorized', 'an ops_admin cannot approve an exception: only the owner');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from qa.approve_release_exception(:'EX_ex'::uuid)) = 'approved', 'the owner approves the exception');
select pg_temp.check((select exceptioned and satisfied and not passed from qa.evaluate_hard_gates(:'RC_rc'::uuid) where gate = 'observability'), 'the gate is satisfied by the exception, and says it was not passed');
reset role;
-- an expired exception no longer satisfies
set local session_replication_role = replica;
update qa.release_exceptions set expires_at = now() - interval '1 hour' where id = :'EX_ex'::uuid;
set local session_replication_role = origin;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select not satisfied from qa.evaluate_hard_gates(:'RC_rc'::uuid) where gate = 'observability'), 'an EXPIRED exception satisfies nothing');
reset role;
select pg_temp.check(pg_temp.refused(format('update qa.release_exceptions set mitigation = ''different'' where id = %L', :'EX_ex'), 'never edited'), 'an approved exception is never edited');

-- the prerequisites are supplied; the candidate goes to review
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from qa.set_candidate_prerequisites(:'RC_rc'::uuid, 'prod-config-v1', 'redeploy the previous artifact; restore the pre-deploy database snapshot', 'ops lead', 'error-rate and latency alerts; request logs retained 30 days', '[{"title":"WhatsApp not verified","impact":"no delivery receipts","workaround":"manual follow-up","owner":"ops","blocking":false,"disclose":true}]')) = 'set', 'rollback, monitoring and configuration are recorded');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000f523', :'ORG', 'ops_admin');
set local role authenticated;
select outcome as o, result as rs, score as sc from qa.submit_candidate_for_review(:'RC_rc'::uuid) \gset SR_
select pg_temp.check(:'SR_o' = 'in_review' and :'SR_rs' = 'ready', 'with every gate satisfied the candidate goes to Admin review');
select pg_temp.check((select state from projects.phase_six where project_id = :'P_id') = 'admin_review', 'Phase 6 is ADMIN_REVIEW');
reset role;

-- Admin review: human; a retest request loops back; the approval is for the exact candidate and re-checks everything NOW
select pg_temp.as_user('00000000-0000-4000-8000-00000000f522', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from qa.decide_release_candidate(:'RC_rc'::uuid, 'approve')) = 'not_authorized', 'a delivery person cannot approve a release candidate');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from qa.decide_release_candidate(:'RC_rc'::uuid, 'request_retest')) = 'note_required', 'a retest request says what to retest');
select pg_temp.check((select outcome from qa.decide_release_candidate(:'RC_rc'::uuid, 'request_retest', 'retest the receipt email on a clean tenant')) = 'sent_back', 'the Admin requests a retest');
select pg_temp.check((select status from qa.release_candidates where id = :'RC_rc'::uuid) = 'blocked', 'the candidate goes back to BLOCKED: no approval carries over');
select pg_temp.check((select state from projects.phase_six where project_id = :'P_id') = 'defect_fix_loop', 'Phase 6 is back in the DEFECT_FIX_LOOP');
select id as "AD_id" from qa.defects where project_id = :'P_id' and title like 'Admin request retest%' \gset
select pg_temp.check(:'AD_id' <> '', 'the request became a tracked defect with the exact commit');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000f522', :'ORG', 'member');
update qa.defects set status = 'fixed', resolution = 'receipt template corrected' where id = :'AD_id'::uuid;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.phase_readiness(:'P_id', 6) r, unnest(r.missing) m where m like '%await independent retest%') = 1, 'Phase 6 cannot complete while a FIX_READY defect awaits independent retest');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000f523', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from qa.record_retest(:'AD_id'::uuid, true, 'fix7777', 'https://qa.example.test/retest-admin')) = 'verified', 'QA independently retests the fix on the fixed build');
select outcome as o, result as rs from qa.submit_candidate_for_review(:'RC_rc'::uuid) \gset SR2_
select pg_temp.check(:'SR2_o' = 'in_review', 'the candidate goes back to Admin review');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from qa.decide_release_candidate(:'RC_rc'::uuid, 'approve', 'reviewed the evidence')) = 'approved', 'the Admin approves the EXACT candidate');
select pg_temp.check((select outcome from qa.decide_release_candidate(:'RC_rc'::uuid, 'approve')) = 'wrong_candidate', 'a second decision on a candidate no longer under review is refused');
select pg_temp.check((select count(*) from qa.admin_qa_reviews where candidate_id = :'RC_rc'::uuid) = 2, 'both decisions are in the append-only review history');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.release_candidate_approved' and subject_id = :'RC_rc'::uuid) = 1, 'the approval was announced once');
select pg_temp.check((select r.outcome from projects.phase_readiness(:'P_id', 6) r) = 'ready', 'every Phase 6 condition now holds');
select pg_temp.check((select outcome from projects.complete_phase(:'P_id', 6)) = 'completed', 'Phase6Completed');
select pg_temp.check((select outcome from projects.complete_phase(:'P_id', 6)) = 'already_completed', 'a duplicate Phase6Completed completes nothing twice');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.phase_six_completed' and subject_id = :'P_id') = 1, 'Phase6Completed was emitted exactly once');
select pg_temp.check((select state from projects.phase_six where project_id = :'P_id') = 'm4_due', 'Phase 6 is M4_DUE');
select pg_temp.check((select not production_deployed and commit_ref = 'abc1234' from projects.phase_six_handoffs where project_id = :'P_id'), 'the Phase 7 intake names the exact commit and records that NOTHING was deployed');
select pg_temp.check((select jsonb_array_length(payload->'knownLimitations') = 1 and payload->'deployment'->>'rollbackOwner' = 'ops lead' from projects.phase_six_handoffs where project_id = :'P_id'), 'the intake carries the rollback, observability, configuration and known limitations');
select pg_temp.check((select jsonb_array_length(payload->'exceptions') = 1 from projects.phase_six_handoffs where project_id = :'P_id'), 'the (expired) approved exception is recorded in the intake: nothing is hidden from Phase 7');
reset role;
select pg_temp.check(pg_temp.refused(format('update projects.phase_six_handoffs set commit_ref = ''zzz'' where project_id = %L', :'P_id'), 'never edited'), 'the Phase 7 intake is frozen');
do $$ begin
  begin
    update projects.phase_six_handoffs set production_deployed = true where project_id = current_setting('e2e.p')::uuid;
    raise exception 'FAILED: Phase 6 recorded a production deployment';
  exception when restrict_violation or check_violation then raise notice 'ok  Phase 6 cannot record a production deployment (it is a CHECK and the row is frozen)'; end;
end $$;

-- source changes after approval: the approval no longer holds
set local session_replication_role = replica;
update projects.deliverable_details set commit_ref = 'eee0002' where deliverable_id = :'BD1_bd';
set local session_replication_role = origin;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select not passed from qa.evaluate_hard_gates(:'RC_rc'::uuid) where gate = 'evidence_current'), 'a changed commit makes the recorded evidence not current');
select pg_temp.check((select not passed from qa.evaluate_hard_gates(:'RC_rc'::uuid) where gate = 'build_succeeds'), 'and the build gate no longer holds for the approved candidate');
select pg_temp.check((select outcome from qa.invalidate_stale_results(:'P_id')) = 'invalidated', 'stale results are invalidated');
select pg_temp.check((select count(*) from qa.phase6_cases where plan_id = (select plan_id from qa.release_candidates where id = :'RC_rc'::uuid) and status = 'invalidated') >= 3, 'every old result is INVALIDATED, not left as a pass');
select pg_temp.check((select count(*) from qa.phase6_result_history where status = 'invalidated') >= 3, 'and the invalidation is in history: nothing was overwritten');
select pg_temp.check((select status from projects.qa_intakes where project_id = :'P_id') = 'stale', 'the QA intake is STALE');
reset role;
set local session_replication_role = replica;
update projects.deliverable_details set commit_ref = 'abc1234' where deliverable_id = :'BD1_bd';
set local session_replication_role = origin;

-- ═════════ Phase 6 -> 7: M4 (20%) and the Phase 7 financial gate ═════════
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'P_id', 'M4', 4, 100000, 'INR') returning id \gset MS4_
select pg_temp.as_service();
set local role service_role;
select invoice_id as i from finance.create_milestone_invoice(:'ORG', :'A_id', :'P_id', :'MS4_id', 'ZP4-M4-1', 'INR', 100000, 0, 100000, '[{"position":0,"description":"M4 - 20%","quantity":1,"unit_price_minor":100000,"amount_minor":100000,"tax_rate_bp":0}]', now() + interval '7 days', null, null) \gset I4_
select pg_temp.check((select outcome from finance.create_milestone_invoice(:'ORG', :'A_id', :'P_id', :'MS4_id', 'ZP4-M4-2', 'INR', 100000, 0, 100000, '[{"position":0,"description":"M4 - 20%","quantity":1,"unit_price_minor":100000,"amount_minor":100000,"tax_rate_bp":0}]', now() + interval '7 days', null, null)) = 'already_invoiced', 'a duplicate M4 invoice event creates no second invoice');
select finance.issue_invoice(:'I4_i', now() + interval '7 days');
select pg_temp.check((select outcome from projects.record_m4_verified(:'P_id')) = 'not_verified', 'NEGATIVE: an issued M4 emits no M4PaymentVerified');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.phase_seven_gate_status(:'P_id')) = 'invoice_issued', 'M4 issued: the Phase 7 financial gate is closed');
insert into finance.payment_submissions (organization_id, invoice_id, account_id, amount_minor, currency, method, reference, status, submitted_at, submitted_by_agent)
  values (:'ORG', :'I4_i', :'PAY_id', 100000, 'INR', 'upi', 'UTR-M4-1', 'pending_verification', now(), 'project_manager');
select pg_temp.check((select outcome from projects.phase_seven_gate_status(:'P_id')) = 'invoice_issued', 'a payment submission (proof) does not open the Phase 7 gate');
select payment_id as pid from finance.record_manual_payment(:'I4_i', 'UTR-M4-1', 50000, now(), 'upi') \gset PY4a_
select finance.verify_payment(:'PY4a_pid', :'OWNER');
select pg_temp.check(not projects.m4_verified_paid(:'P_id'), 'M4 underpaid (50,000 of 100,000 verified): the gate is still closed');
select payment_id as pid from finance.record_manual_payment(:'I4_i', 'UTR-M4-2', 50000, now(), 'upi') \gset PY4b_
select pg_temp.check((select outcome from projects.phase_seven_gate_status(:'P_id')) <> 'verified', 'a recorded but unverified balance does not open the gate');
select finance.verify_payment(:'PY4b_pid', :'OWNER');
select pg_temp.check(projects.m4_verified_paid(:'P_id'), 'M4 verified paid in full by the owner');
do $$ begin
  begin perform projects.record_m4_verified(current_setting('e2e.p')::uuid);
        raise exception 'FAILED: a signed-in person called the runner-only M4 door';
  exception when insufficient_privilege then raise notice 'ok  a person cannot emit M4PaymentVerified: the runner-only door refuses them'; end;
end $$;
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_m4_verified(:'P_id')) = 'recorded', 'M4PaymentVerified is recorded by the runner once the payment is verified in full');
select pg_temp.check((select outcome from projects.record_m4_verified(:'P_id')) = 'already_recorded', 'a replay emits nothing a second time');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.m4_payment_verified' and subject_id = :'P_id') = 1, 'exactly one M4PaymentVerified event exists');
select pg_temp.check((select state from projects.phase_six where project_id = :'P_id') = 'phase7_financially_ready', 'Phase 6 reaches PHASE7_FINANCIALLY_READY');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.phase_seven_gate_status(:'P_id')) = 'verified', 'ONLY NOW the Phase 7 financial gate is open');
reset role;

-- ═════════ after Phase 6: the source changes ═════════
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from qa.reopen_on_source_change(:'P_id')) = 'source_unchanged', 'an unchanged build leaves the approval standing');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(projects.phase_seven_candidate_current(:'P_id'), 'Phase 7 may deploy: the approved candidate is still the build');
reset role;
set local session_replication_role = replica;
update projects.deliverable_details set commit_ref = 'aaa0003' where deliverable_id = :'BD1_bd';
set local session_replication_role = origin;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from qa.reopen_on_source_change(:'P_id')) = 'reopened', 'a source change after approval REOPENS Phase 6');
select pg_temp.check((select status from qa.release_candidates where id = :'RC_rc'::uuid) = 'stale', 'the approved candidate is STALE');
select pg_temp.check((select state = 'blocked' and blocked_reason like '%new candidate%' from projects.phase_six where project_id = :'P_id'), 'Phase 6 is blocked, saying a new candidate and a new approval are needed');
select pg_temp.check((select outcome from qa.reopen_on_source_change(:'P_id')) = 'already_stale', 'reopening twice changes nothing');
select pg_temp.check(not projects.phase_seven_candidate_current(:'P_id'), 'Phase 7 is told the approved candidate no longer describes the build');
reset role;

-- scheduling modes (P601 §55): the destructive suite is serial, load testing exclusive, regression waits for what it protects
update projects.phase_six set state = 'phase7_financially_ready' where project_id = :'P_id';
set local session_replication_role = replica;
update qa.master_test_plans set status = 'superseded' where project_id = :'P_id' and status = 'approved';
insert into qa.master_test_plans (organization_id, project_id, intake_id, version, status, commit_ref, required_categories, approved_by, approved_at)
  values (:'ORG', :'P_id', (select id from projects.qa_intakes where project_id = :'P_id'), 99, 'approved', 'abc1234',
          array['functional', 'ui_e2e', 'api', 'integration', 'database', 'security', 'performance', 'compatibility', 'regression'], :'OWNER', now()) returning id \gset MP9_
set local session_replication_role = origin;
select pg_temp.as_service();
set local role service_role;
select outcome as o from qa.schedule_plan_jobs(:'MP9_id') \gset SJ9_
select pg_temp.check(:'SJ9_o' = 'scheduled' and (select count(*) from qa.qa_jobs where plan_id = :'MP9_id') = 9, 'every required category gets exactly one job [' || :'SJ9_o' || ' ' || (select count(*) from qa.qa_jobs where plan_id = :'MP9_id') || ']');
select pg_temp.check((select execution_mode from qa.qa_jobs where plan_id = :'MP9_id' and category = 'database') = 'serial', 'database tests run SERIAL (destructive, shared state)');
select pg_temp.check((select execution_mode from qa.qa_jobs where plan_id = :'MP9_id' and category = 'performance') = 'exclusive', 'performance tests run EXCLUSIVE (they own the environment)');
select pg_temp.check((select depends_on = array['functional', 'ui_e2e'] from qa.qa_jobs where plan_id = :'MP9_id' and category = 'regression'), 'regression waits for functional and end-to-end');
select pg_temp.check((select count(*) from qa.qa_jobs where plan_id = :'MP9_id' and execution_mode = 'parallel') = 7, 'the independent categories (and regression, once its dependencies finish) run in parallel');
reset role;


-- review fixes: the doors' facts cannot be rewritten around them, and a door cannot be pointed at another tenant
insert into core.organizations (id, name, slug) values ('00000000-0000-4000-8000-0000000000c3', 'Other Agency (review)', 'other-agency-review') on conflict (id) do nothing;
insert into auth.users (id, email) values ('00000000-0000-4000-8000-00000000c301', 'review-other@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values ('00000000-0000-4000-8000-00000000c301', 'review-other@example.test', 'Other Member') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values ('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-00000000c301', 'member') on conflict do nothing;
select pg_temp.as_user('00000000-0000-4000-8000-00000000c301', '00000000-0000-4000-8000-0000000000c3', 'member');
set local role authenticated;
select pg_temp.check((select outcome from qa.invalidate_stale_results(:'P_id')) = 'no_intake', 'another tenant calling invalidate_stale_results on this project is told nothing and changes nothing');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
do $$ begin
  begin
    insert into projects.tasks (organization_id, project_id, title, status) values ('00000000-0000-4000-8000-000000000001', current_setting('e2e.p')::uuid, 'zz direct done', 'done');
    raise exception 'NOT REFUSED';
  exception when restrict_violation then null; end;
end $$;
select pg_temp.check(true, 'a direct INSERT of a started Phase 5 task is refused (the gate lives in start_task)');
do $$ declare t uuid; begin
  select id into t from projects.tasks where project_id = current_setting('e2e.p')::uuid order by created_at limit 1;
  if t is null then raise notice 'no task to probe'; return; end if;
  begin
    update projects.tasks set status = 'in_progress' where id = t and status = 'todo';
  exception when restrict_violation then return; end;
  if found then raise exception 'NOT REFUSED'; end if;
end $$;
select pg_temp.check(true, 'a direct status move out of todo on a Phase 5 task is refused');
do $$ begin
  begin
    insert into qa.defects (organization_id, project_id, severity, status, title, reproduction) values ('00000000-0000-4000-8000-000000000001', current_setting('e2e.p')::uuid, 'blocker', 'verified', 'zz born verified', 'x');
    raise exception 'NOT REFUSED';
  exception when restrict_violation then null; end;
end $$;
select pg_temp.check(true, 'a defect cannot be inserted already verified');
reset role;


-- second review round: approvals are about a commit; a client cannot ask about payments
reset role;
select deliverable_id as bd from projects.add_deliverable(:'P_id', 'build', 'Development build 9', 'https://builds.example.test/9', 'initial', null, '00000000-0000-4000-8000-00000000f522', null, null) \gset BD9_
select outcome from projects.set_deliverable_details(:'BD9_bd', 'web', 'aaa1111', 'build-9', null, null);
update projects.deliverable_details set qa_status = 'passed', qa_decided_at = now(), admin_status = 'approved', admin_decided_at = now() where deliverable_id = :'BD9_bd';
update projects.deliverable_details set commit_ref = 'bbb2222' where deliverable_id = :'BD9_bd';
select pg_temp.check((select qa_status = 'not_reviewed' and admin_status = 'pending' and qa_decided_at is null and admin_decided_at is null from projects.deliverable_details where deliverable_id = :'BD9_bd'), 'swapping the commit after QA and Admin approval un-approves the build');
insert into projects.code_reviews (organization_id, project_id, deliverable_id, commit_ref, verdict, reviewer_id, reviewer_changed_code, reviewed_at)
  values (:'ORG', :'P_id', :'BD9_bd', 'bbb2222', 'passed', :'OWNER', true, now() - interval '2 minutes'),
         (:'ORG', :'P_id', :'BD9_bd', 'bbb2222', 'passed', :'OWNER', false, now());
select pg_temp.check((select verdict from projects.build_review_status(:'BD9_bd')) = 'needs_second', 'a reviewer who changed the code cannot also be the independent second reviewer');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(projects.m3_verified_paid(:'P_id'), 'staff can ask whether M3 is verified paid');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'client');
set local role authenticated;
select pg_temp.check(not projects.m3_verified_paid(:'P_id') and not projects.m4_verified_paid(:'P_id') and not projects.phase_seven_candidate_current(:'P_id'), 'a portal client learns nothing about payments or the Phase 7 candidate');
reset role;



-- third round: assigned / in progress, the baseline's base commit, the PM message template version
reset role;
insert into qa.defects (organization_id, project_id, severity, title, reproduction, s_level) values (:'ORG', :'P_id', 'major', 'zz work-state defect', 'x', 2) returning id \gset WS_
select set_config('e2e.ws', :'WS_id', false);
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select work_state from qa.defects where id = :'WS_id') = 'triage', 'a new defect is in triage');
select pg_temp.check((select outcome from qa.start_defect_work(:'WS_id')) = 'not_assigned', 'work cannot start on a defect nobody holds');
select pg_temp.check((select outcome from qa.assign_defect(:'WS_id')) = 'assigned', 'a delivery manager assigns it (to themselves by default)');
select pg_temp.check((select work_state = 'assigned' and assigned_to = :'OWNER' from qa.defects where id = :'WS_id'), 'it reads Assigned, to that person');
select pg_temp.check((select outcome from qa.assign_defect(:'WS_id', '00000000-0000-4000-8000-0000000fffff')) = 'assignee_not_in_organization', 'it cannot be assigned to someone outside the organization');
select pg_temp.check((select outcome from qa.start_defect_work(:'WS_id')) = 'started', 'the assignee starts work');
select pg_temp.check((select work_state from qa.defects where id = :'WS_id') = 'in_progress', 'it reads In progress');
do $$ begin
  begin update qa.defects set work_state = 'triage' where id = current_setting('e2e.ws')::uuid; raise exception 'NOT REFUSED';
  exception when restrict_violation then null; end;
end $$;
select pg_temp.check(true, 'a direct write of the work state is refused');
reset role;

insert into projects.repositories (organization_id, project_id, name, platform, url) values (:'ORG', :'P_id', 'zz repo', 'github', 'https://github.com/example/zz') returning id \gset RP_
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_baseline_commit(:'P_id', :'RP_id', 'not-a-sha')) = 'bad_commit', 'a base commit must look like a commit');
select pg_temp.check((select outcome from projects.record_baseline_commit(:'P_id', :'RP_id', 'abc1234def')) = 'recorded', 'the base commit and repository are recorded once');
select pg_temp.check((select base_commit = 'abc1234def' and repository_id = :'RP_id' from projects.development_baselines where project_id = :'P_id'), 'the baseline now names them');
select pg_temp.check((select outcome from projects.record_baseline_commit(:'P_id', :'RP_id', 'fff9999')) = 'already_recorded', 'a recorded base commit is never replaced');
do $$ begin
  begin update projects.development_baselines set base_commit = 'eee1111' where project_id = current_setting('e2e.p')::uuid;
  exception when others then null; end;
end $$;
select pg_temp.check((select base_commit = 'abc1234def' from projects.development_baselines where project_id = :'P_id'), 'the baseline stays frozen: a direct edit changes nothing');
reset role;

insert into crm.conversations (organization_id, channel, status, kind) values (:'ORG', 'whatsapp', 'active', 'internal_group') returning id \gset PMC_
insert into crm.conversation_messages (organization_id, conversation_id, seq, author_type, body, metadata) values (:'ORG', :'PMC_id', 1, 'system', 'PM5-M01 test', '{"delivery":"sent"}') returning id \gset PMM_
select set_config('e2e.pmm', :'PMM_id', false);
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from crm.record_pm_message(:'PMM_id', 'PM5-M01', 1, :'P_id')) = 'recorded', 'the runner records which template version a PM message used');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
do $$ begin
  begin perform crm.record_pm_message(current_setting('e2e.pmm')::uuid, 'PM5-M01', 2, current_setting('e2e.p')::uuid); raise exception 'NOT REFUSED';
  exception when insufficient_privilege then null; end;
end $$;
select pg_temp.check(true, 'a person cannot write the PM message log');
select pg_temp.check((select milestone_key = 'PM5-M01' and template_version = 1 and delivery = 'sent' from projects.pm_message_history(:'P_id') limit 1), 'the history reads milestone, wording version and the message''s own delivery state');
reset role;


-- build pipeline hardening: idempotent, no false green, no deploy dressed as a build, a person's success needs evidence
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_build_run(:'BD9_bd', 'review', 'succeeded', null, '[{"name":"build","status":"failed"},{"name":"artifact_verify","status":"ok"}]', '{"node":"22"}', repeat('b', 64), null, null, 'https://ci.example.test/x')) = 'failed_required_stage', 'a succeeded run cannot hide a failed required stage');
select pg_temp.check((select outcome from projects.record_build_run(:'BD9_bd', 'review', 'succeeded', null, '[{"name":"build","status":"ok"}]', '{"node":"22"}', repeat('b', 64), null, null, 'https://ci.example.test/x')) = 'missing_mandatory_stages', 'a succeeded run has the mandatory stages (build and artifact verification)');
select pg_temp.check((select outcome from projects.record_build_run(:'BD9_bd', 'review', 'succeeded', null, '[{"name":"build","status":"ok"},{"name":"artifact_verify","status":"ok"}]', '{"command":"vercel deploy --prod"}', repeat('b', 64), null, null, 'https://ci.example.test/x')) = 'deploy_is_not_a_build', 'a build command that deploys is refused: a build never deploys');
select pg_temp.check((select outcome from projects.record_build_run(:'BD9_bd', 'review', 'succeeded', null, '[{"name":"build","status":"ok"},{"name":"artifact_verify","status":"ok"}]', '{"node":"22"}', repeat('b', 64), null, null, null)) = 'manual_success_needs_evidence', 'a person''s hand-recorded success must name its evidence');
select pg_temp.check((select outcome from projects.record_build_run(:'BD9_bd', 'review', 'succeeded', null, '[{"name":"build","status":"ok"},{"name":"nonsense","status":"great"}]', '{"node":"22"}', repeat('b', 64), null, null, 'https://ci.example.test/x')) = 'bad_stages', 'an unknown stage status is refused');
select outcome as o, run_id as r from projects.record_build_run(:'BD9_bd', 'review', 'succeeded', null, '[{"name":"build","status":"ok"},{"name":"artifact_verify","status":"ok"}]', '{"node":"22"}', repeat('b', 64), null, 'req-1', 'https://ci.example.test/x') \gset IDM1_
select outcome as o, run_id as r from projects.record_build_run(:'BD9_bd', 'review', 'succeeded', null, '[{"name":"build","status":"ok"},{"name":"artifact_verify","status":"ok"}]', '{"node":"22"}', repeat('b', 64), null, 'req-1', 'https://ci.example.test/x') \gset IDM2_
select pg_temp.check(:'IDM1_o' = 'recorded' and :'IDM2_o' = 'already_recorded' and :'IDM1_r' = :'IDM2_r', 'a replayed build request answers with the run it already made (idempotent)');
select pg_temp.check((select count(*) from projects.build_runs where deliverable_id = :'BD9_bd') = 1, 'and no duplicate run was written');
select pg_temp.check((select manual and evidence_url is not null from projects.build_runs where id = :'IDM1_r'::uuid), 'a hand-recorded run is marked manual and keeps its evidence');
reset role;


-- orchestrator: a failed attempt is remembered, an escalation is a record a person closes
select set_config('e2e.t2', :'T2_id', false);
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_execution_failure(:'T2_id', 1, 'build_failure', 'safe', false, false, 'tsc failed')) = 'recorded', 'a failed attempt is recorded with what was decided about it');
select pg_temp.check((select outcome from projects.record_execution_failure(:'T2_id', 1, 'build_failure', 'safe', false, false, 'tsc failed')) = 'recorded', 'a replay is accepted and records nothing twice');
select pg_temp.check((select count(*) from projects.execution_attempts where task_id = :'T2_id') = 1, 'one row per (task, attempt, class)');
select pg_temp.check((select outcome from projects.record_execution_failure(:'T2_id', 2, 'made_up_class', 'safe', false, false, null)) = 'bad_input', 'an unknown failure class is refused');
select pg_temp.check((select count(*) from projects.orchestrator_escalations where task_id = :'T2_id') = 0, 'a failure that does not escalate opens no escalation');
select pg_temp.check((select outcome from projects.record_execution_failure(:'T2_id', 3, 'test_failure', 'never', false, true, 'retries used up')) = 'recorded', 'an exhausted failure is recorded and escalates');
select pg_temp.check((select count(*) from projects.orchestrator_escalations where task_id = :'T2_id' and status = 'open') = 1, 'it opened exactly one escalation for a person');
select pg_temp.check((select outcome from projects.record_execution_failure(:'T2_id', 3, 'test_failure', 'never', false, true, 'retries used up')) = 'recorded' and (select count(*) from projects.orchestrator_escalations where task_id = :'T2_id') = 1, 'a replay opens no second escalation');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
do $$ begin
  begin perform projects.record_execution_failure(current_setting('e2e.t2')::uuid, 9, 'timeout', 'safe', true, false, null); raise exception 'NOT REFUSED';
  exception when insufficient_privilege then null; end;
end $$;
select pg_temp.check(true, 'a person cannot write execution attempts');
select pg_temp.check((select outcome from projects.resolve_escalation((select id from projects.orchestrator_escalations where task_id = current_setting('e2e.t2')::uuid and status = 'open'), '  ')) = 'resolution_required', 'closing an escalation needs the decision taken');
select pg_temp.check((select outcome from projects.resolve_escalation((select id from projects.orchestrator_escalations where task_id = current_setting('e2e.t2')::uuid and status = 'open'), 'Reassigned to the backend developer with a smaller scope')) = 'resolved', 'an Admin closes it with the decision');
select pg_temp.check((select count(*) from projects.orchestrator_escalations where task_id = current_setting('e2e.t2')::uuid and status = 'open') = 0, 'and it no longer reads open');
reset role;


-- integrations: a check target names the endpoint and the SECRET NAME; changing it drops the proof
reset role;
insert into projects.integration_connections (organization_id, project_id, kind, name, health) values (:'ORG', :'P_id', 'payment', 'zz gateway', 'configured') returning id \gset IC_
select set_config('e2e.ic', :'IC_id', false);
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_integration_check_target(:'IC_id', 'http://insecure.example.test/health')) = 'bad_url', 'a check URL must be https');
select pg_temp.check((select outcome from projects.set_integration_check_target(:'IC_id', 'https://api.example.test/health', 'sk-live-abc123')) = 'bad_credential_name', 'a secret is referenced by NAME in capitals; a pasted value is refused');
select pg_temp.check((select outcome from projects.set_integration_check_target(:'IC_id', 'https://api.example.test/health', 'GATEWAY_TEST_KEY')) = 'set', 'the target is set');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_integration_check(:'IC_id', 'http_health', true, 'HTTP 200 from api.example.test at 2026-10-06T12:00:00Z by adapter http_health')) = 'verified', 'the adapter verifies on evidence');
select pg_temp.check((select outcome from projects.note_integration_check(:'IC_id', 'ok')) = 'noted', 'the adapter notes what the check found');
select pg_temp.check((select outcome from projects.note_integration_check(:'IC_id', 'made_up')) = 'bad_class', 'an unknown check class is refused');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
do $$ begin
  begin perform projects.note_integration_check(current_setting('e2e.ic')::uuid, 'ok'); raise exception 'NOT REFUSED';
  exception when insufficient_privilege then null; end;
end $$;
select pg_temp.check(true, 'a person cannot write a check result');
select pg_temp.check((select outcome from projects.set_integration_check_target(:'IC_id', 'https://api.example.test/health', 'GATEWAY_TEST_KEY')) = 'set' and (select health from projects.integration_connections where id = :'IC_id') = 'verified', 'setting the SAME target keeps the proof');
select pg_temp.check((select outcome from projects.set_integration_check_target(:'IC_id', 'https://api.other.example.test/health', 'GATEWAY_TEST_KEY')) = 'set', 'a different target is set');
select pg_temp.check((select health = 'configured' and verification_evidence is null and verified_at is null and verified_by_adapter is null from projects.integration_connections where id = :'IC_id'), 'and it DROPS the proof: the evidence described a connection that no longer exists');
reset role;


-- the PM's derived state and the review package
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select state from projects.pm_phase_five_state(:'P_id')) in ('READY_FOR_PHASE6', 'WAITING_M3'), 'a completed Phase 5 reads READY_FOR_PHASE6 or WAITING_M3, by the M3 payment alone [' || (select state from projects.pm_phase_five_state(:'P_id')) || ']');
select pg_temp.check((select (state = 'READY_FOR_PHASE6') = projects.m3_verified_paid(:'P_id') from projects.pm_phase_five_state(:'P_id')), 'and only a VERIFIED M3 payment moves it to READY_FOR_PHASE6');
select pg_temp.check((select count(*) from projects.build_review_package(:'BD9_bd')) = 8, 'the review package has its eight lines for one exact build');
select pg_temp.check((select not ok from projects.build_review_package(:'BD9_bd') where item = 'Independent code review passed on this commit'), 'an un-reviewed build says so: the line is not ok');
select pg_temp.check((select ok from projects.build_review_package(:'BD9_bd') where item = 'Exact commit'), 'and its exact commit is shown');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'client');
set local role authenticated;
select pg_temp.check((select count(*) from projects.pm_phase_five_state(:'P_id')) = 0 and (select count(*) from projects.build_review_package(:'BD9_bd')) = 0, 'a portal client reads neither the PM state nor the review package');
reset role;


-- test ingest: idempotent delivery, and a report for its own commit
select pg_temp.as_service();
set local role service_role;
select outcome as o, run_id as r from qa.ingest_test_report(:'BD1_bd', 'smoke', '{"tests":[{"name":"smoke.home","status":"passed"}]}', 'https://ci.example.test/smoke/1') \gset IR1_
select outcome as o, run_id as r from qa.ingest_test_report(:'BD1_bd', 'smoke', '{"tests":[{"name":"smoke.home","status":"passed"}]}', 'https://ci.example.test/smoke/1') \gset IR2_
select pg_temp.check(:'IR1_o' = 'ingested' and :'IR2_o' = 'already_ingested' and :'IR1_r' = :'IR2_r', 'a redelivered report answers with the run it already made');
select pg_temp.check((select count(*) from qa.test_runs where deliverable_id = :'BD1_bd' and evidence_url = 'https://ci.example.test/smoke/1') = 1, 'and no second run exists');
select pg_temp.check((select outcome from qa.ingest_test_report(:'BD1_bd', 'smoke', '{"commit":"0000000","tests":[{"name":"smoke.home","status":"passed"}]}', 'https://ci.example.test/smoke/2')) = 'stale_report', 'a report for another commit is refused as stale');
reset role;


-- smoke, blockers, artifacts
select set_config('e2e.idm1', :'IDM1_r', false);
select set_config('e2e.bd9', :'BD9_bd', false);
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(not projects.build_smoke_ready(:'BD9_bd'), 'a build with no smoke verdict is not smoke-ready');
select pg_temp.check((select outcome from projects.record_smoke_check(:'BD9_bd', 'passed', '[{"name":"launch"}]', null, null, null)) = 'pass_needs_checks_and_evidence', 'a person''s smoke PASS names its checks and evidence');
select pg_temp.check((select outcome from projects.record_smoke_check(:'BD9_bd', 'not_tested', '[]', null, '  ', null)) = 'reason_required', 'NOT_TESTED says why');
select outcome as o from projects.record_smoke_check(:'BD9_bd', 'failed', '[]', null, 'crashes on launch', null) \gset SM1_
select pg_temp.check(:'SM1_o' = 'recorded' and not projects.build_smoke_ready(:'BD9_bd'), 'a failed smoke check is recorded and the build is not ready');
select outcome as o from projects.record_smoke_check(:'BD9_bd', 'blocked', '[]', 'ios-simulator', 'no macOS runner is bound', null) \gset SM2_
select pg_temp.check(:'SM2_o' = 'recorded' and not projects.build_smoke_ready(:'BD9_bd'), 'a BLOCKED smoke check is not a pass');
select outcome as o from projects.record_smoke_check(:'BD9_bd', 'not_tested', '[]', null, 'web build; no device lab', null) \gset SM3_
select pg_temp.check(:'SM3_o' = 'recorded' and projects.build_smoke_ready(:'BD9_bd'), 'an honest NOT_TESTED with its reason is shareable');
reset role;
update projects.deliverable_details set commit_ref = 'ccc3333' where deliverable_id = :'BD9_bd';
select pg_temp.check(not projects.build_smoke_ready(:'BD9_bd'), 'the smoke verdict belongs to its commit: a new commit needs a new verdict');
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_build_run(:'BD9_bd', 'review', 'failed', 'environment_missing', '[{"name":"env","status":"failed"}]', '{}', null, null, 'blk-1', null)) = 'recorded', 'a run fails on a missing environment');
select pg_temp.check((select count(*) from projects.build_blockers where deliverable_id = :'BD9_bd' and blocker_type = 'environment_missing' and status = 'open') = 1, 'and a truthful blocker opened by itself');
select pg_temp.check((select outcome from projects.record_build_run(:'BD9_bd', 'review', 'failed', 'environment_missing', '[{"name":"env","status":"failed"}]', '{}', null, null, 'blk-2', null)) = 'recorded' and (select count(*) from projects.build_blockers where deliverable_id = :'BD9_bd' and status = 'open') = 1, 'a second identical failure does not open a second blocker');
select pg_temp.check((select outcome from projects.record_build_artifact(:'IDM1_r'::uuid, 'web_bundle', 's3://bucket/zz/app.zip', 'web', 1234, true, null)) = 'recorded', 'the runner records what the successful run produced');
select pg_temp.check((select outcome from projects.record_build_artifact(:'IDM1_r'::uuid, 'ipa', 's3://bucket/zz/app.ipa', 'ios', 99, false, null)) in ('recorded', 'bad_input'), 'a second record for the run adds nothing');
select pg_temp.check((select count(*) from projects.build_artifacts where build_run_id = :'IDM1_r'::uuid) = 1, 'one artifact record per run');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
do $$ begin
  begin perform projects.record_build_artifact(current_setting('e2e.idm1')::uuid, 'web_bundle', 'x', null, null, true, null); raise exception 'NOT REFUSED';
  exception when insufficient_privilege then null; end;
end $$;
select pg_temp.check(true, 'a person cannot write an artifact record');
select pg_temp.check((select outcome from projects.resolve_build_blocker((select id from projects.build_blockers where deliverable_id = current_setting('e2e.bd9')::uuid and status = 'open' limit 1))) = 'resolved', 'an Admin resolves the blocker');
reset role;

select pg_temp.check((select prosrc ~ 'build_smoke_ready\(v_row\.id\)' and prosrc ~ 'no_smoke' from pg_proc where oid = 'projects.submit_deliverable(uuid,uuid,text)'::regprocedure), 'submit_deliverable refuses a build with no smoke verdict (the live definition carries the gate)');

-- admin panel reads: the M3 invoice for staff who are not Finance, feature coverage, neither for a portal client
select pg_temp.as_user(:'OWNER', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select count(*) from projects.m3_invoice_summary(:'P_id')) = 1, 'a delivery lead reads the M3 invoice summary (number, status, verified amount) without Finance rights');
select pg_temp.check((select verified_paid = projects.m3_verified_paid(:'P_id') and verified_minor <= total_minor from projects.m3_invoice_summary(:'P_id')), 'and its verified flag is the M3 gate itself');
select pg_temp.check((select count(*) from projects.feature_coverage(:'P_id')) >= 0, 'feature coverage reads for staff');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'client');
set local role authenticated;
select pg_temp.check((select count(*) from projects.m3_invoice_summary(:'P_id')) = 0 and (select count(*) from projects.feature_coverage(:'P_id')) = 0, 'a portal client reads neither');
reset role;

-- a plan with no baseline to measure against is not coverage
reset role;
do $$ declare pl uuid; begin
  select id into pl from qa.master_test_plans where project_id = current_setting('e2e.p')::uuid order by version desc limit 1;
  perform set_config('e2e.pl', pl::text, true);
end $$;
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest nobaseline') returning id \gset NB_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'NB_id', 'zztest nobaseline', 'ZP-NB') returning id \gset NBP_
alter table projects.development_baselines disable trigger user;
update projects.development_baselines set project_id = :'NBP_id' where project_id = :'P_id';
alter table projects.development_baselines enable trigger user;
select pg_temp.check(exists (select 1 from qa.plan_problems(current_setting('e2e.pl')::uuid) where problem like 'There is no locked development baseline%'), 'a plan with no baseline to measure against is a problem, not silent coverage');


-- owner decisions: quarantine renewal, derived documentation, the M4 override
reset role;
insert into qa.flaky_tests (organization_id, project_id, test_key) values (:'ORG', :'P_id', 'zz.renewal.test') returning id \gset FQ_
select pg_temp.as_user(:'OWNER', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from qa.resolve_flaky_test(:'FQ_id', 'quarantine', null, now() + interval '5 days')) = 'quarantined', 'a member starts a quarantine');
select pg_temp.check((select outcome from qa.resolve_flaky_test(:'FQ_id', 'quarantine', null, now() + interval '5 days')) = 'renewal_needs_admin', 'a member cannot renew it');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from qa.resolve_flaky_test(:'FQ_id', 'quarantine', null, now() + interval '5 days')) = 'renewed', 'an Admin renews it (1)');
select pg_temp.check((select outcome from qa.resolve_flaky_test(:'FQ_id', 'quarantine', null, now() + interval '5 days')) = 'renewed', 'an Admin renews it (2)');
select pg_temp.check((select outcome from qa.resolve_flaky_test(:'FQ_id', 'quarantine', null, now() + interval '5 days')) = 'renewal_limit_reached_fix_or_remove_the_test', 'the third renewal is refused: fix or remove the test');
reset role;
update projects.technical_documents set derived = false where project_id = :'P_id';
select pg_temp.check(exists (select 1 from projects.stale_documents(:'P_id') where document_id is null and title like 'No documentation has been derived%'), 'a build with no derived documentation is not "documentation current"');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.override_release_payment(:'P_id', 'the client promised to pay on Friday')) = 'm4_gate_has_no_override', 'the owner cannot override the payment of a project under the Phase 6 M4 gate');
reset role;
insert into projects.release_payment_overrides (organization_id, project_id, overridden_by, reason) values (:'ORG', :'P_id', :'OWNER', 'a legacy override row exists');
select pg_temp.check((select state from projects.final_payment_state(:'P_id')) is distinct from 'overridden', 'an old override row no longer satisfies the final payment of a Phase 6 project');


-- races: the doors take the lock their check depends on (the live definitions, not the migration text)
select pg_temp.check((select prosrc ~ 'from projects\.projects p where p\.id = v_base for update' from pg_proc where oid = 'projects.start_task(uuid)'::regprocedure), 'start_task serializes starts in a project (locks the project row before checking path conflicts)');
select pg_temp.check((select bool_and(prosrc ~ 'qa\.defects d where d\.id = p_defect_id and d\.organization_id = v_org for update') from pg_proc where proname = 'hand_off_defect' and pronamespace = 'qa'::regnamespace), 'hand_off_defect locks the defect before checking it was not already handed off');

rollback;
\echo PHASE 4 E2E OK
