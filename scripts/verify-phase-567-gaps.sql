-- ═══════════════════════════════════════════════════════════════════════════
-- Phases 5, 6, 7 gap closure (and two Phase 8 hardening items), driven through the REAL doors on a scratch Postgres, then RED-PROVEN: each control is
-- removed from the live function definition, the check is watched to fail, and the definition is restored. A no-op mutation raises.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-567-gaps.sql        (rolls back)
--
-- No model, payment provider, deployment host, monitoring source or client ran. Every client decision and every payment here is a fixture row.
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
create or replace function pg_temp.as_client(p_sub uuid, p_org uuid, p_account uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
  'app_metadata', jsonb_build_object('organization_id', p_org, 'role', 'client_member', 'client_account_id', p_account))::text, true); end $$;
grant execute on function pg_temp.as_client(uuid, uuid, uuid) to public;
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
-- red-proof helper: swap a fragment of the LIVE definition, return the saved definition. A fragment that is not there raises: a no-op mutation proves nothing.
create or replace function pg_temp.mutate(p_fn regprocedure, p_from text, p_to text) returns text language plpgsql as $$
declare v_def text := pg_get_functiondef(p_fn);
begin
  if position(p_from in v_def) = 0 then raise exception 'RED-PROOF NO-OP: % does not contain %', p_fn, p_from; end if;
  execute replace(v_def, p_from, p_to);
  return v_def;
end $$;
grant execute on function pg_temp.mutate(regprocedure, text, text) to public;
create or replace function pg_temp.restore(p_def text) returns void language plpgsql as $$ begin execute p_def; end $$;
grant execute on function pg_temp.restore(text) to public;

\set ORG '00000000-0000-4000-8000-0000000567a1'
\set ORGB '00000000-0000-4000-8000-0000000567b1'
\set OWNER '00000000-0000-4000-8000-00000056f901'
\set ADM '00000000-0000-4000-8000-00000056f902'
\set DEV '00000000-0000-4000-8000-00000056f903'
\set QA '00000000-0000-4000-8000-00000056f904'
\set UB '00000000-0000-4000-8000-00000056f905'
\set CL '00000000-0000-4000-8000-00000056f906'
\set C1 '1111111111111111111111111111111111111111'
\set C2 '2222222222222222222222222222222222222222'
insert into core.organizations (id, name, slug) values (:'ORG', 'G567 Agency', 'g567-agency'), (:'ORGB', 'G567 Other Agency', 'g567-other');
insert into auth.users (id, email) values (:'OWNER','g-o@example.test'),(:'ADM','g-a@example.test'),(:'DEV','g-d@example.test'),(:'QA','g-q@example.test'),(:'UB','g-b@example.test'),(:'CL','g-c@example.test');
insert into core.memberships (organization_id, user_id, role) values (:'ORG',:'OWNER','owner'),(:'ORG',:'ADM','ops_admin'),(:'ORG',:'DEV','member'),(:'ORG',:'QA','member'),(:'ORGB',:'UB','owner');

-- ───────── fixture (triggers off: the spine that makes these rows is other verifiers' business) ─────────
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest g567 client') returning id \gset A_
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest g567 other client') returning id \gset AO_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest g567 main', 'ZG567-1') returning id \gset P_
set local session_replication_role = replica;
insert into projects.maintenance_items (organization_id, client_account_id, project_id, title, coverage) values (:'ORG', :'A_id', :'P_id', 'g ticket 1', 'maintenance') returning id \gset T1_
insert into projects.maintenance_items (organization_id, client_account_id, project_id, title, coverage) values (:'ORG', :'A_id', :'P_id', 'g ticket 2', 'maintenance') returning id \gset T2_
insert into projects.maintenance_items (organization_id, client_account_id, project_id, title, coverage) values (:'ORG', :'A_id', :'P_id', 'g ticket 3', 'maintenance') returning id \gset T3_
-- a database change the author did NOT mark sensitive; a database change marked sensitive; a frontend change marked sensitive
insert into projects.maintenance_work_items (organization_id, client_account_id, project_id, kind, area, title, ticket_id, sensitive, status, commit_ref, commit_submitted_by, commit_submitted_at, created_by, created_at)
  values (:'ORG', :'A_id', :'P_id', 'patch', 'database', 'unmarked db change', :'T1_id', false, 'fix_submitted', :'C1', :'DEV', now(), :'DEV', now() + interval '1 hour') returning id \gset WD_
