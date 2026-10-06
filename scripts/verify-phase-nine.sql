-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 9 (Finance Agent, cross-phase financial control) driven through the REAL doors on a scratch Postgres.
--
--   * the financial close of a project: reconciliation per milestone (M1-M4), aging, margin, blockers with reasons, a close that needs a zero balance or
--     an APPROVED exception, a frozen snapshot, and a plan that is not reopened afterwards;
--   * exceptions (including a chargeback), waivers (separation of duties in the database), the one definition of "outstanding";
--   * unverified money is never revenue; a waiver is not cash; a refund keeps the original payment;
--   * the period close with a frozen report;
--   * the three finance agents (installed disabled) PROPOSE through one service-only door and an INDEPENDENT person decides.
-- No model ran: each proposal below is what a finance-agent run WOULD hand the door. No payment is verified by anything but the runner path that
-- already existed (finance.verify_payment, unchanged), and no agent verifies, refunds, waives, closes or messages anyone.
--
--   cp scripts/apply-migrations-locally.sh /tmp/x.sh ; KEEP=1 ... (PORT changed)
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-nine.sql        (rolls back)
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;
set local timezone = 'UTC';

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
begin execute stmt; return false;
exception when insufficient_privilege then return true; end $$;
grant execute on function pg_temp.denied(text) to public;

-- fixtures are written the way the runner / a migration writes them (no signed-in person); the real doors then read them
-- each fixture helper acts as the runner (no signed-in person) and then restores whoever was acting
create or replace function pg_temp.mk_inv(p_org uuid, p_client uuid, p_project uuid, p_ms uuid, p_num text, p_total bigint, p_due timestamptz default now() + interval '30 days', p_status text default 'issued')
returns uuid language plpgsql as $$
declare v uuid; v_prev text := current_setting('request.jwt.claims', true);
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into finance.invoices (organization_id, client_account_id, project_id, milestone_id, number, status, subtotal_minor, tax_minor, total_minor, issued_at, due_at)
  values (p_org, p_client, p_project, p_ms, p_num, p_status, p_total, 0, p_total, case when p_status in ('draft', 'pending_approval', 'void') then null else now() end, p_due) returning id into v;
  perform set_config('request.jwt.claims', coalesce(v_prev, ''), true);
  return v;
end $$;
grant execute on function pg_temp.mk_inv(uuid, uuid, uuid, uuid, text, bigint, timestamptz, text) to public;
create or replace function pg_temp.pay(p_inv uuid, p_amount bigint, p_ref text) returns uuid language plpgsql as $$
declare v uuid; o text; v_prev text := current_setting('request.jwt.claims', true);
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select r.payment_id, r.outcome into v, o from finance.record_manual_payment(p_inv, p_ref, p_amount, now(), 'upi') r;
  perform set_config('request.jwt.claims', coalesce(v_prev, ''), true);
  if v is null then raise exception 'fixture payment refused: %', o; end if; return v; end $$;
grant execute on function pg_temp.pay(uuid, bigint, text) to public;
create or replace function pg_temp.verify(p_pay uuid) returns text language plpgsql as $$
declare o text; v_prev text := current_setting('request.jwt.claims', true);
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select r.outcome into o from finance.verify_payment(p_pay, current_setting('p9.admin1')::uuid) r;
  perform set_config('request.jwt.claims', coalesce(v_prev, ''), true);
  return o; end $$;
