-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 Finance doors (migration 20261126200000): commercial baseline, billing clarification, payment instruction snapshot, persisted match result and
-- recommendation (which never verifies), receipt document and delivery, reminder stages, the M2 overview, the consumer-side Phase-4 guard. Red-proofs mutate live definitions.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p4q-finance.sql
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;
\ir p4q-verify-prelude.sql

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORG2 '00000000-0000-4000-8000-0000000000b6'
\set OWNER '00000000-0000-4000-8000-00000000f631'
\set OWNER2 '00000000-0000-4000-8000-00000000f632'
\set MEMBER '00000000-0000-4000-8000-00000000f633'

insert into auth.users (id, email) values (:'OWNER', 'p4qf-owner@example.test'), (:'OWNER2', 'p4qf-owner2@example.test'), (:'MEMBER', 'p4qf-member@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'p4qf-owner@example.test', 'F Owner'), (:'OWNER2', 'p4qf-owner2@example.test', 'F Owner Two'), (:'MEMBER', 'p4qf-member@example.test', 'F Member') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner'), (:'ORG', :'MEMBER', 'member') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'ORG2', 'zztest p4qf other org', 'zztest-p4qf-other') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG2', :'OWNER2', 'owner') on conflict do nothing;
update core.organizations set invoice_reminders_enabled = true, invoice_reminder_interval_days = 3, invoice_reminder_upcoming_days = 3, invoice_reminder_escalation_days = 14 where id = :'ORG';

insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p4qf client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code, budget_minor) values (:'ORG', :'A_id', 'zztest p4qf', 'ZP4QF-1', 1000000) returning id \gset P_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p4qf nobudget', 'ZP4QF-2') returning id \gset PNB_
set local session_replication_role = replica;
insert into projects.phase_three_handoffs (organization_id, project_id, phase_three_id, screen_baseline_id, theme_option_id, color_option_id, client_decision_id, payload, phase_four_ready, readiness_note)
  values (:'ORG', :'P_id', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '{}', false, 'fixture') returning id \gset H_
insert into projects.phase_four (organization_id, project_id, phase_three_handoff_id, state) values (:'ORG', :'P_id', :'H_id', 'prototype_build') returning id \gset F_
insert into projects.milestones (organization_id, project_id, name, position, payment_percent, amount_minor, currency) values (:'ORG', :'P_id', 'M1 kickoff', 1, 40, 400000, 'INR') returning id \gset M1_
insert into projects.milestones (organization_id, project_id, name, position, payment_percent, amount_minor, currency) values (:'ORG', :'P_id', 'M2 prototype', 2, 20, 200000, 'INR') returning id \gset M2_
insert into finance.payment_accounts (organization_id, kind, label, instructions) values (:'ORG', 'bank', 'Main bank', '{"accountNumber":"123456789012","ifsc":"HDFC0001234"}') returning id \gset ACC1_
insert into finance.payment_accounts (organization_id, kind, label, instructions) values (:'ORG', 'upi', 'Other upi', '{"vpa":"x@bank"}') returning id \gset ACC2_
set local session_replication_role = origin;
insert into fx values ('P', :'P_id'), ('PNB', :'PNB_id'), ('ORG', :'ORG'), ('OWNER', :'OWNER'), ('MEMBER', :'MEMBER'), ('M2', :'M2_id'), ('F', :'F_id');

