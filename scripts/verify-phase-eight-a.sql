-- ═════════════════════════════════════════════════════════════════
-- Phase 8A (Customer Success, Support, Upsell, post-launch Sales) - driven through the REAL doors on a scratch Postgres.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-eight-a.sql          (rolls back)
--
-- The AI workflows are not run here (tests/phase-eight-cs-workflows.test.ts proves them against a stand-in model); each step an agent
-- would take is the service-role door it calls. Fixtures are inserted as the table owner with triggers off ONLY where an upstream engine
-- (handover acceptance, defect verification) is not what is under test.
-- ═════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok  %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to public;

-- round 4: a how-to closes only on a citation of an APPROVED article, so a fixture cites one (written as the table owner, like the other fixtures)
create or replace function pg_temp.p5r_cite_approved(p_ticket uuid) returns void language plpgsql security definer as $$
declare v_org uuid; v_art uuid; v_u uuid; v_r text;
begin
  select t.organization_id into v_org from projects.support_tickets t where t.id = p_ticket;
  select u.id into v_u from core.users u order by u.id limit 1;
  if v_org is null or v_u is null then raise exception 'p5r fixture: no ticket or no user'; end if;
  insert into projects.support_knowledge_articles (organization_id, article_key, version, title, body, status, proposed_by_agent, approved_by, approved_at)
  values (v_org, 'p5r-' || replace(gen_random_uuid()::text, '-', ''), 1, 'Exporting your data', 'Open Settings, choose Export, pick a format and press the Export button.', 'approved', 'support', v_u, now())
  returning id into v_art;
  v_r := projects.p8g_cite(v_org, null, 'support', p_ticket, v_art);
  if v_r <> 'cited' then raise exception 'p5r fixture: cite returned %', v_r; end if;
end $$;
grant execute on function pg_temp.p5r_cite_approved(uuid) to public;

create or replace function pg_temp.as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
    'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true);
end $$;
grant execute on function pg_temp.as_user(uuid, uuid, text) to public;

create or replace function pg_temp.as_client(p_sub uuid, p_org uuid, p_account uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
    'app_metadata', jsonb_build_object('organization_id', p_org, 'role', 'client_member', 'client_account_id', p_account))::text, true);
end $$;
grant execute on function pg_temp.as_client(uuid, uuid, uuid) to public;

create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true); end $$;
grant execute on function pg_temp.as_service() to public;

-- true when the statement fails and the message contains the needle
create or replace function pg_temp.errs(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when others then return position(needle in sqlerrm) > 0; end $$;
grant execute on function pg_temp.errs(text, text) to public;
-- a direct write with NO door announced in this transaction (the doors' transaction-local flag is cleared first)
create or replace function pg_temp.direct(stmt text, needle text) returns boolean language plpgsql as $$
begin perform set_config('projects.p8_sanctioned', 'off', true); return pg_temp.errs(stmt, needle); end $$;
grant execute on function pg_temp.direct(text, text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000008b2'
\set OWNER '00000000-0000-4000-8000-00000000f801'
\set ADMIN '00000000-0000-4000-8000-00000000f802'
\set STAFF '00000000-0000-4000-8000-00000000f803'
\set STAFF2 '00000000-0000-4000-8000-00000000f804'
\set CLIENTU '00000000-0000-4000-8000-00000000f805'
\set CLIENTU2 '00000000-0000-4000-8000-00000000f806'
\set BSTAFF '00000000-0000-4000-8000-00000000f807'
\set OUTSIDER '00000000-0000-4000-8000-00000000f808'

insert into core.organizations (id, name, slug) values (:'ORGB', 'Other Agency (8a)', 'other-agency-8a') on conflict (id) do nothing;
insert into auth.users (id, email) values (:'OWNER', 'p8a-owner@example.test'), (:'ADMIN', 'p8a-admin@example.test'), (:'STAFF', 'p8a-staff@example.test'), (:'STAFF2', 'p8a-staff2@example.test'),
  (:'CLIENTU', 'p8a-client@example.test'), (:'CLIENTU2', 'p8a-client2@example.test'), (:'BSTAFF', 'p8a-bstaff@example.test'), (:'OUTSIDER', 'p8a-out@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'p8a-owner@example.test', 'P8A Owner'), (:'ADMIN', 'p8a-admin@example.test', 'P8A Admin'), (:'STAFF', 'p8a-staff@example.test', 'P8A Staff'),
  (:'STAFF2', 'p8a-staff2@example.test', 'P8A Staff Two'), (:'CLIENTU', 'p8a-client@example.test', 'P8A Client'), (:'CLIENTU2', 'p8a-client2@example.test', 'P8A Client Two'),
  (:'BSTAFF', 'p8a-bstaff@example.test', 'P8A Other Staff'), (:'OUTSIDER', 'p8a-out@example.test', 'P8A Outsider') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner'), (:'ORG', :'ADMIN', 'ops_admin'), (:'ORG', :'STAFF', 'member'), (:'ORG', :'STAFF2', 'member'), (:'ORGB', :'BSTAFF', 'member')
  on conflict do nothing;
select set_config('p8.org', :'ORG', true);

-- fixture: a COMPLETED project with the facts the intake reads. p_good = false leaves out the handover, the verification and the contact and adds an unpaid invoice.
create or replace function pg_temp.mk(p_code text, p_limits text default 'none known', p_good boolean default true, p_org uuid default null)
returns table (client uuid, project uuid)
language plpgsql as $$
declare v_org uuid := coalesce(p_org, current_setting('p8.org')::uuid); v_a uuid; v_p uuid; v_sv uuid;
begin
  insert into core.client_accounts (organization_id, name) values (v_org, 'zztest p8a ' || p_code) returning id into v_a;
  insert into projects.projects (organization_id, client_account_id, name, project_code, status) values (v_org, v_a, 'zztest p8a ' || p_code, p_code, 'completed') returning id into v_p;
  insert into projects.scope_versions (organization_id, project_id, version, status, frozen_at) values (v_org, v_p, 1, 'active', now()) returning id into v_sv;
  if p_good then
    alter table projects.handovers disable trigger user;
    insert into projects.handovers (organization_id, project_id, status, delivered_at, accepted_at) values (v_org, v_p, 'accepted', now(), now());
    alter table projects.handovers enable trigger user;
    insert into projects.release_verifications (organization_id, project_id, environment, outcome) values (v_org, v_p, 'production', 'passed');
    insert into crm.contacts (organization_id, client_account_id, full_name, email) values (v_org, v_a, 'Contact ' || p_code, lower(p_code) || '@client.example.test');
  else
    alter table finance.invoices disable trigger user;
    insert into finance.invoices (organization_id, client_account_id, project_id, number, kind, status, issued_at, total_minor) values (v_org, v_a, v_p, 'ZZ-' || p_code, 'milestone', 'issued', now(), 1000);
    alter table finance.invoices enable trigger user;
  end if;
  alter table projects.completion_records disable trigger user;
  insert into projects.completion_records (organization_id, project_id, client_account_id, scope_version_id, scope_version, invoiced_minor, verified_minor, completed_at, known_limitations)
  values (v_org, v_p, v_a, v_sv, 1, case when p_good then 0 else 1000 end, 0, now(), p_limits);
  alter table projects.completion_records enable trigger user;
  return query select v_a, v_p;
end $$;
grant execute on function pg_temp.mk(text, text, boolean, uuid) to public;

-- an open ticket through the webhook door, then classified by a person: returns the id
create or replace function pg_temp.ticket(p_project uuid, p_ref text, p_class text, p_cov text, p_prio text, p_plan uuid default null) returns uuid language plpgsql as $$
declare v_t uuid; v_o text;
begin
  perform pg_temp.as_service();
  select ticket_id into v_t from projects.open_support_ticket(current_setting('p8.org')::uuid, p_project, 'ticket ' || p_ref, 'the client wrote something', 'portal', p_ref);
  perform pg_temp.as_user(current_setting('p8.staff')::uuid, current_setting('p8.org')::uuid, 'member');
  select outcome into v_o from projects.classify_support_ticket(v_t, p_class, p_cov, 'because ' || p_ref, p_prio, p_plan);
  if v_o <> 'classified' then raise exception 'fixture ticket % not classified: %', p_ref, v_o; end if;
  return v_t;
end $$;
grant execute on function pg_temp.ticket(uuid, text, text, text, text, uuid) to public;
select set_config('p8.staff', :'STAFF', true);

-- ═════════ 1. the entry gate and the workspace ═════════
select project as "P_id", client as "A_id" from pg_temp.mk('P8A-MAIN', null) \gset
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.fill_phase_eight_intake(:'ORG', :'P_id')) = 'incomplete', 'a completed project with no recorded known limitations has an INCOMPLETE intake');
select pg_temp.check((select blockers -> 0 ->> 'id' from projects.phase_eight_intake where project_id = :'P_id') = 'P8-GATE-007' and (select jsonb_array_length(blockers) from projects.phase_eight_intake where project_id = :'P_id') = 1,
                     'the one blocker is P8-GATE-007 and it says so');
select pg_temp.check((select count(*) from jsonb_array_elements((select gates from projects.phase_eight_intake where project_id = :'P_id')) g where g ->> 'id' = 'P8-GATE-006' and (g ->> 'passed')::boolean = false and g ->> 'at' = 'start') = 1, 'P8-GATE-006 (warranty) is decided at start, not pretended at intake');

-- the intake door is the service role only
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(pg_temp.errs(format('select * from projects.fill_phase_eight_intake(%L, %L)', :'ORG', :'P_id'), 'permission denied'), 'NEGATIVE: a signed-in person cannot fill the intake (service role only)');
select pg_temp.check((select outcome from projects.start_phase_eight(:'P_id', current_date, current_date + 90, 'defects in the delivered scope', 'new features, third-party outages', null, null)) = 'intake_not_ready', 'NEGATIVE: Phase 8 cannot start from an incomplete intake');
reset role;

-- a person writes the known limitations (the one mutable completion field); the intake refreshes to ready
update projects.completion_records set known_limitations = 'none known at completion' where project_id = :'P_id';
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.fill_phase_eight_intake(:'ORG', :'P_id')) = 'ready', 'once a person records the known limitations the intake is READY');
select pg_temp.check((select status = 'ready' and source = 'completion_record' and phase_seven_handoff_ref is null and build_ref is null from projects.phase_eight_intake where project_id = :'P_id'), 'the intake says where it came from (completion record; no Phase 7 snapshot yet)');
select pg_temp.check((select package ->> 'clientName' from projects.phase_eight_intake where project_id = :'P_id') = 'zztest p8a P8A-MAIN' and jsonb_array_length((select package -> 'contactIds' from projects.phase_eight_intake where project_id = :'P_id')) = 1, 'the handoff package names the client and the contacts');