grant execute on function pg_temp.verify(uuid) to public;
create or replace function pg_temp.pos(p_project uuid) returns jsonb language sql as $$ select finance.project_close_position(p_project) $$;
grant execute on function pg_temp.pos(uuid) to public;
create or replace function pg_temp.tot(p jsonb, k text) returns bigint language sql as $$ select (p -> 'totals' ->> k)::bigint $$;
grant execute on function pg_temp.tot(jsonb, text) to public;
create or replace function pg_temp.code(p jsonb, c text) returns boolean language sql as $$ select exists (select 1 from jsonb_array_elements(p -> 'blockers') e where e ->> 'code' = c) $$;
grant execute on function pg_temp.code(jsonb, text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000009b7'
\set ADMIN1 '00000000-0000-4000-8000-00000000f911'
\set ADMIN2 '00000000-0000-4000-8000-00000000f912'
\set FIN '00000000-0000-4000-8000-00000000f913'
\set FIN2 '00000000-0000-4000-8000-00000000f914'
\set MEMBER '00000000-0000-4000-8000-00000000f915'
\set CLIENT '00000000-0000-4000-8000-00000000f916'
\set UB '00000000-0000-4000-8000-00000000f917'
select set_config('p9.admin1', :'ADMIN1', false);
select set_config('p9.org', :'ORG', false);
select set_config('p9.orgb', :'ORGB', false);

insert into core.organizations (id, name, slug) values (:'ORGB', 'P9 Other Agency', 'p9-other-agency') on conflict do nothing;
insert into auth.users (id, email) values (:'ADMIN1', 'p9-a1@example.test'), (:'ADMIN2', 'p9-a2@example.test'), (:'FIN', 'p9-f1@example.test'), (:'FIN2', 'p9-f2@example.test'),
  (:'MEMBER', 'p9-m@example.test'), (:'CLIENT', 'p9-c@example.test'), (:'UB', 'p9-b@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'ADMIN1', 'p9-a1@example.test', 'P9 Admin One'), (:'ADMIN2', 'p9-a2@example.test', 'P9 Admin Two'), (:'FIN', 'p9-f1@example.test', 'P9 Finance One'),
  (:'FIN2', 'p9-f2@example.test', 'P9 Finance Two'), (:'MEMBER', 'p9-m@example.test', 'P9 Member'), (:'CLIENT', 'p9-c@example.test', 'P9 Client'), (:'UB', 'p9-b@example.test', 'P9 B') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'ADMIN1', 'owner'), (:'ORG', :'ADMIN2', 'ops_admin'), (:'ORG', :'FIN', 'finance'), (:'ORG', :'FIN2', 'finance'),
  (:'ORG', :'MEMBER', 'member'), (:'ORGB', :'UB', 'owner') on conflict do nothing;
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p9 client') returning id as "A_id" \gset
insert into core.client_accounts (organization_id, name) values (:'ORGB', 'zztest p9 client b') returning id as "AB_id" \gset

-- the project the whole close story is told on: four priced milestones, 30 / 20 / 30 / 20
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p9 main', 'ZP9-A') returning id as "PA" \gset
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORGB', :'AB_id', 'zztest p9 other org', 'ZP9-B') returning id as "PO" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'PA', 'M1 advance', 1, 30000, 'INR') returning id as "MA1" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'PA', 'M2 prototype', 2, 20000, 'INR') returning id as "MA2" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'PA', 'M3 development', 3, 30000, 'INR') returning id as "MA3" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'PA', 'M4 delivery', 4, 20000, 'INR') returning id as "MA4" \gset
select pg_temp.mk_inv(:'ORG', :'A_id', :'PA', :'MA1', 'ZP9-A-1', 30000) as "I1" \gset
select pg_temp.mk_inv(:'ORG', :'A_id', :'PA', :'MA2', 'ZP9-A-2', 20000) as "I2" \gset
select pg_temp.mk_inv(:'ORG', :'A_id', :'PA', :'MA3', 'ZP9-A-3', 30000) as "I3" \gset
select pg_temp.mk_inv(:'ORG', :'A_id', :'PA', :'MA4', 'ZP9-A-4', 20000) as "I4" \gset
select set_config('p9.pa', :'PA', false);

-- ═════════ 1. who may read the position, and what it says before any money arrives ═════════
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check(pg_temp.pos(:'PA') is null, 'a member (not Finance, not Admin) gets no position');
select pg_temp.as_user(:'CLIENT', :'ORG', 'client');
select pg_temp.check(pg_temp.pos(:'PA') is null, 'a client gets no position');
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
select pg_temp.check(pg_temp.pos(:'PA') is null, 'an Admin of ANOTHER organization gets no position of this project (cross-tenant denied)');
select pg_temp.check((select outcome from finance.close_project_finances(:'PA')) = 'not_found', 'and cannot close it');
select pg_temp.check((select outcome from finance.evaluate_project_close(:'PA')) = 'not_found', 'nor record an evaluation of it');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.pos(:'PA') as "POS0" \gset
select pg_temp.check(:'POS0'::jsonb ->> 'result' = 'outstanding_only', 'M1-M4 all invoiced, nothing paid: the only blocker is the outstanding balance [' || (:'POS0'::jsonb ->> 'result') || ']');
select pg_temp.check((:'POS0'::jsonb -> 'milestones') is not null and jsonb_array_length(:'POS0'::jsonb -> 'milestones') = 4, 'the position reconciles per milestone M1-M4');
select pg_temp.check(pg_temp.tot(:'POS0'::jsonb, 'contractMinor') = 100000 and pg_temp.tot(:'POS0'::jsonb, 'invoicedMinor') = 100000 and pg_temp.tot(:'POS0'::jsonb, 'verifiedNetMinor') = 0 and pg_temp.tot(:'POS0'::jsonb, 'outstandingMinor') = 100000,
  'agreed 100000, invoiced 100000, verified 0, outstanding 100000');
select pg_temp.check((:'POS0'::jsonb -> 'milestones' -> 0 ->> 'name') = 'M1 advance' and (:'POS0'::jsonb -> 'milestones' -> 3 ->> 'name') = 'M4 delivery', 'milestones come back in plan order');
select pg_temp.check((:'POS0'::jsonb -> 'aging' ->> 'current')::bigint = 100000, 'aging: nothing is due yet, so all of it is current');
\echo 1. reads OK

-- ═════════ 2. unverified money is never revenue ═════════
select pg_temp.pay(:'I1', 30000, 'UTR-P9-1') as "PAY1" \gset
insert into finance.payment_submissions (organization_id, invoice_id, amount_minor, method, reference, submitted_by) values (:'ORG', :'I1', 30000, 'upi', 'UTR-P9-1B', :'FIN') returning id as "SUB1" \gset
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.pos(:'PA') as "POS1" \gset
select pg_temp.check(pg_temp.tot(:'POS1'::jsonb, 'collectedMinor') = 0 and pg_temp.tot(:'POS1'::jsonb, 'verifiedNetMinor') = 0, 'a recorded-but-unverified payment is NOT collected and NOT revenue');
select pg_temp.check(pg_temp.tot(:'POS1'::jsonb, 'unverifiedMinor') = 30000 and pg_temp.tot(:'POS1'::jsonb, 'outstandingMinor') = 100000, 'it appears only on its own unverified line, and the balance still owed does not shrink');
select pg_temp.check(:'POS1'::jsonb ->> 'result' = 'blocked' and pg_temp.code(:'POS1'::jsonb, 'unverified_money') and pg_temp.code(:'POS1'::jsonb, 'payment_submission_unresolved'), 'unverified money and a pending submission each BLOCK the close, with a reason');
select pg_temp.check((select outcome from finance.close_project_finances(:'PA')) = 'blocked', 'close is refused while money is unverified');
select pg_temp.check((select count(*) from finance.financial_close_evaluations where project_id = :'PA' and result = 'blocked') = 1, 'the refused attempt is recorded as an evaluation');
-- the existing human-only verification stays exactly as it was
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check((select outcome from finance.verify_payment(:'PAY1', :'FIN')) = 'forbidden', 'a Finance person still cannot verify a payment (owner decision unchanged)');
select pg_temp.as_service();
select pg_temp.check(pg_temp.verify(:'PAY1') = 'verified', 'the runner path that already existed verifies it');
update finance.payment_submissions set status = 'rejected', rejected_reason = 'p9 fixture: duplicate claim of the same transfer' where id = :'SUB1';
insert into finance.expenses (organization_id, project_id, category, description, amount_minor, incurred_on, currency) values (:'ORG', :'PA', 'tooling', 'zztest p9 licence', 5000, current_date, 'INR');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.pos(:'PA') as "POS2" \gset
select pg_temp.check(pg_temp.tot(:'POS2'::jsonb, 'verifiedNetMinor') = 30000 and pg_temp.tot(:'POS2'::jsonb, 'collectedMinor') = 30000 and pg_temp.tot(:'POS2'::jsonb, 'unverifiedMinor') = 0, 'once a person verifies it, 30000 is collected');
select pg_temp.check(pg_temp.tot(:'POS2'::jsonb, 'expensesMinor') = 5000 and pg_temp.tot(:'POS2'::jsonb, 'marginMinor') = 25000 and (:'POS2'::jsonb -> 'totals' ->> 'marginPercent')::numeric = 83.3, 'margin is verified net - expenses (25000, 83.3%), in SQL');
select pg_temp.check((:'POS2'::jsonb -> 'milestones' -> 0 ->> 'verifiedNetMinor')::bigint = 30000 and (:'POS2'::jsonb -> 'milestones' -> 1 ->> 'verifiedNetMinor')::bigint = 0, 'and it lands on M1 only');
\echo 2. unverified OK

-- ═════════ 3. partial payment, waiver (separation of duties), exceptions, a chargeback ═════════
select pg_temp.as_service();
select pg_temp.pay(:'I2', 20000, 'UTR-P9-2') as "PAY2" \gset
select pg_temp.pay(:'I3', 10000, 'UTR-P9-3') as "PAY3" \gset
select pg_temp.check(pg_temp.verify(:'PAY2') = 'verified' and pg_temp.verify(:'PAY3') = 'verified', 'M2 in full and 10000 of M3 are verified');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.pos(:'PA') as "POS3" \gset
select pg_temp.check(pg_temp.tot(:'POS3'::jsonb, 'verifiedNetMinor') = 60000 and pg_temp.tot(:'POS3'::jsonb, 'outstandingMinor') = 40000, 'a partial payment leaves the remaining balance (M3 20000 + M4 20000)');
-- waiver: Finance asks, an Admin who did not ask decides
select outcome as "W_o", waiver_id as "W1" from finance.request_waiver(:'I3', 20000, 'p9: goodwill on the unpaid part of M3, agreed with the client') \gset
select pg_temp.check(:'W_o' = 'requested', 'Finance requests a waiver of the unpaid 20000 on M3');
select pg_temp.check((select outcome from finance.request_waiver(:'I3', 1000, 'again')) = 'already_pending', 'one pending waiver per invoice');
select pg_temp.check((select outcome from finance.request_waiver(:'I4', 25000, 'too much')) = 'exceeds_outstanding', 'a waiver cannot exceed what is owed');
select pg_temp.check(pg_temp.code(pg_temp.pos(:'PA'), 'waiver_pending'), 'a pending waiver blocks the close');
select pg_temp.check((select outcome from finance.decide_waiver(:'W1', 'approved', 'self')) = 'not_authorized', 'Finance cannot decide a waiver at all');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from finance.request_waiver(:'I4', 100, 'x')) = 'not_authorized' and (select outcome from finance.decide_waiver(:'W1', 'approved', 'x')) = 'not_authorized', 'a member can neither request nor decide');
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
select pg_temp.check((select outcome from finance.decide_waiver(:'W1', 'approved', 'cross tenant')) = 'not_found', 'another organization cannot decide it');
select pg_temp.as_user(:'ADMIN1', :'ORG', 'owner');
select outcome as "W2_o", waiver_id as "W2" from finance.request_waiver(:'I4', 5000, 'p9: admin asks for a small waiver') \gset
select pg_temp.check((select outcome from finance.decide_waiver(:'W2', 'approved', 'I approve my own')) = 'self_approval', 'an Admin cannot approve the waiver they requested (the database refuses)');
select pg_temp.as_service();
select pg_temp.check(pg_temp.refused(format($q$update finance.waivers set decided_by = requested_by, status = 'approved', decided_at = now(), decision_note = 'forced' where id = %L$q$, :'W2'), 'waivers_check') or pg_temp.refused(format($q$update finance.waivers set decided_by = requested_by, status = 'approved', decided_at = now(), decision_note = 'forced' where id = %L$q$, :'W2'), 'check'), 'and not even a direct write can make requester = approver');
select pg_temp.as_user(:'ADMIN2', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from finance.decide_waiver(:'W2', 'rejected', 'not agreed')) = 'rejected', 'another Admin rejects it with a reason');
select pg_temp.check((select outcome from finance.decide_waiver(:'W2', 'approved', 'changed my mind')) = 'already_decided', 'a decided waiver is final');
select pg_temp.check((select outcome from finance.decide_waiver(:'W1', 'approved', 'agreed with the client in writing')) = 'approved', 'an Admin who did not ask approves the M3 waiver');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.pos(:'PA') as "POS4" \gset
select pg_temp.check(pg_temp.tot(:'POS4'::jsonb, 'waivedMinor') = 20000 and pg_temp.tot(:'POS4'::jsonb, 'outstandingMinor') = 20000, 'the waiver closes the collectible balance on M3 (outstanding 20000 left on M4)');
select pg_temp.check(pg_temp.tot(:'POS4'::jsonb, 'collectedMinor') = 60000 and pg_temp.tot(:'POS4'::jsonb, 'verifiedNetMinor') = 60000 and pg_temp.tot(:'POS4'::jsonb, 'marginMinor') = 55000, 'and the waived value is NOT cash received and NOT revenue (collected/margin unchanged)');
select pg_temp.check((select verified_minor from finance.invoices where id = :'I3') = 10000 and (select total_minor from finance.invoices where id = :'I3') = 30000, 'the invoice itself is not rewritten to make the balance reconcile');
select pg_temp.check(not exists (select 1 from jsonb_array_elements(:'POS4'::jsonb -> 'blockers') e where e ->> 'code' = 'waiver_pending'), 'the decided waiver no longer blocks');
-- exceptions: a chargeback is blocking, its resolver is not its opener, and an Admin settles it
select outcome as "X_o", exception_id as "X1" from finance.open_finance_exception('chargeback', 'p9: the bank notified a dispute on the M1 transfer', :'PA', :'I1', null, '{"bankRef":"CB-1"}') \gset
select pg_temp.check(:'X_o' = 'opened', 'Finance opens a chargeback exception on M1');
select pg_temp.check((select blocking from finance.finance_exceptions where id = :'X1'), 'a chargeback is always blocking');
select pg_temp.check((select outcome from finance.open_finance_exception('chargeback', 'api_key=abcdefghijklmnop1234', :'PA', :'I1')) = 'secret_in_text', 'a secret value in an exception is refused');
select pg_temp.check((select outcome from finance.open_finance_exception('nonsense', 'x', :'PA')) = 'bad_kind', 'an unknown kind is refused');
select pg_temp.check((select outcome from finance.open_finance_exception('other', 'x', :'PO')) = 'not_found', 'an exception cannot name another organization''s project');
select pg_temp.pos(:'PA') as "POS5" \gset
select pg_temp.check(pg_temp.code(:'POS5'::jsonb, 'open_exception') and :'POS5'::jsonb ->> 'result' = 'blocked', 'an open chargeback blocks the close with its reason');
select pg_temp.check((select outcome from finance.resolve_finance_exception(:'X1', 'resolved', 'self')) = 'self_resolution', 'whoever opened a blocking exception cannot resolve it');
select pg_temp.as_user(:'FIN2', :'ORG', 'finance');
select pg_temp.check((select outcome from finance.resolve_finance_exception(:'X1', 'resolved', 'finance two tries')) = 'admin_only', 'a chargeback is settled by an Admin, not by Finance');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from finance.resolve_finance_exception(:'X1', 'resolved', 'x')) = 'not_authorized', 'a member cannot resolve');
select pg_temp.as_user(:'ADMIN1', :'ORG', 'owner');
select pg_temp.check((select outcome from finance.resolve_finance_exception(:'X1', 'resolved', '')) = 'reason_required', 'a resolution needs a reason');
select pg_temp.check((select outcome from finance.resolve_finance_exception(:'X1', 'resolved', 'bank confirmed the dispute was withdrawn')) = 'resolved', 'an Admin resolves it');
select pg_temp.check((select outcome from finance.resolve_finance_exception(:'X1', 'dismissed', 'again')) = 'already_resolved', 'a resolved exception is history');
select pg_temp.as_service();
select pg_temp.check(pg_temp.refused(format($q$update finance.finance_exceptions set reason = 'rewritten' where id = %L$q$, :'X1'), 'history'), 'a resolved exception cannot be edited');
select pg_temp.check(pg_temp.refused(format($q$delete from finance.finance_exceptions where id = %L$q$, :'X1'), 'never deleted'), 'nor deleted');
\echo 3. waivers and exceptions OK

