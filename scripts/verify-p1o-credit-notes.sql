-- ═══════════════════════════════════════════════════════════════════════════
-- Credit notes: an issued invoice is corrected by a document the owner approved (migration 20261127300000).
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p1o-credit-notes.sql     Rolls back. Any failed check raises.
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

\set CORG '00000000-0000-4000-8000-0000000a0400'
\set COWN '00000000-0000-4000-8000-0000000a0401'
\set CMEM '00000000-0000-4000-8000-0000000a0402'
\set COTH '00000000-0000-4000-8000-0000000a0410'
\set COTHU '00000000-0000-4000-8000-0000000a0411'

insert into auth.users (id, email) values (:'COWN', 'p1o-c-owner@example.test'), (:'CMEM', 'p1o-c-member@example.test'), (:'COTHU', 'p1o-c-other@example.test');
insert into core.users (id, email, full_name) values (:'COWN', 'p1o-c-owner@example.test', 'C Owner'), (:'CMEM', 'p1o-c-member@example.test', 'C Member'), (:'COTHU', 'p1o-c-other@example.test', 'C Other') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'CORG', 'zztest p1o credit', 'zztest-p1o-credit'), (:'COTH', 'zztest p1o credit other', 'zztest-p1o-credit-other');
insert into core.memberships (organization_id, user_id, role) values (:'CORG', :'COWN', 'owner'), (:'CORG', :'CMEM', 'member'), (:'COTH', :'COTHU', 'owner');
insert into core.client_accounts (organization_id, name) values (:'CORG', 'zztest p1o credit client') returning id as acct \gset
insert into finance.invoices (organization_id, client_account_id, number, status, subtotal_minor, tax_minor, total_minor, issued_at, kind)
  values (:'CORG', :'acct', 'ZZ-CN-001', 'issued', 1000000, 180000, 1180000, now(), 'service') returning id as inv \gset
insert into finance.invoices (organization_id, client_account_id, number, status, subtotal_minor, total_minor, kind)
  values (:'CORG', :'acct', 'ZZ-CN-DRAFT', 'draft', 100000, 100000, 'service') returning id as draft \gset
insert into finance.invoices (organization_id, client_account_id, number, status, subtotal_minor, tax_minor, total_minor, issued_at, kind)
  values (:'CORG', :'acct', 'ZZ-CN-002', 'issued', 500000, 0, 500000, now(), 'service') returning id as inv2 \gset

-- ── no policy: nobody is named to approve, so nothing is raised ───────────
select pg_temp.as_user(:'COWN', :'CORG', 'owner');
select outcome as np from finance.p1o_request_credit_note(:'inv', 100000, 18000, 'wrong scope billed') \gset
select pg_temp.check(:'np' = 'no_policy', 'with no approval policy for credit notes the request is refused, not left pending against nobody');
select pg_temp.check((select count(*) from finance.p1o_credit_notes where organization_id = :'CORG') = 0, 'and nothing was written');
insert into approvals.approval_policies (organization_id, subject_type, min_amount_minor, required_role, sla_hours) values (:'CORG', 'credit_note', 0, 'ops_admin', 24);
select outcome as np2 from finance.p1o_request_credit_note(:'inv', 100000, 18000, 'wrong scope billed') \gset
select pg_temp.check(:'np2' = 'policy_must_name_the_owner', 'a policy that names anyone but the owner is refused: credit notes are the owner''s call');
update approvals.approval_policies set required_role = 'owner' where organization_id = :'CORG' and subject_type = 'credit_note';