-- negative gates on a project that did not really finish
select project as "PX_id" from pg_temp.mk('P8A-BAD', 'none', false) \gset
select pg_temp.check((select outcome from projects.fill_phase_eight_intake(:'ORG', :'PX_id')) = 'incomplete', 'a project with no accepted handover, no verification, no contact and an open invoice is incomplete');
select pg_temp.check((select array_agg(b ->> 'id' order by b ->> 'id') from projects.phase_eight_intake i, jsonb_array_elements(i.blockers) b where i.project_id = :'PX_id') = array['P8-GATE-002', 'P8-GATE-003', 'P8-GATE-004', 'P8-GATE-008'], 'the blockers are exactly deployment, handover, final payment and the contact package');
select pg_temp.check((select outcome from projects.fill_phase_eight_intake(:'ORG', gen_random_uuid())) = 'unknown_project', 'an unknown project is refused');
select pg_temp.check((select outcome from projects.fill_phase_eight_intake(:'ORGB', :'P_id')) = 'unknown_project', 'NEGATIVE: another organization''s service call cannot read this project');

-- an owner-approved exception, recorded, append-only
select project as "PW_id" from pg_temp.mk('P8A-WAIVE', null) \gset
select pg_temp.check((select outcome from projects.fill_phase_eight_intake(:'ORG', :'PW_id')) = 'incomplete', 'waiver fixture: incomplete only on the known limitations');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.waive_phase_eight_gate(:'PW_id', 'P8-GATE-007', 'the client signed the limitations off by email')) = 'not_authorized', 'NEGATIVE: only the owner waives a gate');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.waive_phase_eight_gate(:'PW_id', 'P8-GATE-001', 'completion is not a thing to waive')) = 'not_waivable', 'the completion gate cannot be waived');
select pg_temp.check((select outcome from projects.waive_phase_eight_gate(:'PW_id', 'P8-GATE-007', 'short')) = 'reason_required', 'a waiver needs a real reason');
select pg_temp.check((select outcome from projects.waive_phase_eight_gate(:'PW_id', 'P8-GATE-007', 'the client signed the limitations off by email')) = 'waived', 'the owner waives P8-GATE-007 with a reason');
reset role;
select pg_temp.check((select status from projects.phase_eight_intake where project_id = :'PW_id') = 'ready', 'a waived gate lets the intake be ready');
select pg_temp.check((select (g ->> 'waived')::boolean and g ->> 'detail' like 'waived by the owner:%' from projects.phase_eight_intake i, jsonb_array_elements(i.gates) g where i.project_id = :'PW_id' and g ->> 'id' = 'P8-GATE-007'), 'the intake shows the gate as WAIVED with the reason, not as passed');
select pg_temp.check(pg_temp.errs(format('update projects.phase_eight_gate_waivers set reason = %L where project_id = %L', 'rewritten history', :'PW_id'), 'history'), 'a waiver is append-only');

-- start: the warranty is decided by a person
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_phase_eight(:'P_id')) = 'warranty_required', 'NEGATIVE: Phase 8 does not start with no warranty decision');
select pg_temp.check((select outcome from projects.start_phase_eight(:'P_id', current_date, current_date + 90, 'defects in delivered scope', null, null, null)) = 'warranty_required', 'NEGATIVE: a warranty window needs its exclusions');
select pg_temp.check((select outcome from projects.start_phase_eight(:'P_id', current_date + 5, current_date, 'defects', 'new features', null, null)) = 'warranty_required', 'NEGATIVE: a window cannot end before it starts');
select pg_temp.check((select outcome from projects.start_phase_eight(:'P_id', current_date, current_date + 90, 'defects', 'new features', null, :'OUTSIDER')) = 'owner_not_a_member', 'NEGATIVE: the Customer Success owner is a member of this organization');
reset role;
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_phase_eight(:'P_id', current_date, current_date + 90, 'defects', 'new features', null, null)) in ('not_authorized', 'no_actor'), 'NEGATIVE: a portal client cannot start Phase 8');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.start_phase_eight(:'P_id', current_date, current_date + 90, 'defects', 'new features', null, null)) = 'not_found', 'NEGATIVE: another organization''s staff cannot start it');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "START1" from projects.start_phase_eight(:'P_id', current_date - 10, current_date + 80, 'defects in the delivered scope', 'new features, third-party outages', null, :'STAFF2') \gset
select pg_temp.check(:'START1' = 'started', 'Phase 8 starts from a ready intake with a warranty window a person defined');
select pg_temp.check((select outcome from projects.start_phase_eight(:'P_id', current_date, current_date + 90, 'x', 'y', null, null)) = 'already_started', 'a second start is the same workspace');
reset role;
select pg_temp.check((select count(*) from projects.phase_eight where project_id = :'P_id') = 1 and (select cs_owner from projects.phase_eight where project_id = :'P_id') = :'STAFF2'::uuid, 'exactly one workspace, owned by the person named');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.phase_eight_started' and subject_id = (select id from projects.phase_eight where project_id = :'P_id')) = 1, 'ProjectPhaseEightStarted is emitted exactly once');
select pg_temp.check((select count(*) from projects.cs_check_ins where project_id = :'P_id' and kind = 'post_handover' and status = 'due') = 1, 'the workspace opened the post-handover check-in once (due, not sent)');
select pg_temp.check((select due_on from projects.cs_check_ins where project_id = :'P_id' and kind = 'post_handover') = ((now() at time zone 'UTC')::date + 7), 'the first check-in is due after the default 7 days');
select pg_temp.check((select status from projects.customer_health_snapshots where project_id = :'P_id' order by seq desc limit 1) = 'healthy', 'the first derived health read is healthy: nothing is open');
select pg_temp.check((select count(*) from audit.audit_log where action = 'phase_eight.started' and subject_id = (select id from projects.phase_eight where project_id = :'P_id')) = 1, 'the start is audited');
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.fill_phase_eight_intake(:'ORG', :'P_id')) = 'already_started', 'the intake is frozen once the workspace has started');
select pg_temp.check(pg_temp.direct(format('update projects.phase_eight_intake set status = %L where project_id = %L', 'incomplete', :'P_id'), 'through its door'), 'a direct write to the intake is refused');
select pg_temp.check(pg_temp.direct(format('update projects.phase_eight set cs_owner = null where project_id = %L', :'P_id'), 'through its door'), 'a direct write to the workspace is refused');

-- the completed project is historical truth: snapshot it now and compare at the end
select md5(to_jsonb(pr)::text || to_jsonb(cr)::text) as "HIST_before" from projects.projects pr join projects.completion_records cr on cr.project_id = pr.id where pr.id = :'P_id' \gset

-- settings: a person confirms the numbers
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_phase_eight_setting('sla_response_hours_p1', 2)) = 'not_authorized', 'NEGATIVE: staff cannot change an SLA setting');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_phase_eight_setting('sla_response_hours_p1', 0)) = 'out_of_range', 'a setting has bounds');
select pg_temp.check((select outcome from projects.set_phase_eight_setting('not_a_setting', 5)) = 'unknown_key', 'an unknown setting key is refused');
reset role;
select pg_temp.check(projects.p8_setting(:'ORG', 'sla_response_hours_p1') = 4 and projects.p8_setting(:'ORG', 'renewal_window_days') = 45, 'the documented defaults apply until the owner sets a value');

-- ═════════ 2. support tickets ═════════
select pg_temp.as_service();
select ticket_id as "T1_id" from projects.open_support_ticket(:'ORG', :'P_id', 'Checkout button does nothing', 'It broke after Tuesday', 'whatsapp', 'wamid.HBgM-1') \gset
select pg_temp.check(:'T1_id' is not null, 'a client message through the webhook opens a ticket');
select pg_temp.check((select outcome from projects.open_support_ticket(:'ORG', :'P_id', 'Checkout button does nothing', 'It broke after Tuesday', 'whatsapp', 'wamid.HBgM-1')) = 'duplicate', 'a repeated webhook delivery is the same ticket (outcome)');
select pg_temp.check((select count(*) from projects.support_tickets where project_id = :'P_id' and source_ref = 'wamid.HBgM-1') = 1, 'a repeated webhook delivery creates no second ticket (count)');
select pg_temp.check((select count(*) from core.outbox_events where type = 'support.ticket_created' and subject_id = :'T1_id') = 1, 'SupportTicketCreated is emitted once');
select pg_temp.check(pg_temp.errs(format('insert into projects.support_tickets (organization_id, project_id, client_account_id, source, source_ref, title) values (%L, %L, %L, %L, %L, %L)', :'ORG', :'P_id', :'A_id', 'whatsapp', 'wamid.HBgM-1', 'dup'), 'support_tickets_source_once'), 'the unique index also refuses a second ticket for one source message');
select pg_temp.check((select outcome from projects.open_support_ticket(:'ORG', :'PW_id', 'no workspace', 'x', 'portal')) = 'no_phase_eight', 'a ticket needs a Phase 8 workspace');
select pg_temp.check((select outcome from projects.open_support_ticket(:'ORGB', :'P_id', 'cross tenant', 'x', 'portal')) = 'not_found', 'NEGATIVE: a service call for another organization cannot open a ticket on this project');
select pg_temp.check((select outcome from projects.open_support_ticket(:'ORG', :'P_id', 'x', 'x', 'carrier_pigeon')) = 'bad_source', 'an unknown source is refused');
select pg_temp.check(pg_temp.direct(format('update projects.support_tickets set status = %L where id = %L', 'closed', :'T1_id'), 'through its door'), 'a direct write to a ticket is refused');