-- ═══ commercial baseline ═══════════════════════════════════════════════════
select pg_temp.as_service();
select outcome as b0 from finance.p4q_bind_commercial_baseline(:'P_id') \gset
select pg_temp.check(:'b0' = 'clarification_opened' and (select count(*) from finance.finance_exceptions where project_id = :'P_id' and evidence ->> 'p4q' = 'billing_clarification' and state = 'open') = 1, 'no active scope: a clarification is opened, no baseline is guessed');
select pg_temp.check((select outcome from finance.p4q_bind_commercial_baseline(:'P_id')) = 'clarification_opened' and (select count(*) from finance.finance_exceptions where project_id = :'P_id' and evidence ->> 'p4q' = 'billing_clarification') = 1, 'asking twice opens one clarification');
select outcome as b0b from finance.p4q_bind_commercial_baseline(:'PNB_id') \gset
select pg_temp.check(:'b0b' = 'clarification_opened', 'no budget: a clarification, not a zero-amount invoice');
insert into projects.scope_versions (organization_id, project_id, version, status, frozen_at, source) values (:'ORG', :'P_id', 1, 'active', now(), 'onboarding') returning id \gset SV_
select outcome as b1 from finance.p4q_bind_commercial_baseline(:'P_id') \gset
select pg_temp.check(:'b1' = 'bound' and (select count(*) from projects.milestones where project_id = :'P_id' and commercial_baseline_ref ->> 'scopeVersionId' = :'SV_id') = 2, 'with a scope and a budget both milestones keep the baseline they were priced against');
select pg_temp.check((select outcome from finance.p4q_bind_commercial_baseline(:'P_id')) = 'already_bound', 'binding again changes nothing');
select pg_temp.as_nobody();
select pg_temp.check((select outcome from finance.p4q_bind_commercial_baseline(:'P_id')) = 'no_actor', 'no caller, no binding');

-- ═══ the consumer-side Phase-4 guard ═══════════════════════════════════════
create or replace function pg_temp.mk_invoice(p_milestone uuid, p_number text, p_status text default 'draft', p_total bigint default 200000, p_due interval default interval '10 days') returns text language plpgsql as $$
begin
  insert into finance.invoices (organization_id, client_account_id, project_id, milestone_id, number, kind, status, currency, subtotal_minor, tax_minor, total_minor, issued_at, due_at)
  values (pg_temp.fx('ORG'), (select client_account_id from projects.projects where id = pg_temp.fx('P')), pg_temp.fx('P'), p_milestone, p_number, 'milestone', p_status, 'INR', p_total, 0, p_total,
          case when p_status = 'draft' then null else now() end, now() + p_due);
  return 'created';
exception when restrict_violation then return 'refused: ' || sqlerrm;
end $$;
grant execute on function pg_temp.mk_invoice(uuid, text, text, bigint, interval) to public;
select pg_temp.check(pg_temp.mk_invoice(:'M2_id', 'ZP4QF-M2-A') like 'refused: the M2 invoice is created only after Phase 4 is complete%', 'an M2 invoice cannot be created while Phase 4 is not complete');
select pg_temp.check(pg_temp.mk_invoice(:'M1_id', 'ZP4QF-M1-A') = 'created', 'an M1 invoice is not affected');
update projects.phase_four set state = 'completed', completed_at = now() where id = :'F_id';
select pg_temp.check(pg_temp.mk_invoice(:'M2_id', 'ZP4QF-M2-B') = 'created', 'once Phase 4 is complete the M2 invoice can be created');
select i.id as inv2, i.commercial_baseline_ref ->> 'scopeVersionId' as inv2_sv from finance.invoices i where i.number = 'ZP4QF-M2-B' \gset
select pg_temp.check(:'inv2_sv' = :'SV_id', 'the invoice carries its milestone''s baseline from creation');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check(finance.p4q_invoice_baseline_status(:'inv2') = 'bound', 'the invoice baseline reads bound');
select pg_temp.as_service();
update projects.scope_versions set status = 'superseded' where id = :'SV_id';
select pg_temp.check(finance.p4q_invoice_baseline_status(:'inv2') = 'stale', 'when the scope it was priced on is superseded the invoice reads stale');

-- ═══ payment instruction snapshot ══════════════════════════════════════════
update finance.invoices set status = 'issued', issued_at = now() where id = :'inv2';
select pg_temp.check((select jsonb_array_length(accounts) from finance.p4q_payment_instruction_snapshots where invoice_id = :'inv2') >= 2, 'issuing the invoice snapshots the active receiving accounts');
select pg_temp.check((select accounts::text from finance.p4q_payment_instruction_snapshots where invoice_id = :'inv2') not like '%123456789012%' and (select accounts::text from finance.p4q_payment_instruction_snapshots where invoice_id = :'inv2') like '%9012%', 'the snapshot masks the account number');
set local session_replication_role = replica;
update finance.payment_accounts set instructions = '{"accountNumber":"999999999999"}', updated_at = now() + interval '1 minute' where id = :'ACC1_id';
set local session_replication_role = origin;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select changed_since_issue from finance.p4q_invoice_payment_snapshot(:'inv2') where account_id = :'ACC1_id') is true and (select accounts::text from finance.p4q_payment_instruction_snapshots where invoice_id = :'inv2') like '%9012%', 'a later account change shows as drift and does not rewrite the snapshot');
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
select pg_temp.check((select count(*) from finance.p4q_invoice_payment_snapshot(:'inv2')) = 0, 'another organisation reads no snapshot');