-- ═════════ 4. the close: a zero balance, frozen, and the plan is not reopened ═════════
select pg_temp.pay(:'I4', 20000, 'UTR-P9-4') as "PAY4" \gset
select pg_temp.check(pg_temp.verify(:'PAY4') = 'verified', 'M4 is verified');
select count(*) as "PAYS_BEFORE" from finance.payments where organization_id = :'ORG' and verified_at is not null \gset
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.pos(:'PA') as "POS6" \gset
select pg_temp.check(:'POS6'::jsonb ->> 'result' = 'clear' and jsonb_array_length(:'POS6'::jsonb -> 'blockers') = 0, 'agreed 100000 = verified 80000 + waived 20000: the position is clear');
select pg_temp.check(pg_temp.tot(:'POS6'::jsonb, 'verifiedNetMinor') = 80000 and pg_temp.tot(:'POS6'::jsonb, 'waivedMinor') = 20000 and pg_temp.tot(:'POS6'::jsonb, 'marginMinor') = 75000, 'cash 80000, waived 20000 reported separately, margin 75000');
select outcome as "EV_o" from finance.evaluate_project_close(:'PA') \gset
select pg_temp.check(:'EV_o' = 'evaluated' and (select result from finance.financial_close_evaluations where project_id = :'PA' order by created_at desc limit 1) = 'clear', 'an evaluation is recorded as clear');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from finance.close_project_finances(:'PA')) = 'not_authorized', 'a member cannot close');
select pg_temp.as_user(:'CLIENT', :'ORG', 'client');
select pg_temp.check((select outcome from finance.close_project_finances(:'PA')) = 'not_authorized', 'a client cannot close');
select pg_temp.as_service();
select pg_temp.check((select outcome from finance.close_project_finances(:'PA')) = 'not_authorized', 'the runner cannot close a project: it is a person''s act');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select outcome as "C_o", close_id as "CLOSE1", mode as "C_mode" from finance.close_project_finances(:'PA', 'p9 close') \gset
select pg_temp.check(:'C_o' = 'closed' and :'C_mode' = 'zero_balance', 'Finance closes the project''s finances at zero balance');
select pg_temp.check((select outcome from finance.close_project_finances(:'PA')) = 'already_closed', 'closing twice returns the same close');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.financially_closed' and subject_id = :'PA') = 1, 'ProjectFinanciallyClosed is emitted exactly once');
select pg_temp.check((select (snapshot -> 'totals' ->> 'verifiedNetMinor')::bigint from finance.project_financial_closes where id = :'CLOSE1') = 80000, 'the close holds a frozen snapshot of the position');
select pg_temp.check((select count(*) from finance.payments where organization_id = :'ORG' and verified_at is not null) = :'PAYS_BEFORE'::bigint, 'closing verified nothing and changed no payment');
select pg_temp.as_user(:'ADMIN1', :'ORG', 'owner');
select pg_temp.check(finance.project_is_financially_closed(:'PA'), 'Phase 7 can read the fact: closed');
select pg_temp.as_user(:'CLIENT', :'ORG', 'client');
select pg_temp.check(not finance.project_is_financially_closed(:'PA'), 'a client is told nothing');
select pg_temp.as_service();
select pg_temp.check(pg_temp.refused(format($q$update finance.project_financial_closes set note = 'edited' where id = %L$q$, :'CLOSE1'), 'history'), 'a close is history: not editable');
select pg_temp.check(pg_temp.refused(format($q$delete from finance.project_financial_closes where id = %L$q$, :'CLOSE1'), 'history'), 'not deletable');
select pg_temp.check(pg_temp.refused(format($q$update finance.financial_close_evaluations set result = 'clear' where project_id = %L$q$, :'PA'), 'history'), 'an evaluation is history too');
select pg_temp.check(pg_temp.refused(format($q$insert into finance.invoices (organization_id, client_account_id, project_id, milestone_id, number, status, subtotal_minor, tax_minor, total_minor) values (%L, %L, %L, %L, 'ZP9-A-5', 'draft', 100, 0, 100)$q$, :'ORG', :'A_id', :'PA', :'MA1'), 'financially closed'), 'a closed project''s milestone is not invoiced again');
select pg_temp.check(pg_temp.refused(format($q$update projects.milestones set amount_minor = 99999 where id = %L$q$, :'MA1'), 'financially closed'), 'its milestone plan is not rewritten');
select pg_temp.check(pg_temp.mk_inv(:'ORG', :'A_id', :'PA', null, 'ZP9-A-CR1', 1000, now() + interval '30 days', 'draft') is not null, 'new work after close is a separate (non-milestone) finance record: allowed');
select pg_temp.check(not exists (select 1 from finance.invoices where project_id = :'PA' and milestone_id is not null and number = 'ZP9-A-5'), 'and the original milestones stay as they were');
\echo 4. close OK

