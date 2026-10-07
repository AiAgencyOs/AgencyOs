-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 Quotation Master: policy version, tax from configuration, acceptance as evidence, cancellation, negotiation reads, and the escalated-approval defect
-- (migration 20261127200000).
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p1o-quotation.sql     Rolls back. Any failed check raises.
-- Every quotation here travels the REAL path (submit_proposal, decide_approval, sync_proposal_decision, send_proposal); nothing is forced into a state.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok  %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to public;
create or replace function pg_temp.as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
    'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true);
end $$;
grant execute on function pg_temp.as_user(uuid, uuid, text) to public;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '{"role":"service_role"}', true); end $$;
grant execute on function pg_temp.as_service() to public;
create or replace function pg_temp.fails_with(stmt text, code text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when others then return sqlstate = code; end $$;
grant execute on function pg_temp.fails_with(text, text) to public;
create or replace function pg_temp.mutate(fn regprocedure, from_text text, to_text text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(fn); n text;
begin
  n := replace(d, from_text, to_text);
  if n = d then raise exception 'RED-PROOF MUTATION CHANGED NOTHING: % / %', fn, from_text; end if;
  execute n;
end $$;
grant execute on function pg_temp.mutate(regprocedure, text, text) to public;

\set QORG '00000000-0000-4000-8000-0000000a0300'
\set QOWN '00000000-0000-4000-8000-0000000a0301'
\set QMEM '00000000-0000-4000-8000-0000000a0302'
\set QOTH '00000000-0000-4000-8000-0000000a0310'
\set QOTHU '00000000-0000-4000-8000-0000000a0311'

insert into auth.users (id, email) values (:'QOWN', 'p1o-q-owner@example.test'), (:'QMEM', 'p1o-q-member@example.test'), (:'QOTHU', 'p1o-q-other@example.test');
insert into core.users (id, email, full_name) values (:'QOWN', 'p1o-q-owner@example.test', 'Q Owner'), (:'QMEM', 'p1o-q-member@example.test', 'Q Member'), (:'QOTHU', 'p1o-q-other@example.test', 'Q Other') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'QORG', 'zztest p1o quote', 'zztest-p1o-quote'), (:'QOTH', 'zztest p1o quote other', 'zztest-p1o-quote-other');
insert into core.memberships (organization_id, user_id, role) values (:'QORG', :'QOWN', 'owner'), (:'QORG', :'QMEM', 'member'), (:'QOTH', :'QOTHU', 'owner');
insert into approvals.approval_policies (organization_id, subject_type, min_amount_minor, required_role, sla_hours) values (:'QORG', 'proposal', 0, 'owner', 24);
insert into crm.contacts (organization_id, full_name, email) values (:'QORG', 'zztest p1o client', 'p1o-q-client@example.test') returning id as contact \gset
insert into core.client_accounts (organization_id, name) values (:'QORG', 'zztest p1o q client') returning id as acct \gset

-- a quotation, drafted with one line and the arithmetic the constraints demand
create or replace function pg_temp.draft(p_org uuid, p_opp uuid, p_title text, p_subtotal bigint, p_discount bigint default 0, p_slot int default null) returns uuid language plpgsql as $$
declare v_id uuid; v_ver int;
begin
  select coalesce(max(version), 0) + 1 into v_ver from sales.proposals where opportunity_id = p_opp;
  insert into sales.proposals (organization_id, opportunity_id, version, title, subtotal_minor, discount_minor, total_minor, plan_slot)
    values (p_org, p_opp, v_ver, p_title, p_subtotal, p_discount, p_subtotal - p_discount, p_slot) returning id into v_id;
  insert into sales.proposal_items (organization_id, proposal_id, position, description, quantity, unit_price_minor, amount_minor)
    values (p_org, v_id, 0, 'build ' || p_title, 1, p_subtotal, p_subtotal);
  return v_id;
end $$;
grant execute on function pg_temp.draft(uuid, uuid, text, bigint, bigint, int) to public;
-- the real path from draft to sent
create or replace function pg_temp.sendq(p_prop uuid, p_owner uuid, p_org uuid) returns void language plpgsql as $$
declare r record; v_req uuid; o text;
begin
  perform pg_temp.as_user(p_owner, p_org, 'owner');
  select * into r from sales.submit_proposal(p_prop, p_owner);
  if r.outcome <> 'submitted' then raise exception 'submit gave %', r.outcome; end if;
  select * into r from approvals.decide_approval(r.request_id, 'approved', 'ok');
  if r.outcome <> 'approved' and r.outcome <> 'decided' then raise notice 'decide gave %', r.outcome; end if;
  o := sales.sync_proposal_decision(p_prop);
  select * into r from sales.send_proposal(p_prop, null, 'wa:p1o');
  if r.outcome <> 'sent' then raise exception 'send gave % (after sync %)', r.outcome, o; end if;
end $$;
grant execute on function pg_temp.sendq(uuid, uuid, uuid) to public;

insert into sales.opportunities (organization_id, client_account_id, name) values (:'QORG', :'acct', 'zztest p1o deal one') returning id as opp1 \gset
insert into sales.opportunities (organization_id, client_account_id, name) values (:'QORG', :'acct', 'zztest p1o deal two') returning id as opp2 \gset
insert into sales.opportunities (organization_id, client_account_id, name) values (:'QORG', :'acct', 'zztest p1o deal three') returning id as opp3 \gset
insert into sales.opportunities (organization_id, client_account_id, name) values (:'QORG', :'acct', 'zztest p1o deal four') returning id as opp4 \gset
insert into sales.opportunities (organization_id, client_account_id, name) values (:'QORG', :'acct', 'zztest p1o deal five') returning id as opp5 \gset
insert into sales.opportunities (organization_id, client_account_id, name) values (:'QORG', :'acct', 'zztest p1o deal six') returning id as opp6 \gset

-- ═══ 1. an escalated approval moves the quote (the defect, reproduced against the old body in the red-proof below) ═══
select pg_temp.draft(:'QORG', :'opp1', 'expiry quote', 500000) as p_exp \gset
select pg_temp.as_user(:'QOWN', :'QORG', 'owner');
select request_id as r1 from sales.submit_proposal(:'p_exp', :'QOWN') \gset
select pg_temp.check((select status from sales.proposals where id = :'p_exp') = 'pending_approval', 'the quote is in review');
update approvals.approval_requests set sla_due_at = now() - interval '1 minute' where id = :'r1';
select pg_temp.as_service();
select escalation_id as r2 from approvals.expire_overdue(50) where expired_id = :'r1' \gset
select pg_temp.check(:'r2' is not null, 'the unanswered request expired and raised an escalation');
select pg_temp.as_user(:'QOWN', :'QORG', 'owner');
select outcome as dec from approvals.decide_approval(:'r2', 'approved', 'approved late') \gset
select pg_temp.check(:'dec' = 'decided', 'the owner approves the ESCALATED request');
select sales.sync_proposal_decision(:'p_exp') as sync1 \gset
select pg_temp.check(:'sync1' = 'approved' and (select status from sales.proposals where id = :'p_exp') = 'approved', 'the quote becomes approved (before this change it stayed in review for ever)');
select pg_temp.check((select approval_request_id from sales.proposals where id = :'p_exp') = :'r2', 'and now points at the request that was actually decided');

-- ═══ 2. the policy a quote was judged under ═══
select pg_temp.check((select policy_version like 'pv-%' and jsonb_array_length(policy_snapshot->'approvalPolicies') = 1 from sales.proposals where id = :'p_exp'), 'entering review stamped a policy version and the approver ladder that was in force');
select policy_version as pv1 from sales.proposals where id = :'p_exp' \gset
select pg_temp.check(pg_temp.fails_with(format($f$update sales.proposals set policy_version = 'pv-forged' where id = %L$f$, :'p_exp'), '23001'), 'the stamped policy version cannot be rewritten');
select pg_temp.check(pg_temp.fails_with(format($f$update sales.proposals set policy_snapshot = '{}' where id = %L$f$, :'p_exp'), '23001'), 'nor can the snapshot');

select outcome as lim from sales.p1o_set_negotiation_limits(:'QORG', 100, 50) \gset
select pg_temp.check(:'lim' = 'set', 'an administrator sets a maximum discount amount and a minimum advance');
select pg_temp.draft(:'QORG', :'opp2', 'discount quote', 400000, 5000) as p_disc \gset
select pg_temp.check(jsonb_array_length(sales.p1o_check_negotiation_limits(:'p_disc')) = 2, 'the check names both breaches (discount above the cap; the corpus advance of 40 is below 50)');
select request_id as rd from sales.submit_proposal(:'p_disc', :'QOWN') \gset
select pg_temp.check((select jsonb_array_length(policy_snapshot->'breaches') = 2 and policy_version <> :'pv1' from sales.proposals where id = :'p_disc'), 'the breaches are recorded in the snapshot for the approver, and the new limits make a different policy version');
select pg_temp.check((select status from sales.proposals where id = :'p_disc') = 'pending_approval', 'a breach is recorded, not refused: the owner is the approver');
select pg_temp.as_user(:'QMEM', :'QORG', 'member');
select pg_temp.check((select outcome from sales.p1o_set_negotiation_limits(:'QORG', 1, 1)) = 'forbidden', 'a plain member cannot change the limits');
select pg_temp.as_user(:'QOWN', :'QORG', 'owner');

-- ═══ 3. tax from configuration; an uncertain treatment is flagged and blocks review ═══
select pg_temp.draft(:'QORG', :'opp3', 'tax quote', 1000000, 100000) as p_tax \gset
select outcome as t1 from sales.p1o_apply_quote_tax(:'p_tax') \gset
select pg_temp.check(:'t1' = 'tax_uncertain' and (select count(*) from sales.p1o_quote_flags where proposal_id = :'p_tax' and state = 'open') = 1, 'no tax configuration: the system does not guess, it flags');
select pg_temp.check(pg_temp.fails_with(format($f$select * from sales.submit_proposal(%L, %L)$f$, :'p_tax', :'QOWN'), '23001'), 'a quote with an open tax flag cannot be submitted for approval');
select pg_temp.check((select status from sales.proposals where id = :'p_tax') = 'draft' and not exists (select 1 from approvals.approval_requests where subject_id = :'p_tax'), 'and nothing moved: it is still a draft with no approval request');
select pg_temp.check((select outcome from sales.p1o_set_quote_tax_config(:'QORG', 'gst', 1800)) = 'set', 'an administrator configures GST at 18 percent');
select outcome as t2 from sales.p1o_apply_quote_tax(:'p_tax') \gset
select pg_temp.check(:'t2' = 'tax_uncertain', 'GST configured but no GSTIN on record is still uncertain');
update core.organizations set gstin = '27ABCDE1234F1Z5' where id = :'QORG';
select outcome as rf from sales.p1o_resolve_quote_flag((select id from sales.p1o_quote_flags where proposal_id = :'p_tax' and state = 'open'), 'GSTIN added to the organisation') \gset
select pg_temp.check(:'rf' = 'resolved', 'an administrator resolves the flag');
select outcome as t3, tax_minor as tm, total_minor as tt from sales.p1o_apply_quote_tax(:'p_tax') \gset
select pg_temp.check(:'t3' = 'applied' and :'tm' = '162000' and :'tt' = '1062000', 'tax is 18 percent of the discounted subtotal and the total follows');
select pg_temp.check((select tax_basis->>'rateBp' = '1800' and tax_minor = 162000 from sales.proposals where id = :'p_tax'), 'the basis is kept on the quote');
select pg_temp.check((select outcome from sales.p1o_set_quote_tax_config(:'QORG', 'gst', 0)) = 'refused' and (select outcome from sales.p1o_set_quote_tax_config(:'QORG', 'non_gst', 1800)) = 'refused', 'a GST mode without a rate, or a non-GST mode with one, is refused');
select request_id as rt from sales.submit_proposal(:'p_tax', :'QOWN') \gset
select pg_temp.check((select policy_snapshot->'tax'->>'mode' = 'gst' from sales.proposals where id = :'p_tax'), 'the tax set-up in force is in the policy snapshot');
select pg_temp.check((select outcome from sales.p1o_apply_quote_tax(:'p_tax')) = 'not_draft', 'tax is not recomputed once the quote is in review');

-- ═══ 4. readiness names what is missing ═══
select pg_temp.check((select ok from sales.p1o_quote_readiness(:'opp1') where check_name = 'tax_configuration') and (select ok from sales.p1o_quote_readiness(:'opp1') where check_name = 'approval_policy'), 'configured tax and an approval policy are ready');
select pg_temp.check(not (select ok from sales.p1o_quote_readiness(:'opp1') where check_name = 'accepted_requirements'), 'no accepted requirement version: the quote is not ready, and says so');
select pg_temp.check((select ok from sales.p1o_quote_readiness(:'opp1') where check_name = 'payment_structure') = (exists (select 1 from sales.payment_structures where organization_id = :'QORG' and active)), 'the payment-structure check reports what the table holds');
select pg_temp.as_user(:'QOTHU', :'QOTH', 'owner');
select pg_temp.check((select count(*) from sales.p1o_quote_readiness(:'opp1')) = 0, 'another organisation reads nothing');
select pg_temp.as_user(:'QOWN', :'QORG', 'owner');

-- ═══ 5. acceptance is evidence, tied to one exact version ═══
-- two live versions on one deal (plan slots 1 and 2), both genuinely sent
select pg_temp.draft(:'QORG', :'opp1', 'plan one', 300000, 0, 1) as pa \gset
select pg_temp.draft(:'QORG', :'opp1', 'plan two', 600000, 0, 2) as pb \gset
select pg_temp.sendq(:'pa', :'QOWN', :'QORG');
select pg_temp.sendq(:'pb', :'QOWN', :'QORG');
select version as va from sales.proposals where id = :'pa' \gset
select version as vb from sales.proposals where id = :'pb' \gset
select pg_temp.check((select count(*) from sales.proposals where opportunity_id = :'opp1' and status = 'sent') = 2, 'two versions of one deal are open with the client');
select pg_temp.as_user(:'QOWN', :'QORG', 'owner');
select pg_temp.check((select outcome from sales.p1o_record_acceptance(:'pa', :'contact', 'whatsapp', '')) = 'evidence_required', 'acceptance without evidence is refused');
select pg_temp.check((select outcome from sales.p1o_record_acceptance(:'pa', null, 'whatsapp', 'wa:msg-1')) = 'client_identity_required', 'acceptance without a client identity is refused');
select pg_temp.check((select outcome from sales.p1o_record_acceptance(:'pa', :'contact', 'carrier_pigeon', 'wa:msg-1')) = 'bad_channel', 'an unknown channel is refused');
select outcome as amb, clarification_id as cl from sales.p1o_record_acceptance(:'pa', :'contact', 'whatsapp', 'wa:msg-1') \gset
select pg_temp.check(:'amb' = 'needs_clarification' and :'cl' is not null, 'two open versions and no stated version: a clarification, not an acceptance');
select pg_temp.check((select status from sales.proposals where id = :'pa') = 'sent' and (select status from sales.proposals where id = :'pb') = 'sent', 'nothing was accepted');
select pg_temp.check((select count(*) from core.outbox_events where organization_id = :'QORG' and type = 'proposal.acceptance_ambiguous') = 1, 'the ambiguity is an event, so a person is asked to ask');
select pg_temp.check((select outcome from sales.p1o_record_acceptance(:'pa', :'contact', 'whatsapp', 'wa:msg-1', :vb)) = 'version_mismatch', 'a stated version that is not this one is refused');
select pg_temp.as_service();
select pg_temp.check((select outcome from sales.p1o_record_acceptance(:'pa', :'contact', 'whatsapp', 'wa:msg-1', :va)) = 'needs_a_person', 'the service role cannot record an acceptance: it is a person''s act');
select pg_temp.check((select outcome from sales.p1o_raise_acceptance_clarification(:'opp1', 'wa:msg-2')) = 'already_open', 'but an agent can raise the question, and finds it already open');
select pg_temp.check((select outcome from sales.p1o_raise_acceptance_clarification(:'opp5', 'wa:msg-3')) = 'not_ambiguous', 'with fewer than two open versions there is nothing to ask');
select pg_temp.as_user(:'QOWN', :'QORG', 'owner');
select pg_temp.as_user(:'QMEM', :'QORG', 'member');
select pg_temp.check((select outcome from sales.p1o_record_acceptance(:'pa', :'contact', 'whatsapp', 'wa:msg-1', :va)) = 'forbidden', 'a plain member cannot record an acceptance');
select pg_temp.as_user(:'QOWN', :'QORG', 'owner');
select outcome as acc from sales.p1o_record_acceptance(:'pa', :'contact', 'whatsapp', 'wa:msg-1', :va, 'wamid.123', 'yes, plan one') \gset
select pg_temp.check(:'acc' = 'recorded' and (select status from sales.proposals where id = :'pa') = 'accepted', 'with the version named, the acceptance is recorded');
select pg_temp.check((select acceptance_channel = 'whatsapp' and acceptance_evidence_ref = 'wa:msg-1' and acceptance_message_ref = 'wamid.123' and responded_by_contact_id = :'contact'::uuid from sales.proposals where id = :'pa'), 'channel, evidence, message and client identity are on the row');
select pg_temp.check((select acceptance_terms->>'totalMinor' = '300000' and acceptance_terms->>'version' = :'va' and acceptance_terms->>'policyVersion' like 'pv-%' and acceptance_terms ? 'itemsDigest' from sales.proposals where id = :'pa'), 'the accepted terms are snapshotted: version, totals, items digest and the policy version');
select pg_temp.check(pg_temp.fails_with(format($f$update sales.proposals set acceptance_evidence_ref = 'forged' where id = %L$f$, :'pa'), '23001'), 'the evidence of acceptance cannot be rewritten');
select pg_temp.check(pg_temp.fails_with(format($f$update sales.proposals set acceptance_terms = '{}' where id = %L$f$, :'pa'), '23001'), 'nor the accepted terms');
select pg_temp.check((select state from sales.p1o_acceptance_clarifications where id = :'cl') = 'resolved', 'the explicit acceptance resolves the open clarification');
select pg_temp.check(pg_temp.fails_with(format($f$update sales.proposals set acceptance_evidence_ref = 'x' where id = %L$f$, :'pb'), '23001'), 'evidence cannot be attached to a quote that was not accepted');
-- a single open version needs no statement of which
select pg_temp.draft(:'QORG', :'opp4', 'single', 200000) as ps \gset
select pg_temp.sendq(:'ps', :'QOWN', :'QORG');
select pg_temp.as_user(:'QOWN', :'QORG', 'owner');
select pg_temp.check((select outcome from sales.p1o_record_acceptance(:'ps', :'contact', 'email', 'mail:thread-9')) = 'recorded', 'one open version: no ambiguity, accepted with evidence');
-- the older staff door still works and still snapshots the terms, but it does not demand evidence
select pg_temp.draft(:'QORG', :'opp5', 'legacy', 150000) as pl \gset
select pg_temp.sendq(:'pl', :'QOWN', :'QORG');
select pg_temp.as_user(:'QOWN', :'QORG', 'owner');
select outcome as lg from sales.record_proposal_response(:'pl', 'accepted', null, null) \gset
select pg_temp.check(:'lg' = 'recorded' and (select acceptance_terms->>'totalMinor' = '150000' and acceptance_channel = 'staff_recorded' and acceptance_evidence_ref is null from sales.proposals where id = :'pl'), 'the legacy staff door still accepts, snapshots the terms and labels the channel staff_recorded, with no evidence (the gap the wiring step closes)');

-- ═══ 6. cancel ═══
select pg_temp.draft(:'QORG', :'opp2', 'to cancel draft', 100000, 0, 3) as pc1 \gset
select pg_temp.check(pg_temp.fails_with(format($f$update sales.proposals set status = 'cancelled', cancelled_at = now(), cancel_reason = 'x' where id = %L$f$, :'pc1'), '23001'), 'a direct write cannot cancel a quotation');
select pg_temp.check((select outcome from sales.p1o_cancel_proposal(:'pc1', '')) = 'missing_reason', 'a cancellation needs a reason');
select pg_temp.as_user(:'QMEM', :'QORG', 'member');
select pg_temp.check((select outcome from sales.p1o_cancel_proposal(:'pc1', 'client withdrew')) = 'forbidden', 'a plain member cannot cancel');
select pg_temp.as_user(:'QOWN', :'QORG', 'owner');
select outcome as cx from sales.p1o_cancel_proposal(:'pc1', 'client withdrew') \gset
select pg_temp.check(:'cx' = 'cancelled' and (select status from sales.proposals where id = :'pc1') = 'cancelled', 'an administrator cancels a draft');
select pg_temp.check((select outcome from sales.p1o_cancel_proposal(:'pc1', 'again')) = 'already_cancelled', 'once');
select pg_temp.check(pg_temp.fails_with(format($f$update sales.proposals set status = 'draft' where id = %L$f$, :'pc1'), '23001'), 'cancelled is terminal');
select pg_temp.check((select outcome from sales.p1o_cancel_proposal(:'pa', 'too late')) = 'not_cancellable', 'an accepted quotation cannot be cancelled');
select pg_temp.check((select count(*) from core.outbox_events where organization_id = :'QORG' and type = 'proposal.cancelled' and subject_id = :'pc1') = 1, 'cancellation is an event');
-- a quote in review: its approval is withdrawn
select outcome as cx2 from sales.p1o_cancel_proposal(:'p_disc', 'we repriced') \gset
select pg_temp.check(:'cx2' = 'cancelled', 'a quotation in review can be cancelled');
select pg_temp.check((select state from approvals.approval_requests where id = :'rd') = 'cancelled', 'and its pending approval was withdrawn with it');
select pg_temp.check(pg_temp.draft(:'QORG', :'opp2', 'after cancel', 90000, 0, 3) is not null, 'the live-version slot is free again: a new draft in plan slot 3 can be created');

-- ═══ 7. typed responses, negotiation read, change summary, timeline ═══
select pg_temp.check((select outcome from sales.p1o_record_quote_response(:'ps', 'accepted')) = 'use_the_acceptance_door', 'a classified response can never be an acceptance');
select pg_temp.check((select outcome from sales.p1o_record_quote_response(:'pb', 'made_up')) = 'bad_class', 'an unknown class is refused');
select pg_temp.check((select outcome from sales.p1o_record_quote_response(:'pb', 'payment_term_objection', 'wa:msg-5', 'wants 20 percent advance')) = 'recorded', 'a payment-term objection is recorded as such');
select pg_temp.check((select outcome from sales.p1o_record_quote_response(:'pb', 'needs_more_time')) = 'recorded', 'so is a request for more time');
insert into crm.leads (organization_id, title) values (:'QORG', 'zztest p1o neg lead') returning id as nlead \gset
update sales.opportunities set lead_id = :'nlead' where id = :'opp1';
insert into sales.objections (organization_id, lead_id, round, proposal_id, kind, concern, response, outcome) values (:'QORG', :'nlead', 1, :'pb', 'price', 'too expensive', 'offered plan one', 'resolved');
select pg_temp.check((select count(*) from sales.p1o_negotiation_rounds(:'opp1')) = 1 and (select proposal_version from sales.p1o_negotiation_rounds(:'opp1')) = :vb and (select jsonb_array_length(client_responses) from sales.p1o_negotiation_rounds(:'opp1')) = 2,
  'the negotiation read joins the round, the version it was about and the typed client responses');
select pg_temp.draft(:'QORG', :'opp5', 'legacy v2', 175000) as pv2 \gset
select pg_temp.check((select (sales.p1o_version_change_summary(:'pv2')->>'previousVersion')::int = 1 and sales.p1o_version_change_summary(:'pv2')->'changes' @> '[{"field":"total"}]' from (select 1) s), 'the change summary says what moved between version 1 and 2 (the total)');
select pg_temp.check((select count(*) from sales.p1o_quote_timeline(:'pa')) >= 3, 'the audit timeline of one quote lists its history');
select pg_temp.as_user(:'QOTHU', :'QOTH', 'owner');
select pg_temp.check((select count(*) from sales.p1o_quote_timeline(:'pa')) = 0 and sales.p1o_version_change_summary(:'pv2') is null and (select count(*) from sales.p1o_negotiation_rounds(:'opp1')) = 0, 'another organisation reads none of it');
select pg_temp.as_user(:'QOWN', :'QORG', 'owner');
select pg_temp.check((select count(*) from sales.p1o_quote_trace(:'pa')) = 0, 'a quote with no project has no downstream invoices to trace');

-- ═══ red-proofs ═══
-- the escalation chain: with the follow-the-chain step removed the quote stays in review (the original defect)
select pg_temp.draft(:'QORG', :'opp2', 'red chain', 250000, 0, 1) as pr1 \gset
select request_id as rr1 from sales.submit_proposal(:'pr1', :'QOWN') \gset
update approvals.approval_requests set sla_due_at = now() - interval '1 minute' where id = :'rr1';
select pg_temp.as_service();
select escalation_id as rr2 from approvals.expire_overdue(50) where expired_id = :'rr1' \gset
select pg_temp.as_user(:'QOWN', :'QORG', 'owner');
select outcome from approvals.decide_approval(:'rr2', 'approved', 'late') \gset
select pg_temp.mutate('sales.sync_proposal_decision(uuid)', 'v_req := v_next;', 'v_req := v_req;');
select sales.sync_proposal_decision(:'pr1') as rsync \gset
select pg_temp.check(:'rsync' = 'pending_approval', 'RED-PROOF: without the chain-following step the owner''s approval of the escalation leaves the quote in review');

select pg_temp.mutate('sales.proposals_guard()', $m$if current_setting('p1o.cancel_door', true) is distinct from 'on' then$m$, 'if false then');
select pg_temp.draft(:'QORG', :'opp3', 'red cancel', 120000, 0, 2) as pr2 \gset
select pg_temp.check(not pg_temp.fails_with(format($f$update sales.proposals set status = 'cancelled', cancelled_at = now(), cancel_reason = 'x' where id = %L$f$, :'pr2'), '23001'), 'RED-PROOF: without the cancel-door flag a direct write cancels a quotation');

select pg_temp.mutate('sales.p1o_record_acceptance(uuid,uuid,text,text,integer,text,text)', 'if p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0 then', 'if false then');
select pg_temp.draft(:'QORG', :'opp3', 'red evidence', 130000, 0, 3) as pr3 \gset
select pg_temp.sendq(:'pr3', :'QOWN', :'QORG');
select pg_temp.as_user(:'QOWN', :'QORG', 'owner');
select pg_temp.check((select outcome from sales.p1o_record_acceptance(:'pr3', :'contact', 'whatsapp', '', 3)) <> 'evidence_required', 'RED-PROOF: without the evidence rule an acceptance with no evidence goes through');

select pg_temp.mutate('sales.p1o_record_acceptance(uuid,uuid,text,text,integer,text,text)', 'if p_stated_version is null and cardinality(v_open) > 1 then', 'if false then');
select pg_temp.draft(:'QORG', :'opp3', 'red amb', 140000, 0, 1) as pr4 \gset
select pg_temp.sendq(:'pr4', :'QOWN', :'QORG');
select pg_temp.draft(:'QORG', :'opp3', 'red amb b', 145000, 0, 2) as pr4b \gset
select pg_temp.sendq(:'pr4b', :'QOWN', :'QORG');
select pg_temp.as_user(:'QOWN', :'QORG', 'owner');
select pg_temp.check((select count(*) from sales.proposals where opportunity_id = :'opp3' and status = 'sent') >= 2, 'precondition: two versions are open on the deal');
select pg_temp.as_service();
select outcome as raised from sales.p1o_raise_acceptance_clarification(:'opp3', 'wa:red') \gset
select pg_temp.check(:'raised' = 'raised', 'an agent raises a clarification where two versions are open');
select pg_temp.as_user(:'QOWN', :'QORG', 'owner');
select pg_temp.check((select outcome from sales.p1o_record_acceptance(:'pr4', :'contact', 'whatsapp', 'wa:red')) = 'recorded', 'RED-PROOF: without the ambiguity rule an unspecific "okay" accepts one of two versions');

select pg_temp.draft(:'QORG', :'opp6', 'red tax', 110000) as pr5 \gset
insert into sales.p1o_quote_flags (organization_id, proposal_id, kind, note) values (:'QORG', :'pr5', 'tax_uncertain', 'red-proof flag');
select pg_temp.check(pg_temp.fails_with(format($f$select * from sales.submit_proposal(%L, %L)$f$, :'pr5', :'QOWN'), '23001'), 'control present: a flagged quote is refused');
select pg_temp.mutate('sales.p1o_proposals_guard()', $m$if exists (select 1 from sales.p1o_quote_flags f where f.proposal_id = new.id$m$, $m$if false and exists (select 1 from sales.p1o_quote_flags f where f.proposal_id = new.id$m$);
select pg_temp.check((select outcome from sales.submit_proposal(:'pr5', :'QOWN')) = 'submitted', 'RED-PROOF: without the tax-flag gate an uncertain quote goes for approval');

rollback;
\echo 'verify-p1o-quotation: all checks passed'
