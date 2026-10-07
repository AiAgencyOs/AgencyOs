-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 8 part C: the maintenance plan lifecycle (catalog, acceptance, payment gate, usage, overage draft, renewal, cancellation), the SLA-breach and stall
-- sweeps, and the data-safety control, driven through the REAL doors on a scratch Postgres. No payment provider, model or client ran; every payment here is a
-- fixture row an Admin would have verified through the existing door, and every client decision is a staff-recorded reference.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-eight-c.sql        (rolls back)
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

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000009b7'
\set ORGC '00000000-0000-4000-8000-0000000009c7'
\set OWNER '00000000-0000-4000-8000-00000000f911'
\set ADM '00000000-0000-4000-8000-00000000f912'
\set ADM2 '00000000-0000-4000-8000-00000000f917'
\set DEV '00000000-0000-4000-8000-00000000f913'
\set QA '00000000-0000-4000-8000-00000000f914'
\set LEAD '00000000-0000-4000-8000-00000000f915'
\set UB '00000000-0000-4000-8000-00000000f916'
\set UC '00000000-0000-4000-8000-00000000f918'
\set CL '00000000-0000-4000-8000-00000000f919'
\set CLB '00000000-0000-4000-8000-00000000f91a'
\set C1 '1111111111111111111111111111111111111111'
\set C2 '2222222222222222222222222222222222222222'
\set C3 '3333333333333333333333333333333333333333'
insert into core.organizations (id, name, slug) values (:'ORGB', 'P8C Other Agency', 'p8c-other'), (:'ORGC', 'P8C Tiny Agency', 'p8c-tiny') on conflict do nothing;
insert into auth.users (id, email) values (:'OWNER','p8c-o@example.test'),(:'ADM','p8c-a@example.test'),(:'ADM2','p8c-a2@example.test'),(:'DEV','p8c-d@example.test'),(:'QA','p8c-q@example.test'),(:'LEAD','p8c-l@example.test'),(:'UB','p8c-b@example.test'),(:'UC','p8c-c@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER','p8c-o@example.test','O'),(:'ADM','p8c-a@example.test','A'),(:'ADM2','p8c-a2@example.test','A2'),(:'DEV','p8c-d@example.test','D'),(:'QA','p8c-q@example.test','Q'),(:'LEAD','p8c-l@example.test','L'),(:'UB','p8c-b@example.test','B'),(:'UC','p8c-c@example.test','C') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG',:'OWNER','owner'),(:'ORG',:'ADM','ops_admin'),(:'ORG',:'ADM2','ops_admin'),(:'ORG',:'DEV','member'),(:'ORG',:'QA','member'),(:'ORG',:'LEAD','delivery_lead'),(:'ORGB',:'UB','owner'),(:'ORGC',:'UC','owner') on conflict do nothing;

-- ───────── fixture (triggers off: the spine that makes these is other verifiers' business) ─────────
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p8c client') returning id \gset A_
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p8c other client') returning id \gset AB_
insert into core.client_accounts (organization_id, name) values (:'ORGC', 'zztest p8c tiny client') returning id \gset AC_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p8c main', 'ZP8C-1') returning id \gset P1_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p8c exception', 'ZP8C-2') returning id \gset P2_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p8c decline', 'ZP8C-3') returning id \gset P3_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p8c nohandover', 'ZP8C-4') returning id \gset P4_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORGC', :'AC_id', 'zztest p8c tiny', 'ZP8C-5') returning id \gset P5_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p8c unaccepted', 'ZP8C-6') returning id \gset P6_
set local session_replication_role = replica;
insert into projects.handovers (organization_id, project_id, status) values (:'ORG', :'P1_id', 'delivered'), (:'ORG', :'P2_id', 'delivered'), (:'ORG', :'P3_id', 'delivered'), (:'ORGC', :'P5_id', 'delivered'), (:'ORG', :'P6_id', 'delivered');
insert into sales.opportunities (organization_id, client_account_id, name) values (:'ORG', :'A_id', 'zztest p8c amc') returning id \gset O_
insert into sales.opportunities (organization_id, client_account_id, name) values (:'ORG', :'AB_id', 'zztest p8c other amc') returning id \gset OB_
insert into sales.opportunities (organization_id, client_account_id, name) values (:'ORG', :'A_id', 'zztest p8c draft amc') returning id \gset OD_
insert into sales.opportunities (organization_id, client_account_id, name) values (:'ORG', :'A_id', 'zztest p8c renewal amc') returning id \gset OR_
insert into sales.proposals (organization_id, opportunity_id, title, status, subtotal_minor, tax_minor, total_minor) values (:'ORG', :'O_id', 'AMC accepted', 'accepted', 100000, 18000, 118000) returning id \gset SPA_
insert into sales.proposals (organization_id, opportunity_id, title, version, status, subtotal_minor, tax_minor, total_minor) values (:'ORG', :'OD_id', 'AMC draft', 1, 'draft', 1, 0, 1) returning id \gset SPD_
insert into sales.proposals (organization_id, opportunity_id, title, version, status, subtotal_minor, tax_minor, total_minor) values (:'ORG', :'OR_id', 'AMC renewal', 1, 'approved', 100000, 18000, 118000) returning id \gset SPR_
insert into sales.proposals (organization_id, opportunity_id, title, status, subtotal_minor, tax_minor, total_minor) values (:'ORG', :'OB_id', 'Other client accepted', 'accepted', 100, 0, 100) returning id \gset SPX_
insert into projects.maintenance_items (organization_id, client_account_id, project_id, title, coverage) values (:'ORG', :'A_id', :'P1_id', 'covered ticket 1', 'maintenance') returning id \gset T1_
insert into projects.maintenance_items (organization_id, client_account_id, project_id, title, coverage) values (:'ORG', :'A_id', :'P1_id', 'covered ticket 2', 'maintenance') returning id \gset T2_
insert into projects.maintenance_items (organization_id, client_account_id, project_id, title, coverage) values (:'ORG', :'A_id', :'P1_id', 'covered ticket 3', 'maintenance') returning id \gset T3_
insert into projects.maintenance_items (organization_id, client_account_id, project_id, title, coverage) values (:'ORG', :'A_id', :'P1_id', 'covered ticket 4', 'maintenance') returning id \gset T4_
insert into projects.maintenance_items (organization_id, client_account_id, project_id, title, coverage) values (:'ORG', :'A_id', :'P1_id', 'warranty ticket', 'warranty') returning id \gset TW_
insert into projects.maintenance_items (organization_id, client_account_id, project_id, title, coverage) values (:'ORGC', :'AC_id', :'P5_id', 'tiny ticket', 'maintenance') returning id \gset TC_
insert into qa.defects (organization_id, project_id, severity, title, reproduction, found_commit) values (:'ORG', :'P1_id', 'major', 'prod bug', 'steps', :'C1') returning id \gset D1_
insert into qa.defects (organization_id, project_id, severity, title, reproduction, found_commit) values (:'ORG', :'P1_id', 'major', 'second bug', 'steps', :'C1') returning id \gset D2_
insert into projects.scope_versions (organization_id, project_id, version) values (:'ORG', :'P1_id', 1) returning id \gset SV_
insert into projects.change_requests (organization_id, project_id, scope_version_id, requested, classification, status) values (:'ORG', :'P1_id', :'SV_id', 'small tweak', 'free_change', 'approved') returning id \gset CR_
-- invoices: INV1 activation (A), INV2 renewal (A), INV3 exception plan (B)
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, total_minor, subtotal_minor, tax_minor, kind, issued_at) values (:'ORG', :'A_id', :'P1_id', 'P8C-INV-1', 'issued', 118000, 100000, 18000, 'service', now()) returning id \gset INV1_
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, total_minor, subtotal_minor, tax_minor, kind, issued_at) values (:'ORG', :'A_id', :'P1_id', 'P8C-INV-2', 'issued', 118000, 100000, 18000, 'service', now()) returning id \gset INV2_
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, total_minor, subtotal_minor, tax_minor, kind, issued_at) values (:'ORG', :'A_id', :'P2_id', 'P8C-INV-3', 'issued', 50000, 50000, 0, 'service', now()) returning id \gset INV3_
set local session_replication_role = origin;
select count(*) as "INV_BEFORE" from finance.invoices where organization_id = :'ORG' \gset