-- classification and coverage
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.classify_support_ticket(:'T1_id', 'new_project', 'covered_maintenance', 'a whole new platform', 'p3', null)) = 'coverage_mismatch', 'NEGATIVE: a new project can never be covered maintenance');
select pg_temp.check((select outcome from projects.classify_support_ticket(:'T1_id', 'change_request', 'covered_warranty', 'a new feature as a bug', 'p3', null)) = 'coverage_mismatch', 'NEGATIVE: a change request is never called a warranty bug');
select pg_temp.check((select outcome from projects.classify_support_ticket(:'T1_id', 'how_to', 'included_support', 'x', 'p3', null)) = 'reason_required', 'a classification needs a reason');
select pg_temp.check((select outcome from projects.classify_support_ticket(:'T1_id', 'warranty_bug', 'covered_warranty', 'the button is broken as delivered', 'p9', null)) = 'bad_priority', 'priority is p1..p4');
select pg_temp.check((select outcome from projects.classify_support_ticket(:'T1_id', 'maintenance', 'covered_maintenance', 'routine upkeep', 'p3', null)) = 'no_active_plan', 'NEGATIVE: maintenance coverage needs an active plan version covering the day');
reset role;
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select outcome from projects.classify_support_ticket(:'T1_id', 'how_to', 'included_support', 'a client classifying their own ticket', 'p4', null)) in ('not_authorized', 'no_actor'), 'NEGATIVE: a portal client cannot classify a ticket');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.classify_support_ticket(:'T1_id', 'how_to', 'included_support', 'cross tenant guess', 'p4', null)) = 'not_found', 'NEGATIVE: another organization''s staff cannot classify it');
reset role;

-- warranty window: raised long before the window opened -> outside warranty
select pg_temp.as_service();
select ticket_id as "TOLD_id" from projects.open_support_ticket(:'ORG', :'P_id', 'Old problem', 'from before the window', 'email', 'mail-old-1', now() - interval '200 days') \gset
select pg_temp.check((select raised_at < now() - interval '199 days' from projects.support_tickets where id = :'TOLD_id'), 'the service clock can be injected for a ticket');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.classify_support_ticket(:'TOLD_id', 'warranty_bug', 'covered_warranty', 'was it broken at delivery?', 'p3', null)) = 'outside_warranty', 'NEGATIVE: a defect raised outside the warranty window cannot be recorded as covered');
select pg_temp.check((select outcome from projects.classify_support_ticket(:'TOLD_id', 'warranty_bug', 'not_covered', 'raised outside the warranty window', 'p3', null)) = 'classified', 'it is recorded NOT covered, with the reason, instead');
reset role;

-- a how-to: answered from approved knowledge, no false defect (E2E-03)
insert into qa.defects (organization_id, project_id, severity, title, reproduction) values (:'ORG', :'P_id', 'major', 'checkout button dead', 'click pay') returning id as "DEF_id" \gset
insert into qa.defects (organization_id, project_id, severity, title, reproduction) values (:'ORG', (select project from pg_temp.mk('P8A-OTHER')), 'major', 'another project defect', 'x') returning id as "DEFX_id" \gset
select pg_temp.ticket(:'P_id', 'howto-1', 'how_to', 'included_support', 'p4') as "THOW_id" \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.link_support_root_cause(:'THOW_id', :'DEF_id')) = 'wrong_link_for_classification', 'NEGATIVE: a how-to cannot be linked to a defect');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'THOW_id', 'in_progress')) = 'assign_first', 'a how-to is assigned before it is worked');
select pg_temp.check((select outcome from projects.assign_support_ticket(:'THOW_id', :'OUTSIDER')) = 'assignee_not_a_member', 'NEGATIVE: the assignee is a member of this organization');
select pg_temp.check((select outcome from projects.assign_support_ticket(:'THOW_id', :'STAFF2')) = 'assigned', 'assigned to a person');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'THOW_id', 'in_progress')) = 'advanced', 'a how-to needs no root cause to be worked');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'THOW_id', 'in_qa')) = 'no_qa_for_this_class', 'a how-to does not go to QA');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'THOW_id', 'closed')) = 'answer_and_source_required', 'a how-to closes only with the answer given');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'THOW_id', 'closed', 'Explained the export button')) = 'approved_knowledge_citation_required', 'NEGATIVE: a how-to cannot close without a cited approved article');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'THOW_id', 'closed', 'Explained the export button', 'knowledge: exports-guide v2')) = 'approved_knowledge_citation_required', 'NEGATIVE: free-text "evidence" no longer stands in for the citation');
reset role;
select pg_temp.p5r_cite_approved(:'THOW_id');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.advance_support_ticket(:'THOW_id', 'closed', 'Explained the export button')) = 'advanced', 'a how-to is closed answered once an approved article is cited');
reset role;
select pg_temp.check((select status = 'closed' and close_reason = 'answered' and defect_id is null and classification = 'how_to' from projects.support_tickets where id = :'THOW_id'), 'the how-to ended as answered, with no defect behind it');
select pg_temp.check(pg_temp.errs(format('update projects.support_tickets set resolution_note = %L where id = %L', 'rewrite', :'THOW_id'), 'history'), 'a closed ticket is history');

-- a covered warranty defect through to the client's confirmation (E2E-02)
select pg_temp.ticket(:'P_id', 'bug-1', 'warranty_bug', 'covered_warranty', 'p2') as "TBUG_id" \gset
select pg_temp.check((select response_due_at = raised_at + interval '8 hours' and resolution_due_at = raised_at + interval '72 hours' from projects.support_tickets where id = :'TBUG_id'), 'the SLA clocks are computed in SQL from the raise time and the P2 settings');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.assign_support_ticket(:'TBUG_id', :'STAFF2')) = 'assigned', 'the defect ticket is assigned');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'TBUG_id', 'in_progress')) = 'root_cause_required', 'NEGATIVE: a warranty bug is not worked without its root cause linked to a defect');
select pg_temp.check((select outcome from projects.link_support_root_cause(:'TBUG_id', :'DEFX_id')) = 'wrong_project', 'NEGATIVE: the defect must be this project''s');
select pg_temp.check((select outcome from projects.link_support_root_cause(:'TBUG_id', null, gen_random_uuid())) = 'wrong_link_for_classification', 'NEGATIVE: a covered defect cannot be linked to a change request');
select pg_temp.check((select outcome from projects.link_support_root_cause(:'TBUG_id', :'DEF_id')) = 'linked', 'the ticket is linked to its defect');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'TBUG_id', 'in_progress')) = 'advanced', 'now it can be worked');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'TBUG_id', 'client_confirmation')) = 'qa_required', 'NEGATIVE: a technical fix cannot skip QA');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'TBUG_id', 'in_qa', 'fix ready', null, true)) = 'advanced', 'the fix goes to QA, and a release is needed');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'TBUG_id', 'release', null, 'build 41')) = 'qa_not_verified', 'NEGATIVE: no release while the defect is not verified');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'TBUG_id', 'client_confirmation')) = 'release_required', 'NEGATIVE: a ticket that needs a release does not skip it');
reset role;
select pg_temp.as_service();
set local session_replication_role = replica;
update qa.defects set status = 'verified', resolution = 'fixed and retested', verified_by = :'ADMIN', verified_at = now() where id = :'DEF_id';
set local session_replication_role = origin;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.advance_support_ticket(:'TBUG_id', 'release')) = 'advanced', 'the verified fix moves to release');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'TBUG_id', 'client_confirmation')) = 'release_evidence_required', 'NEGATIVE: the release is evidenced by a reference');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'TBUG_id', 'client_confirmation', null, 'release v1.0.3 deployed 14:10')) = 'advanced', 'released, waiting for the client');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'TBUG_id', 'closed')) = 'client_confirmation_required', 'NEGATIVE: the ticket cannot close without the client''s confirmation');
select pg_temp.check((select outcome from projects.record_client_confirmation(:'TBUG_id', 'ok')) = 'evidence_required', 'the confirmation needs evidence of where and what the client said');
select pg_temp.check((select outcome from projects.record_client_confirmation(:'TBUG_id', 'client replied "works now" on WhatsApp 15:02')) = 'confirmed', 'a PERSON records the client''s confirmation with its evidence');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'TBUG_id', 'closed', 'fixed in v1.0.3')) = 'advanced', 'the ticket closes after QA, release and confirmation');
reset role;
select pg_temp.check((select status = 'closed' and close_reason = 'resolved' and client_confirmed_at is not null from projects.support_tickets where id = :'TBUG_id'), 'closed resolved with a confirmation');
-- the same rule held by the table (not only the door): a sanctioned write that skips the confirmation is refused
select pg_temp.ticket(:'P_id', 'bug-2', 'warranty_bug', 'covered_warranty', 'p3') as "TBUG2_id" \gset
select set_config('projects.p8_sanctioned', 'on', true);
select pg_temp.check(pg_temp.errs(format('update projects.support_tickets set status = %L, closed_at = now(), close_reason = %L where id = %L', 'closed', 'resolved', :'TBUG2_id'), 'support_tickets_closed_technical_needs_confirmation'), 'the TABLE refuses a technical ticket closed without a client confirmation (not only the door)');
select pg_temp.check(pg_temp.errs(format('update projects.support_tickets set classification = %L, coverage_decision = %L where id = %L', 'change_request', 'covered_warranty', :'TBUG2_id'), 'support_tickets_coverage_matches_classification'), 'the TABLE refuses new scope covered as warranty (CHECK, so even a direct write fails)');
select pg_temp.check(pg_temp.errs(format('update projects.support_tickets set classification = %L, coverage_decision = %L where id = %L', 'how_to', 'covered_maintenance', :'TBUG2_id'), 'support_tickets_coverage_matches_classification'), 'the TABLE refuses a how-to carrying maintenance coverage');
select set_config('projects.p8_sanctioned', 'off', true);

-- out of scope: a change request closes only by naming what it became (E2E-06)
select pg_temp.ticket(:'P_id', 'cr-1', 'change_request', 'not_covered', 'p3') as "TCR_id" \gset
insert into projects.change_requests (organization_id, project_id, scope_version_id, requested) values (:'ORG', :'P_id', (select id from projects.scope_versions where project_id = :'P_id' limit 1), 'add a loyalty module') returning id as "CR_id" \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.assign_support_ticket(:'TCR_id', :'STAFF2')) = 'assigned', 'a change-request ticket is assigned');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'TCR_id', 'in_progress')) = 'out_of_scope_is_not_maintenance_work', 'NEGATIVE: new scope is never executed as maintenance');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'TCR_id', 'closed', 'handed over')) = 'must_route_first', 'NEGATIVE: it does not close until it names the change request it became');
select pg_temp.check((select outcome from projects.link_support_root_cause(:'TCR_id', :'DEF_id')) = 'wrong_link_for_classification', 'NEGATIVE: new scope carries no defect');
select pg_temp.check((select outcome from projects.link_support_root_cause(:'TCR_id', null, :'CR_id')) = 'linked', 'it is linked to the change request');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'TCR_id', 'closed', 'routed to a change request')) = 'advanced', 'and then closes as routed');
reset role;
select pg_temp.check((select close_reason from projects.support_tickets where id = :'TCR_id') = 'routed', 'closed as routed, not as resolved');

