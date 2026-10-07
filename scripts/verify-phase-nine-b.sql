-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 9B (the open gaps of the Finance Agent phase) driven through the REAL doors on a scratch Postgres.
--
--   1. ReconciliationDue: an Admin sets a cadence; the runner sweep records what is due and OPENS the period, idempotently, and never closes it.
--   2. The per-milestone financial lifecycle is DERIVED (nothing stored) from invoices, verified payments, waivers, refunds and disputes.
--   3. Wrong-account validation is a RECORDED check: a payer / receiving account that does not line up opens a finance exception and changes nothing else.
--   4. A finance-specific automation pause, per organization: the request door and the proposal door both refuse while it stands.
--   5. One validated handoff payload on a finance proposal: the shape as a CHECK, every claim in it against the rows.
--
-- Nothing here verifies a payment, changes an amount, refunds, or messages a client. Fixtures are written the way the runner writes them (no signed-in
-- person); the real doors are then driven as Admin, Finance, a member, a client and another organization. Every count is scoped to this file's own rows.
--
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-nine-b.sql        (rolls back)
-- The measured two-session concurrency proof of the close is scripts/verify-phase-nine-concurrency.sh (it commits rows, so it is not part of this file).
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
-- the statement raises an error whose message contains the needle (any error class)
create or replace function pg_temp.raises(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when others then return position(needle in sqlerrm) > 0; end $$;
grant execute on function pg_temp.raises(text, text) to public;
create or replace function pg_temp.denied(stmt text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when insufficient_privilege then return true; end $$;
grant execute on function pg_temp.denied(text) to public;

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
  select r.outcome into o from finance.verify_payment(p_pay, current_setting('p9b.admin1')::uuid) r;
  perform set_config('request.jwt.claims', coalesce(v_prev, ''), true);
  return o; end $$;
grant execute on function pg_temp.verify(uuid) to public;
create or replace function pg_temp.st(p_project uuid, p_ms uuid) returns text language sql as $$ select l.state from finance.milestone_financial_lifecycle(p_project) l where l.milestone_id = p_ms $$;
grant execute on function pg_temp.st(uuid, uuid) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000009c7'
\set ADMIN1 '00000000-0000-4000-8000-00000000fb11'
\set ADMIN2 '00000000-0000-4000-8000-00000000fb12'
\set FIN '00000000-0000-4000-8000-00000000fb13'
\set FIN2 '00000000-0000-4000-8000-00000000fb14'
\set MEMBER '00000000-0000-4000-8000-00000000fb15'
\set CLIENT '00000000-0000-4000-8000-00000000fb16'
\set UB '00000000-0000-4000-8000-00000000fb17'
select set_config('p9b.admin1', :'ADMIN1', false);

insert into core.organizations (id, name, slug) values (:'ORGB', 'P9B Other Agency', 'p9b-other-agency') on conflict do nothing;
insert into auth.users (id, email) values (:'ADMIN1', 'p9b-a1@example.test'), (:'ADMIN2', 'p9b-a2@example.test'), (:'FIN', 'p9b-f1@example.test'), (:'FIN2', 'p9b-f2@example.test'),
  (:'MEMBER', 'p9b-m@example.test'), (:'CLIENT', 'p9b-c@example.test'), (:'UB', 'p9b-b@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'ADMIN1', 'p9b-a1@example.test', 'P9B Admin One'), (:'ADMIN2', 'p9b-a2@example.test', 'P9B Admin Two'), (:'FIN', 'p9b-f1@example.test', 'P9B Finance One'),
  (:'FIN2', 'p9b-f2@example.test', 'P9B Finance Two'), (:'MEMBER', 'p9b-m@example.test', 'P9B Member'), (:'CLIENT', 'p9b-c@example.test', 'P9B Client'), (:'UB', 'p9b-b@example.test', 'P9B B') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'ADMIN1', 'owner'), (:'ORG', :'ADMIN2', 'ops_admin'), (:'ORG', :'FIN', 'finance'), (:'ORG', :'FIN2', 'finance'),
  (:'ORG', :'MEMBER', 'member'), (:'ORGB', :'UB', 'owner') on conflict do nothing;
insert into core.client_accounts (organization_id, name) values (:'ORG', 'Acme Widgets Pvt Ltd') returning id as "CA" \gset
insert into core.client_accounts (organization_id, name) values (:'ORGB', 'zztest p9b client b') returning id as "CAB" \gset
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'CA', 'zztest p9b main', 'ZP9B-A') returning id as "PA" \gset
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'CA', 'zztest p9b second', 'ZP9B-B') returning id as "PB" \gset
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORGB', :'CAB', 'zztest p9b other org', 'ZP9B-X') returning id as "PO" \gset
insert into finance.payment_accounts (organization_id, kind, label) values (:'ORG', 'bank', 'zztest p9b operating account') returning id as "ACC" \gset
insert into finance.payment_accounts (organization_id, kind, label) values (:'ORGB', 'bank', 'zztest p9b other org account') returning id as "ACCB" \gset

-- ═════════ 1. ReconciliationDue: scheduled by an Admin, opened by the runner, never closed by it ═════════
-- the pure cadence
select pg_temp.check((select (period_start, period_end) = ('2030-01-14'::date, '2030-01-21'::date) from finance.reconciliation_latest_due_period('week', 1, '2030-01-07', '2030-01-21')), 'weekly: on the boundary day the period that just ended is due');
select pg_temp.check((select (period_start, period_end) = ('2030-01-07'::date, '2030-01-14'::date) from finance.reconciliation_latest_due_period('week', 1, '2030-01-07', '2030-01-20')), 'weekly: the day before the boundary the previous period is the latest');
select pg_temp.check(not exists (select 1 from finance.reconciliation_latest_due_period('week', 1, '2030-01-07', '2030-01-13')), 'before the first period has ended nothing is due');
select pg_temp.check(not exists (select 1 from finance.reconciliation_latest_due_period('week', 1, '2030-01-07', '2029-12-01')), 'a day before the anchor nothing is due');
select pg_temp.check((select (period_start, period_end) = ('2030-01-31'::date, '2030-02-28'::date) from finance.reconciliation_latest_due_period('month', 1, '2030-01-31', '2030-03-01')), 'monthly from a month-end anchor: boundaries clamp (Jan 31, Feb 28)');
select pg_temp.check((select (period_start, period_end) = ('2030-01-31'::date, '2030-02-28'::date) from finance.reconciliation_latest_due_period('month', 1, '2030-01-31', '2030-02-28')), 'monthly: on the clamped boundary day itself the period that just ended is due');
select pg_temp.check((select (period_start, period_end) = ('2030-02-28'::date, '2030-03-31'::date) from finance.reconciliation_latest_due_period('month', 1, '2030-01-31', '2030-03-31')), 'and the next boundary returns to the 31st (stepped from the anchor, not from the clamp)');
select pg_temp.check((select (period_start, period_end) = ('2030-01-04'::date, '2030-01-07'::date) from finance.reconciliation_latest_due_period('day', 3, '2030-01-01', '2030-01-08')), 'every three days');
select pg_temp.check(not exists (select 1 from finance.reconciliation_latest_due_period('year', 1, '2030-01-01', '2031-01-01')) and not exists (select 1 from finance.reconciliation_latest_due_period('day', 0, '2030-01-01', '2031-01-01')), 'an unknown unit or a zero count has no period');