-- ═════════ the catalog: Admin-set, versioned, no invented price ═════════
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.create_maintenance_catalog_version('Care', 'annual', 10, 5)) = 'not_authorized', 'a member cannot set the catalog');
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.create_maintenance_catalog_version('Care', 'annual')) = 'entitlement_required', 'a version states its entitlement: nothing is assumed');
select pg_temp.check((select outcome from projects.create_maintenance_catalog_version('Care', 'annual', 0, null)) = 'entitlement_required', 'a zero entitlement is not an entitlement');
select pg_temp.check((select outcome from projects.create_maintenance_catalog_version('Care', 'weekly', 10, 5)) = 'bad_billing_model', 'a billing model nobody named is refused');
select pg_temp.check((select outcome from projects.create_maintenance_catalog_version('Care', 'annual', 10, 5, 'password = abcdefghijklmnop1234')) = 'secret_in_text', 'a pasted secret is refused');
select outcome, catalog_id as id, version as v from projects.create_maintenance_catalog_version('Care', 'annual', 10, 5, 'bug fixes and small changes', 'new features', 'renewal is proposed by the agency and accepted by the client') \gset CAT_
select pg_temp.check(:'CAT_outcome' = 'created' and :'CAT_v' = '1', 'the Admin drafts version 1');
select pg_temp.check((select outcome from projects.add_maintenance_price_line(:'CAT_id', 'Annual care', 'cycle', 90000, 'inr')) = 'entered', 'a person enters a price line as data');
select pg_temp.check((select outcome from projects.add_maintenance_price_line(:'CAT_id', 'Extra hour', 'overage_hour', 1500, 'INR')) = 'entered', 'a person enters an overage rate');
select pg_temp.check((select outcome from projects.add_maintenance_price_line(:'CAT_id', 'Extra hour again', 'overage_hour', 1600, 'INR')) = 'already_entered', 'one overage rate per kind per version');
select pg_temp.check((select outcome from projects.add_maintenance_price_line(:'CAT_id', 'Bad', 'cycle', -1, 'INR')) = 'bad_amount', 'a negative amount is refused');
select pg_temp.check((select outcome from projects.publish_maintenance_catalog_version(:'CAT_id')) = 'author_cannot_publish', 'creator != approver: the author of a version does not publish it');
reset role;
select pg_temp.as_user(:'ADM2', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.publish_maintenance_catalog_version(:'CAT_id')) = 'published', 'an independent Admin publishes it');
select pg_temp.check((select outcome from projects.add_maintenance_price_line(:'CAT_id', 'Late', 'cycle', 1, 'INR')) = 'not_a_draft', 'a published version takes no more price lines');
reset role;
select pg_temp.check(pg_temp.refused(format($$insert into projects.maintenance_plan_price_lines (organization_id, catalog_id, label, per, amount_minor, currency, entered_by) values (%L, %L, 'sneak', 'cycle', 1, 'INR', %L)$$, :'ORG', :'CAT_id', :'ADM'), 'draft catalog version only'), 'even a service-level insert cannot add a price to a published version');
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_plan_catalog set included_hours = 999 where id = %L$$, :'CAT_id'), 'never edited'), 'a published version is never edited');
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_plan_catalog set status = 'retired' where id = %L$$, :'CAT_id'), 'through its doors'), 'a catalog status moves through its doors only');
select pg_temp.check(pg_temp.refused(format($$delete from projects.maintenance_plan_price_lines where catalog_id = %L$$, :'CAT_id'), 'never edited or deleted'), 'price lines are history');
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select outcome, catalog_id as id from projects.create_maintenance_catalog_version('Care', 'annual', 12, 6) \gset CAT2_
select pg_temp.check(:'CAT2_outcome' = 'created' and (select version from projects.maintenance_plan_catalog where id = :'CAT2_id') = 2, 'the next version is a new row, not an edit');
select outcome, catalog_id as id from projects.create_maintenance_catalog_version('Hours only', 'monthly', 4, null) \gset CATH_
reset role;
select pg_temp.as_user(:'ADM2', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.publish_maintenance_catalog_version(:'CATH_id')) = 'published', 'the hours-only version is published');
reset role;

-- ═════════ open a plan, and what holds it ═════════
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.open_maintenance_plan(:'P1_id', :'CAT_id')) = 'not_authorized', 'a member cannot open a plan');
reset role;
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.open_maintenance_plan(:'P1_id', :'CAT2_id')) = 'catalog_not_published', 'a draft version cannot be opened');
select pg_temp.check((select outcome from projects.open_maintenance_plan(:'P4_id', :'CAT_id')) = 'no_handover', 'no delivered handover: nothing to maintain');
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select outcome, plan_id as id from projects.open_maintenance_plan(:'P1_id', :'CAT_id') \gset PA_
select pg_temp.check(:'PA_outcome' = 'opened', 'plan A is opened from the published version (by an Admin)');
select pg_temp.check((select outcome from projects.open_maintenance_plan(:'P1_id', :'CAT_id')) = 'project_has_a_live_plan', 'one live plan per project');
select pg_temp.check((select status = 'draft' and starts_on is null and ends_on is null and accepted_at is null from projects.maintenance_plans where id = :'PA_id'), 'a new plan is a draft with no period and no acceptance: nothing is assumed');
select pg_temp.check((select pg_temp.denied(format($$insert into projects.maintenance_plan_lifecycle (organization_id, client_account_id, plan_id, catalog_id, entered_by) values (%L, %L, %L, %L, %L)$$, :'ORG', :'A_id', :'PA_id', :'CAT_id', :'ADM'))), 'a signed-in person cannot write the lifecycle table');
reset role;
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_plans set status = 'active' where id = %L$$, :'PA_id'), 'moves through its doors'), 'a lifecycle plan cannot be edited into a status, even by a service-level write');
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_plans set ends_on = current_date + 400 where id = %L$$, :'PA_id'), 'moves through its doors'), 'nor given a period by an edit');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.denied(format($$update projects.maintenance_plans set status = 'renewed' where id = %L$$, :'PA_id')), 'a signed-in owner has no raw write on a plan at all: the grant is gone (the lifecycle guard above is the second layer)');
reset role;

-- ═════════ the client's acceptance, recorded by staff with evidence ═════════
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_maintenance_plan_acceptance(:'PA_id', 'accepted', :'SPA_id', 'email', 'mail-1', 'Client Contact')) = 'not_authorized', 'a member cannot record a client decision');
reset role;
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_maintenance_plan_acceptance(:'PA_id', 'accepted', :'SPA_id', 'email', '', 'Client Contact')) = 'evidence_required', 'acceptance without evidence is refused');
select pg_temp.check((select outcome from projects.record_maintenance_plan_acceptance(:'PA_id', 'accepted', :'SPA_id', 'email', 'token = abcdefghijklmnopqrstu', 'Client Contact')) = 'secret_in_text', 'evidence is a reference, never a secret');
select pg_temp.check((select outcome from projects.record_maintenance_plan_acceptance(:'PA_id', 'accepted', :'SPD_id', 'email', 'mail-1', 'Client Contact')) = 'quote_not_accepted', 'the quote the client accepted must be an accepted proposal');
select pg_temp.check((select outcome from projects.record_maintenance_plan_acceptance(:'PA_id', 'accepted', :'SPX_id', 'email', 'mail-1', 'Client Contact')) = 'proposal_is_another_clients', 'another client''s quote is refused');
select pg_temp.check((select outcome from projects.record_maintenance_plan_acceptance(:'PA_id', 'accepted', :'SPA_id', 'fax', 'mail-1', 'Client Contact')) = 'bad_channel', 'an unknown channel is refused');
select pg_temp.check((select outcome from projects.record_maintenance_plan_acceptance(:'PA_id', 'accepted', :'SPA_id', 'email', 'mail-1', 'Client Contact')) = 'accepted', 'staff record the client''s acceptance against the exact quote');
select pg_temp.check((select outcome from projects.record_maintenance_plan_acceptance(:'PA_id', 'accepted', :'SPA_id', 'email', 'mail-1', 'Client Contact')) = 'already_decided', 'the client''s decision is recorded once');
reset role;
select pg_temp.check((select accepted_proposal_id = :'SPA_id' and accepted_at is not null and status = 'draft' from projects.maintenance_plans where id = :'PA_id'), 'the plan names the accepted quote and stays a draft until it is paid');
select pg_temp.check((select count(*) from projects.maintenance_plan_acceptances where plan_id = :'PA_id') = 1, 'one acceptance record, with its evidence reference');
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_plan_acceptances set evidence_ref = 'x' where plan_id = %L$$, :'PA_id'), 'never edited or deleted'), 'an acceptance is history');