-- ── requesting ────────────────────────────────────────────────────────────
select pg_temp.as_user(:'CMEM', :'CORG', 'member');
select pg_temp.check((select outcome from finance.p1o_request_credit_note(:'inv', 100000, 18000, 'wrong scope billed')) = 'forbidden', 'a plain member cannot request one');
select pg_temp.as_service();
select pg_temp.check((select outcome from finance.p1o_request_credit_note(:'inv', 100000, 18000, 'wrong scope billed')) = 'needs_a_person', 'the service role cannot request one: it is a human act');
select pg_temp.as_user(:'COTHU', :'COTH', 'owner');
select pg_temp.check((select outcome from finance.p1o_request_credit_note(:'inv', 100000, 18000, 'wrong scope billed')) = 'forbidden', 'another organisation cannot');
select pg_temp.as_user(:'COWN', :'CORG', 'owner');
select pg_temp.check((select outcome from finance.p1o_request_credit_note(:'draft', 1000, 0, 'not issued yet')) = 'not_an_issued_invoice', 'a draft invoice is not credited: it is simply not issued');
select pg_temp.check((select outcome from finance.p1o_request_credit_note(:'inv', 0, 0, 'zero')) = 'non_positive', 'an amount of nothing is refused');
select pg_temp.check((select outcome from finance.p1o_request_credit_note(:'inv', 1000, 2000, 'tax over amount')) = 'bad_tax_portion', 'a tax portion larger than the credit is refused');
select pg_temp.check((select outcome from finance.p1o_request_credit_note(:'inv', 1000, 0, 'x')) = 'missing_reason', 'a credit needs a reason');
select pg_temp.check((select outcome from finance.p1o_request_credit_note(:'inv', 1180001, 0, 'more than the invoice')) = 'exceeds_invoice', 'a credit above the invoice total is refused, never clamped');
select outcome as rq, credit_note_id as cn, request_id as rid, creditable_minor as room from finance.p1o_request_credit_note(:'inv', 1000000, 150000, 'scope removed by agreement') \gset
select pg_temp.check(:'rq' = 'requested' and :'room' = '180000', 'a credit within the total is requested and the remaining room is reported');
select pg_temp.check((select state from approvals.approval_requests where id = :'rid') = 'pending' and (select required_role from approvals.approval_requests where id = :'rid') = 'owner', 'an owner approval is pending for it');
select pg_temp.check((select outcome from finance.p1o_request_credit_note(:'inv', 200000, 0, 'would exceed with the pending one')) = 'exceeds_invoice', 'a pending request counts against the ceiling: two requests cannot measure against the same balance');
select pg_temp.check(pg_temp.fails_with(format($f$insert into finance.p1o_credit_notes (organization_id, invoice_id, amount_minor, reason) values (%L, %L, 1, 'direct')$f$, :'CORG', :'inv'), '23001'), 'a direct insert is refused: the door is the only way in');
select pg_temp.check(pg_temp.fails_with(format($f$update finance.p1o_credit_notes set status = 'issued', number = 'CN-9999', issued_at = now(), issued_by = %L where id = %L$f$, :'COWN', :'cn'), '23001'), 'a direct write cannot issue it');

-- ── issuing needs the owner''s approval and a person ───────────────────────
select pg_temp.check((select outcome from finance.p1o_issue_credit_note(:'cn')) = 'not_approved', 'a credit note whose approval is pending cannot be issued');
select outcome as dec from approvals.decide_approval(:'rid', 'approved', 'agreed with the client') \gset
select pg_temp.check(:'dec' = 'decided', 'the owner approves');
select pg_temp.as_service();
select pg_temp.check((select outcome from finance.p1o_issue_credit_note(:'cn')) = 'needs_a_person', 'the service role cannot issue: issuing is a human gate');
select pg_temp.as_user(:'CMEM', :'CORG', 'member');
select pg_temp.check((select outcome from finance.p1o_issue_credit_note(:'cn')) = 'forbidden', 'a plain member cannot issue');
select pg_temp.as_user(:'COWN', :'CORG', 'owner');
select outcome as iss, number as cnn from finance.p1o_issue_credit_note(:'cn') \gset
select pg_temp.check(:'iss' = 'issued' and :'cnn' = 'CN-0001', 'an administrator issues it and it is numbered CN-0001');
select pg_temp.check((select outcome from finance.p1o_issue_credit_note(:'cn')) = 'already_issued', 'issuing again is idempotent');
select pg_temp.check((select count(*) from core.outbox_events where organization_id = :'CORG' and type = 'finance.credit_note_issued' and subject_id = :'cn') = 1, 'one event, naming ids and the amount');
select pg_temp.check((select count(*) from audit.audit_log where organization_id = :'CORG' and action = 'credit_note.issued') = 1, 'and one audit row');
select pg_temp.check(pg_temp.fails_with(format($f$update finance.p1o_credit_notes set amount_minor = 1 where id = %L$f$, :'cn'), '23001'), 'an issued credit note does not change');
select pg_temp.check((select total_minor = 1180000 and status = 'issued' from finance.invoices where id = :'inv'), 'the invoice itself is untouched: a credit note is a document beside it');
select pg_temp.check((select credited_minor = 1000000 and net_minor = 180000 and invoiced_minor = 1180000 from finance.p1o_invoice_net_after_credits(:'inv')), 'net after credits is invoiced less issued credits');