-- ═════════ 5. a balance closes only against an APPROVED exception; a refund keeps the original payment ═════════
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p9 balance', 'ZP9-BAL') returning id as "PB" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor) values (:'ORG', :'PB', 'M1 only', 1, 10000) returning id as "MB1" \gset
select pg_temp.mk_inv(:'ORG', :'A_id', :'PB', :'MB1', 'ZP9-B-1', 10000) as "IB1" \gset
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check(pg_temp.pos(:'PB') ->> 'result' = 'outstanding_only', 'only a balance stands');
select pg_temp.check((select outcome from finance.close_project_finances(:'PB')) = 'balance_needs_an_approved_exception', 'a balance cannot close without an approved exception');
select outcome as "E_o", close_exception_id as "CE1" from finance.request_close_exception(:'PB', 'p9: client is insolvent, remaining 10000 is not collectible') \gset
select pg_temp.check(:'E_o' = 'requested', 'Finance requests a close exception');
select pg_temp.check((select outcome from finance.request_close_exception(:'PB', 'again')) = 'already_pending', 'one pending request per project');
select pg_temp.check((select outcome from finance.decide_close_exception(:'CE1', 'approved', 'nope')) = 'not_authorized', 'Finance cannot decide it');
select pg_temp.check((select outcome from finance.close_project_finances(:'PB')) = 'balance_needs_an_approved_exception', 'a REQUESTED exception does not let the close through');
select pg_temp.as_user(:'ADMIN1', :'ORG', 'owner');
select pg_temp.check((select outcome from finance.decide_close_exception(:'CE1', 'approved', 'approved by the owner')) = 'approved', 'an Admin who did not ask approves it');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select outcome as "C2_o", mode as "C2_mode", close_id as "CLOSE2" from finance.close_project_finances(:'PB') \gset
select pg_temp.check(:'C2_o' = 'closed' and :'C2_mode' = 'approved_exception', 'the balance closes against the approved exception');
select pg_temp.check((select close_exception_id from finance.project_financial_closes where id = :'CLOSE2') is not null, 'and the close names the exception it relied on');
-- self-approval, and a stale exception
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p9 self', 'ZP9-SELF') returning id as "PC" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor) values (:'ORG', :'PC', 'M1 only', 1, 10000) returning id as "MC1" \gset
select pg_temp.mk_inv(:'ORG', :'A_id', :'PC', :'MC1', 'ZP9-C-1', 10000) as "IC1" \gset
select pg_temp.as_user(:'ADMIN1', :'ORG', 'owner');
select close_exception_id as "CE2" from finance.request_close_exception(:'PC', 'p9: admin requests') \gset
select pg_temp.check((select outcome from finance.decide_close_exception(:'CE2', 'approved', 'self')) = 'self_approval', 'an Admin cannot approve the close exception they requested');
select pg_temp.as_user(:'ADMIN2', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from finance.decide_close_exception(:'CE2', 'approved', 'second admin')) = 'approved', 'another Admin can');
select pg_temp.as_service();
select pg_temp.mk_inv(:'ORG', :'A_id', :'PC', null, 'ZP9-C-CR', 5000) as "ICR" \gset
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check((select outcome from finance.close_project_finances(:'PC')) = 'balance_needs_an_approved_exception', 'an exception approved for 10000 does not cover a balance that has since grown to 15000');
-- other blockers are fixed, not excused
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p9 unverified', 'ZP9-UNV') returning id as "PD" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor) values (:'ORG', :'PD', 'M1 only', 1, 10000) returning id as "MD1" \gset
select pg_temp.as_service();
select pg_temp.mk_inv(:'ORG', :'A_id', :'PD', :'MD1', 'ZP9-D-1', 10000) as "ID1" \gset
select pg_temp.pay(:'ID1', 4000, 'UTR-P9-D') as "PAYD" \gset
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check((select outcome from finance.request_close_exception(:'PD', 'excuse unverified money')) = 'other_blockers_stand', 'an exception cannot excuse unverified money');
select pg_temp.check((select outcome from finance.request_close_exception(:'PA', 'already closed')) = 'already_closed', 'a closed project takes no exception request');
-- a project with nothing financial on record cannot close
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p9 empty', 'ZP9-EMPTY') returning id as "PE" \gset
select pg_temp.check(pg_temp.code(pg_temp.pos(:'PE'), 'no_financial_record') and (select outcome from finance.close_project_finances(:'PE')) = 'blocked', 'a project with no milestone and no invoice cannot close: what was agreed is not reconstructable');
-- a milestone that was never invoiced blocks
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p9 uninvoiced', 'ZP9-UNI') returning id as "PU" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor) values (:'ORG', :'PU', 'M1', 1, 5000);
select pg_temp.check(pg_temp.code(pg_temp.pos(:'PU'), 'milestone_not_invoiced'), 'a priced milestone with no issued invoice blocks the close');
-- a refund: the original payment stays in the history
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p9 refund', 'ZP9-REF') returning id as "PR" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor) values (:'ORG', :'PR', 'M1', 1, 10000) returning id as "MR1" \gset
select pg_temp.as_service();
select pg_temp.mk_inv(:'ORG', :'A_id', :'PR', :'MR1', 'ZP9-R-1', 10000) as "IR1" \gset
select pg_temp.pay(:'IR1', 10000, 'UTR-P9-R') as "PAYR" \gset
select pg_temp.check(pg_temp.verify(:'PAYR') = 'verified', 'the milestone is paid and verified');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check(pg_temp.pos(:'PR') ->> 'result' = 'clear', 'it is clear');
select pg_temp.as_service();
insert into finance.refunds (organization_id, invoice_id, amount_minor, reason, status, provider, provider_refund_id, recorded_at) values (:'ORG', :'IR1', 4000, 'p9 fixture refund', 'recorded', 'manual', 'RF-P9-1', now());
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.pos(:'PR') as "POSR" \gset
select pg_temp.check(pg_temp.tot(:'POSR'::jsonb, 'collectedMinor') = 10000 and pg_temp.tot(:'POSR'::jsonb, 'refundedMinor') = 4000 and pg_temp.tot(:'POSR'::jsonb, 'verifiedNetMinor') = 6000, 'the original verified payment is preserved (10000), the refund is its own line (4000), net verified is 6000');
select pg_temp.check(pg_temp.tot(:'POSR'::jsonb, 'outstandingMinor') = 4000 and :'POSR'::jsonb ->> 'result' = 'outstanding_only', 'and the refund shows up as an auditable adjustment: the balance is open again until a person deals with it');
select pg_temp.check((select count(*) from finance.payments where invoice_id = :'IR1' and verified_at is not null and amount_minor = 10000) = 1, 'the payment row itself is untouched');
\echo 5. exceptions to the balance OK