-- the decline path (project 3)
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select outcome, plan_id as id from projects.open_maintenance_plan(:'P3_id', :'CAT_id') \gset PC_
select pg_temp.check((select outcome from projects.record_maintenance_plan_acceptance(:'PC_id', 'declined', null, 'call_note', 'call 2026-11-09', 'Client Contact')) = 'reason_required', 'a decline says why');
select pg_temp.check((select outcome from projects.record_maintenance_plan_acceptance(:'PC_id', 'declined', null, 'call_note', 'call 2026-11-09', 'Client Contact', 'budget')) = 'declined', 'a declined plan is recorded with its reason');
reset role;
select pg_temp.check((select status = 'declined' and ended_reason = 'budget' from projects.maintenance_plans where id = :'PC_id'), 'the plan is declined, with the reason on it');

-- ═════════ the payment gate ═════════
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.activate_maintenance_plan(:'PA_id')) = 'not_authorized', 'only an Admin activates');
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.activate_maintenance_plan(:'PA_id')) = 'approver_is_the_author', 'creator != approver: the Admin who opened the plan does not activate it');
reset role;

-- the first cycle must be billed AND paid; the gate is the existing one
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.activate_maintenance_plan(:'PA_id')) = 'first_cycle_not_billed', 'an accepted plan with no invoice linked is not activated');
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PA_id', :'INV1_id', 'activation', current_date - 10, current_date + 20)) = 'linked', 'the first cycle''s invoice is linked to the plan');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select outcome, gate_state as gs from projects.activate_maintenance_plan(:'PA_id') \gset G1_
select pg_temp.check(:'G1_outcome' = 'first_cycle_not_paid' and :'G1_gs' = 'awaiting_payment_verification', 'issued but unpaid: the plan is not active');
reset role;
select pg_temp.check((select status from projects.maintenance_plans where id = :'PA_id') = 'draft', 'the plan stayed a draft');
-- the existing Admin door would verify the payment; here it is the fixture row that door would write
set local session_replication_role = replica;
insert into finance.payments (organization_id, invoice_id, provider_payment_id, amount_minor, status, verified_at, verified_by) values (:'ORG', :'INV1_id', 'p8c-pay-1', 118000, 'captured', now(), :'OWNER');
update finance.invoices set status = 'paid', paid_minor = total_minor, paid_at = now() where id = :'INV1_id';
set local session_replication_role = origin;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select outcome, gate_state as gs from projects.activate_maintenance_plan(:'PA_id') \gset G2_
select pg_temp.check(:'G2_outcome' = 'activated' and :'G2_gs' = 'verified_paid', 'paid on verified money: an independent Admin activates the plan');
select pg_temp.check((select outcome from projects.activate_maintenance_plan(:'PA_id')) = 'wrong_state', 'activation is not repeated');
reset role;
select pg_temp.check((select status = 'active' and starts_on = current_date - 10 and ends_on = current_date + 20 from projects.maintenance_plans where id = :'PA_id'), 'the plan''s period is the paid first cycle''s');
select pg_temp.check((select count(*) = 1 and bool_and(entitled_hours = 10 and entitled_requests = 5 and purpose = 'activation') from projects.maintenance_plan_cycles where plan_id = :'PA_id'), 'the first cycle row carries the entitlement of the published version');
select id as "CYA_id" from projects.maintenance_plan_cycles where plan_id = :'PA_id' \gset
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_plan_cycles set entitled_hours = 999 where id = %L$$, :'CYA_id'), 'never edited or deleted'), 'a cycle is history');

-- ═════════ the usage ledger and the overage draft ═════════
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_maintenance_usage(:'PA_id', 'hours', 1, current_date + 1, null, :'T1_id')) = 'bad_date', 'usage is not recorded in the future');
select pg_temp.check((select outcome from projects.record_maintenance_usage(:'PA_id', 'hours', 1, current_date - 1)) = 'name_a_ticket_or_work_item', 'usage names the ticket or work item it answers to');
select pg_temp.check((select outcome from projects.record_maintenance_usage(:'PA_id', 'hours', 1, current_date - 1, null, :'TW_id')) = 'warranty_work_is_not_plan_usage', 'warranty work is the agency''s cost, not the client''s entitlement');
select pg_temp.check((select outcome from projects.record_maintenance_usage(:'PA_id', 'request', 1.5, current_date - 1, null, :'T1_id')) = 'bad_quantity', 'a request count is whole');
select pg_temp.check((select outcome from projects.record_maintenance_usage(:'PA_id', 'hours', 1, current_date - 30, null, :'T1_id')) = 'no_paid_cycle_covers_that_date', 'a date no paid cycle covers is refused');
select pg_temp.check((select outcome from projects.record_maintenance_usage(:'PA_id', 'hours', 1, current_date - 1, null, :'TC_id')) = 'ticket_not_found', 'another organization''s ticket is not found');
select pg_temp.check((select outcome from projects.record_maintenance_usage(:'PA_id', 'hours', 0, current_date - 1, null, :'T1_id')) = 'bad_quantity', 'zero usage is not an entry');
select outcome, entry_id as id from projects.record_maintenance_usage(:'PA_id', 'hours', 8, current_date - 3, null, :'T1_id', 'investigation') \gset U1_
select pg_temp.check(:'U1_outcome' = 'recorded', 'hours are recorded against a ticket');
select outcome, entry_id as id from projects.record_maintenance_usage(:'PA_id', 'hours', 5, current_date - 2, null, :'T2_id') \gset U2_
select pg_temp.check((select outcome from projects.record_maintenance_usage(:'PA_id', 'request', 2, current_date - 2, null, :'T2_id')) = 'recorded', 'requests are recorded too');
select pg_temp.check((select used_hours = 13 and overage_hours = 3 and entitled_hours = 10 and used_requests = 2 and overage_requests = 0 and entitled_requests = 5 from projects.maintenance_cycle_usage(:'CYA_id')), 'overage is computed: 13 used of 10 included is 3 over; 2 of 5 requests is none');
select pg_temp.check(pg_temp.denied(format($$insert into projects.maintenance_usage_entries (organization_id, client_account_id, plan_id, cycle_id, entry_kind, quantity, occurred_on, ticket_id, recorded_by) values (%L, %L, %L, %L, 'hours', 1, current_date, %L, %L)$$, :'ORG', :'A_id', :'PA_id', :'CYA_id', :'T1_id', :'DEV')), 'a signed-in person cannot write the ledger directly');
reset role;
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_usage_entries set quantity = 1 where id = %L$$, :'U1_id'), 'never edited or deleted'), 'the ledger is never edited');
select pg_temp.check(pg_temp.refused(format($$delete from projects.maintenance_usage_entries where id = %L$$, :'U1_id'), 'never edited or deleted'), 'the ledger is never deleted');
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.reverse_maintenance_usage(:'U2_id', 'logged on the wrong ticket')) = 'not_authorized', 'a member cannot reverse an entry');
select pg_temp.check((select outcome from projects.draft_maintenance_overage(:'CYA_id', 'hours')) = 'not_authorized', 'a member cannot draft an overage line');
reset role;
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select outcome, entry_id as id from projects.record_maintenance_usage(:'PA_id', 'hours', 1, current_date - 1, null, :'T3_id') \gset U3_
select pg_temp.check((select outcome from projects.reverse_maintenance_usage(:'U3_id', 'a duplicate')) = 'self_reversal', 'creator != approver: whoever recorded an entry does not reverse it');
select pg_temp.check((select outcome from projects.reverse_maintenance_usage(:'U2_id', '')) = 'reason_required', 'a reversal says why');
select pg_temp.check((select outcome from projects.draft_maintenance_overage(:'CYA_id', 'hours')) = 'drafted', 'overage beyond the entitlement is surfaced as a draft');
reset role;
select pg_temp.check((select overage_quantity = 4 and unit_rate_minor = 1500 and amount_minor = 6000 and status = 'draft' and price_line_id is not null from projects.maintenance_overage_drafts where cycle_id = :'CYA_id' and entry_kind = 'hours'), 'the draft is computed from the rate a person entered (4 hours at 1500 = 6000) and stays a draft');
select pg_temp.check((select count(*) from information_schema.columns where table_schema = 'projects' and table_name = 'maintenance_overage_drafts' and column_name ~ 'invoice|quote|proposal|paid|billed') = 0, 'the draft has no column that could bill or quote anything');
select pg_temp.check((select count(*) from finance.invoices where organization_id = :'ORG') = :'INV_BEFORE'::bigint, 'no invoice was created by any lifecycle door');
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.draft_maintenance_overage(:'CYA_id', 'hours')) = 'already_drafted', 'the same overage is drafted once');
select pg_temp.check((select outcome from projects.draft_maintenance_overage(:'CYA_id', 'request')) = 'no_overage', 'no overage, no draft');
select pg_temp.check((select outcome from projects.reverse_maintenance_usage(:'U2_id', 'logged on the wrong ticket')) = 'reversed', 'an independent person reverses the entry with a reason');
select pg_temp.check((select outcome from projects.reverse_maintenance_usage(:'U2_id', 'again')) = 'already_reversed', 'an entry is reversed once');
select pg_temp.check((select used_hours = 9 and overage_hours = 0 from projects.maintenance_cycle_usage(:'CYA_id')), 'the reversal corrects the ledger (9 used, none over) without editing history');
reset role;