-- a disputed classification is never guessed and never silently billed: it asks a person
select pg_temp.ticket(:'P_id', 'disp-1', 'disputed', 'needs_review', 'p3') as "TDIS_id" \gset
select pg_temp.check((select escalated_to_role = 'ops_admin' and escalated_at is not null from projects.support_tickets where id = :'TDIS_id'), 'a disputed classification is escalated to a person automatically');
select pg_temp.check((select count(*) from core.outbox_events where type = 'support.ticket_escalated' and subject_id = :'TDIS_id') = 1, 'and says so once');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.assign_support_ticket(:'TDIS_id', :'STAFF2')) = 'assigned', 'a disputed ticket can be assigned');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'TDIS_id', 'in_progress')) = 'dispute_unresolved', 'NEGATIVE: a disputed ticket is not worked until it is classified');
select pg_temp.check((select outcome from projects.escalate_support_ticket(:'TDIS_id', 'owner', 'second opinion')) = 'already_open', 'a second escalation while one is open is refused');
select pg_temp.check((select outcome from projects.acknowledge_support_escalation(:'TDIS_id')) = 'not_authorized', 'NEGATIVE: only an admin acknowledges an escalation');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.acknowledge_support_escalation(:'TDIS_id', 'looking at it')) = 'acknowledged', 'an admin acknowledges it');
reset role;

-- replies are drafts a person sends (the agent never does)
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.record_support_proposal(:'ORG', :'T1_id', 'support', 'warranty_bug', 'the client says it broke after a release', 'Thanks for letting us know. We are looking at the checkout button and will update you today.', 'en')) = 'proposed', 'the Support agent PROPOSES a classification and a draft reply');
select pg_temp.check((select classification is null and status = 'new' and proposed_classification = 'warranty_bug' and proposed_by_agent = 'support' from projects.support_tickets where id = :'T1_id'), 'the proposal changed neither the classification nor the status');
select pg_temp.check((select count(*) from projects.support_reply_drafts where ticket_id = :'T1_id' and status = 'draft' and drafted_by_agent = 'support') = 1, 'the reply exists only as a draft');
select pg_temp.check((select outcome from projects.record_support_proposal(:'ORG', :'T1_id', 'support', 'warranty_bug', 'the client says it broke after a release', 'Thanks for letting us know. We are looking at the checkout button and will update you today.', 'en')) = 'already_proposed', 'a retried run proposes nothing twice');
select pg_temp.check((select outcome from projects.record_support_proposal(:'ORG', :'T1_id', 'support', null, null, 'We can do this for ₹5000 with a discount', 'en')) = 'no_price_here', 'NEGATIVE: an agent''s draft names no price');
select pg_temp.check((select outcome from projects.record_support_proposal(:'ORG', :'T1_id', 'support', null, null, 'Rs. 500 only', 'en')) = 'no_price_here', 'NEGATIVE: nor in another currency spelling');
select pg_temp.check((select outcome from projects.record_support_proposal(:'ORG', :'T1_id', 'sales', 'how_to', 'x', 'hello there', 'en')) = 'not_the_support_agent', 'NEGATIVE: only the support agent uses this door');
select pg_temp.check((select outcome from projects.record_support_proposal(:'ORGB', :'T1_id', 'support', 'how_to', 'x', 'hello there', 'en')) = 'not_found', 'NEGATIVE: the ticket is read in the JOB''s organization only');
select pg_temp.check(pg_temp.errs(format('insert into projects.support_reply_drafts (organization_id, ticket_id, body, body_hash, drafted_by_agent) values (%L, %L, %L, md5(%L), %L)', :'ORG', :'T1_id', 'only $20 per month', 'only $20 per month', 'support'), 'support_reply_drafts_agent_names_no_price'), 'the TABLE also refuses an agent draft that names a price');
set local role service_role;
reset role;
select id as "DRAFT_id" from projects.support_reply_drafts where ticket_id = :'T1_id' and status = 'draft' limit 1 \gset
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(pg_temp.errs(format('select * from projects.record_support_reply_sent(%L, %L)', :'DRAFT_id', 'whatsapp'), 'permission denied'), 'NEGATIVE: the agent''s role cannot record a reply as sent: only a person does');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select first_response_at is null from projects.support_tickets where id = :'T1_id'), 'a draft has not answered the client: the response clock still runs');
select pg_temp.check((select outcome from projects.record_support_reply_sent(:'DRAFT_id', 'carrier_pigeon')) = 'bad_channel', 'a reply is recorded as sent on a real channel');
select pg_temp.check((select outcome from projects.record_support_reply_sent(:'DRAFT_id', 'whatsapp')) = 'recorded', 'a person records that they sent it');
select pg_temp.check((select outcome from projects.record_support_reply_sent(:'DRAFT_id', 'whatsapp')) = 'not_a_draft', 'a sent record is not recorded twice');
select pg_temp.check((select outcome from projects.draft_support_reply(:'T1_id', 'A person''s own draft, names nothing.', 'en')) = 'drafted', 'a person can draft too');
reset role;
select pg_temp.check((select first_response_at is not null from projects.support_tickets where id = :'T1_id') and (select status from projects.support_reply_drafts where id = :'DRAFT_id') = 'sent_recorded', 'the response clock stops at the person''s recorded reply');

-- classify T1 now (priority p1 so the SLA tests below can use it)
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.classify_support_ticket(:'T1_id', 'warranty_bug', 'covered_warranty', 'the button is broken as delivered', 'p1', null)) = 'classified', 'a person classifies it, adopting or ignoring the proposal');
reset role;

-- SLA: computed in SQL, clock injected, stamped once, escalates a person
select pg_temp.as_service();
select ticket_id as "TSLA_id" from projects.open_support_ticket(:'ORG', :'P_id', 'Site down', 'everything is down', 'monitoring', 'mon-1', now() - interval '5 hours') \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.classify_support_ticket(:'TSLA_id', 'warranty_bug', 'covered_warranty', 'production outage', 'p1', null)) = 'classified', 'a P1 outage is classified');
select pg_temp.check((select response_state = 'breached' and resolution_state = 'running' from projects.support_sla_state(:'TSLA_id')), 'the response target (4h) was missed five hours in: the SQL clock says breached, resolution still running');
select pg_temp.check((select response_state = 'running' from projects.support_sla_state(:'TSLA_id', now() - interval '90 minutes')), 'the same ticket read with an injected earlier clock is still running');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(pg_temp.errs('select * from projects.sweep_support_sla()', 'permission denied'), 'NEGATIVE: a person cannot run the SLA sweep');
reset role;
select pg_temp.as_service();
set local role service_role;
select response_breaches as "SW1_resp", resolution_breaches as "SW1_res", escalated as "SW1_esc" from projects.sweep_support_sla(:'ORG', now()) \gset
reset role;
select pg_temp.check(:'SW1_resp'::int >= 1, 'the sweep stamps the missed response target');
select pg_temp.check((select response_breached_at is not null and resolution_breached_at is null and escalated_to_role = 'ops_admin' and escalation_reason = 'an SLA target was missed' from projects.support_tickets where id = :'TSLA_id'), 'the breach is stamped once and a person is asked (ops_admin)');
select pg_temp.check((select count(*) from core.outbox_events where type = 'support.sla_breached' and subject_id = :'TSLA_id') = 1, 'SLABreached is emitted once for the response');
select pg_temp.as_service();
set local role service_role;
select response_breaches as "SW2_resp", resolution_breaches as "SW2_res", escalated as "SW2_esc" from projects.sweep_support_sla(:'ORG', now()) \gset
reset role;
select pg_temp.check(:'SW2_resp'::int = 0 and :'SW2_res'::int = 0 and :'SW2_esc'::int = 0, 'a second sweep stamps nothing, emits nothing and escalates nothing (idempotent)');
select pg_temp.check((select count(*) from core.outbox_events where type = 'support.sla_breached' and subject_id = :'TSLA_id') = 1, 'still exactly one breach event');
select pg_temp.as_service();
set local role service_role;
select resolution_breaches as "SW3_res" from projects.sweep_support_sla(:'ORG', now() + interval '30 hours') \gset
reset role;
select pg_temp.check(:'SW3_res'::int >= 1 and (select resolution_breached_at is not null from projects.support_tickets where id = :'TSLA_id'), 'with the clock moved past 24h the resolution breach is stamped, separately');
select pg_temp.check((select status = 'classified' and coverage_decision = 'covered_warranty' from projects.support_tickets where id = :'TSLA_id'), 'a breach changes neither the state nor the coverage');
select pg_temp.check((select response_breached_at is null from projects.support_tickets where id = :'T1_id'), 'a ticket answered in time is never stamped as breached');

-- the client's own read: status in the client's words only
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.client_support_tickets(:'P_id')) >= 3 and (select count(*) from projects.client_support_tickets(:'P_id') where status_label in ('Received', 'Being looked at', 'Being worked on', 'Being checked', 'Waiting for your confirmation', 'Resolved', 'Closed')) = (select count(*) from projects.client_support_tickets(:'P_id')), 'a client sees their tickets with a client-safe status label');
select pg_temp.check(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.proname = 'client_support_tickets' and pg_get_function_result(p.oid) ~* 'classification|coverage|priority|assignee|sla|due'), 'the client function exposes no classification, coverage, priority, assignee or SLA column');
select pg_temp.check((select count(*) from projects.support_tickets) = 0, 'NEGATIVE: a client cannot read the internal ticket table');
reset role;
select pg_temp.as_client(:'CLIENTU2', :'ORG', (select client from pg_temp.mk('P8A-C2')));
set local role authenticated;
select pg_temp.check((select count(*) from projects.client_support_tickets(:'P_id')) = 0, 'NEGATIVE: another client of the same organization sees none of this project''s tickets');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.support_tickets) = 0 and (select count(*) from projects.support_ticket_events) = 0 and (select count(*) from projects.support_reply_drafts) = 0, 'NEGATIVE: another organization''s staff read no ticket, event or reply');
reset role;
select pg_temp.check(pg_temp.errs(format('update projects.support_ticket_events set note = %L where ticket_id = %L', 'rewrite', :'T1_id'), 'history'), 'ticket history is append-only');
select pg_temp.check((select count(*) from projects.support_ticket_events where ticket_id = :'TBUG_id' and kind = 'state_changed') = 5 and (select count(*) from projects.support_ticket_events where ticket_id = :'TBUG_id') >= 9, 'each transition of the defect ticket left an event with actor and states');