-- who may set a cadence
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from finance.set_reconciliation_schedule(:'ACC', 'week', 1, '2030-01-07', 'bank statement')) = 'not_authorized', 'a member cannot set a reconciliation schedule');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check((select outcome from finance.set_reconciliation_schedule(:'ACC', 'week', 1, '2030-01-07', 'bank statement')) = 'not_authorized', 'a Finance person cannot either: the cadence is an Admin''s choice');
select pg_temp.as_service();
select pg_temp.check((select outcome from finance.set_reconciliation_schedule(:'ACC', 'week', 1, '2030-01-07', 'bank statement')) = 'not_authorized', 'and the runner never sets one');
select pg_temp.as_user(:'ADMIN1', :'ORG', 'owner');
select pg_temp.check((select outcome from finance.set_reconciliation_schedule(:'ACC', 'fortnight', 1, '2030-01-07', 'bank statement')) = 'bad_cadence', 'an unknown unit is refused');
select pg_temp.check((select outcome from finance.set_reconciliation_schedule(:'ACC', 'month', 25, '2030-01-07', 'bank statement')) = 'bad_cadence', 'more than 24 months is refused');
select pg_temp.check((select outcome from finance.set_reconciliation_schedule(:'ACC', 'week', 1, null, 'bank statement')) = 'bad_cadence', 'a cadence needs an anchor date (there is no default)');
select pg_temp.check((select outcome from finance.set_reconciliation_schedule(:'ACC', 'week', 1, '2030-01-07', '   ')) = 'bad_input', 'a source is required');
select pg_temp.check((select outcome from finance.set_reconciliation_schedule(:'ACCB', 'week', 1, '2030-01-07', 'bank statement')) = 'not_found', 'another organization''s account cannot be scheduled');
select outcome as "SCH_o", schedule_id as "SCH" from finance.set_reconciliation_schedule(:'ACC', 'week', 1, '2030-01-07', 'bank statement, operating account') \gset
select pg_temp.check(:'SCH_o' = 'set', 'an Admin sets a weekly cadence for the operating account');
select pg_temp.check((select count(*) from finance.reconciliation_schedules where organization_id = :'ORG' and account_id = :'ACC') = 1 and (select cadence_unit || cadence_count from finance.reconciliation_schedules where id = :'SCH') = 'week1', 'it is data the Admin chose');
select pg_temp.check((select outcome from finance.set_reconciliation_schedule(:'ACC', 'week', 2, '2030-01-07', 'bank statement, operating account')) = 'updated', 'setting it again changes the one schedule (one per account)');
select pg_temp.check((select count(*) from finance.reconciliation_schedules where organization_id = :'ORG' and account_id = :'ACC') = 1, 'still exactly one');
select outcome from finance.set_reconciliation_schedule(:'ACC', 'week', 1, '2030-01-07', 'bank statement, operating account') \gset
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
select pg_temp.check((select outcome from finance.set_reconciliation_schedule(:'ACCB', 'month', 1, '2030-01-01', 'other org statement')) = 'set', 'another organization sets its own schedule independently');
-- reads: Finance and Admin only
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from finance.reconciliation_schedules) = 0, 'a member reads no schedule');
reset role;
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
set local role authenticated;
select pg_temp.check((select count(*) from finance.reconciliation_schedules) = 1, 'Finance reads this organization''s schedule and not the other one''s');
select pg_temp.check(pg_temp.denied($q$insert into finance.reconciliation_schedules (organization_id, cadence_unit, cadence_count, anchor_date, source, set_by) values ('00000000-0000-4000-8000-000000000001', 'day', 1, current_date, 'x', '00000000-0000-4000-8000-00000000fb13')$q$), 'nobody writes a schedule directly');
select pg_temp.check(pg_temp.denied(format($q$update finance.reconciliation_schedules set cadence_count = 9 where id = %L$q$, :'SCH')), 'nor edits one');
reset role;

-- the sweep: a person cannot drive it; the runner opens the due period once
select pg_temp.as_user(:'ADMIN1', :'ORG', 'owner');
select due_recorded as "P_due" from finance.sweep_reconciliation_due(100, '2030-01-21') \gset
select pg_temp.check(:'P_due' = 0 and not exists (select 1 from finance.reconciliation_due_items where schedule_id = :'SCH'), 'a signed-in person (even an Admin) cannot drive the sweep: it does nothing');
select pg_temp.as_user(:'ADMIN1', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.denied($q$select * from finance.sweep_reconciliation_due(100, '2030-01-21')$q$), 'and it is not callable by an end user at all');
reset role;
select pg_temp.as_service();
select due_recorded as "S1_due", opened as "S1_open" from finance.sweep_reconciliation_due(100, '2030-01-21') \gset
select pg_temp.check(:'S1_due' >= 1 and :'S1_open' >= 1, 'the runner records the due period and opens it');
select pg_temp.check((select count(*) from finance.reconciliation_due_items where schedule_id = :'SCH') = 1
  and (select state from finance.reconciliation_due_items where schedule_id = :'SCH') = 'opened'
  and (select period_start || '/' || period_end from finance.reconciliation_due_items where schedule_id = :'SCH') = '2030-01-14/2030-01-21', 'one due item for the period that ended, opened');
select reconciliation_id as "REC1" from finance.reconciliation_due_items where schedule_id = :'SCH' \gset
select pg_temp.check((select status = 'open' and opened_by is null and account_id = :'ACC' and source = 'bank statement, operating account' and period_start = '2030-01-14' and period_end = '2030-01-21'
  from finance.reconciliations where id = :'REC1'), 'the reconciliation is open, opened by the system, for that account, source and period');
select pg_temp.check((select count(*) from audit.audit_log where subject_id = :'REC1' and action = 'reconciliation.opened_when_due') = 1, 'the opening is audited');
select due_recorded as "S2_due", opened as "S2_open" from finance.sweep_reconciliation_due(100, '2030-01-21') \gset
select pg_temp.check((select count(*) from finance.reconciliation_due_items where schedule_id = :'SCH') = 1 and (select count(*) from finance.reconciliations where organization_id = :'ORG' and account_id = :'ACC') = 1, 'running it again changes nothing (idempotent)');
select pg_temp.check((select status from finance.reconciliations where id = :'REC1') = 'open', 'the sweep never closes the period it opened');
-- the next period falls due while the previous one is still open: it WAITS (one open period per account), and is not forced
select due_recorded as "S3_due", opened as "S3_open", waiting as "S3_wait" from finance.sweep_reconciliation_due(100, '2030-01-28') \gset
select pg_temp.check((select state from finance.reconciliation_due_items where schedule_id = :'SCH' and period_start = '2030-01-21') = 'waiting'
  and (select count(*) from finance.reconciliations where organization_id = :'ORG' and account_id = :'ACC') = 1, 'while the previous period is still open the next due item waits; no second period is forced open');