-- ═════════ what a client may see: their own account, plain facts ═════════
select pg_temp.as_client(:'CL', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.client_maintenance_plans()) = 1, 'a client sees their own plan (and not the declined or draft ones)');
select pg_temp.check((select status_label = 'Active' and entitled_hours = 10 and used_hours = 9 and entitled_requests = 5 from projects.client_maintenance_plans() limit 1), 'a client sees the plain facts: status, entitlement, usage');
select pg_temp.check((select count(*) from projects.client_maintenance_usage(:'PA_id')) >= 4, 'a client sees the entries of their own plan, reversals included');
select pg_temp.check((select count(*) from projects.maintenance_usage_entries) = 0 and (select count(*) from projects.maintenance_overage_drafts) = 0 and (select count(*) from projects.maintenance_plan_catalog) = 0, 'a client reads no lifecycle table directly');
select pg_temp.check((select outcome from projects.record_maintenance_usage(:'PA_id', 'hours', 1, current_date - 1, null, :'T1_id')) = 'not_authorized', 'a client cannot record usage');
select pg_temp.check((select count(*) from projects.maintenance_cycle_usage(:'CYA_id')) = 1, 'a client reads their own cycle''s usage');
reset role;
select pg_temp.as_client(:'CLB', :'ORG', :'AB_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.client_maintenance_plans()) = 0 and (select count(*) from projects.client_maintenance_usage(:'PA_id')) = 0 and (select count(*) from projects.maintenance_cycle_usage(:'CYA_id')) = 0, 'another client sees nothing of this account''s plan, usage or cycle');
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select count(*) from projects.client_maintenance_plans()) = 0 and (select count(*) from projects.client_maintenance_usage(:'PA_id')) = 0, 'the client functions answer clients only');
select set_config('request.jwt.claims', jsonb_build_object('sub', :'ADM'::text, 'role', 'authenticated', 'app_metadata', jsonb_build_object('organization_id', :'ORG'::text, 'role', 'ops_admin', 'client_account_id', :'A_id'::text))::text, true);
select pg_temp.check((select count(*) from projects.client_maintenance_plans()) = 0 and (select count(*) from projects.client_maintenance_usage(:'PA_id')) = 0, 'an internal session is not a client even if it carries a client account claim');
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
select pg_temp.check((select count(*) from projects.maintenance_plan_overview(:'P1_id')) = 1 and (select gate_state from projects.maintenance_plan_overview(:'P1_id')) = 'verified_paid', 'the Admin overview shows the plan and its gate');
reset role;
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.proname in ('client_maintenance_plans', 'client_maintenance_usage') and coalesce(array_to_string(p.proargnames, ','), '') ~* 'amount|price|rate|reason|invoice|draft|note|work_item|ticket') = 0, 'the client functions expose no amount, reason, note, draft or internal reference');

-- an unaccepted plan is never activated
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select plan_id as "PE_id" from projects.open_maintenance_plan(:'P6_id', :'CAT_id') \gset
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.activate_maintenance_plan(:'PE_id')) = 'not_accepted', 'a plan whose client has not accepted is never activated');
reset role;