insert into projects.maintenance_work_items (organization_id, client_account_id, project_id, kind, area, title, ticket_id, sensitive, status, commit_ref, commit_submitted_by, commit_submitted_at, created_by, created_at)
  values (:'ORG', :'A_id', :'P_id', 'patch', 'database', 'marked db change', :'T2_id', true, 'fix_submitted', :'C1', :'DEV', now(), :'DEV', now() + interval '1 hour') returning id \gset WS_
insert into projects.maintenance_work_items (organization_id, client_account_id, project_id, kind, area, title, ticket_id, sensitive, status, commit_ref, commit_submitted_by, commit_submitted_at, created_by, created_at)
  values (:'ORG', :'A_id', :'P_id', 'patch', 'frontend', 'frontend change', :'T3_id', true, 'fix_submitted', :'C1', :'DEV', now(), :'DEV', now() + interval '1 hour') returning id \gset WF_
set local session_replication_role = origin;
-- the cutover must be earlier than the fixtures (the control is for new work)
update projects.maintenance_c_cutover set data_safety_from = now() - interval '1 day';

-- ═════════ 1. the data-safety gate keys on area = database, whatever the author ticked ═════════
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select passed from projects.evaluate_maintenance_gates(:'WD_id') where gate = 'data_safety') = false, 'a database change the author did NOT mark sensitive still needs data safety');
select pg_temp.check((select passed from projects.evaluate_maintenance_gates(:'WS_id') where gate = 'data_safety') = false, 'a database change marked sensitive needs data safety');
select pg_temp.check((select passed from projects.evaluate_maintenance_gates(:'WF_id') where gate = 'data_safety') = true, 'a frontend change needs no data-safety record, sensitive or not');
reset role;
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_maintenance_data_safety(:'WD_id', :'C1', 'restore the snapshot', 'backup-snap-1')) = 'self_confirmation', 'the author of the commit still cannot confirm their own backup');
reset role;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_maintenance_data_safety(:'WF_id', :'C1', 'x', 'y')) = 'not_a_sensitive_database_change', 'a non-database change takes no data-safety record');
select pg_temp.check((select outcome from projects.record_maintenance_data_safety(:'WD_id', :'C1', 'restore the snapshot', 'backup-snap-1')) = 'recorded', 'an independent person records data safety for the unmarked database change');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select passed from projects.evaluate_maintenance_gates(:'WD_id') where gate = 'data_safety') = true, 'and the gate then holds on that exact commit');
reset role;

-- ═════════ 2. the sensitive mark and the database area never move backwards ═════════
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_work_items set sensitive = false where id = %L$$, :'WS_id'), 'stays sensitive'), 'the sensitive mark is never taken back');
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_work_items set area = 'frontend' where id = %L$$, :'WD_id'), 'stays a database change'), 'a database change is never edited into another area');
update projects.maintenance_work_items set sensitive = true where id = :'WD_id';
select pg_temp.check((select sensitive from projects.maintenance_work_items where id = :'WD_id'), 'the mark can be added (the control only forbids loosening)');
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_work_items set sensitive = false where id = %L$$, :'WD_id'), 'stays sensitive'), 'and then it holds too');

-- ═════════ 3. a maintenance invoice binds to the accepted price and to a bounded cycle ═════════
set local session_replication_role = replica;
insert into sales.opportunities (organization_id, client_account_id, name) values (:'ORG', :'A_id', 'zztest g567 amc') returning id \gset O_
insert into sales.opportunities (organization_id, client_account_id, name) values (:'ORG', :'A_id', 'zztest g567 amc renewal') returning id \gset OR_
insert into sales.proposals (organization_id, opportunity_id, title, status, subtotal_minor, tax_minor, total_minor) values (:'ORG', :'O_id', 'AMC accepted', 'accepted', 100000, 18000, 118000) returning id \gset SPA_
insert into sales.proposals (organization_id, opportunity_id, title, version, status, subtotal_minor, tax_minor, total_minor) values (:'ORG', :'OR_id', 'AMC renewal', 1, 'approved', 200000, 36000, 236000) returning id \gset SPR_
insert into projects.maintenance_plans (organization_id, client_account_id, project_id, name, billing_model, status, accepted_proposal_id, accepted_at, starts_on, ends_on)
  values (:'ORG', :'A_id', :'P_id', 'AMC annual', 'annual', 'pending_client', :'SPA_id', now(), '2026-11-01', '2027-11-01') returning id \gset PL_
insert into projects.maintenance_plans (organization_id, client_account_id, project_id, name, billing_model, status, starts_on, ends_on)
  values (:'ORG', :'A_id', :'P_id', 'AMC unquoted', 'annual', 'draft', '2026-11-01', '2027-11-01') returning id \gset PU_