-- ═════════ 3. health, recovery, check-ins, renewals ═════════
select * from pg_temp.mk('P8A-HEALTH') \gset H_
select pg_temp.as_service();
select outcome from projects.fill_phase_eight_intake(:'ORG', :'H_project') \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "HSTART" from projects.start_phase_eight(:'H_project', current_date - 10, current_date + 60, 'defects', 'new features', null, :'STAFF') \gset
reset role;
select pg_temp.check(:'HSTART' = 'started', 'health fixture: a second workspace');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select status from projects.customer_health_status(:'H_project')) = 'healthy', 'no open issue: HEALTHY');
reset role;
select pg_temp.ticket(:'H_project', 'h-1', 'how_to', 'included_support', 'p4') as "HT1" \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select status from projects.customer_health_status(:'H_project')) = 'stable', 'an open ticket under the threshold: STABLE');
reset role;
select pg_temp.ticket(:'H_project', 'h-2', 'how_to', 'included_support', 'p4') as "HT2" \gset
select pg_temp.ticket(:'H_project', 'h-3', 'how_to', 'included_support', 'p4') as "HT3" \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select status from projects.customer_health_status(:'H_project')) = 'watch', 'three open tickets (the default watch threshold): WATCH');
select pg_temp.check((select reasons -> 0 ->> 'signal' from projects.customer_health_status(:'H_project')) is not null and (select count(*) from jsonb_array_elements((select reasons from projects.customer_health_status(:'H_project'))) r where r ->> 'level' = 'watch' and r ->> 'signal' = 'open_tickets') = 1, 'the status exposes the contributing signal with its value and level');
select pg_temp.check((select count(*) from projects.customer_health('00000000-0000-4000-8000-0000000000aa')) = 0, 'an unknown project yields no health (never a default)');
reset role;
select pg_temp.as_client(:'CLIENTU', :'ORG', :'H_client');
set local role authenticated;
select pg_temp.check((select count(*) from projects.customer_health(:'H_project')) = 0, 'NEGATIVE: a client reads no health signal');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_health_snapshot(:'H_project')) = 'changed', 'a manual snapshot records the transition to watch');
select pg_temp.check((select outcome from projects.record_health_snapshot(:'H_project')) = 'unchanged', 'an unchanged status writes no second snapshot');
reset role;
select pg_temp.check((select count(*) from projects.customer_health_snapshots where project_id = :'H_project') = 2 and (select previous_status from projects.customer_health_snapshots where project_id = :'H_project' order by seq desc limit 1) = 'healthy', 'the history holds healthy then watch, with the previous status');
select pg_temp.check((select count(*) from core.outbox_events where type = 'customer.health_changed' and (payload ->> 'projectId') = :'H_project'::text) = 2, 'CustomerHealthChanged is emitted per transition only');

-- an urgent open ticket past its resolution target is critical; the account enters recovery exactly once (E2E-08)
select pg_temp.as_service();
select ticket_id as "HP1" from projects.open_support_ticket(:'ORG', :'H_project', 'Payments failing', 'all payments fail', 'portal', 'h-p1', now() - interval '30 hours') \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.classify_support_ticket(:'HP1', 'warranty_bug', 'covered_warranty', 'payments broken', 'p1', null)) = 'classified', 'a P1 ticket raised 30 hours ago');
select pg_temp.check((select status from projects.customer_health_status(:'H_project')) = 'critical', 'an open P1 past its resolution target: CRITICAL');
select pg_temp.check((select outcome from projects.record_health_snapshot(:'H_project')) = 'changed', 'the transition to critical is recorded');
select pg_temp.check((select outcome from projects.record_health_snapshot(:'H_project')) = 'unchanged', 'and is not recorded twice');
reset role;
select pg_temp.check((select count(*) from projects.recovery_plans where project_id = :'H_project' and status = 'open') = 1, 'a recovery plan opened once');
select pg_temp.check((select count(*) from core.outbox_events where type = 'customer.retention_recovery_required' and (payload ->> 'projectId') = :'H_project'::text) = 1, 'RetentionRecoveryRequired is emitted once');
select id as "REC_id" from projects.recovery_plans where project_id = :'H_project' \gset

-- recovery first: eligibility and the commercial hold
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select allowed from projects.check_in_eligibility(:'H_project') where category = 'operational') and not (select allowed from projects.check_in_eligibility(:'H_project') where category = 'commercial')
                     and not (select allowed from projects.check_in_eligibility(:'H_project') where category = 'relationship'), 'at critical with an open P1: operational continues, relationship and commercial outreach are suppressed');
select pg_temp.check((select allowed from projects.check_in_eligibility(:'H_project', 'recovery') where category = 'relationship'), 'a recovery check-in is allowed through an open critical issue');
select pg_temp.check((select reasons from projects.check_in_eligibility(:'H_project') where category = 'commercial') @> array['health is critical: recovery comes first'], 'the reason is shown');
select pg_temp.check((select outcome from projects.update_recovery_plan(:'REC_id', :'STAFF', 'payment gateway key rotated', 'fix and retest', null)) = 'incomplete', 'a recovery plan needs an owner, root cause, actions and a deadline');
select pg_temp.check((select outcome from projects.update_recovery_plan(:'REC_id', :'OUTSIDER', 'payment gateway key rotated', 'fix and retest', current_date + 3)) = 'owner_not_a_member', 'NEGATIVE: the owner is a member');
select pg_temp.check((select outcome from projects.update_recovery_plan(:'REC_id', :'STAFF', 'payment gateway key rotated', 'fix and retest', current_date + 3)) = 'updated', 'the plan is owned and in progress');
select pg_temp.check((select outcome from projects.resolve_recovery_plan(:'REC_id', 'fixed it quickly')) = 'health_not_recovered', 'NEGATIVE: a plan cannot be resolved while the account is still critical (fresh read)');
reset role;

-- opportunities while at risk are suppressed, never sent (E2E-08: no normal upsell while unresolved)
insert into projects.change_requests (organization_id, project_id, scope_version_id, requested) values (:'ORG', :'H_project', (select id from projects.scope_versions where project_id = :'H_project'), 'add reporting') returning id as "HCR_id" \gset
select pg_temp.ticket(:'H_project', 'h-cr', 'change_request', 'not_covered', 'p3') as "HT_CR" \gset
select pg_temp.as_service();
select outcome as "OPP_H_out", opportunity_id as "OPP_H", opportunity_status as "OPP_H_status" from sales.record_phase_eight_opportunity(:'H_project', 'change_request', 'The client wants a reporting module added to the product', jsonb_build_array(jsonb_build_object('type', 'ticket', 'id', :'HT_CR')), 'monthly reports', 'normal', null, null, 'upsell', :'ORG') \gset
select pg_temp.check(:'OPP_H_out' = 'recorded' and :'OPP_H_status' = 'suppressed', 'an opportunity on an at-risk account is recorded SUPPRESSED, not detected');
select pg_temp.check((select suppressed_reason like 'recovery first:%' from sales.phase_eight_opportunities where id = :'OPP_H'), 'with the recovery-first reason');
select pg_temp.check((select count(*) from core.outbox_events where type = 'sales.opportunity_suppressed_for_recovery' and subject_id = :'OPP_H') = 1, 'OpportunitySuppressedForRecovery is emitted');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from sales.qualify_phase_eight_opportunity(:'OPP_H', 'qualify', 'looks genuine')) = 'recovery_first', 'NEGATIVE: a person cannot qualify it while the account needs recovery');
reset role;

-- resolve the service issue (cancel the P1 and the how-tos), re-evaluate, resolve the plan
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.advance_support_ticket(:'HP1', 'cancelled', 'raised in error, duplicate of another ticket')) = 'cancelled', 'the P1 is closed out (cancelled with a note)');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'HT1', 'cancelled', 'client withdrew the question')) = 'cancelled', 'a how-to is cancelled');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'HT2', 'cancelled', 'client withdrew the question')) = 'cancelled', 'another how-to is cancelled');
select pg_temp.check((select status from projects.customer_health_status(:'H_project')) = 'stable', 'health is DERIVED again after the change: two open tickets and no live breach leave STABLE (nothing stored, nothing stale)');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "RES_out", health_status as "RES_hs" from projects.resolve_recovery_plan(:'REC_id', 'gateway key fixed, retested, client confirmed') \gset
reset role;
select pg_temp.check(:'RES_out' = 'resolved' and :'RES_hs' = 'stable', 'the plan resolves only on a fresh read that is no longer at risk');
select pg_temp.check((select resolved_snapshot_id is not null and closed_by is not null and status = 'resolved' from projects.recovery_plans where id = :'REC_id') and (select status from projects.customer_health_snapshots where id = (select resolved_snapshot_id from projects.recovery_plans where id = :'REC_id')) = :'RES_hs', 'the resolution points at the fresh re-evaluation');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from sales.qualify_phase_eight_opportunity(:'OPP_H', 'qualify', 'service recovered, genuine reporting need')) = 'qualified', 'after recovery the hold lifts and a person can qualify it');
select pg_temp.as_service();
select pg_temp.check((select outcome from sales.record_phase_eight_opportunity(:'H_project', 'change_request', 'The client wants a reporting module added to the product', jsonb_build_array(jsonb_build_object('type', 'ticket', 'id', :'HT_CR')), 'monthly reports', 'normal', null, null, 'upsell', :'ORG')) = 'duplicate', 'a retried run for the same evidence is the same opportunity');
reset role;
select pg_temp.check((select count(*) from projects.recovery_plans where project_id = :'H_project') = 1, 'one plan existed throughout');