-- ═════════ plan B: the exception path, the expiring exception, reinstatement, cancellation and churn ═════════
set local session_replication_role = replica;
insert into projects.maintenance_items (organization_id, client_account_id, project_id, title, coverage) values (:'ORG', :'A_id', :'P2_id', 'plan B ticket', 'maintenance') returning id \gset TB_
set local session_replication_role = origin;
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select outcome, plan_id as id from projects.open_maintenance_plan(:'P2_id', :'CATH_id') \gset PB_
select pg_temp.check(:'PB_outcome' = 'opened', 'plan B is opened from the hours-only version');
reset role;
select pg_temp.as_user(:'ADM2', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_maintenance_plan_acceptance(:'PB_id', 'accepted', :'SPA_id', 'whatsapp', 'wa-msg-77', 'Client Contact')) = 'accepted', 'an Admin records the client''s acceptance');
select pg_temp.check((select outcome from projects.activate_maintenance_plan(:'PB_id')) = 'approver_is_the_author', 'creator != approver: whoever recorded the acceptance does not activate the plan');
reset role;
-- the unbilled lifecycle plan: the 8B trigger lets an unbilled plan through, so only the lifecycle trigger can refuse this
select set_config('projects.p8c_sanctioned', 'on', true);
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_plans set status = 'active' where id = %L$$, :'PB_id'), 'in the lifecycle'), 'a lifecycle plan with no invoice cannot be made active even by a sanctioned write');
select set_config('projects.p8c_sanctioned', 'off', true);
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PB_id', :'INV3_id', 'activation', current_date - 5, current_date + 25)) = 'linked', 'plan B''s first invoice is linked');
select exception_id as "EXB_id" from finance.request_maintenance_gate_exception(:'PB_id', 'client pays on delivery', 'weekly follow-up', now() + interval '10 days') \gset
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.activate_maintenance_plan(:'PB_id')) = 'first_cycle_not_paid', 'unpaid and no exception yet: not active');
select pg_temp.check((select outcome from finance.approve_maintenance_gate_exception(:'EXB_id')) = 'approved', 'the owner approves the expiring exception');
select outcome, gate_state as gs from projects.activate_maintenance_plan(:'PB_id') \gset GB_
select pg_temp.check(:'GB_outcome' = 'activated' and :'GB_gs' = 'exception_approved', 'with an owner-approved exception the plan activates');
reset role;
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_maintenance_usage(:'PB_id', 'request', 1, current_date - 1, null, :'TB_id')) = 'kind_not_in_the_entitlement', 'requests are not in an hours-only entitlement');
select pg_temp.check((select outcome from projects.record_maintenance_usage(:'PB_id', 'hours', 5, current_date - 1, null, :'TB_id')) = 'recorded', 'hours are recorded on plan B (4 included)');
reset role;
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.draft_maintenance_overage(c.id, 'hours')) = 'drafted', 'a draft is made even with no rate entered') from projects.maintenance_plan_cycles c where c.plan_id = :'PB_id';
reset role;
select pg_temp.check((select unit_rate_minor is null and amount_minor is null and price_line_id is null and overage_quantity = 1 from projects.maintenance_overage_drafts where plan_id = :'PB_id'), 'with no rate entered the draft carries a quantity and NO amount: a person quotes it');
-- the exception expires while the invoice stays unpaid
set local session_replication_role = replica;
update finance.maintenance_gate_exceptions set expires_at = now() - interval '1 day' where plan_id = :'PB_id';
set local session_replication_role = origin;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check(pg_temp.denied($$select * from projects.sweep_maintenance_plan_payment_gates()$$), 'a signed-in person cannot run the payment-gate sweep');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select flagged from projects.sweep_maintenance_plan_payment_gates(:'ORG')) >= 1, 'the sweep flags a plan whose exception expired unpaid');
reset role;
select pg_temp.check((select status from projects.maintenance_plans where id = :'PB_id') = 'at_risk', 'plan B is at risk: its entitlement is suspended');
select pg_temp.check((select status from projects.maintenance_plans where id = :'PA_id') = 'active', 'plan A, paid on verified money, is untouched');
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_maintenance_usage(:'PB_id', 'hours', 1, current_date - 1, null, :'TB_id')) = 'plan_not_in_force', 'an at-risk plan entitles nothing');
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
reset role;
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.reinstate_maintenance_plan(:'PB_id')) = 'not_authorized', 'only an Admin reinstates a plan');
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.reinstate_maintenance_plan(:'PB_id')) = 'cycle_not_paid', 'reinstatement needs the cycle paid or excepted again');
reset role;
set local session_replication_role = replica;
insert into finance.payments (organization_id, invoice_id, provider_payment_id, amount_minor, status, verified_at, verified_by) values (:'ORG', :'INV3_id', 'p8c-pay-3', 50000, 'captured', now(), :'OWNER');
update finance.invoices set status = 'paid', paid_minor = total_minor, paid_at = now() where id = :'INV3_id';
set local session_replication_role = origin;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.reinstate_maintenance_plan(:'PB_id')) = 'reinstated', 'verified payment reinstates the plan');
-- cancellation
select pg_temp.check((select outcome from projects.request_maintenance_plan_cancellation(:'PB_id', 'because', 'x')) = 'bad_reason_code', 'a churn reason is one of the named codes');
select pg_temp.check((select outcome from projects.request_maintenance_plan_cancellation(:'PB_id', 'price', '  ')) = 'reason_required', 'a cancellation says why');
reset role;
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select outcome, cancellation_id as id from projects.request_maintenance_plan_cancellation(:'PB_id', 'price', 'client found a cheaper plan', 'mail-9') \gset CW_
select pg_temp.check(:'CW_outcome' = 'requested', 'staff request a cancellation with a reason');
select pg_temp.check((select outcome from projects.request_maintenance_plan_cancellation(:'PB_id', 'price', 'again')) = 'cancellation_already_requested', 'one open request per plan');
select pg_temp.check((select outcome from projects.decide_maintenance_plan_cancellation(:'CW_id', 'confirm')) = 'not_authorized', 'only an Admin decides a cancellation');
reset role;
select pg_temp.as_user(:'ADM2', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_maintenance_plan_cancellation(:'CW_id', 'withdraw')) = 'withdrawn', 'a request can be withdrawn');
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select outcome, cancellation_id as id from projects.request_maintenance_plan_cancellation(:'PB_id', 'client_request', 'the client no longer needs maintenance', 'mail-10') \gset CX_
reset role;
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_plan_cancellations set status = 'withdrawn' where id = %L$$, :'CX_id'), 'moves through its doors'), 'a cancellation cannot be moved by an edit');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_maintenance_plan_cancellation(:'CX_id', 'confirm')) = 'requester_cannot_confirm', 'creator != approver: whoever asked does not end the entitlement');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_maintenance_plan_cancellation(:'CX_id', 'confirm')) = 'confirmed', 'an independent Admin confirms it');
select pg_temp.check((select reason_code || ':' || plans from projects.maintenance_churn_summary() where reason_code = 'client_request') = 'client_request:1' and (select count(*) from projects.maintenance_churn_summary() where reason_code = 'price') = 0, 'the churn reason is counted, and a withdrawn request is not churn');
reset role;
select pg_temp.check((select status = 'cancelled' and ended_reason like 'client_request:%' and ends_on <= current_date from projects.maintenance_plans where id = :'PB_id'), 'the plan is cancelled, with the reason on it, and its period ends today at the latest');
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_maintenance_usage(:'PB_id', 'hours', 1, current_date - 1, null, :'TB_id')) = 'plan_not_in_force', 'a cancelled plan entitles nothing');
reset role;
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_plan_cancellations set status = 'requested' where id = %L$$, :'CX_id'), 'closed history'), 'a confirmed cancellation is history');
select pg_temp.check((select count(*) from information_schema.columns where table_schema = 'projects' and table_name like 'maintenance_plan%' and column_name ~ 'refund') = 0, 'no refund logic exists in the lifecycle: money back is the finance door''s');

