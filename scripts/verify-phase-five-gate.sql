-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 financial gate, driven for real on a scratch Postgres.
--
-- Phase 4 Finance spec: ONLY an Admin-verified M2 payment opens Phase 5. Phase4Completed, an
-- issued invoice, money recorded, a submission or a proof must each leave it closed, and the
-- refusal must be the server's, not the UI's.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-five-gate.sql
-- Rolls back. Any failed check raises.
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

\set ORG '00000000-0000-4000-8000-000000000001'
\set U '00000000-0000-4000-8000-00000000f501'

insert into auth.users (id, email) values (:'U', 'p5gate-owner@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'U', 'p5gate-owner@example.test', 'P5 Gate Owner') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'U', 'owner') on conflict do nothing;

create temp table fx (k text primary key, v uuid);
grant all on fx to public;

-- ── fixtures (as the service role, as a finance verifier would leave them) ──
set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true);
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p5 gate client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p5 gate', 'ZP5-GATE') returning id \gset P_
insert into projects.modules (organization_id, project_id, name) values (:'ORG', :'P_id', 'zztest module') returning id \gset M_
insert into projects.tasks (organization_id, project_id, title, module_id, status) values (:'ORG', :'P_id', 'zztest dev task', :'M_id', 'todo') returning id \gset T_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORG', :'P_id', 'zztest non-development task', 'todo') returning id \gset N_
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'P_id', 'zztest M1', 1, 50000, 'INR');
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'P_id', 'zztest M2', 2, 100000, 'INR') returning id \gset MS2_
reset role;

-- ── 1. no M2 invoice at all ────────────────────────────────────────────────
select pg_temp.as_user(:'U', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_task(:'T_id')) = 'm2_not_verified', 'a development task cannot start with no M2 invoice');
select pg_temp.check((select outcome from projects.phase_five_gate_status(:'P_id')) <> 'verified', 'the gate status is not verified');
select pg_temp.check((select outcome from projects.start_task(:'N_id')) <> 'm2_not_verified', 'a task attached to no module or feature is not a Phase 5 task and is not held by the gate');
reset role;

-- ── 2. issued invoice ─────────────────────────────────────────────────────
set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true);
insert into finance.invoices (organization_id, client_account_id, project_id, milestone_id, number, status, currency, subtotal_minor, total_minor, issued_at, kind)
  values (:'ORG', :'A_id', :'P_id', :'MS2_id', 'ZP5-M2', 'issued', 'INR', 100000, 100000, now(), 'milestone') returning id \gset I_
reset role;
select pg_temp.as_user(:'U', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_task(:'T_id')) = 'm2_not_verified', 'an ISSUED M2 invoice does not open Phase 5');
select pg_temp.check((select outcome from projects.phase_five_gate_status(:'P_id')) = 'invoice_issued', 'gate status says invoice_issued');
reset role;

-- ── 3. money recorded but not verified; and status paid without verified money ──
set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true);
update finance.invoices set paid_minor = 100000 where id = :'I_id';
reset role;
select pg_temp.as_user(:'U', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_task(:'T_id')) = 'm2_not_verified', 'money RECORDED but not verified does not open Phase 5');
reset role;
set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true);
update finance.invoices set status = 'paid', paid_at = now(), verified_minor = 40000 where id = :'I_id';
reset role;
select pg_temp.as_user(:'U', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.phase_five_gate_status(:'P_id')) <> 'verified', 'status=paid with only PART of the amount verified: the panel no longer says verified (it used to)');
select pg_temp.check((select outcome from projects.start_task(:'T_id')) = 'm2_not_verified', 'part-verified payment does not open Phase 5');
reset role;

-- ── 4. fully verified ──────────────────────────────────────────────────────
set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true);
update finance.invoices set verified_minor = 100000 where id = :'I_id';
reset role;
select pg_temp.as_user(:'U', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.phase_five_gate_status(:'P_id')) = 'verified', 'fully verified M2: gate status verified');
select pg_temp.check((select outcome from projects.start_task(:'T_id')) <> 'm2_not_verified', 'fully verified M2: the gate no longer holds the task (any further refusal is a different, ordinary check)');
reset role;

rollback;
\echo ALL PHASE 5 GATE CHECKS PASSED