-- ═══ match results: advice, never verification ═════════════════════════════
select pg_temp.as_service();
create or replace function pg_temp.mk_sub(p_inv uuid, p_amount bigint, p_ref text, p_account uuid, p_cur text default 'INR', p_status text default 'pending_verification') returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into finance.payment_submissions (organization_id, invoice_id, account_id, amount_minor, currency, method, reference, paid_at, status, submitted_by)
  values (pg_temp.fx('ORG'), p_inv, p_account, p_amount, p_cur, 'bank_transfer', p_ref, now(), p_status, pg_temp.fx('OWNER')) returning id into v;
  return v;
end $$;
grant execute on function pg_temp.mk_sub(uuid, bigint, text, uuid, text, text) to public;
select pg_temp.mk_sub(:'inv2', 200000, 'UTR-1001', :'ACC1_id') as s_exact \gset
select pg_temp.mk_sub(:'inv2', 150000, 'UTR-1002', :'ACC1_id') as s_under \gset
select pg_temp.mk_sub(:'inv2', 250000, 'UTR-1003', :'ACC1_id') as s_over \gset
select pg_temp.mk_sub(:'inv2', 200000, 'utr-1001', :'ACC1_id', 'INR', 'duplicate') as s_dup \gset
select pg_temp.mk_sub(:'inv2', 200000, 'UTR-1005', null) as s_acct \gset
select pg_temp.mk_sub(:'inv2', 200000, 'UTR-1006', :'ACC1_id', 'USD') as s_cur \gset
select pg_temp.mk_sub(:'inv2', 200000, null, :'ACC1_id') as s_noref \gset
insert into fx values ('S_EXACT', :'s_exact'), ('S_OVER', :'s_over');
select match_class as c1, recommendation as r1 from finance.p4q_match_payment_submission(:'s_exact') \gset
select pg_temp.check(:'c1' = 'exact' and :'r1' = 'MATCH', 'amount, currency, account and reference consistent: MATCH');
select match_class as c2, recommendation as r2 from finance.p4q_match_payment_submission(:'s_under') \gset
select pg_temp.check(:'c2' = 'under' and :'r2' = 'REVIEW', 'less than outstanding: REVIEW');
select match_class as c3, recommendation as r3 from finance.p4q_match_payment_submission(:'s_over') \gset
select pg_temp.check(:'c3' = 'over' and :'r3' = 'EXCEPTION', 'more than outstanding: EXCEPTION');
select match_class as c4, recommendation as r4 from finance.p4q_match_payment_submission(:'s_dup') \gset
select pg_temp.check(:'c4' = 'duplicate' and :'r4' = 'REJECT', 'a submission of a reference already submitted (any case): REJECT');
select match_class as c5, recommendation as r5 from finance.p4q_match_payment_submission(:'s_acct') \gset
select pg_temp.check(:'c5' = 'wrong_account' and :'r5' = 'EXCEPTION', 'money to an account that was not on the invoice: EXCEPTION');
select match_class as c6, recommendation as r6 from finance.p4q_match_payment_submission(:'s_cur') \gset
select pg_temp.check(:'c6' = 'currency_mismatch' and :'r6' = 'REJECT', 'a different currency: REJECT');
select match_class as c7, recommendation as r7 from finance.p4q_match_payment_submission(:'s_noref') \gset
select pg_temp.check(:'c7' = 'unmatched' and :'r7' = 'REVIEW', 'no reference to match against the bank: REVIEW');
select pg_temp.check((select outcome from finance.p4q_match_payment_submission(:'s_exact')) = 'unchanged' and (select count(*) from finance.p4q_payment_match_results where submission_id = :'s_exact') = 1, 'the same inputs give the same stored result');
select pg_temp.check((select status from finance.payment_submissions where id = :'s_exact') = 'pending_verification' and (select paid_minor from finance.invoices where id = :'inv2') = 0, 'a MATCH recommendation verifies nothing and marks nothing paid');
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
select pg_temp.check((select outcome from finance.p4q_match_payment_submission(:'s_exact')) = 'forbidden', 'another organisation cannot match this submission');