-- ═════════ renewal on plan A: proposed, accepted by the client, paid, confirmed; never silent ═════════
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.propose_maintenance_renewal(:'PA_id', current_date + 400, :'SPR_id')) = 'not_authorized', 'a member cannot propose a renewal');
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.propose_maintenance_renewal(:'PA_id', current_date + 400, :'SPD_id')) = 'quote_not_approved', 'a renewal names an approved quote');
select pg_temp.check((select outcome from projects.propose_maintenance_renewal(:'PA_id', current_date + 400, :'SPX_id')) = 'proposal_is_another_clients', 'another client''s quote is refused');
select pg_temp.check((select outcome from projects.propose_maintenance_renewal(:'PA_id', current_date + 21, :'SPR_id')) = 'bad_period', 'a renewal period must be longer than a day');
select outcome, renewal_id as id from projects.propose_maintenance_renewal(:'PA_id', current_date + 400, :'SPR_id') \gset RN_
select pg_temp.check(:'RN_outcome' = 'proposed', 'a person proposes the renewal');
select pg_temp.check((select outcome from projects.propose_maintenance_renewal(:'PA_id', current_date + 401, :'SPR_id')) = 'wrong_state', 'a second proposal is refused while one is open');
reset role;
select pg_temp.check((select status = 'renewal_proposed' and ends_on = current_date + 20 from projects.maintenance_plans where id = :'PA_id'), 'proposing extends nothing: the end date is unchanged');
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_plans set status = 'renewed', ends_on = current_date + 400 where id = %L$$, :'PA_id'), 'moves through its doors'), 'a renewal cannot be written in by an edit');
select pg_temp.check(pg_temp.refused(format($$update projects.maintenance_plan_renewals set status = 'accepted' where id = %L$$, :'RN_id'), 'moves through its doors'), 'a renewal cannot be moved by an edit');
select pg_temp.check((select count(*) from pg_indexes where schemaname = 'projects' and indexname = 'maintenance_one_live_renewal') = 1, 'the one-live-renewal index exists');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.confirm_maintenance_renewal(:'RN_id')) = 'not_accepted', 'a renewal the client has not accepted is not confirmed');
select pg_temp.check((select outcome from projects.confirm_maintenance_renewal(:'RN_id')) <> 'renewed', 'and nothing is renewed');
reset role;
select pg_temp.as_user(:'ADM2', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_maintenance_renewal_decision(:'RN_id', 'accepted', 'email', '', 'Client Contact')) = 'evidence_required', 'the client''s decision needs an evidence reference');
select pg_temp.check((select outcome from projects.record_maintenance_renewal_decision(:'RN_id', 'accepted', 'email', 'mail-20', 'Client Contact')) = 'quote_not_accepted', 'the renewal quote must be accepted through the sales doors first');
reset role;
set local session_replication_role = replica;
update sales.proposals set status = 'accepted' where id = :'SPR_id';
set local session_replication_role = origin;
select pg_temp.as_user(:'ADM2', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_maintenance_renewal_decision(:'RN_id', 'accepted', 'email', 'mail-20', 'Client Contact')) = 'accepted', 'staff record the client''s renewal acceptance');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
reset role;
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.confirm_maintenance_renewal(:'RN_id')) = 'not_authorized', 'only an Admin confirms a renewal');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.confirm_maintenance_renewal(:'RN_id')) = 'renewal_cycle_not_billed', 'an accepted renewal with no invoice is not renewed');
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PA_id', :'INV2_id', 'renewal', current_date + 21, current_date + 400)) = 'linked', 'the renewal invoice is linked to the renewal cycle');
select pg_temp.check((select outcome from projects.confirm_maintenance_renewal(:'RN_id')) = 'approver_is_the_author', 'creator != approver: the proposer does not confirm');
reset role;
select pg_temp.as_user(:'ADM2', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.confirm_maintenance_renewal(:'RN_id')) = 'approver_is_the_author', 'nor does whoever recorded the client''s acceptance');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.confirm_maintenance_renewal(:'RN_id')) = 'renewal_not_paid', 'accepted but unpaid: not renewed');
reset role;
set local session_replication_role = replica;
insert into finance.payments (organization_id, invoice_id, provider_payment_id, amount_minor, status, verified_at, verified_by) values (:'ORG', :'INV2_id', 'p8c-pay-2', 118000, 'captured', now(), :'OWNER');
update finance.invoices set status = 'paid', paid_minor = total_minor, paid_at = now() where id = :'INV2_id';
update projects.maintenance_plans set ends_on = current_date - 1 where id = :'PA_id';
set local session_replication_role = origin;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.confirm_maintenance_renewal(:'RN_id')) = 'plan_lapsed', 'a plan whose period already ended is not revived by a late payment');
reset role;
set local session_replication_role = replica;
update projects.maintenance_plans set ends_on = current_date + 20 where id = :'PA_id';
set local session_replication_role = origin;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select outcome, gate_state as gs from projects.confirm_maintenance_renewal(:'RN_id') \gset RC_
select pg_temp.check(:'RC_outcome' = 'renewed' and :'RC_gs' = 'verified_paid', 'paid on verified money, accepted by the client: an independent Admin renews');
reset role;
select pg_temp.check((select status = 'renewed' and ends_on = current_date + 400 from projects.maintenance_plans where id = :'PA_id'), 'the plan is renewed to the proposed end date');
select pg_temp.check((select count(*) = 2 from projects.maintenance_plan_cycles where plan_id = :'PA_id') and (select count(*) = 1 from projects.maintenance_plan_cycles where plan_id = :'PA_id' and purpose = 'renewal' and starts_on = current_date + 21), 'a second, paid cycle exists');
select pg_temp.check((select status = 'renewed' and confirmed_by = :'OWNER' from projects.maintenance_plan_renewals where id = :'RN_id'), 'the renewal record names who confirmed it');

-- a plan whose period passes with no recorded renewal lapses honestly (the 8A sweep), and nothing revives it
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.publish_maintenance_catalog_version(:'CAT2_id')) = 'author_cannot_publish', 'the author of version 2 cannot publish it');
reset role;
select pg_temp.as_user(:'ADM2', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.publish_maintenance_catalog_version(:'CAT2_id')) = 'published', 'version 2 is published by an independent Admin');
reset role;
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select outcome, plan_id as id from projects.open_maintenance_plan(:'P3_id', :'CAT2_id') \gset PD_
select pg_temp.check((select outcome from projects.record_maintenance_plan_acceptance(:'PD_id', 'accepted', :'SPA_id', 'email', 'mail-30', 'Client Contact')) = 'accepted', 'plan D is accepted');
reset role;
set local session_replication_role = replica;
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, total_minor, subtotal_minor, tax_minor, kind, issued_at, paid_minor, paid_at) values (:'ORG', :'A_id', :'P3_id', 'P8C-INV-4', 'paid', 9000, 9000, 0, 'service', now(), 9000, now()) returning id \gset INV4_
insert into finance.payments (organization_id, invoice_id, provider_payment_id, amount_minor, status, verified_at, verified_by) values (:'ORG', :'INV4_id', 'p8c-pay-4', 9000, 'captured', now(), :'OWNER');
insert into projects.phase_eight_intake (organization_id, project_id, client_account_id, status) values (:'ORG', :'P3_id', :'A_id', 'ready') returning id \gset INT_
insert into projects.phase_eight (organization_id, project_id, client_account_id, intake_id, state, no_warranty_reason) values (:'ORG', :'P3_id', :'A_id', :'INT_id', 'active', 'fixture');
set local session_replication_role = origin;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from finance.link_maintenance_invoice(:'PD_id', :'INV4_id', 'activation', current_date - 40, current_date - 1)) = 'linked', 'plan D''s paid cycle (already over) is linked');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.activate_maintenance_plan(:'PD_id')) = 'activated', 'plan D is activated on verified money');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select expired from projects.sweep_maintenance_renewals(:'ORG')) >= 1, 'the 8A sweep expires a plan whose end date passed with no renewal');
reset role;
select pg_temp.check((select status = 'expired' and length(ended_reason) > 0 from projects.maintenance_plans where id = :'PD_id'), 'it lapses with a reason; it is not extended');
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.propose_maintenance_renewal(:'PD_id', current_date + 400, :'SPR_id')) = 'wrong_state', 'an expired plan is not renewed: it needs a new acceptance');
reset role;

-- ═════════ post-launch work items for the sweeps and the data-safety control ═════════
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select work_item_id as "W1_id" from projects.open_maintenance_work(:'P1_id', 'hotfix', 'backend', 'Fix prod bug', null, null, :'D1_id') \gset
select work_item_id as "W2_id" from projects.open_maintenance_work(:'P1_id', 'patch', 'database', 'Add a column', null, :'T4_id', null, null, false, true) \gset
select work_item_id as "W3_id" from projects.open_maintenance_work(:'P1_id', 'patch', 'frontend', 'Copy fix', null, :'T3_id') \gset
select work_item_id as "W4_id" from projects.open_maintenance_work(:'P1_id', 'enhancement', 'frontend', 'Small tweak', null, null, null, :'CR_id') \gset
select work_item_id as "W5_id" from projects.open_maintenance_work(:'P1_id', 'hotfix', 'backend', 'Second bug', null, null, :'D2_id') \gset
reset role;
select pg_temp.as_service();
select pg_temp.check(projects.maintenance_priority(:'W1_id') = 'p2' and projects.maintenance_priority(:'W2_id') = 'p2' and projects.maintenance_priority(:'W4_id') = 'p3', 'priority is derived like the TypeScript router: hotfix and patch p2, enhancement p3');
select pg_temp.check((select count(*) from projects.evaluate_maintenance_gates(:'W1_id')) = 11, 'there are eleven gates now');