-- ── a second note is numbered next; the ceiling holds across issued notes ─
select outcome as rq2, credit_note_id as cn2, request_id as rid2 from finance.p1o_request_credit_note(:'inv', 180000, 18000, 'goodwill') \gset
select pg_temp.check(:'rq2' = 'requested', 'the remaining room can be credited');
select pg_temp.check((select outcome from finance.p1o_request_credit_note(:'inv', 1, 0, 'one more minor unit')) = 'exceeds_invoice', 'and nothing beyond it');
select outcome from approvals.decide_approval(:'rid2', 'approved', 'ok') \gset
select number as cnn2 from finance.p1o_issue_credit_note(:'cn2') \gset
select pg_temp.check(:'cnn2' = 'CN-0002', 'numbers run per organisation');
-- another organisation numbers from its own sequence
select pg_temp.as_service();
insert into core.client_accounts (organization_id, name) values (:'COTH', 'zztest p1o other client') returning id as oacct \gset
insert into finance.invoices (organization_id, client_account_id, number, status, subtotal_minor, total_minor, issued_at, kind)
  values (:'COTH', :'oacct', 'ZZ-CN-OTHER', 'issued', 100000, 100000, now(), 'service') returning id as oinv \gset
insert into approvals.approval_policies (organization_id, subject_type, min_amount_minor, required_role, sla_hours) values (:'COTH', 'credit_note', 0, 'owner', 24);
select pg_temp.as_user(:'COTHU', :'COTH', 'owner');
select credit_note_id as ocn, request_id as orid from finance.p1o_request_credit_note(:'oinv', 50000, 0, 'other org credit') \gset
select outcome from approvals.decide_approval(:'orid', 'approved', 'ok') \gset
select number as ocnn from finance.p1o_issue_credit_note(:'ocn') \gset
select pg_temp.check(:'ocnn' = 'CN-0001', 'another organisation''s first note is CN-0001 too: the sequence is per organisation');
set local role authenticated;
select pg_temp.check((select count(*) from finance.p1o_credit_notes) = 1, 'and its row-level read shows only its own');
reset role;
select pg_temp.as_user(:'COWN', :'CORG', 'owner');

-- ── correction by reissue: the replacement is linked ──────────────────────
select pg_temp.check((select outcome from finance.p1o_link_replacement_invoice(:'cn', :'inv')) = 'not_a_replacement', 'the credited invoice is not its own replacement');
select pg_temp.check((select outcome from finance.p1o_link_replacement_invoice(:'cn', :'oinv')) = 'unknown_invoice', 'another organisation''s invoice cannot be linked');
select pg_temp.check((select outcome from finance.p1o_link_replacement_invoice(:'cn', :'inv2')) = 'linked', 'a replacement invoice for the same client is linked');
select pg_temp.check((select outcome from finance.p1o_link_replacement_invoice(:'cn', :'draft')) = 'already_linked', 'once');

-- ═══ red-proofs ═══
select pg_temp.mutate('finance.p1o_issue_credit_note(uuid)', 'if v_state is distinct from ''approved'' then', 'if false then');
select credit_note_id as rcn from finance.p1o_request_credit_note(:'inv2', 1000, 0, 'red-proof request') \gset
select pg_temp.check((select outcome from finance.p1o_issue_credit_note(:'rcn')) = 'issued', 'RED-PROOF: without the approval check a credit note is issued on a pending approval');
select pg_temp.mutate('finance.p1o_request_credit_note(uuid,bigint,bigint,text)', 'if p_amount_minor > v_room then', 'if false then');
select pg_temp.check((select outcome from finance.p1o_request_credit_note(:'inv2', 99999999, 0, 'red-proof ceiling')) = 'requested', 'RED-PROOF: without the ceiling a credit larger than the invoice is requested');
select pg_temp.mutate('finance.p1o_credit_note_actor_refusal(uuid)', 'if (select auth.uid()) is null then return ''needs_a_person''; end if;', '');
select pg_temp.as_service();
select pg_temp.check((select outcome from finance.p1o_issue_credit_note(:'rcn')) <> 'needs_a_person', 'RED-PROOF: without the person check the service role passes the human gate');

rollback;
\echo 'verify-p1o-credit-notes: all checks passed'