select pg_temp.check((select status from finance.reconciliations where id = :'REC1') = 'open', 'and the open one is untouched');
-- somebody closes the first (a person's act), and the next sweep opens the waiting one
update finance.reconciliations set status = 'closed', closed_by = :'ADMIN1', closed_at = now() where id = :'REC1';
select pg_temp.as_service();
select opened as "S4_open", waiting as "S4_wait" from finance.sweep_reconciliation_due(100, '2030-01-28') \gset
select pg_temp.check((select state from finance.reconciliation_due_items where schedule_id = :'SCH' and period_start = '2030-01-21') = 'opened'
  and (select count(*) from finance.reconciliations where organization_id = :'ORG' and account_id = :'ACC' and status = 'open') = 1, 'once the account has no open period the waiting item opens');
select pg_temp.check((select count(*) from finance.reconciliation_due_items where schedule_id = :'SCH') = 2, 'two due items, one per period, never more');
select pg_temp.check(pg_temp.raises(format($q$delete from finance.reconciliation_due_items where schedule_id = %L$q$, :'SCH'), 'history'), 'a due item is never deleted');
select pg_temp.check(pg_temp.raises(format($q$update finance.reconciliation_due_items set period_start = period_start + 1 where schedule_id = %L$q$, :'SCH'), 'history'), 'nor edited once opened');
-- a third period falls due while the second is open: it waits
select due_recorded from finance.sweep_reconciliation_due(100, '2030-02-04') \gset
select pg_temp.check((select state from finance.reconciliation_due_items where schedule_id = :'SCH' and period_start = '2030-01-28') = 'waiting', 'a third due item waits behind the open second period');
-- a disabled schedule is not swept, and a waiting item of a disabled schedule is not opened either
select pg_temp.as_user(:'ADMIN2', :'ORG', 'ops_admin');
select outcome from finance.set_reconciliation_schedule(:'ACC', 'week', 1, '2030-01-07', 'bank statement, operating account', false) \gset
select pg_temp.as_service();
update finance.reconciliations set status = 'closed', closed_by = :'ADMIN1', closed_at = now() where organization_id = :'ORG' and account_id = :'ACC' and status = 'open';
select due_recorded from finance.sweep_reconciliation_due(100, '2030-02-18') \gset
select pg_temp.check((select count(*) from finance.reconciliation_due_items where schedule_id = :'SCH') = 3, 'a switched-off schedule records no new due item');
select pg_temp.check((select state from finance.reconciliation_due_items where schedule_id = :'SCH' and period_start = '2030-01-28') = 'waiting' and not exists (select 1 from finance.reconciliations where organization_id = :'ORG' and account_id = :'ACC' and status = 'open'), 'and a waiting item of a switched-off schedule is not opened even though the account is free');
select pg_temp.check(pg_temp.raises(format($q$insert into finance.reconciliation_schedules (organization_id, account_id, cadence_unit, cadence_count, anchor_date, source, set_by) values (%L, %L, 'day', 1, '2030-01-01', 'duplicate', %L)$q$, :'ORG', :'ACC', :'ADMIN1'), 'reconciliation_schedules_one_per_account'), 'a second schedule for the same account is refused by the table');
select pg_temp.check(pg_temp.raises(format($q$insert into finance.reconciliation_due_items (organization_id, schedule_id, period_start, period_end) values (%L, %L, '2030-03-01', '2030-03-08')$q$, :'ORGB', :'SCH'), 'organization'),
  'a due item cannot point at another organization''s schedule (tenancy trigger)');
\echo 1. ReconciliationDue OK

-- ═════════ 2. the per-milestone financial lifecycle is derived, never stored ═════════
select pg_temp.as_service();
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'PA', 'L1 not invoiced', 1, 10000, 'INR') returning id as "L1" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'PA', 'L2 invoiced', 2, 10000, 'INR') returning id as "L2" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'PA', 'L3 partial', 3, 10000, 'INR') returning id as "L3" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'PA', 'L4 verified', 4, 10000, 'INR') returning id as "L4" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'PA', 'L5 overdue', 5, 10000, 'INR') returning id as "L5" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'PA', 'L6 disputed', 6, 10000, 'INR') returning id as "L6" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'PA', 'L7 waived', 7, 10000, 'INR') returning id as "L7" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'PA', 'L8 refunded', 8, 10000, 'INR') returning id as "L8" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'PA', 'L9 other exception', 9, 10000, 'INR') returning id as "L9" \gset
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORGB', :'PO', 'LX other org', 1, 10000, 'INR') returning id as "LX" \gset
select pg_temp.mk_inv(:'ORG', :'CA', :'PA', :'L2', 'ZP9B-L2', 10000) as "IL2" \gset
select pg_temp.mk_inv(:'ORG', :'CA', :'PA', :'L3', 'ZP9B-L3', 10000) as "IL3" \gset
select pg_temp.mk_inv(:'ORG', :'CA', :'PA', :'L4', 'ZP9B-L4', 10000) as "IL4" \gset
select pg_temp.mk_inv(:'ORG', :'CA', :'PA', :'L5', 'ZP9B-L5', 10000, now() - interval '10 days') as "IL5" \gset
select pg_temp.mk_inv(:'ORG', :'CA', :'PA', :'L6', 'ZP9B-L6', 10000) as "IL6" \gset
select pg_temp.mk_inv(:'ORG', :'CA', :'PA', :'L7', 'ZP9B-L7', 10000) as "IL7" \gset
select pg_temp.mk_inv(:'ORG', :'CA', :'PA', :'L8', 'ZP9B-L8', 10000) as "IL8" \gset
select pg_temp.mk_inv(:'ORG', :'CA', :'PA', :'L9', 'ZP9B-L9', 10000) as "IL9" \gset
select pg_temp.mk_inv(:'ORG', :'CA', :'PA', :'L1', 'ZP9B-L1-DRAFT', 10000, now() + interval '30 days', 'draft') as "IL1D" \gset
select pg_temp.pay(:'IL3', 4000, 'UTR-P9B-L3') as "PL3" \gset
select pg_temp.pay(:'IL4', 10000, 'UTR-P9B-L4') as "PL4" \gset
select pg_temp.pay(:'IL8', 10000, 'UTR-P9B-L8') as "PL8" \gset
select pg_temp.pay(:'IL2', 10000, 'UTR-P9B-L2-UNVERIFIED') as "PL2" \gset
select pg_temp.check(pg_temp.verify(:'PL3') = 'verified' and pg_temp.verify(:'PL4') = 'verified' and pg_temp.verify(:'PL8') = 'verified', 'fixture: three payments verified by the runner path that already existed');
insert into finance.refunds (organization_id, invoice_id, amount_minor, reason, status, provider, provider_refund_id, recorded_at) values (:'ORG', :'IL8', 10000, 'p9b fixture refund', 'recorded', 'manual', 'RF-P9B-1', now());
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select outcome as "EX_o", exception_id as "EX1" from finance.open_finance_exception('chargeback', 'p9b: the bank notified a dispute on L6', :'PA', :'IL6') \gset
select outcome from finance.open_finance_exception('unclear_proof', 'p9b: the screenshot is hard to read', :'PA', :'IL9') \gset
select pg_temp.as_user(:'ADMIN1', :'ORG', 'owner');
select outcome as "WV_o", waiver_id as "WV1" from finance.request_waiver(:'IL7', 10000, 'p9b: forgiven in full, agreed in writing') \gset
select pg_temp.as_user(:'ADMIN2', :'ORG', 'ops_admin');
select outcome from finance.decide_waiver(:'WV1', 'approved', 'p9b: approved') \gset
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check(pg_temp.st(:'PA', :'L1') = 'not_invoiced', 'L1: a draft invoice is not an invoice yet: not_invoiced');
select pg_temp.check(pg_temp.st(:'PA', :'L2') = 'invoiced', 'L2: invoiced, and a payment nobody verified moves nothing: invoiced');
select pg_temp.check(pg_temp.st(:'PA', :'L3') = 'partially_verified', 'L3: 4000 of 10000 verified: partially_verified');
select pg_temp.check(pg_temp.st(:'PA', :'L4') = 'fully_verified', 'L4: verified in full: fully_verified');
select pg_temp.check(pg_temp.st(:'PA', :'L5') = 'overdue', 'L5: a balance past its due date: overdue');
select pg_temp.check(pg_temp.st(:'PA', :'L6') = 'disputed', 'L6: an open chargeback: disputed');
select pg_temp.check(pg_temp.st(:'PA', :'L7') = 'waived', 'L7: an approved waiver covers the rest: waived');
select pg_temp.check(pg_temp.st(:'PA', :'L8') = 'refunded', 'L8: verified, then refunded in full: refunded');
select pg_temp.check(pg_temp.st(:'PA', :'L9') = 'invoiced', 'L9: an open exception that is not a dispute does not make it disputed: invoiced');
select pg_temp.check((select count(*) from finance.milestone_financial_lifecycle(:'PA')) = 9, 'one line per milestone, in plan order');
select pg_temp.check((select string_agg(milestone_position::text, ',' order by ordinality) from finance.milestone_financial_lifecycle(:'PA') with ordinality) = '1,2,3,4,5,6,7,8,9', 'in plan order');
select pg_temp.check(finance.milestone_financial_state(:'L3') = 'partially_verified' and finance.milestone_financial_state(:'L1') = 'not_invoiced', 'the single-milestone read agrees with the project read');
select pg_temp.check((select verified_net_minor from finance.milestone_financial_lifecycle(:'PA') where milestone_id = :'L3') = 4000 and (select outstanding_minor from finance.milestone_financial_lifecycle(:'PA') where milestone_id = :'L3') = 6000, 'the figures beside the state are the close position''s own');
-- derived, so it follows the books with nothing to update
select pg_temp.as_service();
select pg_temp.pay(:'IL3', 6000, 'UTR-P9B-L3B') as "PL3B" \gset
select pg_temp.check(pg_temp.verify(:'PL3B') = 'verified', 'fixture: the remaining 6000 of L3 is verified');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check(pg_temp.st(:'PA', :'L3') = 'fully_verified', 'L3 becomes fully_verified with nothing stored or updated: the state is computed');
select pg_temp.check(not exists (select 1 from information_schema.columns where table_schema in ('projects', 'finance') and table_name in ('milestones', 'invoices') and (column_name ilike '%financial_state%' or column_name ilike '%lifecycle%')), 'no table carries a stored financial-state column');
-- who may read
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select count(*) from finance.milestone_financial_lifecycle(:'PA')) = 0 and finance.milestone_financial_state(:'L2') is null, 'a member reads no lifecycle');
select pg_temp.as_user(:'CLIENT', :'ORG', 'client');
select pg_temp.check((select count(*) from finance.milestone_financial_lifecycle(:'PA')) = 0 and finance.milestone_financial_state(:'L2') is null, 'a client reads no lifecycle');
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
select pg_temp.check((select count(*) from finance.milestone_financial_lifecycle(:'PA')) = 0 and finance.milestone_financial_state(:'L2') is null, 'another organization''s Admin reads no lifecycle of this project (cross-tenant denied)');
select pg_temp.check((select count(*) from finance.milestone_financial_lifecycle(:'PO')) = 1 and finance.milestone_financial_state(:'LX') = 'not_invoiced', 'and reads its own');
select pg_temp.as_user(:'ADMIN1', :'ORG', 'owner');
select pg_temp.check(finance.milestone_financial_state(:'LX') is null, 'this organization''s Admin cannot read the other organization''s milestone');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
set local role authenticated;
select pg_temp.check(pg_temp.denied('select * from finance.phase9b_lifecycle_rows(''00000000-0000-4000-8000-000000000000'')'), 'the unauthorised internal row function is not callable by an end user');
reset role;
\echo 2. lifecycle OK