-- ═══ receipt document and delivery ═════════════════════════════════════════
select pg_temp.as_service();
insert into finance.payments (organization_id, invoice_id, provider, provider_payment_id, amount_minor, currency, status) values (:'ORG', :'inv2', 'manual', 'p4q-pay-1', 200000, 'INR', 'captured') returning id \gset PAY_
update finance.payment_submissions set payment_id = :'PAY_id' where id = :'s_exact';
insert into finance.receipts (organization_id, invoice_id, payment_id, number, amount_minor, currency) values (:'ORG', :'inv2', :'PAY_id', 'RCP-P4QF-1', 200000, 'INR') returning id \gset RC_
insert into fx values ('RC', :'RC_id');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check(finance.p4q_receipt_document(:'RC_id') ->> 'milestone' = 'M2 prototype' and finance.p4q_receipt_document(:'RC_id') ->> 'transactionReference' = 'UTR-1001'
  and finance.p4q_receipt_document(:'RC_id') ->> 'client' = 'zztest p4qf client' and finance.p4q_receipt_document(:'RC_id') #>> '{receivingAccount,label}' = 'Main bank', 'the receipt names the milestone, client, method reference and the receiving account');
select pg_temp.check(finance.p4q_receipt_document(:'RC_id')::text not like '%123456789012%' and finance.p4q_receipt_document(:'RC_id')::text not like '%999999999999%', 'the receipt never carries a full account number');
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
select pg_temp.check(finance.p4q_receipt_document(:'RC_id') is null, 'another organisation reads no receipt');
select pg_temp.as_service();
select pg_temp.check((select outcome from finance.p4q_record_receipt_delivery(:'RC_id', 'whatsapp', 'sent')) = 'evidence_required', 'a receipt is not recorded as sent without evidence');
select pg_temp.check((select outcome from finance.p4q_record_receipt_delivery(:'RC_id', 'whatsapp', 'failed', 'provider 503')) = 'recorded', 'a failed send is recorded');
select pg_temp.check((select outcome from finance.p4q_record_receipt_delivery(:'RC_id', 'whatsapp', 'pending')) = 'recorded' and (select outcome from finance.p4q_record_receipt_delivery(:'RC_id', 'whatsapp', 'sent', 'wamid.77')) = 'recorded', 'the receipt delivery retries on its own');
select pg_temp.check((select attempts from finance.p4q_receipt_deliveries where receipt_id = :'RC_id' and channel = 'whatsapp') = 2, 'the attempts are counted');
select pg_temp.check((select outcome from finance.p4q_record_receipt_delivery(:'RC_id', 'whatsapp', 'pending')) = 'bad_transition', 'a sent receipt does not go back to pending');

-- ═══ reminders with stages ═════════════════════════════════════════════════
select pg_temp.mk_invoice(null::uuid, 'ZP4QF-R-UP', 'issued', 100000, interval '2 days') as _ \gset
select pg_temp.mk_invoice(null::uuid, 'ZP4QF-R-LATE', 'issued', 100000, interval '-5 days') as _ \gset
select pg_temp.mk_invoice(null::uuid, 'ZP4QF-R-ESC', 'issued', 100000, interval '-20 days') as _ \gset
select pg_temp.mk_invoice(null::uuid, 'ZP4QF-R-FAR', 'issued', 100000, interval '30 days') as _ \gset
select id as i_up from finance.invoices where number = 'ZP4QF-R-UP' \gset
select id as i_late from finance.invoices where number = 'ZP4QF-R-LATE' \gset
select id as i_esc from finance.invoices where number = 'ZP4QF-R-ESC' \gset
select id as i_far from finance.invoices where number = 'ZP4QF-R-FAR' \gset
insert into fx values ('I_UP', :'i_up');
select pg_temp.check(finance.p4q_invoice_reminder_stage(:'i_up') = 'upcoming' and finance.p4q_invoice_reminder_stage(:'i_late') = 'overdue' and finance.p4q_invoice_reminder_stage(:'i_esc') = 'escalation' and finance.p4q_invoice_reminder_stage(:'i_far') is null,
  'the stage follows the due date: upcoming, overdue, escalation, nothing yet');
update finance.invoices set due_at = date_trunc('day', now()) + interval '12 hours' where id = :'i_far';
select pg_temp.check(finance.p4q_invoice_reminder_stage(:'i_far') = 'due_today' or finance.p4q_invoice_reminder_stage(:'i_far') = 'upcoming', 'an invoice due today is due_today (or upcoming for a due time still ahead the same day)');
select count(*) as sched from finance.p4q_schedule_reminders(500) where scheduled \gset
select pg_temp.check(:'sched' >= 4, 'the scheduler creates a reminder row per invoice and stage');
select pg_temp.check((select count(*) from finance.p4q_schedule_reminders(500) where scheduled) = 0, 'scheduling again creates none');
select pg_temp.check((select count(*) from finance.finance_exceptions where invoice_id = :'i_esc' and kind = 'overdue' and state = 'open') = 1, 'the escalation stage opens an overdue finance exception for a person');
select id as rem_up from finance.p4q_reminders where invoice_id = :'i_up' \gset
select pg_temp.check((select outcome from finance.p4q_mark_reminder(:'rem_up', 'failed')) = 'note_required', 'a failed reminder says why');
select pg_temp.check((select outcome from finance.p4q_mark_reminder(:'rem_up', 'failed', 'whatsapp window closed')) = 'updated' and (select outcome from finance.p4q_mark_reminder(:'rem_up', 'sent', 'sent by email instead')) = 'updated', 'a failed reminder is retried and sent');
select pg_temp.check((select attempts from finance.p4q_reminders where id = :'rem_up') = 2, 'the retried reminder counts its attempts');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from finance.p4q_mark_reminder(:'rem_up', 'scheduled')) = 'not_authorized', 'only the system marks a reminder');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select count(*) from finance.p4q_reminder_overview(:'P_id') where state = 'sent') = 1 and (select count(*) from finance.p4q_reminder_overview(:'P_id') where state = 'scheduled') >= 3, 'the Admin sees scheduled and sent reminders');