-- ═════════ SLA breach: an Admin-set target, recorded once, escalated to a person ═════════
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select breached from projects.sweep_maintenance_sla(:'ORG', clock_timestamp() + interval '1000 hours')) = 0, 'with no SLA policy nothing is ever called late');
select pg_temp.check((select skipped_no_policy from projects.sweep_maintenance_sla(:'ORG', clock_timestamp() + interval '1000 hours')) >= 5, 'work with no policy is counted as skipped, not breached');
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_maintenance_sla_policy('p2', 4, 24)) = 'set', 'an Admin sets the p2 target (24 hours)');
select pg_temp.check(pg_temp.denied($$select * from projects.sweep_maintenance_sla()$$), 'a signed-in person cannot run the SLA sweep');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select breached from projects.sweep_maintenance_sla(:'ORG', clock_timestamp())) = 0, 'inside the target nothing is breached');
select pg_temp.check((select breached from projects.sweep_maintenance_sla(:'ORG', clock_timestamp() + interval '30 hours')) = 4, 'past the target the four p2 items are recorded (the p3 item has no policy)');
select pg_temp.check((select breached from projects.sweep_maintenance_sla(:'ORG', clock_timestamp() + interval '30 hours')) = 0, 'a second sweep records nothing new (once per item)');
reset role;
select pg_temp.check((select priority = 'p2' and policy_version = 1 and resolution_due_at = (select created_at + interval '24 hours' from projects.maintenance_work_items where id = :'W1_id') from projects.maintenance_sla_breaches where work_item_id = :'W1_id'), 'the breach names the priority, the policy version and the computed due time');
select pg_temp.check((select count(*) from projects.maintenance_sla_breaches where work_item_id = :'W4_id') = 0, 'the item with no policy was never called late');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.maintenance_sla_breached' and subject_id in (:'W1_id', :'W2_id', :'W3_id', :'W5_id')) = 4, 'one announcement event per breach');
select pg_temp.check(pg_temp.refused(format($$delete from projects.maintenance_sla_breaches where work_item_id = %L$$, :'W1_id'), 'never edited or deleted'), 'a breach is history');
select id as "BR_id" from projects.maintenance_sla_breaches where work_item_id = :'W1_id' \gset
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.acknowledge_maintenance_sla_breach(:'BR_id', 'on it')) = 'not_authorized', 'a member cannot acknowledge a breach');
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.acknowledge_maintenance_sla_breach(:'BR_id', '')) = 'note_required', 'an acknowledgement says what is being done');
select pg_temp.check((select outcome from projects.acknowledge_maintenance_sla_breach(:'BR_id', 'rescheduled with the client')) = 'acknowledged', 'an Admin (a person) acknowledges the escalation');
select pg_temp.check((select outcome from projects.acknowledge_maintenance_sla_breach(:'BR_id', 'again')) = 'already_acknowledged', 'acknowledged once');
reset role;

-- ═════════ stalls: derived reasons, recorded once, no invented threshold ═════════
set local session_replication_role = replica;
update qa.defects set status = 'wontfix', resolution = 'not a defect' where id = :'D2_id';
set local session_replication_role = origin;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(exists (select 1 from projects.maintenance_work_stall_reasons(:'W5_id') where reason_code = 'authorization_invalid'), 'work whose authorizing defect was closed as wontfix is stalled: authorization_invalid');
select pg_temp.check(not exists (select 1 from projects.maintenance_work_stall_reasons(:'W1_id', clock_timestamp() + interval '1000 hours') where reason_code = 'inactive'), 'with no stall policy, inactivity is not a stall (no threshold is assumed)');
select pg_temp.check((select marked from projects.sweep_maintenance_stalls(:'ORG', clock_timestamp())) >= 1, 'the sweep records the stall');
select pg_temp.check((select marked from projects.sweep_maintenance_stalls(:'ORG', clock_timestamp())) = 0, 'once per reason and state');
reset role;
select pg_temp.check((select count(*) from projects.maintenance_work_stalls where work_item_id = :'W5_id' and reason_code = 'authorization_invalid') = 1 and (select status from projects.maintenance_work_items where id = :'W5_id') = 'open', 'the stall is a record; the work item''s own status is unchanged');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.maintenance_work_stalled' and subject_id = :'W5_id') = 1, 'one announcement event');
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
reset role;
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_maintenance_stall_policy(5)) = 'not_authorized', 'a member cannot set the stall threshold');
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_maintenance_stall_policy(0)) = 'bad_hours', 'a stall threshold is within bounds');
select pg_temp.check((select outcome from projects.set_maintenance_stall_policy(1)) = 'set', 'an Admin sets the inactivity threshold');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select marked from projects.sweep_maintenance_stalls(:'ORG', clock_timestamp() + interval '3 hours')) >= 4, 'past the threshold the idle items are recorded as inactive');
select pg_temp.check((select marked from projects.sweep_maintenance_stalls(:'ORG', clock_timestamp() + interval '3 hours')) = 0, 'and not again');
reset role;
select pg_temp.check((select count(*) from projects.maintenance_work_stalls where work_item_id = :'W1_id' and reason_code = 'inactive') = 1, 'the idle item has one inactive record');
-- structural deadlocks, in an organization with one person
select pg_temp.as_user(:'UC', :'ORGC', 'owner');
set local role authenticated;
select work_item_id as "WC_id" from projects.open_maintenance_work(:'P5_id', 'patch', 'backend', 'Tiny fix', null, :'TC_id') \gset
select projects.submit_maintenance_fix(:'WC_id', :'C1', 'fix', 'revert', 'uc');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(exists (select 1 from projects.maintenance_work_stall_reasons(:'WC_id') where reason_code = 'no_independent_qa'), 'the only person who can write is the commit''s author: independent QA is impossible (no_independent_qa)');
reset role;
set local session_replication_role = replica;
update projects.maintenance_work_items set status = 'release_review', release_requested_by = :'UC', release_requested_commit = :'C1' where id = :'WC_id';
set local session_replication_role = origin;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(exists (select 1 from projects.maintenance_work_stall_reasons(:'WC_id') where reason_code = 'no_independent_approver'), 'no Admin other than the author exists: no_independent_approver');
select pg_temp.check((select marked from projects.sweep_maintenance_stalls(:'ORGC')) >= 1, 'the sweep marks the structural stall');
reset role;
select pg_temp.check((select count(*) from projects.maintenance_work_stalls where work_item_id = :'WC_id') >= 1, 'the structural stall is on record');