-- ═════════ 3. wrong-account validation is a recorded check ═════════
select pg_temp.as_service();
select pg_temp.mk_inv(:'ORG', :'CA', :'PB', null, 'ZP9B-W1', 50000) as "IW" \gset
insert into finance.payment_accounts (organization_id, kind, label, status) values (:'ORG', 'upi', 'zztest p9b retired account', 'inactive') returning id as "ACCX" \gset
insert into finance.payment_submissions (organization_id, invoice_id, amount_minor, method, reference, payer_name, submitted_by) values (:'ORG', :'IW', 1000, 'upi', 'UTR-W-OK', 'Acme Widgets', :'FIN') returning id as "SW_OK" \gset
insert into finance.payment_submissions (organization_id, invoice_id, amount_minor, method, reference, payer_name, submitted_by) values (:'ORG', :'IW', 1100, 'upi', 'UTR-W-OK2', 'ACME  widgets private limited', :'FIN') returning id as "SW_OK2" \gset
insert into finance.payment_submissions (organization_id, invoice_id, amount_minor, method, reference, payer_name, submitted_by) values (:'ORG', :'IW', 1200, 'upi', 'UTR-W-NONAME', null, :'FIN') returning id as "SW_NN" \gset
insert into finance.payment_submissions (organization_id, invoice_id, amount_minor, method, reference, payer_name, submitted_by) values (:'ORG', :'IW', 1300, 'upi', 'UTR-W-DIFF', 'Ravi Kumar', :'FIN') returning id as "SW_DIFF" \gset
insert into finance.payment_submissions (organization_id, invoice_id, amount_minor, method, reference, payer_name, account_id, submitted_by) values (:'ORG', :'IW', 1400, 'upi', 'UTR-W-ACC', 'Acme Widgets', :'ACCX', :'FIN') returning id as "SW_ACC" \gset
insert into finance.payment_submissions (organization_id, invoice_id, amount_minor, method, reference, payer_name, account_id, submitted_by) values (:'ORG', :'IW', 1500, 'upi', 'UTR-W-BOTH', 'Somebody Else', :'ACCX', :'FIN') returning id as "SW_BOTH" \gset
insert into finance.payment_submissions (organization_id, invoice_id, amount_minor, method, reference, payer_name, account_id, submitted_by) values (:'ORG', :'IW', 1600, 'upi', 'UTR-W-GOODACC', 'Acme Widgets', :'ACC', :'FIN') returning id as "SW_GOOD" \gset
insert into finance.payment_submissions (organization_id, invoice_id, amount_minor, method, reference, payer_name, submitted_by) values (:'ORG', :'IW', 1700, 'upi', 'UTR-W-MAN', 'Priya Nair', :'FIN') returning id as "SW_MAN" \gset
insert into finance.payment_submissions (organization_id, invoice_id, amount_minor, method, reference, payer_name, submitted_by, status, rejected_reason) values (:'ORG', :'IW', 1800, 'upi', 'UTR-W-REJ', 'Zed Zed', :'FIN', 'rejected', 'p9b fixture: duplicate claim of the same transfer') returning id as "SW_REJ" \gset
insert into finance.payment_accounts (organization_id, kind, label, status, effective_from, effective_to) values (:'ORG', 'bank', 'zztest p9b account whose window ended', 'active', now() - interval '10 days', now() - interval '5 days') returning id as "ACCW" \gset
insert into finance.payment_submissions (organization_id, invoice_id, amount_minor, method, reference, payer_name, account_id, paid_at, submitted_by) values (:'ORG', :'IW', 1900, 'upi', 'UTR-W-WOUT', 'Acme Widgets', :'ACCW', now(), :'FIN') returning id as "SW_WOUT" \gset
insert into finance.payment_submissions (organization_id, invoice_id, amount_minor, method, reference, payer_name, account_id, paid_at, submitted_by) values (:'ORG', :'IW', 2000, 'upi', 'UTR-W-WIN', 'Acme Widgets', :'ACCW', now() - interval '7 days', :'FIN') returning id as "SW_WIN" \gset
insert into finance.payment_submissions (organization_id, invoice_id, amount_minor, method, reference, payer_name, account_id, paid_at, submitted_by) values (:'ORG', :'IW', 2200, 'upi', 'UTR-W-EARLY', 'Acme Widgets', :'ACCW', now() - interval '20 days', :'FIN') returning id as "SW_EARLY" \gset
insert into finance.payment_submissions (organization_id, invoice_id, amount_minor, method, reference, payer_name, submitted_by) values (:'ORG', :'IW', 2100, 'upi', 'UTR-W-FILL', 'Ravi Traders Pvt Ltd', :'FIN') returning id as "SW_FILL" \gset
select count(*) as "PAYN0" from finance.payments where organization_id = :'ORG' \gset
select coalesce(sum(verified_minor), 0) as "VER0" from finance.invoices where organization_id = :'ORG' \gset
select md5(string_agg(s.id::text || s.status || s.amount_minor::text || coalesce(s.payer_name, ''), ',' order by s.id)) as "SUBHASH0" from finance.payment_submissions s where s.invoice_id = :'IW' \gset
-- a person had already recorded the difference on one of them
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select outcome as "MX_o", exception_id as "MX" from finance.open_finance_exception('wrong_account', 'p9b: a person already noticed this payer', :'PB', :'IW', :'SW_MAN') \gset
select pg_temp.check(:'MX_o' = 'opened', 'fixture: a person already recorded a wrong_account exception on one submission');
-- the door a person may call
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from finance.check_payment_account(:'SW_DIFF')) = 'not_authorized', 'a member cannot run the check');
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
select pg_temp.check((select outcome from finance.check_payment_account(:'SW_DIFF')) = 'not_found', 'another organization cannot check this one''s submission');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select outcome as "C_o", exception_id as "C_exc" from finance.check_payment_account(:'SW_DIFF') \gset
select pg_temp.check(:'C_o' = 'payer_differs' and :'C_exc' is not null, 'Finance checks one: the payer shares no word with the client account, so a difference is recorded');
select pg_temp.check((select outcome from finance.check_payment_account(:'SW_DIFF')) = 'already_checked', 'a submission is checked once (idempotent)');
select pg_temp.check((select kind = 'wrong_account' and blocking and state = 'open' and submission_id = :'SW_DIFF' and invoice_id = :'IW' and project_id = :'PB' and opened_by = :'FIN' from finance.finance_exceptions where id = :'C_exc'), 'the exception is a blocking, open wrong_account on that submission, project and invoice');
-- the runner sweep does the rest
select pg_temp.as_user(:'ADMIN1', :'ORG', 'owner');
select checked as "WS_p" from finance.sweep_payment_account_checks(100) \gset
select pg_temp.check(:'WS_p' = 0 and not exists (select 1 from finance.payment_account_checks where submission_id = :'SW_OK'), 'a signed-in person cannot drive the sweep');
select pg_temp.as_service();
select checked as "WS_c", flagged as "WS_f" from finance.sweep_payment_account_checks(500) \gset
select pg_temp.check(:'WS_c' >= 11 and :'WS_f' >= 6, 'the runner checks every unresolved submission that was not checked, and flags the differences');
select pg_temp.check((select outcome from finance.payment_account_checks where submission_id = :'SW_OK') = 'consistent' and (select exception_id from finance.payment_account_checks where submission_id = :'SW_OK') is null, 'the payer shares a significant word with the client account: consistent, no exception');
select pg_temp.check((select outcome from finance.payment_account_checks where submission_id = :'SW_OK2') = 'consistent', 'corporate filler and case do not matter: consistent');
select pg_temp.check((select outcome from finance.payment_account_checks where submission_id = :'SW_NN') = 'consistent', 'an unnamed payer is not a difference');
select pg_temp.check((select outcome from finance.payment_account_checks where submission_id = :'SW_GOOD') = 'consistent', 'a named, active receiving account is consistent');
select pg_temp.check((select outcome from finance.payment_account_checks where submission_id = :'SW_FILL') = 'payer_differs', 'sharing only corporate filler (Pvt Ltd) is not a match');
select pg_temp.check((select outcome from finance.payment_account_checks where submission_id = :'SW_WOUT') = 'account_not_active', 'an account whose effective window had ended when the money was paid is flagged');
select pg_temp.check((select outcome from finance.payment_account_checks where submission_id = :'SW_EARLY') = 'account_not_active', 'and flagged for a payment made before its window began');
select pg_temp.check((select outcome from finance.payment_account_checks where submission_id = :'SW_WIN') = 'consistent', 'the same account is consistent for a payment made inside its window');
select pg_temp.check((select outcome from finance.payment_account_checks where submission_id = :'SW_ACC') = 'account_not_active', 'a retired receiving account is flagged');
select pg_temp.check((select outcome from finance.payment_account_checks where submission_id = :'SW_BOTH') = 'both', 'a different payer AND a retired account: both');
select pg_temp.check((select count(*) from finance.finance_exceptions where invoice_id = :'IW' and kind = 'wrong_account' and state = 'open') = 7, 'exactly seven open wrong_account exceptions (diff, retired account, both, the person''s own, filler-only match, window ended, window not begun)');
select pg_temp.check((select exception_id from finance.payment_account_checks where submission_id = :'SW_MAN') = :'MX' and (select count(*) from finance.finance_exceptions where submission_id = :'SW_MAN' and kind = 'wrong_account') = 1, 'a difference a person already recorded is LINKED, not duplicated');
select pg_temp.check(not exists (select 1 from finance.payment_account_checks where submission_id = :'SW_REJ'), 'a submission that is already rejected is not swept');
select pg_temp.check((select opened_by_system and opened_by is null from finance.finance_exceptions where id = (select exception_id from finance.payment_account_checks where submission_id = :'SW_ACC')), 'what the sweep opens is opened by the system');
select checked as "WS2_c" from finance.sweep_payment_account_checks(500) \gset
select pg_temp.check(:'WS2_c' = 0 and (select count(*) from finance.finance_exceptions where invoice_id = :'IW' and kind = 'wrong_account' and state = 'open') = 7 and (select count(*) from finance.payment_account_checks where invoice_id = :'IW') = 12, 'running the sweep again records nothing new (idempotent)');
-- it changed nothing it checked
select pg_temp.check((select count(*) from finance.payments where organization_id = :'ORG') = :'PAYN0'::bigint and (select coalesce(sum(verified_minor), 0) from finance.invoices where organization_id = :'ORG') = :'VER0'::bigint, 'no payment was created, verified or changed');
select pg_temp.check((select md5(string_agg(s.id::text || s.status || s.amount_minor::text || coalesce(s.payer_name, ''), ',' order by s.id)) from finance.payment_submissions s where s.invoice_id = :'IW') = :'SUBHASH0', 'no submission was changed (status, amount, payer)');
-- the blocker reaches the close, and the check is history
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check(exists (select 1 from jsonb_array_elements(finance.project_close_position(:'PB') -> 'blockers') b where b ->> 'code' = 'open_exception' and b ->> 'kind' = 'wrong_account'), 'the open wrong_account exception blocks the project close, with its reason');
select pg_temp.as_service();
select pg_temp.check(pg_temp.raises(format($q$update finance.payment_account_checks set outcome = 'consistent' where submission_id = %L$q$, :'SW_DIFF'), 'history'), 'a recorded check is never edited');
select pg_temp.check(pg_temp.raises(format($q$delete from finance.payment_account_checks where submission_id = %L$q$, :'SW_DIFF'), 'history'), 'nor deleted');
select pg_temp.check(pg_temp.raises(format($q$insert into finance.payment_account_checks (organization_id, submission_id, invoice_id, client_account_id, outcome, client_name) values (%L, %L, %L, %L, 'consistent', 'x')$q$, :'ORG', :'SW_REJ', :'IW', :'CAB'), 'organization'),
  'a check cannot carry another organization''s client account (tenancy trigger)');