-- check-ins: outcomes, engagement, idempotency, agent agenda
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.create_check_in(:'H_project', 'adoption', 'adoption-1', current_date + 14, null, null, :'ORG')) = 'created', 'a check-in is created');
select pg_temp.check((select outcome from projects.create_check_in(:'H_project', 'adoption', 'adoption-1', current_date + 14, null, null, :'ORG')) = 'already_exists', 'a retried event creates no duplicate check-in (outcome)');
reset role;
select pg_temp.check((select count(*) from projects.cs_check_ins where project_id = :'H_project' and kind = 'adoption') = 1, 'a retried event creates no duplicate check-in (count)');
select id as "CI_id" from projects.cs_check_ins where project_id = :'H_project' and kind = 'adoption' \gset
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_check_in_agenda(:'ORG', :'CI_id', 'customer_success', 'Ask how the reporting export is used. Confirm who is the day-to-day contact.')) = 'recorded', 'the Customer Success agent drafts an agenda');
select pg_temp.check((select outcome from projects.record_check_in_agenda(:'ORG', :'CI_id', 'support', 'Ask something')) = 'not_the_customer_success_agent', 'NEGATIVE: only the Customer Success agent drafts an agenda');
select pg_temp.check((select outcome from projects.record_check_in_agenda(:'ORG', :'CI_id', 'customer_success', 'Offer a 20% off discount on the next module')) = 'no_price_here', 'NEGATIVE: an agenda names no discount');
select pg_temp.check(pg_temp.errs(format('select * from projects.complete_check_in(%L, %L, %L, %L)', :'CI_id', 'responded', 'call', 'spoke for ten minutes about reports'), 'permission denied'), 'NEGATIVE: the agent cannot complete a relationship task');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.complete_check_in(:'CI_id', 'responded', 'call', 'short')) = 'outcome_required', 'a check-in completes only with a recorded outcome');
select pg_temp.check((select status from projects.customer_health_status(:'H_project')) is not null, 'health before a no-response check-in');
select status as "BEFORE_NR" from projects.customer_health_status(:'H_project') \gset
select pg_temp.check((select outcome from projects.complete_check_in(:'CI_id', 'no_response', 'whatsapp', 'messaged twice, no answer; will try the email contact')) = 'completed', 'a person records the check-in with its channel and engagement');
select status as "AFTER_NR" from projects.customer_health_status(:'H_project') \gset
select pg_temp.check(:'BEFORE_NR' = :'AFTER_NR', 'no response is engagement, not dissatisfaction: health did not move');
select pg_temp.check((select outcome from projects.complete_check_in(:'CI_id', 'responded', 'call', 'again, with an outcome')) = 'not_due', 'a completed check-in is not completed twice');
reset role;
select pg_temp.check(pg_temp.direct(format('update projects.cs_check_ins set outcome = null where id = %L', :'CI_id'), 'through its door'), 'a direct write to a check-in is refused');
select pg_temp.check(pg_temp.errs(format('select set_config(%L, %L, true); update projects.cs_check_ins set outcome = null where id = %L', 'projects.p8_sanctioned', 'on', :'CI_id'), 'cs_check_ins_complete_is_evidenced'), 'the TABLE refuses a completed check-in with no outcome (CHECK)');

-- opt-out: promotional outreach stops, operational continues (E2E-11)
select pg_temp.as_service();
insert into crm.communication_consent (organization_id, contact_id, channel, status, source) values (:'ORG', (select id from crm.contacts where client_account_id = :'H_client'), 'whatsapp', 'withdrawn', 'verifier');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(not (select allowed from projects.check_in_eligibility(:'H_project') where category = 'commercial') and (select reasons from projects.check_in_eligibility(:'H_project') where category = 'commercial')::text like '%withdrew consent%', 'a contact who withdrew consent: promotional outreach is off, with the reason');
select pg_temp.check(not (select allowed from projects.check_in_eligibility(:'H_project') where category = 'relationship') and (select allowed from projects.check_in_eligibility(:'H_project') where category = 'operational'), 'relationship messages stop; operational support continues');
reset role;

-- renewal hooks: flagged and reviewed, never silently renewed (CUS-TST-005)
insert into sales.opportunities (organization_id, client_account_id, name) values (:'ORG', :'A_id', 'plan deal') returning id as "PO_id" \gset
insert into sales.proposals (organization_id, opportunity_id, title) values (:'ORG', :'PO_id', 'plan proposal') returning id as "PP_id" \gset
insert into projects.maintenance_plans (organization_id, client_account_id, project_id, name, billing_model, starts_on, ends_on, status, accepted_proposal_id, accepted_at)
  values (:'ORG', :'A_id', :'P_id', 'Care plan', 'monthly', current_date - 330, current_date + 30, 'active', :'PP_id', now()) returning id as "PLAN_id" \gset
insert into projects.maintenance_plans (organization_id, client_account_id, project_id, name, billing_model, starts_on, ends_on, status, accepted_proposal_id, accepted_at)
  values (:'ORG', :'A_id', :'P_id', 'Old plan', 'annual', current_date - 400, current_date - 5, 'active', :'PP_id', now()) returning id as "OLD_id" \gset
insert into projects.maintenance_plans (organization_id, client_account_id, project_id, name, billing_model, starts_on, ends_on, status, accepted_proposal_id, accepted_at)
  values (:'ORG', :'A_id', :'P_id', 'Far plan', 'annual', current_date - 10, current_date + 300, 'active', :'PP_id', now()) returning id as "FAR_id" \gset
select md5(starts_on::text || ends_on::text || coalesce(accepted_at::text, '')) as "PLAN_dates" from projects.maintenance_plans where id = :'PLAN_id' \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(pg_temp.errs('select * from projects.sweep_maintenance_renewals()', 'permission denied'), 'NEGATIVE: a person cannot run the renewal sweep');
reset role;
select pg_temp.as_service();
set local role service_role;
select flagged as "RS1_f", expired as "RS1_e" from projects.sweep_maintenance_renewals(:'ORG', now()) \gset
reset role;
select pg_temp.check(:'RS1_f'::int >= 1 and :'RS1_e'::int >= 1, 'the sweep flags a plan inside its window and expires one past its end');
select pg_temp.check((select status from projects.maintenance_plans where id = :'PLAN_id') = 'renewal_approaching' and (select status from projects.maintenance_plans where id = :'FAR_id') = 'active', 'a plan inside the window is renewal_approaching; one far away is untouched');
select pg_temp.check((select md5(starts_on::text || ends_on::text || coalesce(accepted_at::text, '')) from projects.maintenance_plans where id = :'PLAN_id') = :'PLAN_dates', 'NEGATIVE: the sweep never renews, extends or re-dates a plan');
select pg_temp.check((select status = 'expired' and ended_reason like '%no recorded renewal%' and ends_on = current_date - 5 from projects.maintenance_plans where id = :'OLD_id'), 'a plan past its end date expires, with the reason, and is not extended');
select pg_temp.check((select count(*) from projects.maintenance_plans where project_id = :'P_id' and status in ('renewed', 'active') and ends_on < current_date) = 0, 'no plan was silently marked renewed');
select pg_temp.check((select count(*) from projects.cs_check_ins where project_id = :'P_id' and kind = 'renewal' and source_ref = :'PLAN_id') = 1 and (select count(*) from core.outbox_events where type = 'maintenance.renewal_due' and subject_id = :'PLAN_id') = 1, 'a renewal review check-in and MaintenanceRenewalDue exist once');
select pg_temp.as_service();
set local role service_role;
select flagged as "RS2_f", expired as "RS2_e" from projects.sweep_maintenance_renewals(:'ORG', now()) \gset
reset role;
select pg_temp.check(:'RS2_f'::int = 0 and :'RS2_e'::int = 0 and (select count(*) from projects.cs_check_ins where project_id = :'P_id' and kind = 'renewal') = 1 and (select count(*) from core.outbox_events where type = 'maintenance.renewal_due' and subject_id = :'PLAN_id') = 1, 'a second sweep duplicates nothing');
-- a maintenance ticket now has an active plan to be covered by
select pg_temp.ticket(:'P_id', 'maint-1', 'maintenance', 'covered_maintenance', 'p3', :'FAR_id') as "TMAINT_id" \gset
select pg_temp.check((select coverage_decision = 'covered_maintenance' and plan_id = :'FAR_id' from projects.support_tickets where id = :'TMAINT_id'), 'a maintenance ticket names the active plan version that covers it');
insert into projects.maintenance_plans (organization_id, client_account_id, project_id, name, billing_model, starts_on, ends_on, status) values (:'ORG', :'A_id', :'P_id', 'Paused plan', 'monthly', current_date - 20, current_date + 200, 'paused') returning id as "PAUSED_id" \gset
insert into projects.maintenance_plans (organization_id, client_account_id, project_id, name, billing_model, starts_on, ends_on, status, accepted_proposal_id, accepted_at) values (:'ORG', :'A_id', :'P_id', 'Lapsed-by-date plan', 'monthly', current_date - 100, current_date - 2, 'active', :'PP_id', now()) returning id as "PAST_id" \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.classify_support_ticket(:'TMAINT_id', 'maintenance', 'covered_maintenance', 'upkeep', 'p3', :'OLD_id')) = 'no_active_plan', 'NEGATIVE: an expired plan version does not cover a new ticket');
select pg_temp.check((select outcome from projects.classify_support_ticket(:'TMAINT_id', 'maintenance', 'covered_maintenance', 'upkeep', 'p3', :'PAUSED_id')) = 'no_active_plan', 'NEGATIVE: a paused plan does not cover a ticket even inside its dates (status)');
select pg_temp.check((select outcome from projects.classify_support_ticket(:'TMAINT_id', 'maintenance', 'covered_maintenance', 'upkeep', 'p3', :'PAST_id')) = 'no_active_plan', 'NEGATIVE: an active plan whose end date has passed does not cover a ticket (dates)');
select pg_temp.check((select outcome from projects.classify_support_ticket(:'TMAINT_id', 'maintenance', 'covered_maintenance', 'upkeep', 'p3', gen_random_uuid())) = 'no_active_plan', 'NEGATIVE: an unknown plan does not cover a ticket');
reset role;

