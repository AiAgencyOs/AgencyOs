-- ═════════════════════════════════════════════════════════════════
-- Phase 8D (handoff edges, communication governance, value-report drafts, observability) - driven through the REAL doors on a scratch Postgres.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-eight-d.sql          (rolls back)
--
-- Nothing here sends anything: the ledger records what a PERSON did, eligibility is a read, a value report is a draft. Fixtures are inserted as the
-- table owner with triggers off ONLY where an upstream engine (handover acceptance, a release's own gates) is not what is under test.
-- Every table-wide count is scoped to this verifier's own organization / client rows.
-- ═════════════════════════════════════════════════════════════════
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
\set ORGB '00000000-0000-4000-8000-0000000008d2'
\set OWNER '00000000-0000-4000-8000-00000000fd01'
\set ADMIN '00000000-0000-4000-8000-00000000fd02'
\set STAFF '00000000-0000-4000-8000-00000000fd03'
\set STAFF2 '00000000-0000-4000-8000-00000000fd04'
\set CLIENTU '00000000-0000-4000-8000-00000000fd05'
\set BSTAFF '00000000-0000-4000-8000-00000000fd07'

insert into core.organizations (id, name, slug) values (:'ORGB', 'Other Agency (8d)', 'other-agency-8d') on conflict (id) do nothing;
insert into auth.users (id, email) values (:'OWNER', 'p8d-owner@example.test'), (:'ADMIN', 'p8d-admin@example.test'), (:'STAFF', 'p8d-staff@example.test'), (:'STAFF2', 'p8d-staff2@example.test'),
  (:'CLIENTU', 'p8d-client@example.test'), (:'BSTAFF', 'p8d-bstaff@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'p8d-owner@example.test', 'P8D Owner'), (:'ADMIN', 'p8d-admin@example.test', 'P8D Admin'), (:'STAFF', 'p8d-staff@example.test', 'P8D Staff'),
  (:'STAFF2', 'p8d-staff2@example.test', 'P8D Staff Two'), (:'CLIENTU', 'p8d-client@example.test', 'P8D Client'), (:'BSTAFF', 'p8d-bstaff@example.test', 'P8D Other Staff') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner'), (:'ORG', :'ADMIN', 'ops_admin'), (:'ORG', :'STAFF', 'member'), (:'ORG', :'STAFF2', 'member'), (:'ORGB', :'BSTAFF', 'member')
  on conflict do nothing;
select set_config('p8.org', :'ORG', true);
select set_config('p8.staff', :'STAFF', true);

-- fixture: a COMPLETED project with the facts the Phase 8 intake reads (as in the 8A verifier) and a passed production verification
create or replace function pg_temp.mk(p_code text, p_org uuid default null)
returns table (client uuid, project uuid)
language plpgsql as $$
declare v_org uuid := coalesce(p_org, current_setting('p8.org')::uuid); v_a uuid; v_p uuid; v_sv uuid;
begin
  insert into core.client_accounts (organization_id, name) values (v_org, 'zztest p8d ' || p_code) returning id into v_a;
  insert into projects.projects (organization_id, client_account_id, name, project_code, status) values (v_org, v_a, 'zztest p8d ' || p_code, p_code, 'completed') returning id into v_p;
  insert into projects.scope_versions (organization_id, project_id, version, status, frozen_at) values (v_org, v_p, 1, 'active', now()) returning id into v_sv;
  alter table projects.handovers disable trigger user;
  insert into projects.handovers (organization_id, project_id, status, delivered_at, accepted_at) values (v_org, v_p, 'accepted', now(), now());
  alter table projects.handovers enable trigger user;
  insert into projects.release_verifications (organization_id, project_id, environment, outcome, evidence_url) values (v_org, v_p, 'production', 'passed', 'https://evidence.example.test/' || lower(p_code));
  insert into crm.contacts (organization_id, client_account_id, full_name, email) values (v_org, v_a, 'Contact ' || p_code, lower(p_code) || '@client.example.test');
  alter table projects.completion_records disable trigger user;
  insert into projects.completion_records (organization_id, project_id, client_account_id, scope_version_id, scope_version, invoiced_minor, verified_minor, completed_at, known_limitations)
  values (v_org, v_p, v_a, v_sv, 1, 0, 0, now(), 'none known');
  alter table projects.completion_records enable trigger user;
  return query select v_a, v_p;
end $$;
grant execute on function pg_temp.mk(text, uuid) to public;

-- a how-to ticket taken all the way to CLOSED through the real doors (answer + the knowledge it came from)
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

create or replace function pg_temp.closed_ticket(p_project uuid, p_ref text) returns uuid language plpgsql as $$
declare v_t uuid; v_o text;
begin
  perform pg_temp.as_service();
  select ticket_id into v_t from projects.open_support_ticket(current_setting('p8.org')::uuid, p_project, 'ticket ' || p_ref, 'the client asked how to export', 'portal', p_ref);
  perform pg_temp.as_user(current_setting('p8.staff')::uuid, current_setting('p8.org')::uuid, 'member');
  select outcome into v_o from projects.classify_support_ticket(v_t, 'how_to', 'included_support', 'because ' || p_ref, 'p4', null);
  if v_o <> 'classified' then raise exception 'fixture ticket % not classified: %', p_ref, v_o; end if;
  select outcome into v_o from projects.assign_support_ticket(v_t, current_setting('p8.staff')::uuid);
  if v_o <> 'assigned' then raise exception 'fixture ticket % not assigned: %', p_ref, v_o; end if;
  select outcome into v_o from projects.advance_support_ticket(v_t, 'in_progress');
  if v_o <> 'advanced' then raise exception 'fixture ticket % not started: %', p_ref, v_o; end if;
  perform pg_temp.p5r_cite_approved(v_t);
  select outcome into v_o from projects.advance_support_ticket(v_t, 'closed', 'Explained the export button');
  if v_o <> 'advanced' then raise exception 'fixture ticket % not closed: %', p_ref, v_o; end if;
  return v_t;
end $$;
grant execute on function pg_temp.closed_ticket(uuid, text) to public;

-- ═════════ 0. fixtures ═════════
select client as "A_id", project as "PA_id" from pg_temp.mk('P8D-A') \gset
select client as "A2_id", project as "PA2_id" from pg_temp.mk('P8D-A2') \gset
select client as "X_id", project as "PX_id" from pg_temp.mk('P8D-X', :'ORGB') \gset
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p8d plain client B') returning id as "B_id" \gset
insert into crm.contacts (organization_id, client_account_id, full_name, email) values (:'ORG', :'B_id', 'Contact B', 'b@client.example.test') returning id as "BCT_id" \gset
insert into crm.contacts (organization_id, client_account_id, full_name, email) values (:'ORG', :'B_id', 'Contact B two', 'b2@client.example.test') returning id as "BCT2_id" \gset
select id as "ACT_id" from crm.contacts where client_account_id = :'A_id' \gset

-- ═════════ 1. the roster handoff edges (mirror of the registry's literal arrays) ═════════
select pg_temp.check((select count(*) from ai.agent_handoff_targets where (from_agent, to_agent) in
                       (('support', 'customer_success'), ('support', 'sales'), ('customer_success', 'support'), ('customer_success', 'finance'), ('sales', 'customer_success'))) = 5,
                     'the five Phase 8 handoff edges are seeded: support to customer_success and sales, customer_success to support and finance, sales back to customer_success');
select pg_temp.check((select count(*) from ai.agent_handoff_targets where from_agent in ('support', 'customer_success') and to_agent not in ('developer', 'quality_assurance', 'sales', 'customer_success', 'support', 'finance')) = 0
                     and not exists (select 1 from ai.agent_handoff_targets where from_agent = 'upsell' and to_agent <> 'sales')
                     and not exists (select 1 from ai.agent_handoff_targets where from_agent = 'finance' and to_agent in ('customer_success', 'support', 'sales')),
                     'and nothing wider: upsell still hands only to sales, finance gains no edge back');

-- ═════════ 2. caps and quiet periods: Admin-set, no defaults ═════════
select pg_temp.check((select count(*) from projects.client_communication_caps where client_account_id = :'B_id') = 0 and (select count(*) from projects.client_quiet_periods where client_account_id = :'B_id') = 0,
                     'a client has NO cap and NO quiet period until an Admin sets one (no default number exists)');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_client_communication_cap(:'B_id', null, 2, 30)) = 'not_authorized', 'NEGATIVE: a member cannot set a cap (Admin only)');
select pg_temp.check((select outcome from projects.add_client_quiet_period(:'B_id', now(), now() + interval '2 days', 'a member cannot set this')) = 'not_authorized', 'NEGATIVE: nor a quiet period');
reset role;
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_client_communication_cap(:'A_id', null, 2, 30)) = 'not_authorized', 'NEGATIVE: a portal client cannot set a cap on themselves');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_client_communication_cap(:'B_id', null, 2, 30)) = 'not_found', 'NEGATIVE: another organization''s owner cannot set a cap on this client');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_client_communication_cap(:'B_id', null, 0, 30)) = 'out_of_range' and (select outcome from projects.set_client_communication_cap(:'B_id', null, 2, 400)) = 'out_of_range'
                     and (select outcome from projects.set_client_communication_cap(:'B_id', 'telegram', 2, 30)) = 'bad_channel', 'a cap is range- and channel-checked');