-- ═══ the M2 overview ═══════════════════════════════════════════════════════
select pg_temp.check((select payment_percent from finance.p4q_m2_overview(:'P_id')) = 20 and (select trigger_state from finance.p4q_m2_overview(:'P_id')) = 'phase_four_complete'
  and (select gate from finance.p4q_m2_overview(:'P_id')) = 'invoice_issued' and (select balance_minor from finance.p4q_m2_overview(:'P_id')) = 200000, 'the M2 line shows percent, trigger, gate and balance');
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
select pg_temp.check((select count(*) from finance.p4q_m2_overview(:'P_id')) = 0, 'another organisation reads no M2 line');

-- ═══ no direct writes ══════════════════════════════════════════════════════
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.direct('update finance.p4q_payment_match_results set recommendation = ''MATCH''') = 'refused', 'a recommendation cannot be edited');
select pg_temp.check(pg_temp.direct('delete from finance.p4q_payment_instruction_snapshots') = 'refused', 'a snapshot cannot be deleted');
select pg_temp.check(pg_temp.direct('update finance.p4q_reminders set state = ''sent''') = 'refused', 'a reminder cannot be marked sent by a direct statement');
select pg_temp.check((select count(*) from finance.p4q_payment_match_results) >= 7, 'staff read the match results');
reset role;
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from finance.p4q_payment_match_results) = 0 and (select count(*) from finance.p4q_receipt_deliveries) = 0, 'another organisation reads none of them');
reset role;
select pg_temp.as_nobody();

-- ═══ RED-PROOFS ════════════════════════════════════════════════════════════
select pg_temp.red('an M2 invoice is created before Phase 4 completes', 'finance.p4q_m2_needs_phase_four_complete()', 'if v_state is not null and v_state <> ''completed'' then', 'if false then',
  $p$ select (select state from projects.phase_four where id = pg_temp.fx('F')) is not null and (with u as (update projects.phase_four set state = 'prototype_build', completed_at = null where id = pg_temp.fx('F') returning 1) select count(*) from u) = 1
        and pg_temp.mk_invoice(pg_temp.fx('M2'), 'ZP4QF-RED-1') like 'refused:%' $p$);