select pg_temp.check(pg_temp.raises(format($q$insert into finance.payment_account_checks (organization_id, submission_id, invoice_id, client_account_id, outcome, client_name) values (%L, %L, %L, %L, 'payer_differs', 'x')$q$, :'ORG', :'SW_REJ', :'IW', :'CA'), 'payment_account_checks'),
  'a difference without an exception is refused by the table itself');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from finance.payment_account_checks) = 0, 'a member reads no check');
reset role;
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from finance.payment_account_checks where invoice_id = :'IW') = 0, 'another organization reads none of this one''s checks');
select pg_temp.check(pg_temp.denied(format($q$insert into finance.payment_account_checks (organization_id, submission_id, invoice_id, client_account_id, outcome, client_name) values (%L, %L, %L, %L, 'consistent', 'x')$q$, :'ORGB', :'SW_REJ', :'IW', :'CAB')), 'and nobody writes a check directly');
reset role;
\echo 3. wrong-account OK

-- ═════════ 4. the finance automation pause, per organization ═════════
select pg_temp.as_service();
select pg_temp.mk_inv(:'ORG', :'CA', :'PB', null, 'ZP9B-P1', 20000) as "IP" \gset
select pg_temp.as_user(:'FIN2', :'ORG', 'finance');
select request_id as "RQ_A" from finance.request_finance_agent_run('finance_reconciliation', :'PB') \gset
select request_id as "RQ_C" from finance.request_finance_agent_run('finance_close', :'PB') \gset
select pg_temp.check(:'RQ_A' is not null and :'RQ_C' is not null, 'fixture: two runs requested while nothing is paused');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check((select outcome from finance.set_finance_automation_paused('finance_close', true, 'p9b: pausing')) = 'not_authorized', 'a Finance person cannot pause automation: an Admin does');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from finance.set_finance_automation_paused('finance_close', true, 'p9b: pausing')) = 'not_authorized', 'a member cannot');
select pg_temp.as_service();
select pg_temp.check((select outcome from finance.set_finance_automation_paused('finance_close', true, 'p9b: pausing')) = 'not_authorized', 'and the runner cannot pause or resume itself');
select pg_temp.as_user(:'ADMIN1', :'ORG', 'owner');
select pg_temp.check((select outcome from finance.set_finance_automation_paused('functional_test', true, 'x')) = 'bad_agent', 'only the finance agents or all');
select pg_temp.check((select outcome from finance.set_finance_automation_paused('finance_close', true, '   ')) = 'reason_required', 'a reason is required');
select pg_temp.check((select outcome from finance.set_finance_automation_paused('finance_close', true, 'api_key=abcdefghijklmnop1234')) = 'reason_required', 'and it is not a place for a secret');
select pg_temp.check((select outcome from finance.set_finance_automation_paused('finance_close', false, 'p9b: nothing was paused')) = 'unchanged', 'resuming what is not paused changes nothing');
select pg_temp.check((select outcome from finance.set_finance_automation_paused('finance_close', true, 'p9b: investigating a figure')) = 'paused', 'an Admin pauses the finance close agent for this organization');
select pg_temp.check((select outcome from finance.set_finance_automation_paused('finance_close', true, 'again')) = 'unchanged', 'pausing twice changes nothing');
select pg_temp.as_service();
select pg_temp.check(finance.finance_automation_is_paused(:'ORG', 'finance_close') and not finance.finance_automation_is_paused(:'ORG', 'finance_reconciliation'), 'the runner sees that agent paused and the others not');
select pg_temp.check(not finance.finance_automation_is_paused(:'ORGB', 'finance_close'), 'another organization is not paused');
select pg_temp.as_user(:'ADMIN1', :'ORG', 'owner');
select pg_temp.check(not finance.finance_automation_is_paused(:'ORG', 'finance_close'), 'the runner question answers nothing to a signed-in person');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check((select outcome from finance.request_finance_agent_run('finance_close', :'PB')) = 'automation_paused', 'while paused, a run of that agent cannot be requested: nothing is queued');
select pg_temp.check((select count(*) from finance.finance_agent_requests where project_id = :'PB' and agent_key = 'finance_close') = 1, 'and no new request row exists');
select pg_temp.check((select outcome from finance.request_finance_agent_run('finance_reconciliation', :'PB')) = 'requested', 'another finance agent still runs');
select pg_temp.as_service();
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_C', :'ORG', 'finance_close', 'close_readiness_note', 'a run that began before the pause', null, '{}')) = 'automation_paused', 'a run that was already in flight cannot WRITE while that agent is paused');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_A', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'a different agent is unaffected', null, array['invoice:' || :'IP'])) = 'proposed', 'an agent that is not paused still writes');
select pg_temp.as_user(:'ADMIN2', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from finance.set_finance_automation_paused('all', true, 'p9b: stop everything finance')) = 'paused', 'an Admin pauses ALL finance automation');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check((select outcome from finance.request_finance_agent_run('finance_reconciliation', :'PB')) = 'automation_paused', 'all: the reconciliation agent is stopped too');
select pg_temp.as_service();
select pg_temp.check(finance.finance_automation_is_paused(:'ORG', 'finance_communication'), 'all: every finance agent is paused');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_A', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'paused by all', null, array['invoice:' || :'IP'])) = 'automation_paused', 'all: no proposal is written');
select pg_temp.as_user(:'ADMIN1', :'ORG', 'owner');
select pg_temp.check((select outcome from finance.set_finance_automation_paused('all', false, 'p9b: resumed')) = 'resumed' and (select outcome from finance.set_finance_automation_paused('finance_close', false, 'p9b: figure explained')) = 'resumed', 'an Admin resumes, with a reason');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check((select outcome from finance.request_finance_agent_run('finance_close', :'PB')) = 'requested', 'after the resume the run is requested again');
select pg_temp.check((select count(*) from finance.finance_automation_changes where organization_id = :'ORG') = 4 and (select count(*) from finance.finance_automation_changes where organization_id = :'ORG' and paused) = 2, 'every pause and resume is in the history, with who and why');
select pg_temp.as_service();
select pg_temp.check(pg_temp.raises($q$update finance.finance_automation_changes set reason = 'edited'$q$, 'history'), 'the history is append-only');
select pg_temp.check(pg_temp.raises($q$delete from finance.finance_automation_controls$q$, 'history'), 'and the current state is never deleted');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from finance.finance_automation_controls) = 0 and (select count(*) from finance.finance_automation_changes) = 0, 'a member reads neither');
reset role;
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
set local role authenticated;
select pg_temp.check((select count(*) from finance.finance_automation_controls) = 2, 'Finance reads this organization''s two control rows');
select pg_temp.check(pg_temp.denied($q$update finance.finance_automation_controls set paused = true$q$), 'and cannot write them directly');
reset role;
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
select pg_temp.check((select outcome from finance.set_finance_automation_paused('all', true, 'p9b: other org pause')) = 'paused', 'another organization pauses itself');
select pg_temp.as_service();
select pg_temp.check(not finance.finance_automation_is_paused(:'ORG', 'finance_close') and finance.finance_automation_is_paused(:'ORGB', 'finance_close'), 'and that does not touch this organization');
\echo 4. pause OK