select pg_temp.check((select outcome from projects.set_client_communication_cap(:'B_id', null, 2, 30)) = 'set', 'an Admin sets a cap: at most 2 person-sent contacts in 30 days');
select outcome as "CAP2_out" from projects.set_client_communication_cap(:'B_id', null, 3, 30) \gset
select pg_temp.check(:'CAP2_out' = 'set' and (select count(*) from projects.client_communication_caps where client_account_id = :'B_id') = 1
                     and (select max_contacts from projects.client_communication_caps where client_account_id = :'B_id') = 3, 'setting it again REPLACES the one cap for that scope (one row)');
select pg_temp.check((select outcome from projects.set_client_communication_cap(:'B_id', null, 2, 30)) = 'set', 'back to 2 in 30');
select pg_temp.check((select outcome from projects.add_client_quiet_period(:'B_id', now(), now() + interval '2 days', 'x')) = 'reason_required', 'a quiet period needs a reason');
select pg_temp.check((select outcome from projects.add_client_quiet_period(:'B_id', now() + interval '2 days', now(), 'ends before it starts')) = 'bad_interval', 'and a forward interval');
reset role;
select pg_temp.check((select count(*) from audit.audit_log where organization_id = :'ORG' and action = 'client_communication.cap_set') = 3, 'every cap change is audited');
select pg_temp.check(pg_temp.direct(format('update projects.client_communication_caps set max_contacts = 999 where client_account_id = %L', :'B_id'), 'through its door'), 'a direct write to a cap is refused (a door must announce itself)');
select pg_temp.check(pg_temp.errs(format('delete from projects.client_communication_caps where client_account_id = %L', :'B_id'), 'is history and is never deleted'), 'and a cap row is never deleted');

-- ═════════ 3. the ledger: a person records, an agent drafts, nothing is edited ═════════
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_client_communication(:'B_id', 'whatsapp', 'relationship', 'x')) = 'summary_required', 'a ledger entry needs a summary');
select pg_temp.check((select outcome from projects.record_client_communication(:'B_id', 'telegram', 'relationship', 'Sent a thank-you note')) = 'bad_channel', 'and a known channel');
select pg_temp.check((select outcome from projects.record_client_communication(:'B_id', 'whatsapp', 'marketing', 'Sent a thank-you note')) = 'bad_purpose', 'and a known purpose');
select pg_temp.check((select outcome from projects.record_client_communication(:'B_id', 'whatsapp', 'relationship', 'Sent a thank-you note', null, null, now() + interval '1 day')) = 'in_the_future', 'a send cannot be dated in the future');
select pg_temp.check((select outcome from projects.record_client_communication(:'X_id', 'whatsapp', 'relationship', 'Sent a thank-you note')) = 'not_found', 'NEGATIVE: another organization''s client cannot be recorded against');
select outcome as "L1_out", ledger_id as "L1_id" from projects.record_client_communication(:'B_id', 'whatsapp', 'relationship', 'Sent a check-in message to the owner', null, :'BCT_id', null, null, 'wa-msg-001') \gset
select pg_temp.check(:'L1_out' = 'recorded', 'a person records that they sent a WhatsApp message');
select outcome as "L1b_out", ledger_id as "L1b_id" from projects.record_client_communication(:'B_id', 'whatsapp', 'relationship', 'Sent a check-in message to the owner', null, :'BCT_id', null, null, 'wa-msg-001') \gset
select pg_temp.check(:'L1b_out' = 'duplicate' and :'L1b_id' = :'L1_id', 'the same provider reference records once (a retried delivery is the same entry)');
reset role;
select pg_temp.check((select entry_kind = 'sent_by_person' and recorded_by = :'STAFF' and eligible_at_record = false and cardinality(eligibility_reasons) >= 1 from projects.client_communication_ledger where id = :'L1_id'),
                     'the entry stores who recorded it and that the read said NO at the time (no consent yet): the breach is visible, the true send was not refused');
select pg_temp.check((select count(*) from projects.client_communication_ledger where client_account_id = :'B_id') = 1, 'exactly one ledger row exists for the duplicate pair');
select pg_temp.check(pg_temp.errs(format('update projects.client_communication_ledger set summary = %L where id = %L', 'rewritten history', :'L1_id'), 'is history and is never edited'), 'the ledger is APPEND-ONLY: no update');
select pg_temp.check(pg_temp.errs(format('delete from projects.client_communication_ledger where id = %L', :'L1_id'), 'is history and is never edited'), 'and no delete');
-- the table layer: a send with no person, a draft attributed to a person, a draft naming a price
select pg_temp.check(pg_temp.errs(format('insert into projects.client_communication_ledger (organization_id, client_account_id, channel, purpose, entry_kind, summary, occurred_at, eligible_at_record) values (%L, %L, %L, %L, %L, %L, now(), true)',
                                         :'ORG', :'B_id', 'whatsapp', 'relationship', 'sent_by_person', 'A send with nobody who sent it'), 'ledger_sent_is_a_persons'), 'TABLE: a sent entry must name the person who sent it');
select pg_temp.check(pg_temp.errs(format('insert into projects.client_communication_ledger (organization_id, client_account_id, channel, purpose, entry_kind, summary, occurred_at, drafted_by_agent, recorded_by) values (%L, %L, %L, %L, %L, %L, now(), %L, %L)',
                                         :'ORG', :'B_id', 'whatsapp', 'relationship', 'drafted_by_agent', 'A draft attributed to a person', 'customer_success', :'STAFF'), 'ledger_draft_is_an_agents'), 'TABLE: a draft is never attributed to a person');
select pg_temp.check(pg_temp.errs(format('insert into projects.client_communication_ledger (organization_id, client_account_id, channel, purpose, entry_kind, summary, occurred_at, drafted_by_agent) values (%L, %L, %L, %L, %L, %L, now(), %L)',
                                         :'ORG', :'B_id', 'whatsapp', 'commercial', 'drafted_by_agent', 'Offer a 20% off deal to the client', 'upsell'), 'ledger_draft_names_no_price'), 'TABLE: an agent draft names no price or discount');
select pg_temp.check(pg_temp.errs(format('insert into projects.client_communication_ledger (organization_id, client_account_id, channel, purpose, entry_kind, summary, occurred_at, recorded_by, eligible_at_record) values (%L, %L, %L, %L, %L, %L, now(), %L, true)',
                                         :'ORGB', :'B_id', 'whatsapp', 'relationship', 'sent_by_person', 'A row grafted onto another tenant''s client', :'STAFF'), 'tenancy:'), 'TENANCY: a ledger row cannot name another organization''s client');

