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

-- ═════════ 4. P604: a functional case states its scenario and failure class; coverage, done and the handoff are derived from rows ═════════
insert into projects.deliverables (organization_id, project_id, kind, version, title, created_by) values (:'ORG', :'P_id', 'build', 1, 'zztest g567 build', :'DEV') returning id \gset D_
insert into projects.deliverable_details (deliverable_id, organization_id, project_id, commit_ref) values (:'D_id', :'ORG', :'P_id', 'abc1234');
set local session_replication_role = replica;
insert into projects.scope_versions (organization_id, project_id, version) values (:'ORG', :'P_id', 1) returning id \gset SV_
insert into projects.scope_items (organization_id, scope_version_id, title, inclusion) values (:'ORG', :'SV_id', 'login', 'included') returning id \gset SI1_
insert into projects.scope_items (organization_id, scope_version_id, title, inclusion) values (:'ORG', :'SV_id', 'checkout', 'included') returning id \gset SI2_
insert into projects.scope_items (organization_id, scope_version_id, title, inclusion) values (:'ORG', :'SV_id', 'about page', 'included') returning id \gset SI3_
insert into projects.scope_items (organization_id, scope_version_id, title, inclusion) values (:'ORG', :'SV_id', 'out of scope thing', 'excluded') returning id \gset SI4_
insert into projects.development_baselines (organization_id, project_id, phase_five_id, ui_version_id, prototype_artifact_id, prototype_deliverable_id, scope_version_id)
  values (:'ORG', :'P_id', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), :'SV_id');
insert into projects.qa_intakes (organization_id, project_id, phase_six_id, phase_five_handoff_id, build_deliverable_id, commit_ref, artifact_sha256, status, m3_verified, external_dependencies)
  values (:'ORG', :'P_id', gen_random_uuid(), gen_random_uuid(), :'D_id', 'abc1234', repeat('a', 64), 'valid', true, '["payment gateway sandbox"]') returning id \gset I_
insert into qa.master_test_plans (organization_id, project_id, intake_id, version, status, commit_ref, required_categories, environments, approved_by, approved_at)
  values (:'ORG', :'P_id', :'I_id', 1, 'approved', 'abc1234', array['functional'], array['staging'], :'OWNER', now()) returning id \gset MP_