insert into projects.maintenance_plans (organization_id, client_account_id, project_id, name, billing_model, status, accepted_proposal_id, accepted_at)
  values (:'ORG', :'A_id', :'P_id', 'AMC monthly', 'monthly', 'pending_client', :'SPA_id', now()) returning id \gset PM_
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, total_minor, subtotal_minor, tax_minor, kind, issued_at) values (:'ORG', :'A_id', :'P_id', 'G-INV-OK', 'issued', 118000, 100000, 18000, 'service', now()) returning id \gset INVOK_
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, total_minor, subtotal_minor, tax_minor, kind, issued_at) values (:'ORG', :'A_id', :'P_id', 'G-INV-LOW', 'issued', 7000, 7000, 0, 'service', now()) returning id \gset INVLOW_
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, total_minor, subtotal_minor, tax_minor, kind, issued_at) values (:'ORG', :'A_id', :'P_id', 'G-INV-U', 'issued', 118000, 100000, 18000, 'service', now()) returning id \gset INVU_
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, total_minor, subtotal_minor, tax_minor, kind, issued_at) values (:'ORG', :'A_id', :'P_id', 'G-INV-REN', 'issued', 236000, 200000, 36000, 'service', now()) returning id \gset INVREN_
insert into projects.maintenance_plans (organization_id, client_account_id, project_id, name, billing_model, status, accepted_proposal_id, accepted_at, starts_on, ends_on)
  values (:'ORG', :'A_id', :'P_id', 'AMC red-proof dated', 'annual', 'pending_client', :'SPA_id', now(), '2026-11-01', '2027-11-01') returning id \gset PD_
insert into projects.maintenance_plans (organization_id, client_account_id, project_id, name, billing_model, status, accepted_proposal_id, accepted_at)
  values (:'ORG', :'A_id', :'P_id', 'AMC red-proof open', 'annual', 'pending_client', :'SPA_id', now()) returning id \gset PN_
insert into projects.maintenance_items (organization_id, client_account_id, project_id, title, coverage) values (:'ORG', :'A_id', :'P_id', 'g ticket 4', 'maintenance') returning id \gset T4_
insert into projects.maintenance_work_items (organization_id, client_account_id, project_id, kind, area, title, ticket_id, sensitive, status, commit_ref, commit_submitted_by, commit_submitted_at, created_by, created_at)
  values (:'ORG', :'A_id', :'P_id', 'patch', 'database', 'red-proof unmarked db change', :'T4_id', false, 'fix_submitted', :'C1', :'DEV', now(), :'DEV', now() + interval '1 hour') returning id \gset WU_
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, total_minor, subtotal_minor, tax_minor, kind, issued_at) values (:'ORG', :'A_id', :'P_id', 'G-INV-X1', 'issued', 118000, 100000, 18000, 'service', now()) returning id \gset INVX1_
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, total_minor, subtotal_minor, tax_minor, kind, issued_at) values (:'ORG', :'A_id', :'P_id', 'G-INV-X2', 'issued', 118000, 100000, 18000, 'service', now()) returning id \gset INVX2_
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, total_minor, subtotal_minor, tax_minor, kind, issued_at) values (:'ORG', :'A_id', :'P_id', 'G-INV-M', 'issued', 118000, 100000, 18000, 'service', now()) returning id \gset INVM_
set local session_replication_role = origin;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PU_id', :'INVU_id', 'activation', '2026-11-01', '2027-11-01')) = 'no_accepted_price', 'a plan with no accepted quote has no price to bind to');
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PL_id', :'INVLOW_id', 'activation', '2026-11-01', '2027-11-01')) = 'amount_differs_from_the_accepted_price', 'an invoice at another amount is refused, never coerced');
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PL_id', :'INVOK_id', 'activation', '2026-11-01', '2026-11-01')) = 'bad_cycle', 'a cycle must end after it starts');
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PL_id', :'INVOK_id', 'activation', '2026-11-01', '2028-11-01')) = 'cycle_too_long', 'an annual plan cannot be billed for two years at once');
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PL_id', :'INVOK_id', 'activation', '2026-10-01', '2027-10-01')) = 'cycle_outside_the_plan_period', 'an activation cycle stays inside the plan''s own dates');
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PM_id', :'INVM_id', 'activation', '2026-11-01', '2027-11-01')) = 'cycle_too_long', 'a monthly plan is billed for about a month');
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PL_id', :'INVOK_id', 'activation', '2026-11-01', '2027-11-01')) = 'linked', 'the invoice at the accepted total, for a bounded cycle, is linked');
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PL_id', :'INVOK_id', 'activation', '2026-11-01', '2027-11-01')) = 'already_linked', 'a duplicate link is the same link');
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PL_id', :'INVREN_id', 'activation', '2027-01-01', '2027-02-01')) = 'cycle_overlaps_a_billed_cycle', 'a cycle overlapping a billed cycle is refused');
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PL_id', :'INVREN_id', 'renewal', '2027-11-01', '2028-11-01')) = 'no_accepted_price', 'a renewal with no accepted renewal quote has no price');
reset role;
-- an accepted renewal: its exact period and its own quote
insert into projects.maintenance_plan_renewals (organization_id, client_account_id, plan_id, price_proposal_id, renewal_starts_on, renewal_ends_on, status, proposed_by, channel, evidence_ref, client_contact, decision_recorded_by, decision_recorded_at)
  values (:'ORG', :'A_id', :'PL_id', :'SPR_id', '2027-11-01', '2028-11-01', 'accepted', :'OWNER', 'email', 'mail-9', 'Client Contact', :'ADM', now());
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PL_id', :'INVREN_id', 'renewal', '2027-11-02', '2028-11-01')) = 'cycle_is_not_the_accepted_renewal', 'a renewal invoice covers exactly the renewal the client accepted');
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PL_id', :'INVOK_id', 'renewal', '2027-11-01', '2028-11-01')) = 'invoice_already_linked', 'one invoice bills one cycle');
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PL_id', :'INVREN_id', 'renewal', '2027-11-01', '2028-11-01')) = 'linked', 'the renewal invoice at the renewal quote is linked');
reset role;
select pg_temp.check((select count(*) from audit.audit_log where organization_id = :'ORG' and action = 'maintenance_billing.linked') = 2, 'each link is audited');