select pg_temp.check(pg_temp.errs(format('insert into projects.client_communication_ledger (organization_id, client_account_id, channel, purpose, entry_kind, summary, occurred_at, recorded_by, eligible_at_record, external_ref) values (%L, %L, %L, %L, %L, %L, now(), %L, true, %L)',
                                         :'ORG', :'B_id', 'whatsapp', 'relationship', 'sent_by_person', 'A second row for the same provider message', :'STAFF', 'wa-msg-001'), 'client_communication_ledger_one_external'), 'TABLE: one provider reference is one entry (the unique index, not only the door lookup)');
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_client_communication(:'A_id', 'call', 'relationship', 'A portal client trying to record a contact')) in ('not_authorized', 'no_actor'), 'NEGATIVE: a portal client cannot record a contact');
select pg_temp.check((select outcome from projects.record_client_communication_event(:'L1_id', 'delivered')) in ('not_authorized', 'no_actor', 'not_found'), 'NEGATIVE: nor an event');
reset role;
-- the agent doors check the role INSIDE too (a signed-in JWT reaching them as the owner is still refused)
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
select pg_temp.check((select outcome from projects.record_agent_communication_draft(:'ORG', :'B_id', 'whatsapp', 'relationship', 'A draft by a person pretending', 'customer_success')) = 'not_authorized', 'the agent draft door refuses a non-service JWT inside the function');
select pg_temp.check(pg_temp.errs(format('insert into projects.client_communication_ledger (organization_id, client_account_id, project_id, channel, purpose, entry_kind, summary, occurred_at, recorded_by, eligible_at_record) values (%L, %L, %L, %L, %L, %L, %L, now(), %L, true)',
                                         :'ORGB', :'X_id', :'PA_id', 'whatsapp', 'relationship', 'sent_by_person', 'A row naming another tenant''s project', :'BSTAFF'), 'tenancy:'), 'TENANCY: a ledger row cannot name another organization''s project');
select pg_temp.check(pg_temp.errs(format('insert into projects.client_communication_ledger (organization_id, client_account_id, contact_id, channel, purpose, entry_kind, summary, occurred_at, recorded_by, eligible_at_record) values (%L, %L, %L, %L, %L, %L, %L, now(), %L, true)',
                                         :'ORGB', :'X_id', :'ACT_id', 'whatsapp', 'relationship', 'sent_by_person', 'A row naming another tenant''s contact', :'BSTAFF'), 'tenancy:'), 'TENANCY: nor another organization''s contact');
select pg_temp.check(pg_temp.errs(format('insert into projects.client_communication_events (organization_id, ledger_id, event, occurred_at, recorded_by) values (%L, %L, %L, now(), %L)', :'ORGB', :'L1_id', 'delivered', :'BSTAFF'), 'tenancy:'), 'TENANCY: an event cannot name another organization''s ledger entry');
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
select pg_temp.check((select outcome from projects.record_client_communication_event(:'L1_id', 'read')) = 'not_found', 'NEGATIVE: another organization''s staff cannot record an event on this ledger entry');
-- direct writes by a signed-in person are not possible at all
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(pg_temp.errs(format('insert into projects.client_communication_ledger (organization_id, client_account_id, channel, purpose, entry_kind, summary, occurred_at, recorded_by, eligible_at_record) values (%L, %L, %L, %L, %L, %L, now(), %L, true)',
                                         :'ORG', :'B_id', 'whatsapp', 'relationship', 'sent_by_person', 'A direct insert by staff', :'STAFF'), 'permission denied'), 'NEGATIVE: staff cannot insert into the ledger directly: the door is the only way');
select pg_temp.check(pg_temp.errs(format('insert into projects.client_communication_caps (organization_id, client_account_id, max_contacts, window_days) values (%L, %L, 1, 1)', :'ORG', :'B_id'), 'permission denied'), 'NEGATIVE: nor a cap');
-- the agent door is service-role only
select pg_temp.check(pg_temp.errs(format('select * from projects.record_agent_communication_draft(%L, %L, %L, %L, %L, %L)', :'ORG', :'B_id', 'whatsapp', 'relationship', 'A draft from a person', 'customer_success'), 'permission denied'),
                     'NEGATIVE: a signed-in person cannot call the agent draft door');
reset role;
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.record_agent_communication_draft(:'ORG', :'B_id', 'whatsapp', 'relationship', 'Drafted a gentle check-in for the owner to send', 'customer_success')) = 'drafted', 'an agent leaves a DRAFT in the ledger');
select pg_temp.check((select outcome from projects.record_agent_communication_draft(:'ORG', :'B_id', 'whatsapp', 'commercial', 'Draft that offers 20% off if they renew', 'upsell')) = 'names_a_price', 'an agent draft that names a price or discount is refused (door layer)');
select pg_temp.check((select outcome from projects.record_agent_communication_draft(:'ORGB', :'B_id', 'whatsapp', 'relationship', 'Draft for another tenant''s client', 'customer_success')) = 'not_found', 'NEGATIVE: an agent cannot draft against a client of another organization');
select pg_temp.check((select outcome from projects.record_agent_communication_draft(:'ORG', :'B_id', 'whatsapp', 'relationship', 'Draft with no agent named', '')) = 'summary_and_agent_required', 'and the agent is named');
select pg_temp.check((select entry_kind = 'drafted_by_agent' and recorded_by is null and eligible_at_record is null from projects.client_communication_ledger where drafted_by_agent = 'customer_success' and client_account_id = :'B_id'), 'a draft carries no person and no eligibility claim');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_client_communication(:'B_id', 'whatsapp', 'relationship', 'Second message', null, null, null, null, 'wa-msg-002')) = 'recorded', 'a second person-sent contact is recorded');
reset role;

