-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 8 part B: post-launch maintenance work, its gates, routing records, agent proposals and maintenance billing,
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

-- ═════════ SLA policy: none is invented; routing record is service-only and explained ═════════
select pg_temp.check((select count(*) from projects.maintenance_sla_policies where organization_id = :'ORG') = 0, 'no SLA policy exists until an Admin sets one');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_maintenance_sla_policy('p1', 4, 2)) = 'bad_hours', 'resolution cannot be shorter than response');
select pg_temp.check((select policy_version from projects.set_maintenance_sla_policy('p1', 4, 24)) = 1, 'an Admin sets a policy (version 1)');
select pg_temp.check((select policy_version from projects.set_maintenance_sla_policy('p1', 2, 12)) = 2, 'a new policy is a new version; the old stays');
select pg_temp.check(pg_temp.denied(format($$select * from projects.record_maintenance_routing(%L, %L, 'k', 'held', 'p2', null, 'r', '[]', '{}', false, '[]', 'v')$$, :'ORG', :'W2_id')), 'a person cannot write a routing decision');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_maintenance_routing(:'ORG', :'W2_id', 'k1', 'routed', 'p2', 'quality_assurance', 'r', '[]', '{}', false, '[]', 'v')) = 'builder_cannot_be_qa', 'a builder is never routed as QA');
select pg_temp.check((select outcome from projects.record_maintenance_routing(:'ORG', :'W2_id', 'k1', 'held', 'p2', null, 'agent disabled', '[{"agent":"backend_developer","eligible":false,"rejected":"installed but not enabled"}]', '{"state":"unknown"}', false, '["quality_assurance"]', 'registry-x')) = 'recorded', 'a held decision is recorded with its candidates');
select pg_temp.check((select outcome from projects.record_maintenance_routing(:'ORG', :'W2_id', 'k1', 'held', 'p2', null, 'agent disabled', '[]', '{}', false, '[]', 'v')) = 'already_recorded', 'a duplicate decision key records once');
select pg_temp.check((select outcome from projects.record_maintenance_routing(:'ORGB', :'W2_id', 'k2', 'held', 'p2', null, 'r', '[]', '{}', false, '[]', 'v')) = 'not_found', 'another organization cannot be named');
reset role;

-- ═════════ agent proposals: asked by a person, proposed by the service door, decided by someone else ═════════
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select request_id as "RQ_id" from projects.request_maintenance_agent_run(:'W2_id', 'bug_fix') \gset
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_maintenance_agent_proposal(:'RQ_id', :'ORGB', 'bug_fix', 'fix_plan', 's', '["a"]', '[]', false, false, '{}', null)) = 'wrong_organization', 'a proposal cannot name another organization');
select pg_temp.check((select outcome from projects.record_maintenance_agent_proposal(:'RQ_id', :'ORG', 'regression_test', 'regression_plan', 's', '["a"]', '[]', false, false, '{}', null)) = 'wrong_agent', 'the agent must be the one asked');
select pg_temp.check((select outcome from projects.record_maintenance_agent_proposal(:'RQ_id', :'ORG', 'bug_fix', 'fix_plan', 'use key sk-abcdefghijklmnopqrstuv', '["a"]', '[]', false, false, '{}', null)) = 'secret_in_text', 'a secret value is refused');
select pg_temp.check((select outcome from projects.record_maintenance_agent_proposal(:'RQ_id', :'ORG', 'bug_fix', 'fix_plan', 'minimal fix', '["reproduce","patch"]', '[]', false, false, '{}', null)) = 'proposed', 'the agent proposes a fix plan');
select pg_temp.check((select count(*) from projects.maintenance_work_items where id = :'W2_id' and status = 'release_review') = 1, 'a proposal changed no work state');
reset role;
select id as "PR_id" from projects.maintenance_agent_proposals where request_id = :'RQ_id' \gset
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_maintenance_agent_proposal(:'PR_id','accepted')) = 'self_acceptance', 'the requester cannot accept');
reset role;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_maintenance_agent_proposal(:'PR_id','accepted')) = 'accepted', 'an independent person accepts');
select pg_temp.check((select outcome from projects.decide_maintenance_agent_proposal(:'PR_id','rejected','n')) = 'already_decided', 'a decision is final');
reset role;