-- ═════════ 6. the runner keeps the exception queue honest, and a forgiven debt is not chased ═════════
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p9 sweep', 'ZP9-SWP') returning id as "PW" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor) values (:'ORG', :'PW', 'M1', 1, 8000) returning id as "MW1" \gset
select pg_temp.as_service();
select pg_temp.mk_inv(:'ORG', :'A_id', :'PW', :'MW1', 'ZP9-W-1', 8000, now() - interval '40 days') as "IW1" \gset
select pg_temp.mk_inv(:'ORG', :'A_id', :'PW', null, 'ZP9-W-2', 6000, now() - interval '10 days') as "IW2" \gset
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.pos(:'PW') as "POSW" \gset
select pg_temp.check((:'POSW'::jsonb -> 'aging' ->> 'days31to60')::bigint = 8000 and (:'POSW'::jsonb -> 'aging' ->> 'days1to30')::bigint = 6000 and pg_temp.tot(:'POSW'::jsonb, 'overdueMinor') = 14000, 'aging buckets the overdue balances (8000 at 40 days, 6000 at 10 days)');
select pg_temp.as_service();
select opened_overdue as "S1" from finance.sweep_finance_exceptions(1000) \gset
select pg_temp.check(:'S1'::int >= 2, 'the sweep opens an overdue exception for each overdue invoice');
select pg_temp.check((select count(*) from finance.finance_exceptions where invoice_id in (:'IW1', :'IW2') and kind = 'overdue' and state = 'open') = 2 and not (select blocking from finance.finance_exceptions where invoice_id = :'IW1' and kind = 'overdue'), 'one open each, and an overdue invoice is listed, not blocking (its balance already blocks)');
select opened_overdue as "S2" from finance.sweep_finance_exceptions(1000) \gset
select pg_temp.check(:'S2'::int = 0 and (select count(*) from finance.finance_exceptions where invoice_id in (:'IW1', :'IW2') and kind = 'overdue') = 2, 'a second sweep duplicates nothing');
-- a fully waived overdue invoice is not chased; the unwaived one still is
update core.organizations set invoice_reminders_enabled = true where id = :'ORG';
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select waiver_id as "WW" from finance.request_waiver(:'IW2', 6000, 'p9: forgiven in full') \gset
select pg_temp.as_user(:'ADMIN1', :'ORG', 'owner');
select pg_temp.check((select outcome from finance.decide_waiver(:'WW', 'approved', 'forgiven')) = 'approved', 'the whole balance of IW2 is waived');
select pg_temp.as_service();
select pg_temp.check(exists (select 1 from finance.observe_invoice_reminder_candidates(100000) c where c.invoice_id = :'IW1'), 'an overdue invoice with a balance is still offered for a reminder');
select pg_temp.check(not exists (select 1 from finance.observe_invoice_reminder_candidates(100000) c where c.invoice_id = :'IW2'), 'a fully waived invoice is NOT offered: the client is not chased for a forgiven debt');
select resolved_overdue as "S3" from finance.sweep_finance_exceptions(1000) \gset
select pg_temp.check((select state from finance.finance_exceptions where invoice_id = :'IW2' and kind = 'overdue') = 'resolved' and (select state from finance.finance_exceptions where invoice_id = :'IW1' and kind = 'overdue') = 'open', 'the state is re-checked: the waived one is closed by the sweep, the still-overdue one stays open');
select pg_temp.check((select resolved_by is null and resolved_by_system from finance.finance_exceptions where invoice_id = :'IW2' and kind = 'overdue'), 'and it says the system closed it');
-- overpayment is structured, never silently absorbed
insert into finance.payments (organization_id, invoice_id, provider, provider_payment_id, amount_minor, status, captured_at, verified_at, verified_by) values (:'ORG', :'IW1', 'manual', 'P9-OVER', 9000, 'captured', now(), now(), :'ADMIN1');
select opened_overpayment as "S4" from finance.sweep_finance_exceptions(1000) \gset
select pg_temp.check(:'S4'::int = 1 and (select blocking from finance.finance_exceptions where invoice_id = :'IW1' and kind = 'overpayment'), 'an overpayment becomes a blocking exception');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check(pg_temp.code(pg_temp.pos(:'PW'), 'overpayment'), 'and the project''s close position names it');
\echo 6. sweep and reminders OK

-- ═════════ 7. the three agents (installed disabled) PROPOSE; an independent person decides ═════════
select pg_temp.check((select count(*) from ai.agents where key in ('finance_reconciliation', 'finance_communication', 'finance_close') and enabled = false) = 3, 'the three finance agents exist and are DISABLED');
select pg_temp.check((select count(*) from ai.agent_handoff_targets where from_agent in ('finance_reconciliation', 'finance_communication', 'finance_close') and to_agent = 'finance') = 3
  and (select count(*) from ai.agent_handoff_targets where from_agent in ('finance_reconciliation', 'finance_communication', 'finance_close')) = 3, 'each may hand back to finance and to nobody else');