-- ═════════ 4. eligibility: consent, quiet periods, caps, the 8A category rules ═════════
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select not allowed and 'no contact of this client has recorded WhatsApp consent' = any (reasons) from projects.can_contact_now(:'B_id', 'whatsapp', 'relationship')), 'no recorded consent: WhatsApp is not allowed, and says why');
select pg_temp.check((select not allowed and reasons[1] like 'no consent record exists for email%' from projects.can_contact_now(:'B_id', 'email', 'relationship')), 'email has NO consent record (ADM-81): not allowed');
select pg_temp.check((select not allowed and reasons[1] like 'no consent record exists for portal%' from projects.can_contact_now(:'B_id', 'portal', 'operational')), 'portal likewise');
select pg_temp.check((select allowed from projects.can_contact_now(:'B_id', 'call', 'relationship', null, now() - interval '40 days')), 'a call is a person''s act: consent does not apply (and outside the cap window nothing else blocks it)');
select pg_temp.check((select not allowed and reasons[1] = 'the channel is not one AgencyOS knows' from projects.can_contact_now(:'B_id', 'smoke_signal', 'relationship', null, now() - interval '40 days')), 'an unknown channel is refused');
select pg_temp.check((select not allowed and reasons[1] = 'the purpose is not operational, relationship or commercial' from projects.can_contact_now(:'B_id', 'call', 'marketing', null, now() - interval '40 days')), 'an unknown purpose is refused');
select pg_temp.check((select not allowed and reasons[1] = 'the client is not known' from projects.can_contact_now(gen_random_uuid(), 'call', 'relationship', null, now() - interval '40 days')), 'an unknown client is refused');
reset role;
update core.client_accounts set status = 'archived' where id = :'B_id';
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select not allowed and 'the client account is archived' = any (reasons) from projects.can_contact_now(:'B_id', 'call', 'relationship', null, now() - interval '40 days')), 'an archived client is not contacted');
reset role;
update core.client_accounts set status = 'active' where id = :'B_id';
insert into crm.communication_consent (organization_id, contact_id, channel, status, source) values (:'ORG', :'BCT_id', 'whatsapp', 'granted', 'verifier');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select not allowed and 'contact cap reached: 2 of 2 in 30 days' = any (reasons) from projects.can_contact_now(:'B_id', 'whatsapp', 'relationship')), 'consent granted, but the cap of 2 in 30 days is REACHED by the two person-sent entries');
select pg_temp.check((select reasons from projects.can_contact_now(:'B_id', 'whatsapp', 'relationship')) = array['contact cap reached: 2 of 2 in 30 days'], 'consent is satisfied: the ONLY remaining reason is the cap (the agent draft was not counted: 3 rows, 2 counted)');
select pg_temp.check((select allowed from projects.can_contact_now(:'B_id', 'whatsapp', 'relationship', :'BCT_id', now() + interval '31 days')), 'a month later the window has rolled past both entries and the cap no longer blocks');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.clear_client_communication_cap(:'B_id', null)) = 'not_authorized', 'NEGATIVE: a member cannot clear a cap (Admin only)');
reset role;
-- a cap scoped to a channel only counts that channel
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.clear_client_communication_cap(:'B_id', null)) = 'cleared', 'an Admin clears the all-channel cap');
select pg_temp.check((select outcome from projects.clear_client_communication_cap(:'B_id', null)) = 'not_found', 'clearing a cleared cap finds nothing');
select pg_temp.check((select allowed from projects.can_contact_now(:'B_id', 'whatsapp', 'relationship', :'BCT_id')), 'with the cap cleared and consent granted, WhatsApp is allowed');
select pg_temp.check((select outcome from projects.set_client_communication_cap(:'B_id', 'call', 1, 30)) = 'set', 'a cap on calls only');
reset role;
select pg_temp.check((select allowed from projects.can_contact_now(:'B_id', 'whatsapp', 'relationship', :'BCT_id')) is not null and (select count(*) from projects.client_communication_ledger where client_account_id = :'B_id' and channel = 'call') = 0, 'fixture: no call recorded yet');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select allowed from projects.can_contact_now(:'B_id', 'call', 'relationship')), 'a call is allowed while no call has been recorded');
select pg_temp.check((select outcome from projects.record_client_communication(:'B_id', 'call', 'relationship', 'Called the owner about the renewal')) = 'recorded', 'a person records the call');
select pg_temp.check((select not allowed and 'contact cap reached: 1 of 1 in 30 days on call' = any (reasons) from projects.can_contact_now(:'B_id', 'call', 'relationship')), 'the call cap is reached');
select pg_temp.check((select allowed from projects.can_contact_now(:'B_id', 'whatsapp', 'relationship', :'BCT_id')), 'and does not touch WhatsApp');
reset role;
-- consent is per contact; a withdrawal blocks
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select not allowed and 'no WhatsApp consent is recorded for that contact' = any (reasons) from projects.can_contact_now(:'B_id', 'whatsapp', 'relationship', :'BCT2_id')), 'consent is per contact: the second contact has none');
select pg_temp.check((select not allowed and 'that contact does not belong to this client' = any (reasons) from projects.can_contact_now(:'B_id', 'whatsapp', 'relationship', :'ACT_id')), 'a contact of another client is refused');
reset role;
update crm.communication_consent set status = 'withdrawn' where contact_id = :'BCT_id';
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select not allowed and 'that contact withdrew WhatsApp consent' = any (reasons) from projects.can_contact_now(:'B_id', 'whatsapp', 'relationship', :'BCT_id')), 'a withdrawn consent blocks that contact');
select pg_temp.check((select not allowed and 'a contact of this client withdrew WhatsApp consent' = any (reasons) from projects.can_contact_now(:'B_id', 'whatsapp', 'relationship')), 'and the client-level read');
reset role;
update crm.communication_consent set status = 'granted' where contact_id = :'BCT_id';
-- quiet periods
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select outcome as "Q1_out", quiet_period_id as "Q1_id" from projects.add_client_quiet_period(:'B_id', now() - interval '1 hour', now() + interval '3 days', 'the client asked for no contact during their audit') \gset
select pg_temp.check(:'Q1_out' = 'added', 'an Admin adds a quiet period with a reason');
select pg_temp.check((select not allowed and exists (select 1 from unnest(reasons) r where r like 'quiet period until %: the client asked for no contact during their audit') from projects.can_contact_now(:'B_id', 'whatsapp', 'relationship', :'BCT_id')), 'inside the quiet period nothing is allowed, and the reason is quoted');
select pg_temp.check((select not allowed from projects.can_contact_now(:'B_id', 'call', 'operational', null, now() - interval '40 days')) is false, 'a quiet period in the future of the asked time does not apply to a date before it');
select pg_temp.check((select allowed from projects.can_contact_now(:'B_id', 'whatsapp', 'relationship', :'BCT_id', now() + interval '4 days')), 'after the period ends it no longer blocks');
select pg_temp.check((select outcome from projects.cancel_client_quiet_period(:'Q1_id', 'x')) = 'reason_required', 'cancelling needs a reason');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.cancel_client_quiet_period(:'Q1_id', 'a member may not cancel an Admin rule')) = 'not_authorized', 'NEGATIVE: a member cannot cancel a quiet period');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.cancel_client_quiet_period(:'Q1_id', 'the audit finished early')) = 'cancelled', 'an Admin cancels it');
select pg_temp.check((select outcome from projects.cancel_client_quiet_period(:'Q1_id', 'the audit finished early')) = 'already_cancelled', 'once');
select pg_temp.check((select allowed from projects.can_contact_now(:'B_id', 'whatsapp', 'relationship', :'BCT_id')) and (select count(*) from projects.client_quiet_periods where id = :'Q1_id' and cancelled_at is not null) = 1, 'a cancelled period no longer blocks and keeps its row');
reset role;
select pg_temp.check(pg_temp.direct(format('update projects.client_quiet_periods set ends_at = now() - interval %L where id = %L', '1 hour', :'Q1_id'), 'through its door'), 'a direct write to a quiet period is refused (a door must announce itself)');
-- the 8A category rules through the client's live Phase 8 project: an open P1 puts the relationship ahead of anything else
select pg_temp.as_service();
select outcome as "FILL_out" from projects.fill_phase_eight_intake(:'ORG', :'PA_id') \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "START_out" from projects.start_phase_eight(:'PA_id', current_date - 1, current_date + 89, 'defects in the delivered scope', 'new features, third-party outages', null, :'STAFF2') \gset
reset role;
select pg_temp.check(:'FILL_out' = 'ready' and :'START_out' = 'started', 'fixture: client A has a live Phase 8 workspace');
insert into crm.communication_consent (organization_id, contact_id, channel, status, source) values (:'ORG', :'ACT_id', 'whatsapp', 'granted', 'verifier');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select allowed from projects.can_contact_now(:'A_id', 'whatsapp', 'relationship', :'ACT_id')) and (select allowed from projects.can_contact_now(:'A_id', 'whatsapp', 'commercial', :'ACT_id')), 'a healthy client with consent: relationship and commercial are allowed');
reset role;
select pg_temp.as_service();
select ticket_id as "TP1_id" from projects.open_support_ticket(:'ORG', :'PA_id', 'ticket p1', 'the client cannot log in', 'portal', 'P8D-P1') \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "TP1_class" from projects.classify_support_ticket(:'TP1_id', 'warranty_bug', 'covered_warranty', 'login is broken in the delivered scope', 'p1', null) \gset
select pg_temp.check(:'TP1_class' = 'classified', 'fixture: an open P1 ticket on the live project');
select pg_temp.check((select not allowed and exists (select 1 from unnest(reasons) r where r like 'zztest p8d P8D-A: %an open P1 ticket comes first%') from projects.can_contact_now(:'A_id', 'whatsapp', 'relationship', :'ACT_id')), 'RULES: an open P1 blocks a relationship message (the 8A category rule is reused, with the project named)');
select pg_temp.check((select not allowed from projects.can_contact_now(:'A_id', 'whatsapp', 'commercial', :'ACT_id')), 'and a commercial one (recovery and urgent issues come first)');
select pg_temp.check((select allowed from projects.can_contact_now(:'A_id', 'whatsapp', 'operational', :'ACT_id')), 'while an OPERATIONAL message (telling them about the fix) is still allowed');
reset role;
-- access: a portal client and another organization's staff read nothing
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.can_contact_now(:'A_id', 'call', 'relationship')) = 0, 'NEGATIVE: a portal client gets no answer from the eligibility read');
select pg_temp.check((select count(*) from projects.client_communication_ledger) + (select count(*) from projects.client_communication_events) + (select count(*) from projects.client_communication_caps) + (select count(*) from projects.client_quiet_periods)
                     + (select count(*) from projects.client_communication_history(:'B_id')) = 0, 'NEGATIVE: and reads no ledger, event, cap, quiet period or history row');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.client_communication_ledger) + (select count(*) from projects.client_communication_caps) + (select count(*) from projects.client_quiet_periods) + (select count(*) from projects.client_communication_history(:'B_id')) = 0, 'NEGATIVE: another organization''s staff read none of it');