-- ═════════ 5. one validated handoff payload on a finance proposal ═════════
select pg_temp.as_service();
select pg_temp.mk_inv(:'ORG', :'CA', :'PB', null, 'ZP9B-H1', 30000) as "IH" \gset
select pg_temp.mk_inv(:'ORG', :'CA', :'PA', null, 'ZP9B-H2', 7000) as "IHOTHER" \gset
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select request_id as "RQ_H" from finance.request_finance_agent_run('finance_reconciliation', :'PB') \gset
select request_id as "RQ_HC" from finance.request_finance_agent_run('finance_communication', :'PB', :'IH') \gset
select pg_temp.as_service();
select jsonb_build_object('schemaVersion', 1, 'organizationId', :'ORG', 'clientAccountId', :'CA', 'projectId', :'PB', 'requestId', :'RQ_H', 'agentKey', 'finance_reconciliation', 'kind', 'anomaly_flag',
  'milestoneId', null, 'invoiceId', :'IH', 'expectedAmountMinor', 30000, 'currency', 'INR', 'financialState', 'blocked', 'evidenceRefs', jsonb_build_array('invoice:' || :'IH'),
  'policy', jsonb_build_object('ref', 'phase9.finance-agent', 'moneyAuthority', 'none'), 'approvals', jsonb_build_object('requestedBy', :'FIN2', 'independentReviewRequired', true),
  'priority', 'normal', 'blockers', '[]'::jsonb, 'correlationId', 'corr-1', 'retry', jsonb_build_object('attempt', 0, 'maxAttempts', 5))::text as "H0" \gset