select pg_temp.check((select count(*) from ai.agent_verifiers where producer in ('finance_reconciliation', 'finance_communication', 'finance_close') and verifier = 'quality_assurance') = 3, 'and each is verified by quality_assurance');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from finance.request_finance_agent_run('finance_reconciliation', :'PA')) = 'not_authorized', 'a member cannot ask a finance agent to look');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check((select outcome from finance.request_finance_agent_run('finance_communication', :'PW')) = 'name_an_invoice', 'a reminder draft is about exactly one invoice');
select pg_temp.check((select outcome from finance.request_finance_agent_run('functional_test', :'PW')) = 'bad_agent', 'only the finance agents');
select pg_temp.check((select outcome from finance.request_finance_agent_run('finance_reconciliation', :'PO')) = 'not_found', 'not another organization''s project');
select request_id as "RQ1" from finance.request_finance_agent_run('finance_reconciliation', :'PW') \gset
select request_id as "RQ2" from finance.request_finance_agent_run('finance_communication', :'PW', :'IW1') \gset
select request_id as "RQ3" from finance.request_finance_agent_run('finance_close', :'PW') \gset
select pg_temp.check(:'RQ1' is not null and :'RQ2' is not null and :'RQ3' is not null, 'Finance asks the three agents');
select count(*) as "PAY_N0" from finance.payments where organization_id = :'ORG' \gset
select coalesce(sum(verified_minor), 0) as "VER_0" from finance.invoices where organization_id = :'ORG' \gset
select count(*) as "REF_N0" from finance.refunds where organization_id = :'ORG' \gset
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
set local role authenticated;
select pg_temp.check(pg_temp.denied(format($q$select * from finance.record_finance_proposal(%L, %L, 'finance_reconciliation', 'anomaly_flag', 'x', null, array['invoice:%s'])$q$, :'RQ1', :'ORG', :'IW1')), 'a signed-in person cannot call the proposal door (service role only)');
reset role;
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ1', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'x', null, array['invoice:' || :'IW1'])) = 'not_authorized', 'and the door refuses a person inside too');
select pg_temp.as_service();
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ1', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'Invoice ZP9-W-1 holds more verified money than it is for (9000 over).', 'The sweep opened an overpayment exception.', array['invoice:' || :'IW1', 'payment:' || (select id::text from finance.payments where provider_payment_id = 'P9-OVER')])) = 'proposed', 'a reconciliation agent proposes an anomaly flag with evidence');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ1', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'Invoice ZP9-W-1 holds more verified money than it is for (9000 over).', null, array['invoice:' || :'IW1'])) = 'already_proposed', 'the same proposal twice is one proposal');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ1', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'no evidence', null, '{}')) = 'evidence_required', 'a flag without evidence is refused');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ1', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'x', null, array['invoice:' || :'I1'])) = 'evidence_not_found', 'evidence from ANOTHER project is refused');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ1', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'x', null, array['invoice:00000000-0000-4000-8000-0000000fffff'])) = 'evidence_not_found', 'an invented record is refused');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ1', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'x', null, array['somewhere'])) = 'bad_evidence_ref', 'a free-text citation is refused');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ1', :'ORGB', 'finance_reconciliation', 'anomaly_flag', 'x', null, array['invoice:' || :'IW1'])) = 'wrong_organization', 'a payload cannot name another organization');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ1', :'ORG', 'finance_close', 'close_readiness_note', 'x', null, '{}')) = 'wrong_agent', 'the agent must be the request''s');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ1', :'ORG', 'finance_reconciliation', 'reminder_draft', 'x', null, array['invoice:' || :'IW1'])) = 'kind_not_for_this_agent', 'a reconciliation agent cannot write a reminder');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ1', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'leaked token=abcdefghijklmnop12345', null, array['invoice:' || :'IW1'])) = 'secret_in_text', 'a secret value is refused');
-- reminder drafts: the amount is the database's, never the model's
select finance.invoice_outstanding_minor(:'IW1') as "OWED1" \gset
select pg_temp.check(:'OWED1'::bigint = 0, 'the overpaid invoice owes nothing, so no reminder can be drafted for it');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ2', :'ORG', 'finance_communication', 'reminder_draft', 'x', null, '{}', null, 'Please pay the balance.', 1)) = 'nothing_owed', 'a reminder for an invoice with nothing owed is refused');
-- a real balance: IW2 was waived; use a fresh overdue invoice for the drafting rules
select pg_temp.mk_inv(:'ORG', :'A_id', :'PW', null, 'ZP9-W-3', 12000, now() - interval '5 days') as "IW3" \gset
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select request_id as "RQ4" from finance.request_finance_agent_run('finance_communication', :'PW', :'IW3') \gset
select pg_temp.as_service();
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ4', :'ORG', 'finance_communication', 'reminder_draft', 'Reminder for ZP9-W-3', null, '{}', null, 'Dear client, invoice ZP9-W-3 of 12000 is past its due date. Please pay the outstanding balance.', 12000)) = 'proposed', 'a reminder draft quoting the real balance (12000) is recorded');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ4', :'ORG', 'finance_communication', 'reminder_draft', 'wrong amount', null, '{}', null, 'Dear client, invoice ZP9-W-3 of 1 is past its due date.', 1)) = 'amount_is_not_the_balance', 'a draft quoting an amount that is not the invoice''s real balance is refused (the database computes the balance)');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ4', :'ORG', 'finance_communication', 'reminder_draft', 'claims paid', null, '{}', null, 'We have received your payment of 12000, thank you.', 12000)) = 'claims_payment_received', 'a draft that claims payment was received is refused');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ4', :'ORG', 'finance_communication', 'reminder_draft', 'promises', null, '{}', null, 'We can waive the late fee if you pay today.', 12000)) = 'promises_a_concession', 'a draft that promises a waiver is refused');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ4', :'ORG', 'finance_communication', 'reminder_draft', 'discount', null, '{}', null, 'Pay now and get a 10% discount.', 12000)) = 'promises_a_concession', 'a draft that promises a discount is refused');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ4', :'ORG', 'finance_communication', 'reminder_draft', 'acct', null, '{}', null, 'Please pay 12000 to account 123456789012 today.', 12000)) = 'account_number_shaped_text', 'a draft carrying an account-number-shaped string is refused');
-- a close agent: readiness note, and an exception classification a person can accept
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ3', :'ORG', 'finance_close', 'close_readiness_note', 'Project ZP9-SWP is not ready: an overpayment and an overdue balance stand.', null, array['invoice:' || :'IW1'])) = 'proposed', 'a close agent proposes a readiness note');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ3', :'ORG', 'finance_close', 'exception_classification', 'The M2 transfer names another payer.', null, array['invoice:' || :'IW2'], null, null, null, 'wrong_account')) = 'proposed', 'and an exception classification');
select pg_temp.check((select count(*) from finance.finance_proposals where status = 'proposed') = (select count(*) from finance.finance_proposals), 'every proposal is only ever "proposed"');
select pg_temp.check((select count(*) from finance.payments where organization_id = :'ORG') = :'PAY_N0'::bigint and (select coalesce(sum(verified_minor), 0) from finance.invoices where organization_id = :'ORG') = :'VER_0'::numeric and (select count(*) from finance.refunds where organization_id = :'ORG') = :'REF_N0'::bigint, 'NO proposal verified a payment, changed an amount or touched a refund');
select pg_temp.check(pg_temp.refused(format($q$update finance.finance_proposals set summary = 'edited' where request_id = %L$q$, :'RQ1'), 'history'), 'a proposal is history: not editable');
select pg_temp.check(pg_temp.refused(format($q$delete from finance.finance_agent_requests where id = %L$q$, :'RQ1'), 'history'), 'a request is history too');
-- decisions: an INDEPENDENT person
select id as "PR_flag" from finance.finance_proposals where request_id = :'RQ1' and kind = 'anomaly_flag' limit 1 \gset
select id as "PR_draft" from finance.finance_proposals where request_id = :'RQ4' and kind = 'reminder_draft' limit 1 \gset
select id as "PR_note" from finance.finance_proposals where request_id = :'RQ3' and kind = 'close_readiness_note' limit 1 \gset
select id as "PR_class" from finance.finance_proposals where request_id = :'RQ3' and kind = 'exception_classification' limit 1 \gset
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check((select outcome from finance.accept_finance_proposal(:'PR_flag', null)) = 'self_acceptance', 'whoever asked for the work cannot accept it');
select pg_temp.check((select outcome from finance.reject_finance_proposal(:'PR_flag', 'bury it')) = 'self_acceptance', 'nor reject it');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from finance.accept_finance_proposal(:'PR_flag', null)) = 'not_authorized', 'a member cannot decide');
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
select pg_temp.check((select outcome from finance.accept_finance_proposal(:'PR_flag', null)) = 'not_found', 'another organization''s Admin cannot see, so cannot decide, this proposal');
select pg_temp.as_user(:'FIN2', :'ORG', 'finance');
select pg_temp.check((select outcome from finance.accept_finance_proposal(:'PR_flag', 'seen, will review the overpayment')) = 'accepted', 'an independent Finance person accepts the flag');
select pg_temp.check((select outcome from finance.accept_finance_proposal(:'PR_flag', null)) = 'already_decided', 'a decided proposal is final');
select pg_temp.check((select outcome from finance.reject_finance_proposal(:'PR_note', '')) = 'reason_required', 'a rejection needs a reason');
select pg_temp.check((select outcome from finance.reject_finance_proposal(:'PR_note', 'already known')) = 'rejected', 'and can be rejected');
select pg_temp.check((select recorded_outcome from finance.accept_finance_proposal(:'PR_draft', null)) = 'draft_wording_approved_nothing_sent', 'accepting a reminder draft approves its wording and sends nothing');
select pg_temp.check((select count(*) from finance.invoice_sends where invoice_id = :'IW3') = 0, 'no message was sent');
select outcome as "AC_o" from finance.accept_finance_proposal(:'PR_class', null) \gset
select pg_temp.check(:'AC_o' = 'accepted' and exists (select 1 from finance.finance_exceptions where kind = 'wrong_account' and opened_by = :'FIN2'), 'accepting an exception classification opens the exception through the existing door, as the accepting person');
select pg_temp.as_service();
select pg_temp.check((select count(*) from finance.finance_proposal_decisions where proposal_id in (:'PR_flag', :'PR_note', :'PR_draft', :'PR_class')) = 4, 'four decisions are recorded');
select pg_temp.check(pg_temp.refused(format($q$update finance.finance_proposal_decisions set note = 'edited' where proposal_id = %L$q$, :'PR_flag'), 'history'), 'a decision is history');
-- a stale draft
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select request_id as "RQ5" from finance.request_finance_agent_run('finance_communication', :'PW', :'IW3') \gset
select pg_temp.as_service();
select outcome as "R5_o" from finance.record_finance_proposal(:'RQ5', :'ORG', 'finance_communication', 'reminder_draft', 'Second reminder for ZP9-W-3', null, '{}', null, 'Dear client, invoice ZP9-W-3 of 12000 is still unpaid. Please pay the outstanding balance.', 12000) \gset
select pg_temp.check(:'R5_o' = 'proposed', 'a second draft is recorded');
select pg_temp.pay(:'IW3', 5000, 'UTR-P9-W3') as "PAYW3" \gset
select pg_temp.check(pg_temp.verify(:'PAYW3') = 'verified', 'the client pays 5000 of the 12000 and a person verifies it (the invoice is only partly paid, so its status does not give the staleness away)');
select id as "PR_draft2" from finance.finance_proposals where request_id = :'RQ5' limit 1 \gset
select pg_temp.as_user(:'FIN2', :'ORG', 'finance');
select pg_temp.check((select outcome from finance.accept_finance_proposal(:'PR_draft2', null)) = 'stale_draft', 'a draft that quotes a balance that has since been paid is stale and cannot be accepted');
\echo 7. agents OK