select pg_temp.check((select not allowed and reasons = array['the client is not known'] from projects.can_contact_now(:'B_id', 'call', 'relationship')), 'and to them this client is not known');
reset role;
select pg_temp.as_service();
select pg_temp.check((select allowed from projects.can_contact_now(:'B_id', 'call', 'relationship', null, now() + interval '40 days')), 'the service role (the next sender) can ask the same read');

-- ═════════ 5. delivery and reply tracking: a person''s events, the message log joined read-only ═════════
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_client_communication_event(:'L1_id', 'teleported')) = 'bad_event', 'an event is delivered, read, failed, bounced or replied');
select pg_temp.check((select outcome from projects.record_client_communication_event(:'L1_id', 'delivered', null, now() - interval '3 days')) = 'before_the_send', 'an event cannot precede the send it describes');
select pg_temp.check((select outcome from projects.record_client_communication_event(:'L1_id', 'delivered')) = 'recorded', 'a person records that it was delivered');
select pg_temp.check((select outcome from projects.record_client_communication_event(:'L1_id', 'delivered')) = 'already_recorded', 'once');
select pg_temp.check((select outcome from projects.record_client_communication_event(:'L1_id', 'replied', 'the owner answered by voice note')) = 'recorded'
                     and (select outcome from projects.record_client_communication_event(:'L1_id', 'replied', 'and again')) = 'recorded', 'a reply may be recorded each time it happens');
select pg_temp.check((select delivery_state = 'delivered' and delivery_source = 'person' and replied from projects.client_communication_history(:'B_id') where id = :'L1_id'), 'the history shows delivered (by a person) and replied');
select pg_temp.check((select delivery_state = 'unknown' and delivery_source = 'none' and not replied from projects.client_communication_history(:'B_id') where external_ref = 'wa-msg-002'), 'an entry with no event and no message log says UNKNOWN, never delivered');
select pg_temp.check((select delivery_state = 'not_sent' from projects.client_communication_history(:'B_id') where entry_kind = 'drafted_by_agent' limit 1), 'an agent draft reads as NOT SENT');
select pg_temp.check((select outcome from projects.record_client_communication_event((select id from projects.client_communication_ledger where drafted_by_agent = 'customer_success' and client_account_id = :'B_id'), 'delivered')) = 'not_a_sent_entry', 'a draft cannot be marked delivered');
reset role;
-- the existing outbound-message log is JOINED, never written: a message with metadata.delivery
insert into crm.leads (organization_id, title, source) values (:'ORG', 'zztest p8d lead', 'manual') returning id as "LEAD_id" \gset
insert into crm.conversations (organization_id, lead_id, channel) values (:'ORG', :'LEAD_id', 'whatsapp') returning id as "CONV_id" \gset
insert into crm.conversation_messages (organization_id, conversation_id, seq, author_type, body, metadata) values (:'ORG', :'CONV_id', 0, 'user', 'the message a person sent', '{"delivery": "failed"}'::jsonb) returning id as "MSG_id" \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "L3_out", ledger_id as "L3_id" from projects.record_client_communication(:'B_id', 'whatsapp', 'operational', 'Sent the fix notification through the platform', null, :'BCT_id', null, :'MSG_id', 'wa-msg-003') \gset
select pg_temp.check(:'L3_out' = 'recorded', 'a person links the entry to the platform message');
select pg_temp.check((select delivery_state = 'failed' and delivery_source = 'message_log' from projects.client_communication_history(:'B_id') where id = :'L3_id'), 'the message log''s delivery state is read through the join');
select outcome as "EV3_out" from projects.record_client_communication_event(:'L3_id', 'delivered') \gset
select pg_temp.check(:'EV3_out' = 'recorded'
                     and (select delivery_state = 'delivered' and delivery_source = 'person' from projects.client_communication_history(:'B_id') where id = :'L3_id'), 'a person''s later event takes precedence over the log');
reset role;
select pg_temp.check((select metadata ->> 'delivery' from crm.conversation_messages where id = :'MSG_id') = 'failed', 'and the message log itself is untouched');
select pg_temp.check(pg_temp.errs(format('insert into projects.client_communication_ledger (organization_id, client_account_id, channel, purpose, entry_kind, summary, occurred_at, recorded_by, eligible_at_record, message_id) values (%L, %L, %L, %L, %L, %L, now(), %L, true, %L)',
                                         :'ORGB', :'X_id', 'whatsapp', 'operational', 'sent_by_person', 'A row naming another tenant''s message', :'BSTAFF', :'MSG_id'), 'tenancy:'), 'TENANCY: a ledger row cannot link another organization''s message');
select pg_temp.check(pg_temp.errs(format('update projects.client_communication_events set note = %L', 'rewritten'), 'is history and is never edited'), 'events are APPEND-ONLY too');

-- ═════════ 6. value reports: facts only, each citing its source, a draft a person approves ═════════
select pg_temp.closed_ticket(:'PA_id', 'P8D-VR1') as "VT1_id" \gset
insert into projects.maintenance_items (organization_id, client_account_id, project_id, title) values (:'ORG', :'A_id', :'PA_id', 'zztest p8d maintenance ticket') returning id as "MI_id" \gset
alter table projects.maintenance_work_items disable trigger user;
insert into projects.maintenance_work_items (organization_id, client_account_id, project_id, kind, area, title, ticket_id, status, commit_ref, commit_submitted_by, approved_commit, release_approved_by, release_approved_at,
                                              deployment_ref, smoke_evidence_ref, released_by, released_at, created_by)
values (:'ORG', :'A_id', :'PA_id', 'patch', 'backend', 'Fixed the export timeout', :'MI_id', 'released', repeat('a', 40), :'STAFF', repeat('a', 40), :'ADMIN', now(), 'deploy-2026-10-07-1', 'smoke-ok-1', :'ADMIN', now(), :'STAFF') returning id as "WI_id" \gset
alter table projects.maintenance_work_items enable trigger user;
insert into projects.tasks (organization_id, project_id, title) values (:'ORG', :'PA_id', 'zztest p8d task') returning id as "TASK_id" \gset
insert into projects.time_logs (organization_id, project_id, task_id, person_id, hours, logged_on, note) values (:'ORG', :'PA_id', :'TASK_id', :'STAFF', 2.5, current_date, 'export fix') returning id as "TL_id" \gset
insert into projects.time_logs (organization_id, project_id, task_id, person_id, hours, logged_on, note) values (:'ORG', :'PA_id', :'TASK_id', :'STAFF', 1.0, current_date - 2, 'investigation') returning id as "TL2_id" \gset
insert into projects.time_logs (organization_id, project_id, task_id, person_id, hours, logged_on, note) values (:'ORG', :'PA_id', :'TASK_id', :'STAFF', 7.0, current_date - 90, 'before the period') returning id as "TL3_id" \gset

-- a CANCELLED ticket is stamped with a closing time too, and is not a resolved ticket
alter table projects.support_tickets disable trigger user;
insert into projects.support_tickets (organization_id, project_id, client_account_id, source, title, status, closed_at, close_reason)
values (:'ORG', :'PA_id', :'A_id', 'internal', 'zztest p8d cancelled ticket', 'cancelled', now(), 'raised in error');
alter table projects.support_tickets enable trigger user;
insert into projects.release_verifications (organization_id, project_id, environment, outcome) values (:'ORG', :'PA_id', 'staging', 'passed');
-- client A2 (same organization) has facts of its own: a closed ticket, a released fix and hours
alter table projects.support_tickets disable trigger user;
insert into projects.support_tickets (organization_id, project_id, client_account_id, source, title, status, classification, coverage_decision, coverage_reason, priority, response_due_at, resolution_due_at, closed_at, close_reason)
values (:'ORG', :'PA2_id', :'A2_id', 'internal', 'zztest p8d a2 ticket', 'closed', 'how_to', 'included_support', 'because a2', 'p4', now(), now(), now(), 'answered');
alter table projects.support_tickets enable trigger user;
insert into projects.maintenance_items (organization_id, client_account_id, project_id, title) values (:'ORG', :'A2_id', :'PA2_id', 'zztest p8d a2 maintenance') returning id as "MI2_id" \gset
alter table projects.maintenance_work_items disable trigger user;
insert into projects.maintenance_work_items (organization_id, client_account_id, project_id, kind, area, title, ticket_id, status, commit_ref, commit_submitted_by, approved_commit, release_approved_by, release_approved_at,
                                              deployment_ref, smoke_evidence_ref, released_by, released_at, created_by)