-- the requester of RQ_H was FIN, not FIN2
select requested_by as "REQBY" from finance.finance_agent_requests where id = :'RQ_H' \gset
select jsonb_set(:'H0'::jsonb, '{approvals,requestedBy}', to_jsonb(:'REQBY'::text))::text as "H1" \gset
select pg_temp.check(finance.phase9b_handoff_shape_ok(null) and finance.phase9b_handoff_shape_ok(:'H1'::jsonb), 'the shape check accepts null (a legacy proposal) and a complete payload');
select pg_temp.check(not finance.phase9b_handoff_shape_ok((:'H1'::jsonb) - 'blockers') and not finance.phase9b_handoff_shape_ok((:'H1'::jsonb) - 'retry') and not finance.phase9b_handoff_shape_ok((:'H1'::jsonb) - 'approvals'), 'a missing key is refused by the shape');
select pg_temp.check(not finance.phase9b_handoff_shape_ok(jsonb_set(:'H1'::jsonb, '{priority}', '"urgent"')) and not finance.phase9b_handoff_shape_ok(jsonb_set(:'H1'::jsonb, '{schemaVersion}', '2')), 'an unknown priority or version is refused');
select pg_temp.check(not finance.phase9b_handoff_shape_ok(jsonb_set(:'H1'::jsonb, '{policy,moneyAuthority}', '"full"')), 'a payload that claims money authority is refused by the shape');
select pg_temp.check(not finance.phase9b_handoff_shape_ok(jsonb_set(:'H1'::jsonb, '{approvals,independentReviewRequired}', 'false')), 'a payload that waives the independent review is refused by the shape');
select pg_temp.check(not finance.phase9b_handoff_shape_ok(jsonb_set(:'H1'::jsonb, '{blockers}', '"none"')) and not finance.phase9b_handoff_shape_ok('[]'::jsonb), 'blockers must be an array and the payload an object');
-- the door
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_H', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'legacy call with no handoff', null, array['invoice:' || :'IH'])) = 'proposed', 'a legacy call without a handoff still works');
select outcome as "HP_o", proposal_id as "HP" from finance.record_finance_proposal(:'RQ_H', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'with a handoff', null, array['invoice:' || :'IH'], null, null, null, null, :'H1'::jsonb) \gset
select pg_temp.check(:'HP_o' = 'proposed', 'a consistent handoff is accepted');
select pg_temp.check((select handoff ->> 'requestId' = :'RQ_H' and handoff ->> 'schemaVersion' = '1' and handoff -> 'policy' ->> 'moneyAuthority' = 'none' from finance.finance_proposals where id = :'HP'), 'and stored as validated jsonb on the proposal');
select pg_temp.check((select handoff is null from finance.finance_proposals where summary = 'legacy call with no handoff' and request_id = :'RQ_H'), 'the legacy proposal carries none');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_H', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'shape broken', null, array['invoice:' || :'IH'], null, null, null, null, ((:'H1'::jsonb) - 'retry'))) = 'bad_handoff', 'a payload with the wrong shape is refused: bad_handoff');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_H', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'secret inside', null, array['invoice:' || :'IH'], null, null, null, null, jsonb_set(:'H1'::jsonb, '{correlationId}', '"token=abcdefghijklmnop12345"'))) = 'bad_handoff', 'a secret inside the payload is refused');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_H', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'other org', null, array['invoice:' || :'IH'], null, null, null, null, jsonb_set(:'H1'::jsonb, '{organizationId}', to_jsonb(:'ORGB'::text)))) = 'handoff_disagrees_with_the_request', 'the payload cannot name another organization (the request''s rows are the authority)');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_H', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'other project', null, array['invoice:' || :'IH'], null, null, null, null, jsonb_set(:'H1'::jsonb, '{projectId}', to_jsonb(:'PA'::text)))) = 'handoff_disagrees_with_the_request', 'nor another project');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_H', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'other request', null, array['invoice:' || :'IH'], null, null, null, null, jsonb_set(:'H1'::jsonb, '{requestId}', to_jsonb(:'RQ_HC'::text)))) = 'handoff_disagrees_with_the_request', 'nor another request');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_H', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'other agent', null, array['invoice:' || :'IH'], null, null, null, null, jsonb_set(:'H1'::jsonb, '{agentKey}', '"finance_close"'))) = 'handoff_disagrees_with_the_request', 'nor another agent');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_H', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'other kind', null, array['invoice:' || :'IH'], null, null, null, null, jsonb_set(:'H1'::jsonb, '{kind}', '"reconciliation_finding"'))) = 'handoff_disagrees_with_the_request', 'nor another kind');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_H', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'other requester', null, array['invoice:' || :'IH'], null, null, null, null, jsonb_set(:'H1'::jsonb, '{approvals,requestedBy}', to_jsonb(:'FIN2'::text)))) = 'handoff_disagrees_with_the_request', 'nor claim a different requester (who may not accept it)');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_H', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'other evidence', null, array['invoice:' || :'IH'], null, null, null, null, jsonb_set(:'H1'::jsonb, '{evidenceRefs}', jsonb_build_array('invoice:' || :'IHOTHER')))) = 'handoff_disagrees_with_the_request', 'the handoff''s evidence is exactly the proposal''s evidence');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_H', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'other client', null, array['invoice:' || :'IH'], null, null, null, null, jsonb_set(:'H1'::jsonb, '{clientAccountId}', to_jsonb(:'CAB'::text)))) = 'handoff_disagrees_with_the_request', 'the client account is the project''s');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_H', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'invoice of another project', null, array['invoice:' || :'IH'], null, null, null, null, jsonb_set(:'H1'::jsonb, '{invoiceId}', to_jsonb(:'IHOTHER'::text)))) = 'handoff_disagrees_with_the_request', 'an invoice of another project is refused');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_H', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'milestone of another project', null, array['invoice:' || :'IH'], null, null, null, null, jsonb_set(:'H1'::jsonb, '{milestoneId}', to_jsonb(:'L2'::text)))) = 'handoff_disagrees_with_the_request', 'a milestone of another project is refused');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_H', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'amount not the balance', null, array['invoice:' || :'IH'], null, null, null, null, jsonb_set(:'H1'::jsonb, '{expectedAmountMinor}', '1'))) = 'handoff_amount_is_not_the_balance', 'an expected amount that is not the database''s balance is refused');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_H', :'ORG', 'finance_reconciliation', 'anomaly_flag', 'amount without an invoice', null, array['invoice:' || :'IH'], null, null, null, null, jsonb_set(jsonb_set(:'H1'::jsonb, '{invoiceId}', 'null'), '{expectedAmountMinor}', '30000'))) = 'handoff_amount_is_not_the_balance', 'and an amount with no invoice behind it');
select pg_temp.check((select count(*) from finance.finance_proposals where request_id = :'RQ_H') = 2, 'every refused payload left no proposal behind');
select pg_temp.check(pg_temp.raises(format($q$insert into finance.finance_proposals (organization_id, request_id, project_id, agent_key, kind, summary, evidence_refs, requested_by, handoff) values (%L, %L, %L, 'finance_reconciliation', 'anomaly_flag', 'direct bad handoff', array['x'], %L, '{"schemaVersion": 1}')$q$, :'ORG', :'RQ_H', :'PB', :'REQBY'), 'finance_proposals_handoff_shape'), 'the table CHECK refuses a malformed handoff even from a direct write');
-- a reminder's handoff names the request's invoice and the database's balance
select requested_by as "REQBYC" from finance.finance_agent_requests where id = :'RQ_HC' \gset
select jsonb_set(jsonb_set(jsonb_set(jsonb_set(:'H1'::jsonb, '{requestId}', to_jsonb(:'RQ_HC'::text)), '{agentKey}', '"finance_communication"'), '{kind}', '"reminder_draft"'), '{approvals,requestedBy}', to_jsonb(:'REQBYC'::text))::text as "HC" \gset
select jsonb_set(:'HC'::jsonb, '{evidenceRefs}', '[]'::jsonb)::text as "HC2" \gset
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_HC', :'ORG', 'finance_communication', 'reminder_draft', 'Reminder for ZP9B-H1', null, '{}', null, 'Dear client, invoice ZP9B-H1 of 30000 is past due. Please arrange the balance.', 30000, null, :'HC2'::jsonb)) = 'proposed', 'a reminder draft with its handoff (invoice = the request''s, amount = the balance) is accepted');
select pg_temp.check((select outcome from finance.record_finance_proposal(:'RQ_HC', :'ORG', 'finance_communication', 'reminder_draft', 'Reminder, other invoice', null, '{}', null, 'Dear client, the balance of 30000 is past due.', 30000, null, jsonb_set(jsonb_set(:'HC2'::jsonb, '{invoiceId}', 'null'), '{expectedAmountMinor}', 'null'))) = 'handoff_disagrees_with_the_request', 'a reminder handoff that names no invoice is refused');
\echo 5. handoff OK
\echo PHASE 9B VERIFIER OK
rollback;