-- ═════════ 8. tenancy, RLS, grants ═════════
select pg_temp.as_service();
select pg_temp.check(pg_temp.refused(format($q$insert into finance.finance_exceptions (organization_id, invoice_id, kind, reason) values (%L, %L, 'other', 'cross tenant')$q$, :'ORGB', :'I1'), 'tenancy'), 'an exception row cannot name another organization''s invoice');
select pg_temp.check(pg_temp.refused(format($q$insert into finance.waivers (organization_id, invoice_id, amount_minor, reason, requested_by) values (%L, %L, 100, 'cross tenant', %L)$q$, :'ORGB', :'I1', :'UB'), 'tenancy'), 'a waiver row cannot either');
select pg_temp.check(pg_temp.refused(format($q$insert into finance.close_exceptions (organization_id, project_id, reason, outstanding_at_request_minor, requested_by) values (%L, %L, 'x', 5, %L)$q$, :'ORGB', :'PA', :'UB'), 'tenancy'), 'nor a close exception');
select pg_temp.check(pg_temp.refused(format($q$update finance.finance_exceptions set organization_id = %L where id = %L$q$, :'ORGB', :'X1'), 'immutable') or pg_temp.refused(format($q$update finance.finance_exceptions set organization_id = %L where id = %L$q$, :'ORGB', :'X1'), 'history'), 'an exception does not change tenant');
select pg_temp.as_user(:'ADMIN1', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from finance.finance_exceptions) > 0 and (select count(*) from finance.waivers) > 0 and (select count(*) from finance.project_financial_closes) > 0 and (select count(*) from finance.finance_proposals) > 0, 'an Admin reads the internal finance tables');
select pg_temp.check(pg_temp.denied($q$insert into finance.finance_exceptions (organization_id, project_id, kind, reason) select organization_id, id, 'other', 'direct' from projects.projects limit 1$q$), 'no direct insert into the exception table');
select pg_temp.check(pg_temp.denied($q$update finance.waivers set status = 'approved'$q$) and pg_temp.denied($q$delete from finance.period_closes$q$), 'no direct update of a waiver, no direct delete of a period close');
reset role;
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
set local role authenticated;
select pg_temp.check((select count(*) from finance.finance_exceptions) > 0 and (select count(*) from finance.finance_proposals) > 0, 'a Finance person reads them too');
reset role;
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from finance.finance_exceptions) = 0 and (select count(*) from finance.waivers) = 0 and (select count(*) from finance.close_exceptions) = 0 and (select count(*) from finance.financial_close_evaluations) = 0
  and (select count(*) from finance.project_financial_closes) = 0 and (select count(*) from finance.period_closes) = 0 and (select count(*) from finance.finance_agent_requests) = 0 and (select count(*) from finance.finance_proposals) = 0
  and (select count(*) from finance.finance_proposal_decisions) = 0, 'a member reads none of the internal finance tables');