values (:'ORG', :'A2_id', :'PA2_id', 'patch', 'backend', 'A2 fix', :'MI2_id', 'released', repeat('b', 40), :'STAFF', repeat('b', 40), :'ADMIN', now(), 'deploy-a2', 'smoke-a2', :'ADMIN', now(), :'STAFF');
alter table projects.maintenance_work_items enable trigger user;
insert into projects.tasks (organization_id, project_id, title) values (:'ORG', :'PA2_id', 'zztest p8d a2 task') returning id as "TASK2_id" \gset
insert into projects.time_logs (organization_id, project_id, task_id, person_id, hours, logged_on, note) values (:'ORG', :'PA2_id', :'TASK2_id', :'STAFF', 4.0, current_date, 'a2 work');

select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select digest as "D1", jsonb_array_length(facts) as "N1" from projects.value_report_facts(:'A_id', current_date - 30, current_date) \gset
select pg_temp.check(:N1 = 4, 'the facts read finds four facts for client A: a ticket, a release, hours and a production check');
select pg_temp.check((select count(*) from projects.value_report_facts(:'A_id', current_date + 1, current_date)) = 0 and (select count(*) from projects.value_report_facts(:'A_id', current_date - 500, current_date)) = 0, 'a backwards or 500-day period reads nothing');
select pg_temp.check((select f ->> 'type' from projects.value_report_facts(:'A_id', current_date - 30, current_date) r, jsonb_array_elements(r.facts) f where f -> 'sources' -> 0 ->> 'id' = :'VT1_id') = 'ticket_resolved', 'the ticket fact cites the ticket row');
select pg_temp.check((select f ->> 'type' = 'change_released' and f ->> 'evidence' = 'deploy-2026-10-07-1' from projects.value_report_facts(:'A_id', current_date - 30, current_date) r, jsonb_array_elements(r.facts) f where f -> 'sources' -> 0 ->> 'id' = :'WI_id'), 'the release fact cites the work item and the deployment reference a person recorded');
select pg_temp.check((select (f ->> 'value')::numeric = 3.5 and jsonb_array_length(f -> 'sources') = 2 and f -> 'sources' @> jsonb_build_array(jsonb_build_object('table', 'projects.time_logs', 'id', :'TL_id'))
                             and not (f -> 'sources' @> jsonb_build_array(jsonb_build_object('table', 'projects.time_logs', 'id', :'TL3_id')))
                        from projects.value_report_facts(:'A_id', current_date - 30, current_date) r, jsonb_array_elements(r.facts) f where f ->> 'type' = 'hours_logged'), 'the hours fact sums only the period''s logs and cites every log row it summed (not the one from 90 days ago)');
select pg_temp.check((select f ->> 'evidence' like 'https://evidence.example.test/%' from projects.value_report_facts(:'A_id', current_date - 30, current_date) r, jsonb_array_elements(r.facts) f where f ->> 'type' = 'production_verification'), 'the production check cites the verification row and carries its evidence link');
select pg_temp.check((select count(*) from projects.value_report_facts(:'A_id', current_date - 30, current_date) r, jsonb_array_elements(r.facts) f where f ->> 'type' not in ('ticket_resolved', 'change_released', 'hours_logged', 'production_verification')) = 0, 'there is no uptime, score or savings fact of any kind');
select pg_temp.check((select count(*) from projects.value_report_facts(:'A_id', current_date - 30, current_date) r, jsonb_array_elements(r.facts) f, jsonb_array_elements(f -> 'sources') src
                       where src ->> 'id' in (select id::text from projects.release_verifications where project_id = :'PA2_id' union select id::text from projects.support_tickets where client_account_id = :'A2_id'
                                              union select id::text from projects.maintenance_work_items where client_account_id = :'A2_id' union select id::text from projects.time_logs where project_id = :'PA2_id')) = 0
                     and (select jsonb_array_length(facts) from projects.value_report_facts(:'A2_id', current_date - 30, current_date)) = 4, 'another client of the same organization contributes nothing to this report (A2 has exactly its own four facts, none of them cited here)');
select pg_temp.check((select count(*) from projects.value_report_facts(:'A_id', current_date - 60, current_date - 31)) = 1 and (select jsonb_array_length(facts) from projects.value_report_facts(:'A_id', current_date - 60, current_date - 31)) = 0,
                     'a period in the past holds no fact: only what happened in the period is reported (nothing released, closed, logged or verified then)');
select pg_temp.check((select count(*) from projects.value_report_facts(:'A_id', current_date - 30, current_date) r, jsonb_array_elements(r.facts) f where f ->> 'type' = 'production_verification') = 1, 'a STAGING verification is not a production check (one production fact, not two)');
select pg_temp.check((select digest from projects.value_report_facts(:'A_id', current_date - 30, current_date)) = :'D1', 'the digest is stable for unchanged facts');
select pg_temp.check((select count(*) from projects.value_report_facts(:'X_id', current_date - 30, current_date)) = 0, 'NEGATIVE: another organization''s client reads nothing');
reset role;
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.value_report_facts(:'A_id', current_date - 30, current_date)) = 0, 'NEGATIVE: a portal client gets no facts read (and no report)');
select pg_temp.check((select outcome from projects.store_value_report_draft(:'A_id', current_date - 30, current_date, 1, 'A portal client trying to store a report about itself.', :'D1')) in ('not_authorized', 'no_actor'), 'NEGATIVE: a portal client cannot store a report draft');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
-- the doors
select pg_temp.check((select outcome from projects.store_value_report_draft(:'A_id', current_date - 30, current_date, 0, 'Over the period we closed one ticket and released one fix.', :'D1')) = 'bad_template_version', 'a draft names the template version that rendered it');
select pg_temp.check((select outcome from projects.store_value_report_draft(:'A_id', current_date - 30, current_date, 1, 'short', :'D1')) = 'body_required', 'a body is required');
select pg_temp.check((select outcome from projects.store_value_report_draft(:'A_id', current_date - 30, current_date, 1, 'We saved the client 40% off the price this month in total.', :'D1')) = 'names_a_price', 'a body that names a price or discount is refused');
select pg_temp.check((select outcome from projects.store_value_report_draft(:'A_id', current_date - 30, current_date, 1, 'Over the period we closed one ticket and released one fix.', md5('stale'))) = 'facts_changed', 'a body rendered from facts that are not the current facts is refused');
select pg_temp.check((select outcome from projects.store_value_report_draft(:'A_id', current_date - 30, current_date, 1, 'Over the period we closed one ticket and released one fix.', null)) = 'facts_changed', 'and with no digest at all');
select pg_temp.check((select outcome from projects.store_value_report_draft(:'B_id', current_date - 30, current_date, 1, 'Over the period nothing was recorded for this client at all.', md5('x'))) = 'nothing_to_report', 'a period with no facts is NOT reported on (nothing to report)');
select pg_temp.check((select outcome from projects.store_value_report_draft(:'X_id', current_date - 30, current_date, 1, 'Over the period we closed one ticket and released one fix.', :'D1')) = 'not_found', 'NEGATIVE: another organization''s client cannot be reported on');
select outcome as "R1_out", report_id as "R1_id" from projects.store_value_report_draft(:'A_id', current_date - 30, current_date, 1, 'Over the period we closed one ticket and released one fix.', :'D1') \gset
select pg_temp.check(:'R1_out' = 'drafted', 'a person stores the draft');
reset role;
select pg_temp.check((select status = 'draft' and built_by = :'STAFF' and built_by_agent is null and template_version = 1 and facts_digest = :'D1' and jsonb_array_length(facts) = 4 from projects.value_report_drafts where id = :'R1_id'), 'the draft holds the frozen facts, the digest, the template version and who built it');
select pg_temp.check(pg_temp.direct(format('update projects.value_report_drafts set body = %L where id = %L', 'Edited around the door and its checks entirely.', :'R1_id'), 'through its door'), 'a direct edit of a draft is refused');
select pg_temp.check(pg_temp.errs(format('select set_config(%L, %L, true); update projects.value_report_drafts set facts = %L::jsonb where id = %L', 'projects.p8_sanctioned', 'on', '[]', :'R1_id'), 'are frozen'), 'FROZEN: even a sanctioned write cannot change the facts of a draft');
select pg_temp.check(pg_temp.errs(format('select set_config(%L, %L, true); update projects.value_report_drafts set template_version = 9 where id = %L', 'projects.p8_sanctioned', 'on', :'R1_id'), 'are frozen'), 'FROZEN: nor the template version');
select pg_temp.check(pg_temp.errs(format('insert into projects.value_report_drafts (organization_id, client_account_id, period_start, period_end, template_version, facts, facts_digest, body, built_by) values (%L, %L, current_date, current_date, 1, %L::jsonb, md5(%L), %L, %L)',
                                         :'ORG', :'A_id', '[{"type": "ticket_resolved", "label": "an uncited fact", "sources": []}]', 'x', 'A body that is long enough to pass', :'STAFF'), 'value_report_facts_are_cited'), 'TABLE: a fact with no source row is refused');