-- ───────── red-proofs: remove each control from the LIVE definition, watch the guarded behaviour become possible, roll the mutation back ─────────
-- (each block runs in a sub-transaction that is rolled back by raising 'rp_done', so the mutation and anything it wrote are undone)
select pg_temp.as_service();
do $rp$
declare v_res boolean;
begin
  begin
    perform pg_temp.mutate('projects.evaluate_maintenance_gates(uuid)'::regprocedure, 'if v_i.area is distinct from ''database'' or v_cut is null', 'if not (v_i.sensitive and v_i.area = ''database'') or v_cut is null');
    v_res := (select passed from projects.evaluate_maintenance_gates((select id from projects.maintenance_work_items where title = 'red-proof unmarked db change')) where gate = 'data_safety');
    raise exception 'rp_done';
  exception when others then if sqlerrm <> 'rp_done' then raise; end if; end;
  perform pg_temp.check(v_res = true, 'RED-PROOF: with the gate keyed on the flag again, the unmarked database change is waved through');
  perform pg_temp.check((select passed from projects.evaluate_maintenance_gates((select id from projects.maintenance_work_items where title = 'red-proof unmarked db change')) where gate = 'data_safety') = false, 'the live gate is restored and refuses it');
end $rp$;
select pg_temp.as_user(:'QA', :'ORG', 'member');
do $rp$
declare v_res text;
begin
  begin
    perform pg_temp.mutate('projects.record_maintenance_data_safety(uuid,text,text,text,boolean)'::regprocedure, 'if v_i.area is distinct from ''database'' then return query select ''not_a_sensitive_database_change''', 'if not (v_i.sensitive and v_i.area = ''database'') then return query select ''not_a_sensitive_database_change''');
    v_res := (select outcome from projects.record_maintenance_data_safety((select id from projects.maintenance_work_items where title = 'red-proof unmarked db change'), '1111111111111111111111111111111111111111', 'restore', 'backup-1'));
    raise exception 'rp_done';
  exception when others then if sqlerrm <> 'rp_done' then raise; end if; end;
  perform pg_temp.check(v_res = 'not_a_sensitive_database_change', 'RED-PROOF: with the door keyed on the flag again, the unmarked database change cannot even record data safety');
  v_res := (select outcome from projects.record_maintenance_data_safety((select id from projects.maintenance_work_items where title = 'red-proof unmarked db change'), '1111111111111111111111111111111111111111', 'restore', 'backup-1'));
  perform pg_temp.check(v_res = 'recorded', 'the live door records it');