-- ═════════ the data-safety control: a sensitive database change needs a rollback plan and backup evidence ═════════
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select projects.submit_maintenance_fix(:'W2_id', :'C1', 'add column', 'drop the column', 'dev');
reset role;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select projects.record_maintenance_qa_result(:'W2_id', 'targeted', 'pass', :'C1', 'run:1');
select projects.record_maintenance_qa_result(:'W2_id', 'regression', 'pass', :'C1', 'run:2');
select projects.record_maintenance_qa_result(:'W2_id', 'security', 'pass', :'C1', 'run:3');
select pg_temp.check((select status from projects.maintenance_work_items where id = :'W2_id') = 'qa_passed', 'every QA gate passed on the sensitive database change');
select pg_temp.check((select passed from projects.evaluate_maintenance_gates(:'W2_id') where gate = 'data_safety') = false, 'but the data-safety gate is open: no rollback plan and backup evidence are recorded');
select outcome as o, open_gates as og from projects.request_maintenance_release(:'W2_id') \gset RR_
select pg_temp.check(:'RR_o' = 'gates_open' and :'RR_og' like '%data_safety%', 'release cannot be requested while data safety is open');
reset role;
select pg_temp.check((select passed from projects.evaluate_maintenance_gates(:'W1_id') where gate = 'data_safety') = true, 'the gate is satisfied trivially for a change that is not a sensitive database change');
-- work opened before the control began is outside it
update projects.maintenance_c_cutover set data_safety_from = now() + interval '1 day';
select pg_temp.check((select passed from projects.evaluate_maintenance_gates(:'W2_id') where gate = 'data_safety') = true, 'work opened before the cutover is outside the new control');
update projects.maintenance_c_cutover set data_safety_from = now() - interval '1 day';
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_maintenance_data_safety(:'W2_id', :'C1', 'drop the column', 'backup-2026-11-09-snapshot')) = 'self_confirmation', 'the author of the commit does not confirm their own backup');
reset role;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_maintenance_data_safety(:'W3_id', :'C1', 'x', 'y')) = 'not_a_sensitive_database_change', 'only a sensitive database change takes a data-safety record');
select pg_temp.check((select outcome from projects.record_maintenance_data_safety(:'W2_id', :'C3', 'drop the column', 'backup-snapshot')) = 'stale_commit', 'evidence about another commit is refused');
select pg_temp.check((select outcome from projects.record_maintenance_data_safety(:'W2_id', :'C1', '', 'backup-snapshot')) = 'rollback_plan_required', 'a rollback plan is required');
select pg_temp.check((select outcome from projects.record_maintenance_data_safety(:'W2_id', :'C1', 'drop the column', ' ')) = 'backup_evidence_required', 'a backup evidence reference is required');
select pg_temp.check((select outcome from projects.record_maintenance_data_safety(:'W2_id', :'C1', 'drop the column', 'secret = abcdefghijklmnopqrstuv')) = 'secret_in_text', 'evidence is a reference, never a secret');
select pg_temp.check((select outcome from projects.record_maintenance_data_safety(:'W2_id', :'C1', 'drop the column; restore the snapshot', 'backup-2026-11-09-snapshot')) = 'recorded', 'an independent person records the rollback plan and the backup reference');
select pg_temp.check((select passed from projects.evaluate_maintenance_gates(:'W2_id') where gate = 'data_safety') = true, 'the data-safety gate holds for this exact commit');
reset role;
-- a different commit is different work: the record does not carry over
select pg_temp.as_user(:'DEV', :'ORG', 'member');
set local role authenticated;
select projects.submit_maintenance_fix(:'W2_id', :'C2', 'add column, revised', 'drop the column', 'dev');
select pg_temp.check((select passed from projects.evaluate_maintenance_gates(:'W2_id') where gate = 'data_safety') = false, 'a new commit invalidates the data-safety record');
reset role;
select pg_temp.as_user(:'QA', :'ORG', 'member');
set local role authenticated;
select projects.record_maintenance_qa_result(:'W2_id', 'targeted', 'pass', :'C2', 'run:4');
select projects.record_maintenance_qa_result(:'W2_id', 'regression', 'pass', :'C2', 'run:5');
select projects.record_maintenance_qa_result(:'W2_id', 'security', 'pass', :'C2', 'run:6');
select pg_temp.check((select outcome from projects.request_maintenance_release(:'W2_id')) = 'gates_open', 're-tested but still without data safety on the new commit: no release request');
select pg_temp.check((select outcome from projects.record_maintenance_data_safety(:'W2_id', :'C2', 'drop the column; restore the snapshot', 'backup-2026-11-09-snapshot-2')) = 'recorded', 'data safety is recorded on the new commit');
select pg_temp.check((select outcome from projects.request_maintenance_release(:'W2_id')) = 'requested', 'release is requested once data safety holds');
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_maintenance_release(:'W2_id', 'approve')) = 'approved', 'an independent Admin approves the exact commit');
reset role;

-- the sweeps check the role INSIDE too, not only the grant: a session that is not the service role gets nothing from them
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
select pg_temp.check((select checked = 0 and breached = 0 from projects.sweep_maintenance_sla(:'ORG', clock_timestamp() + interval '1000 hours')), 'the SLA sweep refuses a session that is not the service role');
select pg_temp.check((select checked = 0 and marked = 0 from projects.sweep_maintenance_stalls(:'ORG', clock_timestamp() + interval '1000 hours')), 'the stall sweep refuses a session that is not the service role');
select pg_temp.check((select checked = 0 and flagged = 0 from projects.sweep_maintenance_plan_payment_gates(:'ORG')), 'the payment-gate sweep refuses a session that is not the service role');

-- ═════════ tenancy and structure ═════════
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.maintenance_plan_catalog) = 0 and (select count(*) from projects.maintenance_usage_entries) = 0 and (select count(*) from projects.maintenance_sla_breaches) = 0 and (select count(*) from projects.maintenance_work_stalls) = 0, 'another organization sees none of it');
select pg_temp.check((select outcome from projects.activate_maintenance_plan(:'PA_id')) = 'not_found' and (select outcome from projects.publish_maintenance_catalog_version(:'CAT2_id')) = 'not_found', 'another organization cannot decide it');
select pg_temp.check((select count(*) from projects.maintenance_plan_overview(:'P1_id')) = 0, 'another organization''s overview is empty');
reset role;
select pg_temp.check(pg_temp.refused(format($$insert into projects.maintenance_usage_entries (organization_id, client_account_id, plan_id, cycle_id, entry_kind, quantity, occurred_on, ticket_id, recorded_by) values (%L, %L, %L, %L, 'hours', 1, current_date, %L, %L)$$, :'ORGB', :'A_id', :'PA_id', :'CYA_id', :'T1_id', :'UB'), 'tenancy:'), 'a ledger row cannot graft another organization''s plan onto itself');
select pg_temp.check((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'projects' and c.relkind = 'r' and c.relname in ('maintenance_plan_catalog', 'maintenance_plan_price_lines', 'maintenance_plan_lifecycle', 'maintenance_plan_acceptances', 'maintenance_plan_cycles', 'maintenance_usage_entries', 'maintenance_overage_drafts', 'maintenance_plan_renewals', 'maintenance_plan_cancellations', 'maintenance_data_safety_records', 'maintenance_stall_policies', 'maintenance_sla_breaches', 'maintenance_sla_breach_acknowledgements', 'maintenance_work_stalls') and c.relrowsecurity) = 14, 'all fourteen new tables have RLS on');
select pg_temp.check((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'projects' and c.relkind = 'r' and c.relname in ('maintenance_plan_catalog', 'maintenance_plan_price_lines', 'maintenance_plan_lifecycle', 'maintenance_plan_acceptances', 'maintenance_plan_cycles', 'maintenance_usage_entries', 'maintenance_overage_drafts', 'maintenance_plan_renewals', 'maintenance_plan_cancellations', 'maintenance_data_safety_records', 'maintenance_stall_policies', 'maintenance_sla_breaches', 'maintenance_sla_breach_acknowledgements', 'maintenance_work_stalls') and (has_table_privilege('authenticated', c.oid, 'INSERT') or has_table_privilege('authenticated', c.oid, 'UPDATE') or has_table_privilege('authenticated', c.oid, 'DELETE') or has_table_privilege('anon', c.oid, 'SELECT'))) = 0, 'no new table takes an end-user write or an anonymous read');
select pg_temp.check((select count(*) from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace join pg_class pc on pc.oid = k.confrelid join pg_namespace pn on pn.oid = pc.relnamespace
   where k.contype = 'f' and n.nspname = 'projects' and c.relname in ('maintenance_plan_price_lines', 'maintenance_plan_lifecycle', 'maintenance_plan_acceptances', 'maintenance_plan_cycles', 'maintenance_usage_entries', 'maintenance_overage_drafts', 'maintenance_plan_renewals', 'maintenance_plan_cancellations', 'maintenance_data_safety_records', 'maintenance_sla_breaches', 'maintenance_sla_breach_acknowledgements', 'maintenance_work_stalls')
     and exists (select 1 from pg_attribute a where a.attrelid = pc.oid and a.attname = 'organization_id' and not a.attisdropped) and pn.nspname || '.' || pc.relname <> 'core.organizations'
     and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = c.relname || '_parent_org_' || (select attname from pg_attribute where attrelid = c.oid and attnum = k.conkey[1]))) = 0, 'every foreign key to an org-scoped parent has its enforce_parent_org trigger');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.proname in ('sweep_maintenance_sla', 'sweep_maintenance_stalls', 'sweep_maintenance_plan_payment_gates') and has_function_privilege('authenticated', p.oid, 'EXECUTE')) = 0, 'the three sweeps are service-role only');
\echo verify-phase-eight-c: OK
rollback;