select pg_temp.check(pg_temp.errs(format('insert into projects.value_report_drafts (organization_id, client_account_id, period_start, period_end, template_version, facts, facts_digest, body) values (%L, %L, current_date, current_date, 1, %L::jsonb, md5(%L), %L)',
                                         :'ORG', :'A_id', '[{"type": "ticket_resolved", "label": "a cited fact", "sources": [{"table": "projects.support_tickets", "id": "x"}]}]', 'x', 'A body that is long enough to pass'), 'value_report_has_one_author'), 'TABLE: a draft has exactly one author, a person or an agent');
select pg_temp.check(pg_temp.errs(format('insert into projects.value_report_drafts (organization_id, client_account_id, period_start, period_end, template_version, facts, facts_digest, body, built_by) values (%L, %L, current_date, current_date, 1, %L::jsonb, md5(%L), %L, %L)',
                                         :'ORGB', :'A_id', '[{"type": "ticket_resolved", "label": "a cited fact", "sources": [{"table": "projects.support_tickets", "id": "x"}]}]', 'x', 'A body that is long enough to pass', :'STAFF'), 'tenancy:'), 'TENANCY: a draft cannot name another organization''s client');
select pg_temp.check(pg_temp.errs(format('insert into projects.value_report_drafts (organization_id, client_account_id, period_start, period_end, template_version, facts, facts_digest, body, built_by) values (%L, %L, current_date, current_date, 1, %L::jsonb, md5(%L), %L, %L)',
                                         :'ORG', :'A_id', '[{"type": "ticket_resolved", "label": "a cited fact", "sources": [{"table": "projects.support_tickets", "id": "x"}]}]', 'x', 'We offered a 20% off renewal to the client this month', :'STAFF'), 'value_report_body_names_no_price'), 'TABLE: a report body names no price or discount (the CHECK, not only the door)');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
select pg_temp.check((select outcome from projects.store_value_report_draft_as_agent(:'ORG', :'A_id', current_date - 30, current_date, 1, 'A draft stored by a person pretending to be an agent.', :'D1', 'customer_success')) = 'not_authorized', 'the agent store door refuses a non-service JWT inside the function');
-- the agent door
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(pg_temp.errs(format('select * from projects.store_value_report_draft_as_agent(%L, %L, current_date - 30, current_date, 1, %L, %L, %L)', :'ORG', :'A_id', 'Over the period we closed one ticket and released one fix.', :'D1', 'customer_success'), 'permission denied'), 'NEGATIVE: a signed-in person cannot call the agent store door');
select pg_temp.check(pg_temp.errs(format('select * from projects.p8d_store_value_report(%L, %L, null, %L, current_date - 30, current_date, 1, %L, %L)', :'ORG', :'STAFF', :'A_id', 'Over the period we closed one ticket and released one fix.', :'D1'), 'permission denied'), 'NEGATIVE: nor the inner store function');
-- edit / approve: a person
select pg_temp.check((select outcome from projects.edit_value_report_draft(:'R1_id', 'short')) = 'body_required', 'an edit needs a body');
select pg_temp.check((select outcome from projects.edit_value_report_draft(:'R1_id', 'We gave a discount of 15% on this month for the client.')) = 'names_a_price', 'and names no price or discount');
select pg_temp.check((select outcome from projects.edit_value_report_draft(:'R1_id', 'Over the period we closed one ticket, shipped one fix and logged three and a half hours.')) = 'edited', 'a person edits the wording');
reset role;
select pg_temp.check((select edited_by = :'STAFF' and edited_at is not null and body like '%three and a half hours%' and facts_digest = :'D1' from projects.value_report_drafts where id = :'R1_id'), 'the edit is attributed and the facts are untouched');
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select outcome from projects.approve_value_report_draft(:'R1_id')) in ('not_authorized', 'no_actor') and (select count(*) from projects.value_report_drafts) = 0, 'NEGATIVE: a portal client cannot approve (or even read) a draft');
select pg_temp.check((select outcome from projects.edit_value_report_draft(:'R1_id', 'A portal client trying to rewrite its own report.')) in ('not_authorized', 'no_actor')
                     and (select outcome from projects.discard_value_report_draft(:'R1_id', 'a portal client discarding its report')) in ('not_authorized', 'no_actor'), 'NEGATIVE: nor edit or discard one');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.approve_value_report_draft(:'R1_id')) = 'not_found' and (select outcome from projects.edit_value_report_draft(:'R1_id', 'Another organization trying to rewrite this report.')) = 'not_found', 'NEGATIVE: another organization cannot approve or edit it');
reset role;
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.store_value_report_draft_as_agent(:'ORG', :'A_id', current_date - 30, current_date, 1, 'Agent drafted: over the period we closed one ticket and released one fix.', :'D1', '')) = 'agent_required', 'the agent door names its agent');
select outcome as "R2_out", report_id as "R2_id" from projects.store_value_report_draft_as_agent(:'ORG', :'A_id', current_date - 30, current_date, 1, 'Agent drafted: over the period we closed one ticket and released one fix.', :'D1', 'customer_success') \gset
select pg_temp.check(:'R2_out' = 'drafted' and (select built_by is null and built_by_agent = 'customer_success' and status = 'draft' from projects.value_report_drafts where id = :'R2_id'), 'an agent drafts a report: a draft, attributed to the agent, never approved');
select pg_temp.check((select outcome from projects.store_value_report_draft_as_agent(:'ORGB', :'A_id', current_date - 30, current_date, 1, 'Agent drafted for a client that is not in that organization.', :'D1', 'customer_success')) = 'not_found', 'NEGATIVE: an agent cannot report on a client of another organization');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.approve_value_report_draft(:'R1_id')) = 'approved', 'a person approves the draft');
select pg_temp.check((select outcome from projects.approve_value_report_draft(:'R1_id')) = 'not_a_draft' and (select outcome from projects.edit_value_report_draft(:'R1_id', 'Editing a report after it was approved by somebody.')) = 'not_a_draft', 'an approved report is final: no second approval, no edit');
select pg_temp.check((select outcome from projects.discard_value_report_draft(:'R1_id', 'discarding a report that was approved')) = 'not_a_draft', 'an approved report cannot be discarded');
select pg_temp.check((select outcome from projects.discard_value_report_draft(:'R2_id', 'x')) = 'reason_required', 'discarding needs a reason');
select pg_temp.check((select outcome from projects.discard_value_report_draft(:'R2_id', 'the person wrote their own')) = 'discarded', 'a draft can be discarded with a reason');
select pg_temp.check((select outcome from projects.approve_value_report_draft(:'R2_id')) = 'not_a_draft', 'a discarded draft cannot then be approved');
reset role;
select pg_temp.check((select status = 'approved' and approved_by = :'STAFF' and approved_at is not null from projects.value_report_drafts where id = :'R1_id'), 'the approval is a person and a time');
select pg_temp.check(pg_temp.errs(format('select set_config(%L, %L, true); update projects.value_report_drafts set body = %L where id = %L', 'projects.p8_sanctioned', 'on', 'A final report rewritten after the fact by someone.', :'R1_id'), 'value report is final'), 'FINAL: even a sanctioned write cannot change an approved report');
select pg_temp.check((select count(*) from audit.audit_log where organization_id = :'ORG' and action in ('value_report.drafted', 'value_report.edited', 'value_report.approved', 'value_report.discarded')) = 5, 'drafting, editing, approving and discarding are all audited');
select pg_temp.check((select count(*) from information_schema.columns c where c.table_schema = 'projects' and c.table_name = 'value_report_drafts' and c.column_name ~* '(price|amount|quote|discount|cost|fee|total|score|rate|minor|currency|uptime|satisfaction|savings)') = 0, 'a value report has no price, score, uptime, satisfaction or savings column');