end $rp$;
select pg_temp.as_service();
do $rp$
declare v_res boolean;
begin
  begin
    drop trigger maintenance_work_flags_monotonic on projects.maintenance_work_items;
    update projects.maintenance_work_items set sensitive = false where title = 'marked db change';
    v_res := (select not sensitive from projects.maintenance_work_items where title = 'marked db change');
    raise exception 'rp_done';
  exception when others then if sqlerrm <> 'rp_done' then raise; end if; end;
  perform pg_temp.check(v_res = true, 'RED-PROOF: with the monotonic trigger dropped the sensitive mark can be cleared');
  perform pg_temp.check((select sensitive from projects.maintenance_work_items where title = 'marked db change') = true, 'and it is intact after the rollback');
end $rp$;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
do $rp$
declare v_res text;
begin
  begin
    perform pg_temp.mutate('finance.link_maintenance_invoice(uuid,uuid,text,date,date)'::regprocedure, 'if v_inv.total_minor is distinct from v_prop.total_minor or v_inv.currency is distinct from v_prop.currency then', 'if false then');
    v_res := (select outcome from finance.link_maintenance_invoice((select id from projects.maintenance_plans where name = 'AMC red-proof dated'), (select id from finance.invoices where number = 'G-INV-LOW'), 'activation', '2026-11-01', '2027-11-01'));
    raise exception 'rp_done';
  exception when others then if sqlerrm <> 'rp_done' then raise; end if; end;
  perform pg_temp.check(v_res = 'linked', 'RED-PROOF: without the price binding an invoice at the wrong amount links');
  begin
    perform pg_temp.mutate('finance.link_maintenance_invoice(uuid,uuid,text,date,date)'::regprocedure, 'if v_max is not null and (p_cycle_end - p_cycle_start) > v_max then', 'if false then');
    v_res := (select outcome from finance.link_maintenance_invoice((select id from projects.maintenance_plans where name = 'AMC red-proof open'), (select id from finance.invoices where number = 'G-INV-X1'), 'activation', '2026-11-01', '2028-11-01'));
    raise exception 'rp_done';
  exception when others then if sqlerrm <> 'rp_done' then raise; end if; end;
  perform pg_temp.check(v_res = 'linked', 'RED-PROOF: without the length bound a two-year annual cycle links');
  begin
    perform pg_temp.mutate('finance.link_maintenance_invoice(uuid,uuid,text,date,date)'::regprocedure, 'daterange(l.cycle_start, l.cycle_end) && daterange(p_cycle_start, p_cycle_end)', 'false');
    perform finance.link_maintenance_invoice((select id from projects.maintenance_plans where name = 'AMC red-proof dated'), (select id from finance.invoices where number = 'G-INV-X1'), 'activation', '2026-11-01', '2027-02-01');
    v_res := (select outcome from finance.link_maintenance_invoice((select id from projects.maintenance_plans where name = 'AMC red-proof dated'), (select id from finance.invoices where number = 'G-INV-X2'), 'activation', '2027-01-01', '2027-03-01'));
    raise exception 'rp_done';
  exception when others then if sqlerrm <> 'rp_done' then raise; end if; end;
  perform pg_temp.check(v_res = 'linked', 'RED-PROOF: without the overlap check the same days are billed twice');
  begin
    perform pg_temp.mutate('finance.link_maintenance_invoice(uuid,uuid,text,date,date)'::regprocedure, '((v_plan.starts_on is not null and p_cycle_start < v_plan.starts_on) or (v_plan.ends_on is not null and p_cycle_end > v_plan.ends_on))', 'false');
    v_res := (select outcome from finance.link_maintenance_invoice((select id from projects.maintenance_plans where name = 'AMC red-proof dated'), (select id from finance.invoices where number = 'G-INV-X1'), 'activation', '2026-10-01', '2027-10-01'));
    raise exception 'rp_done';
  exception when others then if sqlerrm <> 'rp_done' then raise; end if; end;
  perform pg_temp.check(v_res = 'linked', 'RED-PROOF: without the period check a cycle outside the plan''s dates links');
  begin
    perform pg_temp.mutate('finance.link_maintenance_invoice(uuid,uuid,text,date,date)'::regprocedure, 'v_ren.renewal_starts_on is distinct from p_cycle_start or v_ren.renewal_ends_on is distinct from p_cycle_end', 'false');
    v_res := (select outcome from finance.link_maintenance_invoice((select id from projects.maintenance_plans where name = 'AMC annual'), (select id from finance.invoices where number = 'G-INV-REN'), 'renewal', '2027-11-02', '2028-11-01'));
    raise exception 'rp_done';
  exception when others then if sqlerrm <> 'rp_done' then raise; end if; end;
  perform pg_temp.check(v_res in ('linked', 'invoice_already_linked'), 'RED-PROOF: without the exact-renewal check the renewal cycle is not held to the accepted period');
end $rp$;
rollback;