-- ═════════ finance: proposals only, no amount from the agent, gate on verified money ═════════
set local session_replication_role = replica;
insert into sales.opportunities (organization_id, name) values (:'ORG', 'zztest amc') returning id \gset O_
insert into sales.proposals (organization_id, opportunity_id, title, status, subtotal_minor, tax_minor, total_minor) values (:'ORG', :'O_id', 'AMC', 'accepted', 100000, 18000, 118000) returning id \gset SP_
insert into sales.proposal_items (organization_id, proposal_id, position, description, quantity, unit_price_minor, amount_minor) values (:'ORG', :'SP_id', 1, 'Annual maintenance', 1, 100000, 100000);
insert into projects.maintenance_plans (organization_id, client_account_id, project_id, name, billing_model, status) values (:'ORG', :'A_id', :'P_id', 'AMC', 'annual', 'pending_client') returning id \gset PL_
insert into projects.maintenance_plans (organization_id, client_account_id, project_id, name, billing_model, status) values (:'ORG', :'A_id', :'P_id', 'AMC unaccepted', 'annual', 'draft') returning id \gset PLU_
update projects.maintenance_plans set accepted_proposal_id = :'SP_id', accepted_at = now() where id = :'PL_id';
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, total_minor, subtotal_minor, tax_minor, kind, issued_at) values (:'ORG', :'A_id', :'P_id', 'P8B-INV-1', 'issued', 118000, 100000, 18000, 'service', now()) returning id \gset INV_
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, total_minor, subtotal_minor, tax_minor, kind, issued_at, paid_minor, paid_at) values (:'ORG', :'A_id', :'P_id', 'P8B-INV-2', 'paid', 5000, 5000, 0, 'service', now(), 5000, now()) returning id \gset INVP_
insert into finance.payments (organization_id, invoice_id, provider_payment_id, amount_minor, status, verified_at, verified_by) values (:'ORG', :'INVP_id', 'p8b-pay', 5000, 'captured', now(), :'OWNER');
set local session_replication_role = origin;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from finance.request_maintenance_billing('maintenance_invoice', :'PLU_id')) = 'plan_not_accepted', 'billing follows acceptance of an exact quote');
select pg_temp.check((select outcome from finance.request_maintenance_billing('payment_reminder', null, null, :'INVP_id')) = 'invoice_not_collectible', 'no reminder for a paid invoice');
select request_id as "FR_id" from finance.request_maintenance_billing('maintenance_invoice', :'PL_id') \gset
select request_id as "FRR_id" from finance.request_maintenance_billing('payment_reminder', null, null, :'INV_id') \gset
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.denied(format($$select * from finance.record_maintenance_billing_proposal(%L, %L, 'finance', 'x')$$, :'FR_id', :'ORG')), 'a signed-in person cannot write as the Finance agent');
select pg_temp.check(pg_temp.denied(format($$select * from projects.record_maintenance_agent_proposal(%L, %L, 'bug_fix', 'fix_plan', 's', '["a"]', '[]', false, false, '{}', null)$$, :'RQ_id', :'ORG')), 'a signed-in person cannot write as a maintenance agent');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from finance.record_maintenance_billing_proposal(:'FR_id', :'ORG', 'finance', 'Annual plan, first cycle')) = 'proposed', 'the Finance agent drafts an invoice proposal');
reset role;
set local session_replication_role = replica;
update finance.invoices set status = 'paid', paid_minor = total_minor, paid_at = now() where id = :'INV_id';
set local session_replication_role = origin;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from finance.record_maintenance_billing_proposal(:'FRR_id', :'ORG', 'finance', null, 'Reminder about P8B-INV-1')) = 'invoice_not_collectible', 'a reminder is refused once the invoice is no longer collectible (state now, not at request)');
reset role;
set local session_replication_role = replica;
update finance.invoices set status = 'issued', paid_minor = 0, paid_at = null where id = :'INV_id';
set local session_replication_role = origin;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from finance.record_maintenance_billing_proposal(:'FRR_id', :'ORG', 'finance', null, 'Gentle reminder')) = 'reminder_must_name_the_invoice', 'a reminder must name its invoice');
select pg_temp.check((select outcome from finance.record_maintenance_billing_proposal(:'FRR_id', :'ORG', 'finance', null, 'Reminder about P8B-INV-1')) = 'proposed', 'the Finance agent drafts a reminder');
reset role;
select pg_temp.check((select total_minor from finance.maintenance_billing_proposals where request_id = :'FR_id') = 118000, 'the amount is the quoted total, copied by the database');
select pg_temp.check((select balance_minor from finance.maintenance_billing_proposals where request_id = :'FRR_id') = 118000, 'the reminder balance is computed from verified money');
select pg_temp.check((select count(*) from finance.payments where organization_id = :'ORG' and invoice_id = :'INV_id') = 0, 'no payment was recorded or verified by any proposal');
select id as "FP_id" from finance.maintenance_billing_proposals where request_id = :'FR_id' \gset
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from finance.decide_maintenance_billing_proposal(:'FP_id','accepted')) = 'self_acceptance', 'the requester cannot accept the proposal');
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from finance.decide_maintenance_billing_proposal(:'FP_id','accepted', null, :'INVP_id')) = 'amount_differs_from_the_quoted_price', 'an invoice at a different amount is refused, never coerced');
select pg_temp.check((select outcome from finance.decide_maintenance_billing_proposal(:'FP_id','accepted', null, :'INV_id')) = 'accepted', 'an independent Admin accepts with the matching invoice');
-- the gate
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PL_id', :'INV_id', 'activation', '2026-11-01', '2027-11-01')) = 'linked', 'the invoice is linked to the plan cycle');
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PL_id', :'INV_id', 'activation', '2026-11-01', '2027-11-01')) = 'already_linked', 'a duplicate link is the same link');
select pg_temp.check((select state from finance.maintenance_financial_gate(:'PL_id')) = 'awaiting_payment_verification', 'issued but unpaid: awaiting verification');
reset role;
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_plans set status = 'active' where id = %L$$, :'PL_id'), 'verified money'), 'a billed plan does not activate before verified payment');
select pg_temp.check((select count(*) from projects.maintenance_plans where id = :'PL_id' and status = 'active') = 0, 'the plan stayed inactive');
-- exception: requester != approver, owner only
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select exception_id as "EX_id" from finance.request_maintenance_gate_exception(:'PL_id', 'client pays on delivery', 'weekly follow-up', now() + interval '10 days') \gset
select pg_temp.check((select outcome from finance.approve_maintenance_gate_exception(:'EX_id')) = 'not_authorized', 'only the owner approves an exception');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select exception_id as "EX2_id" from finance.request_maintenance_gate_exception(:'PL_id', 'own request', 'none', now() + interval '5 days') \gset
select pg_temp.check((select outcome from finance.approve_maintenance_gate_exception(:'EX2_id')) = 'requester_cannot_approve', 'the owner cannot approve an exception they requested');
select pg_temp.check((select outcome from finance.approve_maintenance_gate_exception(:'EX_id')) = 'approved', 'the owner approves the exception');
reset role;
update projects.maintenance_plans set status = 'active' where id = :'PL_id';
select pg_temp.check((select status from projects.maintenance_plans where id = :'PL_id') = 'active', 'with an approved exception the plan activates');
set local session_replication_role = replica;
insert into projects.maintenance_plans (organization_id, client_account_id, project_id, name, billing_model, status, accepted_proposal_id, accepted_at) values (:'ORG', :'A_id', :'P_id', 'AMC unverified', 'annual', 'pending_client', :'SP_id', now()) returning id \gset PL3_
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, total_minor, subtotal_minor, tax_minor, kind, issued_at, paid_minor, paid_at) values (:'ORG', :'A_id', :'P_id', 'P8B-INV-3', 'paid', 7000, 7000, 0, 'service', now(), 7000, now()) returning id \gset INV3_
set local session_replication_role = origin;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select finance.link_maintenance_invoice(:'PL3_id', :'INV3_id', 'activation', '2026-11-01', '2027-11-01');
select pg_temp.check((select state from finance.maintenance_financial_gate(:'PL3_id')) = 'awaiting_payment_verification', 'a status of paid with no VERIFIED payment is not the gate (a screenshot is not verification)');
reset role;
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_plans set status = 'active' where id = %L$$, :'PL3_id'), 'verified money'), 'such a plan does not activate');
-- unbilled plans are untouched
set local session_replication_role = replica;
update projects.maintenance_plans set accepted_proposal_id = :'SP_id', accepted_at = now() where id = :'PLU_id';
set local session_replication_role = origin;
update projects.maintenance_plans set status = 'active' where id = :'PLU_id';
select pg_temp.check((select status from projects.maintenance_plans where id = :'PLU_id') = 'active', 'a plan never linked to an invoice is outside the new rule');

-- ═════════ tenancy ═════════
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.maintenance_work_items) = 0 and (select count(*) from finance.maintenance_billing_proposals) = 0, 'another organization sees none of it');
select pg_temp.check((select outcome from projects.decide_maintenance_release(:'W2_id','approve')) = 'not_found', 'another organization cannot decide it');
reset role;
\echo verify-phase-eight-b: OK
rollback;