insert into qa.risk_items (organization_id, plan_id, area, kind, level, depth, reason) values (:'ORG', :'MP_id', 'login', 'authentication', 'high', 'deep', 'sign-in is high risk');
insert into qa.phase6_cases (organization_id, project_id, plan_id, scope_item_id, title, acceptance_criterion, category, priority) values (:'ORG', :'P_id', :'MP_id', :'SI1_id', 'login ok', 'a user signs in', 'functional', 'critical') returning id \gset CA_
insert into qa.phase6_cases (organization_id, project_id, plan_id, scope_item_id, title, acceptance_criterion, category, priority) values (:'ORG', :'P_id', :'MP_id', :'SI1_id', 'login wrong password', 'a wrong password is refused', 'functional', 'high') returning id \gset CB_
insert into qa.phase6_cases (organization_id, project_id, plan_id, scope_item_id, title, acceptance_criterion, category, priority) values (:'ORG', :'P_id', :'MP_id', :'SI2_id', 'checkout total', 'total is right', 'functional', 'medium') returning id \gset CC_
insert into qa.phase6_cases (organization_id, project_id, plan_id, scope_item_id, title, acceptance_criterion, category, priority) values (:'ORG', :'P_id', :'MP_id', :'SI2_id', 'checkout blocked step', 'step reachable', 'functional', 'medium') returning id \gset CD_
insert into qa.phase6_cases (organization_id, project_id, plan_id, scope_item_id, title, acceptance_criterion, category, priority) values (:'ORG', :'P_id', :'MP_id', null, 'speed', 'fast', 'performance', 'low') returning id \gset CE_
set local session_replication_role = origin;
-- results as an independent person (DEV built the deliverable, so QA records)
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from qa.record_case_result(:'CA_id', 'pass', 'run:1')) = 'recorded', 'fixture: login ok passes');
select pg_temp.check((select outcome from qa.record_case_result(:'CD_id', 'blocked', null, 'payment sandbox down')) = 'recorded', 'fixture: a case is blocked');
select pg_temp.check((select outcome from qa.record_functional_case_profile(:'CE_id', 'happy_path', 'feature')) = 'not_a_functional_case', 'only a functional case takes a functional profile');
select pg_temp.check((select outcome from qa.record_functional_case_profile(:'CA_id', 'nonsense', 'feature')) = 'bad_scenario_kind', 'the scenario kind is one of the twelve');
select pg_temp.check((select outcome from qa.record_functional_case_profile(:'CA_id', 'happy_path', 'nonsense')) = 'bad_layer', 'the layer is one of the eight');
select pg_temp.check((select outcome from qa.record_functional_case_profile(:'CA_id', 'happy_path', 'feature', null, 'production')) = 'environment_not_in_plan', 'an environment the plan does not list is refused');
select pg_temp.check((select outcome from qa.record_functional_case_profile(:'CA_id', 'happy_path', 'feature', null, null, null, null, 'product_code')) = 'failure_class_needs_a_failed_or_blocked_case', 'a failure class needs a failure');
select pg_temp.check((select outcome from qa.record_functional_case_profile(:'CA_id', 'happy_path', 'feature', null, null, null, null, null, 'not relevant')) = 'a_tested_case_is_applicable', 'NOT_APPLICABLE never rescues a tested case');
select pg_temp.check((select outcome from qa.record_functional_case_profile(:'CA_id', 'happy_path', 'feature', 'api_key = abcdefghijklmnopqrstuv')) = 'secret_in_text', 'a secret in the persona is refused');
select pg_temp.check((select outcome from qa.record_functional_case_profile(:'CA_id', 'happy_path', 'feature', 'member', 'staging', 'a registered user', 'signed in and landed on the dashboard')) = 'recorded', 'the happy-path profile is recorded');
select pg_temp.check((select outcome from qa.record_functional_case_profile(:'CB_id', 'invalid_input', 'validation', 'anonymous', 'staging')) = 'recorded', 'a negative scenario is profiled');
select pg_temp.check((select outcome from qa.record_functional_case_profile(:'CC_id', 'happy_path', 'workflow')) = 'recorded', 'checkout happy path profiled');
select pg_temp.check((select outcome from qa.record_functional_case_profile(:'CD_id', 'interrupted_flow', 'integration', null, null, null, null, 'environment')) = 'recorded', 'a blocked case states its failure class');
reset role;
select pg_temp.check(pg_temp.refused(format($$update qa.functional_case_profiles set scenario_kind = 'wrong_role' where case_id = %L$$, :'CA_id'), 'through its door'), 'a profile is not edited around its door');
select pg_temp.check(pg_temp.refused(format($$delete from qa.functional_case_profiles where case_id = %L$$, :'CA_id'), 'never deleted'), 'a profile is never deleted');
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from qa.record_functional_exclusion(:'MP_id', :'SI3_id', 'static page')) = 'not_authorized', 'a plain member cannot record an exclusion');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from qa.record_functional_exclusion(:'MP_id', :'SI4_id', 'x')) = 'not_an_included_requirement', 'only an included requirement takes an exclusion');
select pg_temp.check((select outcome from qa.record_functional_exclusion(:'MP_id', :'SI1_id', 'x')) = 'has_a_direct_functional_case', 'a requirement with a direct case needs no exclusion');
select pg_temp.check((select outcome from qa.record_functional_exclusion(:'MP_id', :'SI3_id', ' ')) = 'reason_required', 'an exclusion states why');
select pg_temp.check((select outcome from qa.record_functional_exclusion(:'MP_id', :'SI3_id', 'static content with no behaviour; covered by the visual check')) = 'recorded', 'a person records why there is no direct functional test');
select pg_temp.check((select outcome from qa.record_functional_exclusion(:'MP_id', :'SI3_id', 'again')) = 'already_recorded', 'recorded once');
select pg_temp.check((select coverage from qa.functional_coverage(:'MP_id') where scope_item_id = :'SI1_id') = 'minimum_met', 'login has a happy path and a negative scenario');
select pg_temp.check((select coverage from qa.functional_coverage(:'MP_id') where scope_item_id = :'SI2_id') = 'partial', 'checkout has a happy path but no negative scenario: partial');
select pg_temp.check((select coverage from qa.functional_coverage(:'MP_id') where scope_item_id = :'SI3_id') = 'excluded', 'a requirement with a recorded reason is excluded, not hidden');
select pg_temp.check((select count(*) from qa.functional_coverage(:'MP_id')) = 3, 'an out-of-scope item is not a requirement');
select pg_temp.check((select 'wrong_role' = any (kinds_missing) from qa.functional_coverage(:'MP_id') where scope_item_id = :'SI1_id'), 'the missing scenario kinds are named');
select pg_temp.check((select satisfied from qa.functional_definition_of_done(:'MP_id') where item = 'scenario_minimum') = false, 'done: checkout lacks a negative scenario');
select pg_temp.check((select satisfied from qa.functional_definition_of_done(:'MP_id') where item = 'role_paths_checked') = false, 'done: the risk matrix names authentication and no wrong-role case has a result');
select pg_temp.check((select satisfied from qa.functional_definition_of_done(:'MP_id') where item = 'all_executed') = false, 'done: cases are still waiting');
select pg_temp.check((select satisfied from qa.functional_definition_of_done(:'MP_id') where item = 'exact_build') = true, 'done: the build is exact');
select pg_temp.check((select satisfied from qa.functional_definition_of_done(:'MP_id') where item = 'failures_classified') = true, 'done: the blocked case states its class');
select pg_temp.check((select detail from qa.functional_definition_of_done(:'MP_id') where item = 'skips_and_blocks_visible') like '1 blocked%', 'skips and blocks are visible with their counts');
select pg_temp.check((select (qa.functional_handoff(:'MP_id') ->> 'declares_production_ready')::boolean) = false, 'the handoff never declares production readiness');
select pg_temp.check((select qa.functional_handoff(:'MP_id') ->> 'recommendation') = 'blocked', 'a blocked case means the functional recommendation is blocked, not pass');
select pg_temp.check((select (qa.functional_handoff(:'MP_id') -> 'totals' ->> 'blocked')::int) = 1 and (select (qa.functional_handoff(:'MP_id') -> 'totals' ->> 'pass')::int) = 1, 'the handoff totals count pass and blocked');
select pg_temp.check((select qa.functional_handoff(:'MP_id') -> 'knownLimitations' ->> 0) = 'payment gateway sandbox', 'known limitations come from the intake');
reset role;
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from qa.functional_coverage(:'MP_id')) = 0 and qa.functional_handoff(:'MP_id') is null, 'another organisation reads no coverage and no handoff');
reset role;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from qa.record_functional_case_profile(:'CD_id', 'interrupted_flow', 'integration', null, null, null, null, 'environment', 'sandbox is out of scope for this build')) = 'recorded', 'a blocked case may be marked not applicable with its reason');
select pg_temp.check((select (qa.functional_handoff(:'MP_id') -> 'totals' ->> 'not_applicable')::int) = 1, 'it is counted as not applicable, visibly');
reset role;

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
select pg_temp.as_service();
do $rp$
declare v_res text;
begin
  begin
    perform pg_temp.mutate('qa.functional_handoff(uuid)'::regprocedure, '''declares_production_ready'', false', '''declares_production_ready'', true');
    v_res := (qa.functional_handoff((select id from qa.master_test_plans where organization_id = '00000000-0000-4000-8000-0000000567a1')) ->> 'declares_production_ready');
    raise exception 'rp_done';
  exception when others then if sqlerrm <> 'rp_done' then raise; end if; end;
  perform pg_temp.check(v_res = 'true', 'RED-PROOF: the handoff''s readiness flag is the control that keeps it from declaring production readiness');
  begin
    perform pg_temp.mutate('qa.functional_handoff(uuid)'::regprocedure, 'when v_blocked > 0 or v_skipped > 0 then ''blocked''', 'when false then ''blocked''');
    v_res := (qa.functional_handoff((select id from qa.master_test_plans where organization_id = '00000000-0000-4000-8000-0000000567a1')) ->> 'recommendation');
    raise exception 'rp_done';
  exception when others then if sqlerrm <> 'rp_done' then raise; end if; end;
  perform pg_temp.check(v_res <> 'blocked', 'RED-PROOF: without the blocked rule a blocked case no longer shows in the recommendation');
  begin
    perform pg_temp.mutate('qa.record_functional_case_profile(uuid,text,text,text,text,text,text,text,text)'::regprocedure, 'if p_not_applicable_reason is not null and v_case.status in (''pass'', ''fail'') then', 'if false then');
    perform pg_temp.as_user('00000000-0000-4000-8000-00000056f904', '00000000-0000-4000-8000-0000000567a1', 'member');
    v_res := (select outcome from qa.record_functional_case_profile((select id from qa.phase6_cases where title = 'login ok'), 'happy_path', 'feature', null, null, null, null, null, 'not relevant'));
    raise exception 'rp_done';
  exception when others then if sqlerrm <> 'rp_done' then raise; end if; end;
  perform pg_temp.check(v_res = 'recorded', 'RED-PROOF: without the rule NOT_APPLICABLE would rescue a passed case');
end $rp$;
rollback;