select pg_temp.red('a duplicate reference is not seen', 'finance.p4q_match_payment_submission(uuid)', 'elsif v_dup then', 'elsif false then',
  $p$ select (pg_temp.as_service() is not null) and (select match_class from finance.p4q_match_payment_submission((select id from finance.payment_submissions where reference = 'utr-1001'))) = 'duplicate' $p$);
select pg_temp.red('an overpayment is recommended as a match', 'finance.p4q_match_payment_submission(uuid)', 'elsif v_s.amount_minor > v_out then', 'elsif false then',
  $p$ select (pg_temp.as_service() is not null) and (select recommendation from finance.p4q_match_payment_submission(pg_temp.fx('S_OVER'))) = 'EXCEPTION' $p$);
create or replace function pg_temp.match_leaves_pending() returns boolean language plpgsql as $$
declare v uuid; st text;
begin
  perform pg_temp.as_service();
  v := pg_temp.mk_sub(pg_temp.fx('INV2'), 200000, 'UTR-RED', pg_temp.fx('ACC1'));
  perform * from finance.p4q_match_payment_submission(v);
  select status into st from finance.payment_submissions where id = v;
  return st = 'pending_verification';
end $$;
grant execute on function pg_temp.match_leaves_pending() to public;
insert into fx values ('INV2', :'inv2'), ('ACC1', :'ACC1_id');
select pg_temp.check(pg_temp.match_leaves_pending(), 'matching a fresh submission leaves it pending verification');
select pg_temp.red('the matcher can mark a submission verified', 'finance.p4q_match_payment_submission(uuid)', 'perform core.emit_event(v_s.organization_id, ''payment.p4q_match_prepared''',
  'update finance.payment_submissions set status = ''partially_verified'' where id = v_s.id; perform core.emit_event(v_s.organization_id, ''payment.p4q_match_prepared''',
  $p$ select pg_temp.match_leaves_pending() $p$);
select pg_temp.red('the snapshot is not taken at issue', 'finance.p4q_snapshot_instructions_at_issue()', 'if new.status = ''issued'' and old.status is distinct from ''issued'' then', 'if false then',
  $p$ select (with i as (insert into finance.invoices (organization_id, client_account_id, project_id, number, kind, status, currency, subtotal_minor, tax_minor, total_minor) values (pg_temp.fx('ORG'), (select client_account_id from projects.projects where id = pg_temp.fx('P')), pg_temp.fx('P'), 'ZP4QF-RED-2', 'service', 'draft', 'INR', 1, 0, 1) returning id)
        select count(*) from i) = 1
        and (with u as (update finance.invoices set status = 'issued', issued_at = now() where number = 'ZP4QF-RED-2' returning id) select count(*) from u) = 1
        and exists (select 1 from finance.p4q_payment_instruction_snapshots sn join finance.invoices x on x.id = sn.invoice_id where x.number = 'ZP4QF-RED-2') $p$);
select pg_temp.red('a receipt delivery is recorded sent without evidence', 'finance.p4q_record_receipt_delivery(uuid,text,text,text)', 'if p_state in (''sent'', ''delivered'', ''failed'', ''unknown'') and v_ev is null then', 'if false then',
  $p$ select (pg_temp.as_service() is not null) and (select outcome from finance.p4q_record_receipt_delivery(pg_temp.fx('RC'), 'email', 'sent')) = 'evidence_required' $p$);
select pg_temp.red('no clarification when the baseline is unknown', 'finance.p4q_bind_commercial_baseline(uuid)', 'if v_sv.id is null or v_p.budget_minor is null or v_p.budget_minor <= 0 then', 'if false then',
  $p$ select (pg_temp.as_service() is not null) and (select outcome from finance.p4q_bind_commercial_baseline(pg_temp.fx('PNB'))) = 'clarification_opened' $p$);

rollback;
\echo ALL P4Q FINANCE CHECKS PASSED