-- ═════════ 4. opportunities and the Sales handoff ═════════
select pg_temp.ticket(:'P_id', 'opp-cr', 'change_request', 'not_covered', 'p3') as "TOPP_id" \gset
select pg_temp.as_service();
set local role service_role;
select outcome as "OPP_out", opportunity_id as "OPP_id", opportunity_status as "OPP_status" from sales.record_phase_eight_opportunity(:'P_id', 'change_request', 'The client has twice asked for a loyalty module in the app', jsonb_build_array(jsonb_build_object('type', 'ticket', 'id', :'TOPP_id')), 'loyalty points', 'normal', 'the owner', null, 'upsell', :'ORG') \gset
reset role;
select pg_temp.check(:'OPP_out' = 'recorded', 'the Upsell agent records an opportunity from classified out-of-scope evidence');
select pg_temp.check(:'OPP_status' in ('detected', 'suppressed'), 'it is recorded, never qualified or sent, by an agent');
select pg_temp.check((select status = 'detected' or status = 'suppressed' from sales.phase_eight_opportunities where id = :'OPP_id') and (select qualified_by is null and sales_opportunity_id is null from sales.phase_eight_opportunities where id = :'OPP_id'), 'an agent record has no qualifier and no CRM deal');
-- main project may still hold P1/P2 tickets: clear the hold before the qualify/handoff tests by cancelling them
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.advance_support_ticket(:'T1_id', 'cancelled', 'verifier clean-up of an open P1')) = 'cancelled', 'clean-up: an open P1 is closed out');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'TSLA_id', 'cancelled', 'verifier clean-up of an open P1')) = 'cancelled', 'clean-up: the SLA ticket is closed out');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'TDIS_id', 'cancelled', 'verifier clean-up of a disputed ticket')) = 'cancelled', 'clean-up: the disputed ticket is closed out');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'TMAINT_id', 'cancelled', 'verifier clean-up')) = 'cancelled', 'clean-up: the maintenance ticket is closed out');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from sales.record_phase_eight_opportunity(:'P_id', 'change_request', 'The client has twice asked for a loyalty module in the app', jsonb_build_array(jsonb_build_object('type', 'ticket', 'id', :'TOPP_id')), 'loyalty points', 'normal', 'the owner', null, 'upsell', :'ORG')) = 'duplicate', 'a retried run records no second opportunity (outcome)');
reset role;
select pg_temp.check((select count(*) from sales.phase_eight_opportunities where project_id = :'P_id') = 1, 'a retried run records no second opportunity (count)');
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from sales.record_phase_eight_opportunity(:'P_id', 'change_request', 'Wants help using the export button', jsonb_build_array(jsonb_build_object('type', 'ticket', 'id', :'THOW_id')), null, 'normal', null, null, 'upsell', :'ORG')) = 'already_included', 'NEGATIVE: a how-to is an obligation, not an opportunity');
select pg_temp.check((select outcome from sales.record_phase_eight_opportunity(:'P_id', 'change_request', 'The button broke after a release, charge for it', jsonb_build_array(jsonb_build_object('type', 'ticket', 'id', :'TBUG_id')), null, 'normal', null, null, 'upsell', :'ORG')) = 'already_included', 'NEGATIVE: a warranty defect is not a sale');
select pg_temp.check((select outcome from sales.record_phase_eight_opportunity(:'P_id', 'change_request', 'A need with no evidence behind it at all', '[]'::jsonb, null, 'normal', null, null, 'upsell', :'ORG')) = 'evidence_required', 'NEGATIVE: no evidence, no opportunity');
select pg_temp.check((select outcome from sales.record_phase_eight_opportunity(:'P_id', 'change_request', 'A need with fabricated evidence behind it', jsonb_build_array(jsonb_build_object('type', 'ticket', 'id', gen_random_uuid())), null, 'normal', null, null, 'upsell', :'ORG')) = 'evidence_not_found', 'NEGATIVE: evidence must be a record of this project');
select pg_temp.check((select outcome from sales.record_phase_eight_opportunity(:'P_id', 'change_request', 'Another project''s ticket as evidence', jsonb_build_array(jsonb_build_object('type', 'ticket', 'id', :'HT_CR')), null, 'normal', null, null, 'upsell', :'ORG')) = 'evidence_not_found', 'NEGATIVE: another project''s ticket is not this project''s evidence');
select pg_temp.check((select outcome from sales.record_phase_eight_opportunity(:'P_id', 'change_request', 'Loyalty module for about ₹50000 as agreed', jsonb_build_array(jsonb_build_object('type', 'ticket', 'id', :'TOPP_id')), null, 'normal', null, null, 'upsell', :'ORG')) = 'no_price_here', 'NEGATIVE: an agent names no price in the need');
select pg_temp.check((select outcome from sales.record_phase_eight_opportunity(:'P_id', 'new_project', 'A separate analytics platform for the client', jsonb_build_array(jsonb_build_object('type', 'ticket', 'id', :'TOPP_id', 'price', 100)), null, 'normal', null, null, 'upsell', :'ORG')) = 'no_price_here', 'NEGATIVE: an agent puts no price in the evidence');
select pg_temp.check((select outcome from sales.record_phase_eight_opportunity(:'P_id', 'new_project', 'A separate analytics platform for the client', jsonb_build_array(jsonb_build_object('type', 'ticket', 'id', :'TOPP_id')), 'give them a discount', 'normal', null, null, 'upsell', :'ORG')) = 'no_price_here', 'NEGATIVE: nor a discount');
select pg_temp.check((select outcome from sales.record_phase_eight_opportunity(:'P_id', 'new_project', 'A separate analytics platform for the client', jsonb_build_array(jsonb_build_object('type', 'ticket', 'id', :'TOPP_id')), null, 'normal', null, null, 'sales', :'ORG')) = 'not_an_opportunity_agent', 'NEGATIVE: the Sales agent is not an opportunity detector');
select pg_temp.check((select outcome from sales.record_phase_eight_opportunity(:'P_id', 'new_project', 'A separate analytics platform for the client', jsonb_build_array(jsonb_build_object('type', 'ticket', 'id', :'TOPP_id')), null, 'normal', null, null, 'upsell', :'ORGB')) = 'not_found', 'NEGATIVE: the project is read in the JOB''s organization only');
select pg_temp.check(pg_temp.errs(format('select * from sales.qualify_phase_eight_opportunity(%L, %L, %L)', :'OPP_id', 'qualify', 'an agent qualifying'), 'permission denied'), 'NEGATIVE: an agent cannot qualify an opportunity');
select pg_temp.check(pg_temp.errs(format('select * from sales.hand_off_phase_eight_opportunity(%L)', :'OPP_id'), 'permission denied'), 'NEGATIVE: an agent cannot hand an opportunity to Sales');
reset role;
select pg_temp.check(pg_temp.errs(format('insert into sales.phase_eight_opportunities (organization_id, client_account_id, project_id, kind, need, evidence, dedupe_key, status, created_by) values (%L, %L, %L, %L, %L, %L::jsonb, %L, %L, %L)', :'ORG', :'A_id', :'P_id', 'new_project', 'Quote them $5000 for the new platform', '[{"type":"ticket","id":"x"}]', 'k-price', 'detected', :'STAFF'), 'names no price'), 'the TRIGGER also refuses a direct write that names a price');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from sales.hand_off_phase_eight_opportunity(:'OPP_id')) in ('not_qualified'), 'NEGATIVE: an unqualified opportunity is not handed to Sales');
select pg_temp.check((select outcome from sales.qualify_phase_eight_opportunity(:'OPP_id', 'qualify', 'x')) = 'note_required', 'qualifying needs a note');
select pg_temp.check((select outcome from sales.qualify_phase_eight_opportunity(:'OPP_id', 'qualify', 'two genuine requests in tickets, owner confirmed')) = 'qualified', 'a PERSON qualifies it');
reset role;
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select outcome from sales.hand_off_phase_eight_opportunity(:'OPP_id')) in ('not_authorized', 'no_actor') and (select count(*) from sales.phase_eight_opportunities) = 0, 'NEGATIVE: a client cannot hand off, and reads no opportunity');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "HO_out", sales_opportunity_id as "HO_sales" from sales.hand_off_phase_eight_opportunity(:'OPP_id') \gset
select pg_temp.check(:'HO_out' = 'handed_off', 'a person hands the qualified opportunity to Sales (sales.open_renewal)');
select pg_temp.check((select outcome from sales.hand_off_phase_eight_opportunity(:'OPP_id')) = 'already_handed_off', 'a second handoff is the same one');
reset role;
select pg_temp.check((select count(*) from sales.opportunities where source_project_id = :'P_id') = 1 and (select value_minor from sales.opportunities where id = :'HO_sales') = 0 and (select stage from sales.opportunities where id = :'HO_sales') = 'discovery' and (select kind from sales.opportunities where id = :'HO_sales') = 'upsell', 'the CRM deal exists once, in discovery, with NO value: the price is a person''s, in the quotation doors');
select pg_temp.check((select count(*) from sales.proposals where opportunity_id = :'HO_sales') = 0, 'Phase 8A drafted no proposal and no quote');
select pg_temp.check((select count(*) from core.outbox_events where type = 'sales.phase_eight_handoff_created' and subject_id = :'OPP_id') = 1, 'SalesHandoffCreated is emitted once');
select project as "NEWP_id" from pg_temp.mk('P8A-NEWCLIENT') \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from sales.close_phase_eight_opportunity(:'OPP_id', 'accepted', 'client accepted the quote')) = 'name_what_it_became', 'NEGATIVE: an accepted expansion names the change request or project it became');
select pg_temp.check((select outcome from sales.close_phase_eight_opportunity(:'OPP_id', 'accepted', 'accepted', gen_random_uuid())) = 'wrong_project', 'NEGATIVE: the change request is this project''s');
select pg_temp.check((select outcome from sales.close_phase_eight_opportunity(:'OPP_id', 'accepted', 'accepted', null, :'P_id')) = 'wrong_project', 'NEGATIVE: the completed project is never the new project');
select pg_temp.check((select outcome from sales.close_phase_eight_opportunity(:'OPP_id', 'accepted', 'accepted', null, :'NEWP_id')) = 'wrong_project', 'NEGATIVE: a new project is the same client''s');
select pg_temp.check((select outcome from sales.close_phase_eight_opportunity(:'OPP_id', 'lost', 'x')) = 'reason_required', 'a lost opportunity needs a reason');
select pg_temp.check((select outcome from sales.close_phase_eight_opportunity(:'OPP_id', 'accepted', 'client signed the separate change request', :'CR_id')) = 'accepted', 'accepted, as a separate change request');
reset role;
select pg_temp.check((select md5(to_jsonb(pr)::text || to_jsonb(cr)::text) from projects.projects pr join projects.completion_records cr on cr.project_id = pr.id where pr.id = :'P_id') = :'HIST_before', 'the completed project and its completion record are byte-for-byte unchanged by Phase 8');