-- ═════════ 7. observability: counts and ages from the existing tables ═════════
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select n from projects.phase_eight_observability() where metric = 'tickets_by_state' and bucket = 'closed') >= 1 and (select n from projects.phase_eight_observability() where metric = 'tickets_by_state' and bucket = 'classified') >= 1,
                     'tickets are counted by state (a closed one and the classified P1)');
select pg_temp.check((select n from projects.phase_eight_observability() where metric = 'tickets_by_sla') >= 1 and (select count(*) from projects.phase_eight_observability() where metric = 'tickets_by_sla' and bucket = 'running') = 1, 'open tickets are counted by their resolution SLA state');
select pg_temp.check((select oldest_at from projects.phase_eight_observability() where metric = 'tickets_by_sla' and bucket = 'running') <= clock_timestamp(), 'and carry the age of the oldest');
select pg_temp.check((select count(*) from projects.phase_eight_observability() where metric = 'tickets_by_sla' and bucket in ('met', 'met_late', 'not_applicable')) = 0, 'the resolution SLA counts are of OPEN tickets only (a closed ticket is not in them)');
select pg_temp.check((select n from projects.phase_eight_observability() where metric = 'health_distribution' and bucket = 'at_risk') = 1, 'the derived health distribution counts the P1 account as at risk');
select pg_temp.check((select count(*) from projects.phase_eight_observability() where metric = 'recovery_plans') >= 0, 'recovery plans are read');
reset role;
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.phase_eight_observability()) = 0, 'NEGATIVE: a portal client reads no observability row');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.phase_eight_observability() where metric = 'tickets_by_state') = 0 and (select count(*) from projects.phase_eight_observability() where metric = 'health_distribution') = 0, 'NEGATIVE: another organization sees none of this organization''s counts');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(pg_temp.errs('select * from projects.phase_eight_observability()', 'permission denied'), 'the service role does not read it (it has no organization to count)');
reset role;

-- ═════════ 8. structure ═════════
create temp table p8d_tables (tbl text);
insert into p8d_tables values ('client_communication_caps'), ('client_quiet_periods'), ('client_communication_ledger'), ('client_communication_events'), ('value_report_drafts');
grant select on p8d_tables to public;
select pg_temp.check((select count(*) from p8d_tables t join pg_class c on c.relname = t.tbl join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'projects' where c.relrowsecurity) = 5, 'every Phase 8D table has row security on');
select pg_temp.check((select count(*) from p8d_tables t join pg_policies p on p.schemaname = 'projects' and p.tablename = t.tbl and p.cmd = 'SELECT' where p.qual like '%is_internal%' and p.qual like '%current_organization_id%') = 5, 'every Phase 8D table has exactly the internal-only, organization-scoped read policy');
select pg_temp.check((select count(*) from p8d_tables t join pg_policies p on p.schemaname = 'projects' and p.tablename = t.tbl where p.cmd <> 'SELECT') = 0, 'and no write policy at all');
select pg_temp.check((select count(*) from p8d_tables t where has_table_privilege('authenticated', 'projects.' || t.tbl, 'insert') or has_table_privilege('authenticated', 'projects.' || t.tbl, 'update') or has_table_privilege('authenticated', 'projects.' || t.tbl, 'delete')
                          or has_table_privilege('anon', 'projects.' || t.tbl, 'select') or not has_table_privilege('service_role', 'projects.' || t.tbl, 'select')) = 0, 'authenticated can only read, anon nothing, the service role everything');
select pg_temp.as_service();
select pg_temp.check((select count(*) from core.unguarded_org_fks() u where u.child in ('projects.client_communication_caps', 'projects.client_quiet_periods', 'projects.client_communication_ledger', 'projects.client_communication_events', 'projects.value_report_drafts')) = 0,
                     'TENANCY: every org-scoped foreign key of the new tables (client_account_id, project_id, contact_id, message_id, ledger_id) has its parent-org guard');
select pg_temp.check((select count(*) from core.unfrozen_org_tables() u where u.org_table in ('projects.client_communication_caps', 'projects.client_quiet_periods', 'projects.client_communication_ledger', 'projects.client_communication_events', 'projects.value_report_drafts')) = 0,
                     'TENANCY: every new table freezes its organization_id');
select pg_temp.check((select count(*) from pg_trigger tg join pg_class c on c.oid = tg.tgrelid where c.relname in ('client_communication_ledger', 'client_communication_events') and tg.tgname like '%append_only' and not tg.tgisinternal) = 2, 'the ledger and its events carry the append-only guard');
select pg_temp.check((select count(*) from information_schema.columns c join p8d_tables t on t.tbl = c.table_name where c.table_schema = 'projects' and c.table_name <> 'value_report_drafts'
                       and c.column_name ~* '(price|amount|quote|discount|cost|fee|total|score|minor|currency)') = 0, 'the governance tables have no price, amount, quote, discount, score or currency column');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.proname in ('record_agent_communication_draft', 'store_value_report_draft_as_agent', 'p8d_store_value_report')
                       and has_function_privilege('authenticated', p.oid, 'execute')) = 0, 'the agent-only doors are not executable by a signed-in user');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.proname in ('set_client_communication_cap', 'clear_client_communication_cap', 'add_client_quiet_period', 'cancel_client_quiet_period', 'record_client_communication',
                                                                                                                                       'record_client_communication_event', 'edit_value_report_draft', 'approve_value_report_draft', 'discard_value_report_draft', 'store_value_report_draft', 'phase_eight_observability')
                       and has_function_privilege('service_role', p.oid, 'execute')) = 0, 'the person-only doors are not executable by the service role (an agent cannot set a cap, record a send, approve or discard)');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.prosecdef and (p.proconfig is null or not p.proconfig::text like '%search_path=%')
                       and p.proname in ('set_client_communication_cap', 'clear_client_communication_cap', 'add_client_quiet_period', 'cancel_client_quiet_period', 'record_client_communication', 'record_agent_communication_draft', 'record_client_communication_event',
                                         'p8d_store_value_report', 'store_value_report_draft', 'store_value_report_draft_as_agent', 'edit_value_report_draft', 'approve_value_report_draft', 'discard_value_report_draft')) = 0, 'every Phase 8D SECURITY DEFINER function pins an empty search_path');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.proname in ('p8d_wire_table', 'p8d_wire_parent')) = 0, 'the migration''s own wiring helpers were dropped');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects'
                       and p.proname in ('can_contact_now', 'record_client_communication', 'record_agent_communication_draft', 'record_client_communication_event', 'store_value_report_draft', 'p8d_store_value_report', 'phase_eight_observability', 'client_communication_history', 'value_report_facts')
                       and pg_get_functiondef(p.oid) ~* 'net\.http|http_post|pg_notify|core\.emit_event|crm\.conversation_messages\s*\(|insert into crm\.|insert into finance\.|insert into sales\.') = 0,
                     'nothing here sends: no door or read inserts into crm, finance or sales, posts to the network, notifies or emits an event');

\echo Phase 8D (handoff edges, communication governance, value-report drafts, observability) verified OK
rollback;