reset role;
select pg_temp.as_user(:'CLIENT', :'ORG', 'client');
set local role authenticated;
select pg_temp.check((select count(*) from finance.finance_exceptions) = 0 and (select count(*) from finance.waivers) = 0 and (select count(*) from finance.project_financial_closes) = 0 and (select count(*) from finance.finance_proposals) = 0 and (select count(*) from finance.period_closes) = 0,
  'a client of the same organization reads no internal finance table');
reset role;
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from finance.finance_exceptions) = 0 and (select count(*) from finance.waivers) = 0 and (select count(*) from finance.project_financial_closes) = 0 and (select count(*) from finance.finance_proposals) = 0 and (select count(*) from finance.financial_close_evaluations) = 0,
  'an Admin of another organization reads none of them');
select pg_temp.check(pg_temp.denied($q$select * from finance.sweep_finance_exceptions(1)$q$) and pg_temp.denied($q$select finance.invoice_outstanding_minor(gen_random_uuid())$q$), 'the sweep and the balance helper are not callable by a signed-in user');
reset role;
\echo 8. tenancy OK

-- ═════════ 9. the period close: a frozen report, exceptions listed with reasons ═════════
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from finance.close_period(current_date - 2, current_date + 1, 'P9 test period')) = 'not_authorized' and finance.period_close_preview(current_date - 2, current_date + 1) is null, 'a member can neither preview nor close a period');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check((select outcome from finance.close_period(current_date - 2, current_date + 30, 'future')) = 'period_not_ended', 'a period that has not ended cannot be frozen');
select pg_temp.check((select outcome from finance.close_period(current_date, current_date, 'empty')) = 'bad_period', 'a backwards period is refused');
select finance.period_close_preview(current_date - 2, current_date + 1) as "PREV" \gset
select pg_temp.check(jsonb_typeof(:'PREV'::jsonb -> 'projects') = 'array' and jsonb_array_length(:'PREV'::jsonb -> 'exceptions') > 0, 'the preview lists the exceptions standing, each with a reason');
select pg_temp.check(not exists (select 1 from jsonb_array_elements(:'PREV'::jsonb -> 'exceptions') e where nullif(e ->> 'reason', '') is null), 'every listed exception carries a reason');
select pg_temp.check((select (p ->> 'collectedMinor')::bigint from jsonb_array_elements(:'PREV'::jsonb -> 'projects') p where p ->> 'projectId' = :'PA') = 80000
  and (select (p ->> 'refundedMinor')::bigint from jsonb_array_elements(:'PREV'::jsonb -> 'projects') p where p ->> 'projectId' = :'PR') = 4000
  and (select (p ->> 'expensedMinor')::bigint from jsonb_array_elements(:'PREV'::jsonb -> 'projects') p where p ->> 'projectId' = :'PA') = 5000
  and (select (p ->> 'marginMinor')::bigint from jsonb_array_elements(:'PREV'::jsonb -> 'projects') p where p ->> 'projectId' = :'PA') = 75000, 'per-project profit and loss: collected, refunded, expensed and margin are computed in SQL');
select pg_temp.check((select (p ->> 'collectedMinor')::bigint from jsonb_array_elements(:'PREV'::jsonb -> 'projects') p where p ->> 'projectId' = :'PD') = 0 and (:'PREV'::jsonb ->> 'unverifiedMinor')::bigint >= 4000, 'a payment recorded in the period but never verified is NOT in the period''s cash; it is listed apart as unverified');
select pg_temp.check((:'PREV'::jsonb ->> 'waivedMinor')::bigint >= 26000 and (:'PREV'::jsonb -> 'profitAndLoss' ->> 'revenueMinor')::bigint = (:'PREV'::jsonb ->> 'collectedMinor')::bigint - (:'PREV'::jsonb ->> 'refundedMinor')::bigint, 'waived value has its own line and is not in revenue');
select pg_temp.check((select outcome from finance.close_period(current_date - 2, current_date + 1, 'P9 test period')) = 'exceptions_not_acknowledged', 'standing exceptions must be formally documented before a period closes');
select outcome as "PC_o", period_close_id as "PCL" from finance.close_period(current_date - 2, current_date + 1, 'P9 test period', 'p9: the listed exceptions are known and tracked; overpayment on ZP9-W-1 is with the Admin') \gset
select pg_temp.check(:'PC_o' = 'closed', 'with the acknowledgement, the period closes');
select pg_temp.check((select report from finance.period_closes where id = :'PCL') ->> 'periodStart' is not null and (select jsonb_array_length(exceptions) from finance.period_closes where id = :'PCL') > 0, 'the frozen report and its exception list are stored');
select pg_temp.check((select outcome from finance.close_period(current_date - 1, current_date + 1, 'overlap', 'ack')) = 'overlaps_a_closed_period', 'a period overlapping a closed one is refused');
select pg_temp.as_service();
select pg_temp.check(pg_temp.refused(format($q$update finance.period_closes set label = 'edited' where id = %L$q$, :'PCL'), 'history'), 'a closed period''s report cannot be edited');
select pg_temp.check(pg_temp.refused(format($q$delete from finance.period_closes where id = %L$q$, :'PCL'), 'history'), 'nor deleted');
select pg_temp.check(pg_temp.refused(format($q$insert into finance.period_closes (organization_id, period_start, period_end, label, report, invoiced_minor, collected_minor, refunded_minor, waived_minor, expensed_minor, net_minor, exceptions, closed_by) values (%L, current_date - 1, current_date, 'x', '{}', 0, 0, 0, 0, 0, 0, '[]', %L)$q$, :'ORG', :'FIN'), 'overlap'), 'a direct insert cannot overlap either (the trigger holds even without the door)');
select pg_temp.check(pg_temp.refused(format($q$insert into finance.period_closes (organization_id, period_start, period_end, label, report, invoiced_minor, collected_minor, refunded_minor, waived_minor, expensed_minor, net_minor, exceptions, closed_by) values (%L, current_date - 900, current_date - 800, 'x', '{}', 0, 0, 0, 0, 0, 0, '[{"kind":"other"}]', %L)$q$, :'ORG', :'FIN'), 'period_closes'), 'a period with standing exceptions and no acknowledgement cannot be stored even by a direct write (the CHECK holds without the door)');
select pg_temp.check(pg_temp.refused(format($q$insert into finance.expenses (organization_id, project_id, category, description, amount_minor, incurred_on) values (%L, %L, 'tooling', 'late', 100, current_date)$q$, :'ORG', :'PA'), 'closed financial period'), 'an expense dated inside the closed period cannot be added');
select pg_temp.check(pg_temp.refused(format($q$update finance.expenses set amount_minor = 1 where project_id = %L$q$, :'PA'), 'closed financial period'), 'nor changed');
select pg_temp.check(pg_temp.refused(format($q$delete from finance.expenses where project_id = %L$q$, :'PA'), 'closed financial period'), 'nor deleted');
select pg_temp.check((select count(*) from finance.expenses where project_id = :'PA') = 1, 'and the original expense is intact');
insert into finance.expenses (organization_id, project_id, category, description, amount_minor, incurred_on) values (:'ORG', :'PA', 'tooling', 'outside the closed period', 100, current_date - 400);
select pg_temp.check(true, 'an expense dated OUTSIDE any closed period is unaffected');
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
select pg_temp.check((select outcome from finance.close_period(current_date - 2, current_date + 1, 'org b period')) = 'closed', 'another organization closes the same dates independently (periods are per organization)');
\echo 9. period close OK
\echo PHASE 9 FINANCE VERIFIER OK
rollback;