-- the service-only doors check the role INSIDE as well (the grant is the first layer, this is the second): a signed-in person on a connection that can reach them is refused
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
select pg_temp.check((select outcome from projects.fill_phase_eight_intake(:'ORG', :'P_id')) = 'not_service', 'fill_phase_eight_intake refuses a caller who is not the service role, inside the function');
select pg_temp.check((select outcome from projects.record_support_proposal(:'ORG', :'TOPP_id', 'support', 'how_to', 'x', 'hello there', 'en')) = 'not_service', 'record_support_proposal refuses a caller who is not the service role, inside the function');
select pg_temp.check((select outcome from projects.record_check_in_agenda(:'ORG', :'CI_id', 'customer_success', 'An agenda')) = 'not_service', 'record_check_in_agenda refuses a caller who is not the service role, inside the function');
select pg_temp.check((select response_breaches + resolution_breaches + escalated from projects.sweep_support_sla(:'ORG', now() + interval '1000 days')) = 0 and (select count(*) from projects.support_tickets where project_id = :'P_id' and response_breached_at is not null and id = :'TOPP_id') = 0, 'sweep_support_sla does nothing for a caller who is not the service role, inside the function');
select pg_temp.check((select flagged + expired from projects.sweep_maintenance_renewals(:'ORG', now() + interval '1000 days')) = 0 and (select count(*) from projects.maintenance_plans where id = :'FAR_id' and status = 'active') = 1, 'sweep_maintenance_renewals does nothing for a caller who is not the service role, inside the function');
select pg_temp.check((select outcome from sales.record_phase_eight_opportunity(:'P_id', 'new_project', 'An agent key typed by a person at the keyboard', jsonb_build_array(jsonb_build_object('type', 'ticket', 'id', :'TOPP_id')), null, 'normal', null, null, 'upsell', null)) = 'agent_key_is_for_the_runner', 'a person cannot record an opportunity AS an agent');

-- the Admin's reads are derived on read, internal-only
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.support_queue(:'P_id')) >= 6 and (select response_state from projects.support_queue(:'P_id') where id = :'TSLA_id') = 'breached' and (select resolution_state from projects.support_queue(:'P_id') where id = :'TSLA_id') = 'not_applicable', 'the support queue shows each ticket with its SQL-derived SLA states (a cancelled ticket owes no resolution)');
select pg_temp.check((select count(*) from projects.customer_success_overview()) >= 2 and (select health_status from projects.customer_success_overview() where project_id = :'H_project') = (select status from projects.customer_health_status(:'H_project')), 'the account overview shows the same derived health as the function, per project');
reset role;
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.support_queue(:'P_id')) = 0 and (select count(*) from projects.customer_success_overview()) = 0, 'NEGATIVE: a client reads neither the support queue nor the overview');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.support_queue(:'P_id')) = 0 and (select count(*) from projects.customer_success_overview()) = 0, 'NEGATIVE: another organization''s staff read neither');
reset role;

-- ═════════ 5. security, tenancy and the no-price guarantee ═════════
select pg_temp.as_service();
select pg_temp.check((select count(*) from core.unguarded_org_fks()) = 0, 'every org-scoped foreign key checks its parent''s tenant');
select pg_temp.check((select count(*) from core.unfrozen_org_tables()) = 0, 'every org-scoped table freezes organization_id');
select pg_temp.check((select count(*) from core.audit_invoker_writes_without_policy()) = 0 and (select count(*) from core.audit_untenanted_write_policies()) = 0, 'no invoker write without a policy, no untenanted write policy');

create temp table p8_tables (sch text, tbl text);
insert into p8_tables values ('projects', 'phase_eight_settings'), ('projects', 'phase_eight_intake'), ('projects', 'phase_eight_gate_waivers'), ('projects', 'phase_eight'), ('projects', 'support_tickets'),
  ('projects', 'support_ticket_events'), ('projects', 'support_reply_drafts'), ('projects', 'customer_health_snapshots'), ('projects', 'recovery_plans'), ('projects', 'cs_check_ins'), ('sales', 'phase_eight_opportunities');
grant select on p8_tables to public;
select pg_temp.check((select count(*) from p8_tables t join pg_class c on c.relname = t.tbl join pg_namespace n on n.oid = c.relnamespace and n.nspname = t.sch where c.relrowsecurity) = 11, 'every Phase 8A table has row security on');
select pg_temp.check((select count(*) from p8_tables t join pg_policies p on p.schemaname = t.sch and p.tablename = t.tbl and p.cmd = 'SELECT' where p.qual like '%is_internal%' and p.qual like '%current_organization_id%') = 11, 'every Phase 8A table has exactly the internal-only, organization-scoped read policy');
select pg_temp.check((select count(*) from p8_tables t join pg_policies p on p.schemaname = t.sch and p.tablename = t.tbl where p.cmd <> 'SELECT') = 0, 'and no write policy at all');
select pg_temp.check((select count(*) from p8_tables t where has_table_privilege('authenticated', t.sch || '.' || t.tbl, 'insert') or has_table_privilege('authenticated', t.sch || '.' || t.tbl, 'update') or has_table_privilege('authenticated', t.sch || '.' || t.tbl, 'delete') or has_table_privilege('anon', t.sch || '.' || t.tbl, 'select')) = 0, 'no signed-in or anonymous write or anon read on any Phase 8A table');
-- a client of the same organization reads no row of any of them; staff of another organization reads none
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.phase_eight_intake) + (select count(*) from projects.phase_eight) + (select count(*) from projects.support_tickets) + (select count(*) from projects.support_reply_drafts)
                     + (select count(*) from projects.customer_health_snapshots) + (select count(*) from projects.recovery_plans) + (select count(*) from projects.cs_check_ins) + (select count(*) from sales.phase_eight_opportunities)
                     + (select count(*) from projects.phase_eight_gate_waivers) + (select count(*) from projects.phase_eight_settings) + (select count(*) from projects.support_ticket_events) = 0, 'NEGATIVE: a portal client reads no Phase 8A internal table');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.phase_eight_intake) + (select count(*) from projects.phase_eight) + (select count(*) from projects.customer_health_snapshots) + (select count(*) from projects.recovery_plans) + (select count(*) from projects.cs_check_ins)
                     + (select count(*) from sales.phase_eight_opportunities) = 0, 'NEGATIVE: another organization''s staff read no Phase 8A row');
select pg_temp.check((select count(*) from projects.customer_health(:'P_id')) = 0 and (select count(*) from projects.check_in_eligibility(:'P_id')) = 0, 'NEGATIVE: nor any derived health or eligibility');
select pg_temp.check((select outcome from sales.record_phase_eight_opportunity(:'P_id', 'change_request', 'Cross tenant person attempt at an opportunity', jsonb_build_array(jsonb_build_object('type', 'ticket', 'id', :'TOPP_id')), null, 'normal', null, null, null, null)) = 'not_found', 'NEGATIVE: another organization''s staff cannot record an opportunity on this project');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(pg_temp.errs(format('insert into projects.support_tickets (organization_id, project_id, client_account_id, source, title) values (%L, %L, %L, %L, %L)', :'ORG', :'P_id', :'A_id', 'portal', 'direct'), 'permission denied'), 'NEGATIVE: staff cannot insert a ticket directly: the door is the only way');
select pg_temp.check(pg_temp.errs(format('update projects.recovery_plans set status = %L', 'resolved'), 'permission denied'), 'NEGATIVE: nor resolve a recovery plan directly');
reset role;

-- no amount, price, quote, discount, score or stored health fiction exists anywhere in Phase 8A
select pg_temp.check((select count(*) from information_schema.columns c join p8_tables t on t.sch = c.table_schema and t.tbl = c.table_name
                       where c.column_name ~* '(price|amount|quote|quotation|discount|cost|fee|total|score|rate|minor|currency)') = 0, 'no Phase 8A table has a price, amount, quote, discount, score or currency column');
select pg_temp.check((select count(*) from information_schema.columns c where c.table_schema in ('projects', 'sales') and c.table_name in ('phase_eight', 'phase_eight_intake', 'cs_check_ins', 'recovery_plans', 'support_tickets', 'phase_eight_opportunities')
                       and c.column_name ~* '^(health|health_status|health_score)$') = 0, 'health is stored on no workspace, ticket, check-in or plan: it is only ever derived (snapshots are dated copies)');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('projects', 'sales')
                       and p.proname in ('open_support_ticket', 'classify_support_ticket', 'advance_support_ticket', 'record_support_proposal', 'record_check_in_agenda', 'record_phase_eight_opportunity', 'qualify_phase_eight_opportunity',
                                         'hand_off_phase_eight_opportunity', 'close_phase_eight_opportunity', 'sweep_maintenance_renewals', 'p8_build_intake', 'start_phase_eight', 'p8_take_snapshot')
                       and pg_get_functiondef(p.oid) ~* 'sales\.proposals|record_discount_decision|set_proposal_pricing|draft_proposal|send_proposal') = 0,
                     'no Phase 8A door writes a proposal, a discount decision, a price or an invoice: quoting stays in the existing quotation doors');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('projects', 'sales') and p.proname in ('record_support_proposal', 'record_check_in_agenda', 'sweep_support_sla', 'sweep_maintenance_renewals', 'fill_phase_eight_intake')
                       and has_function_privilege('authenticated', p.oid, 'execute')) = 0, 'the service-role-only doors are not executable by a signed-in user');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('projects', 'sales') and p.proname in ('qualify_phase_eight_opportunity', 'hand_off_phase_eight_opportunity', 'close_phase_eight_opportunity', 'record_support_reply_sent', 'complete_check_in', 'classify_support_ticket', 'record_client_confirmation')
                       and has_function_privilege('service_role', p.oid, 'execute')) = 0, 'the person-only doors are not executable by the service role (agents cannot qualify, hand off, send, complete, classify or confirm)');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('projects', 'sales') and p.prosecdef and (p.proconfig is null or not p.proconfig::text like '%search_path=%')
                       and p.proname in ('open_support_ticket', 'classify_support_ticket', 'assign_support_ticket', 'link_support_root_cause', 'advance_support_ticket', 'record_client_confirmation', 'escalate_support_ticket', 'acknowledge_support_escalation',
                                         'draft_support_reply', 'record_support_reply_sent', 'discard_support_reply_draft', 'record_support_proposal', 'sweep_support_sla', 'client_support_tickets', 'p8_ticket_event', 'p8_hours', 'p8_build_intake',
                                         'fill_phase_eight_intake', 'waive_phase_eight_gate', 'start_phase_eight', 'set_phase_eight_state', 'set_phase_eight_setting', 'p8_setting', 'p8_take_snapshot', 'record_health_snapshot', 'update_recovery_plan',
                                         'resolve_recovery_plan', 'abandon_recovery_plan', 'create_check_in', 'complete_check_in', 'skip_check_in', 'record_check_in_agenda', 'phase_eight_opened', 'sweep_maintenance_renewals',
                                         'record_phase_eight_opportunity', 'qualify_phase_eight_opportunity', 'hand_off_phase_eight_opportunity', 'close_phase_eight_opportunity', 'p8_commercial_hold')) = 0, 'every Phase 8A SECURITY DEFINER function pins an empty search_path');

\echo Phase 8A (workspace, support, health, recovery, check-ins, renewals, opportunities) verified OK
rollback;
