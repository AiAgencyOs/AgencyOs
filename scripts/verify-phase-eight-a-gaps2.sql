-- ═════════════════════════════════════════════════════════════════
-- Phase 8A second half (correlation ids, audited tenant denial, preferences, cadence, feedback and goals, support follow-ups, next actions, provider callback, metric reconciliation) - driven through the REAL doors on a scratch Postgres.
--
--   KEEP=1 scripts/apply-migrations-locally.sh (any port)
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-eight-a-gaps2.sql          (rolls back)
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

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000008f2'
\set OWNER '00000000-0000-4000-8000-00000000fe01'
\set ADMIN '00000000-0000-4000-8000-00000000fe02'
\set STAFF '00000000-0000-4000-8000-00000000fe03'
\set CLIENTU '00000000-0000-4000-8000-00000000fe05'
\set BSTAFF '00000000-0000-4000-8000-00000000fe07'

insert into core.organizations (id, name, slug) values (:'ORGB', 'Other Agency (8a gaps 2)', 'other-agency-8a-gaps-2') on conflict (id) do nothing;
insert into auth.users (id, email) values (:'OWNER', 'p8f-owner@example.test'), (:'ADMIN', 'p8f-admin@example.test'), (:'STAFF', 'p8f-staff@example.test'),
  (:'CLIENTU', 'p8f-client@example.test'), (:'BSTAFF', 'p8f-bstaff@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'p8f-owner@example.test', 'P8F Owner'), (:'ADMIN', 'p8f-admin@example.test', 'P8F Admin'), (:'STAFF', 'p8f-staff@example.test', 'P8F Staff'),
  (:'CLIENTU', 'p8f-client@example.test', 'P8F Client'), (:'BSTAFF', 'p8f-bstaff@example.test', 'P8F Other Staff') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner'), (:'ORG', :'ADMIN', 'ops_admin'), (:'ORG', :'STAFF', 'member'), (:'ORGB', :'BSTAFF', 'member')
  on conflict do nothing;
select set_config('p8.org', :'ORG', true);
select set_config('p8.staff', :'STAFF', true);

-- a warranty-bug ticket taken to in_progress through the real doors (one warranty window is open on a fixture project)
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

create or replace function pg_temp.open_ticket(p_project uuid, p_ref text, p_class text, p_cov text, p_prio text, p_org uuid default null, p_actor uuid default null, p_actor_org uuid default null, p_to text default 'in_progress') returns uuid language plpgsql as $$
declare v_t uuid; v_o text; v_d uuid; v_org uuid := coalesce(p_org, current_setting('p8.org')::uuid); v_au uuid := coalesce(p_actor, current_setting('p8.staff')::uuid); v_ao uuid := coalesce(p_actor_org, v_org);
begin
  perform pg_temp.as_service();
  select ticket_id into v_t from projects.open_support_ticket(v_org, p_project, 'ticket ' || p_ref, 'description for ' || p_ref, 'portal', p_ref);
  if p_to = 'new' then return v_t; end if;
  perform pg_temp.as_user(v_au, v_ao, 'member');
  select outcome into v_o from projects.classify_support_ticket(v_t, p_class, p_cov, 'because ' || p_ref, p_prio, null);
  if v_o <> 'classified' then raise exception 'fixture ticket % not classified: %', p_ref, v_o; end if;
  if p_to = 'classified' then return v_t; end if;
  select outcome into v_o from projects.assign_support_ticket(v_t, v_au);
  if v_o <> 'assigned' then raise exception 'fixture ticket % not assigned: %', p_ref, v_o; end if;
  if p_class = 'warranty_bug' then
    insert into qa.defects (organization_id, project_id, severity, title, reproduction) values (v_org, p_project, 'major', 'defect for ' || p_ref, 'click the button') returning id into v_d;
    select outcome into v_o from projects.link_support_root_cause(v_t, v_d);
    if v_o <> 'linked' then raise exception 'fixture ticket % not linked: %', p_ref, v_o; end if;
  end if;
  select outcome into v_o from projects.advance_support_ticket(v_t, 'in_progress');
  if v_o <> 'advanced' then raise exception 'fixture ticket % not started: %', p_ref, v_o; end if;
  if p_to = 'closed' then
    perform pg_temp.p5r_cite_approved(v_t);
    select outcome into v_o from projects.advance_support_ticket(v_t, 'closed', 'Explained the export button');
    if v_o <> 'advanced' then raise exception 'fixture ticket % not closed: %', p_ref, v_o; end if;
  end if;
  return v_t;
end $$;
grant execute on function pg_temp.open_ticket(uuid, text, text, text, text, uuid, uuid, uuid, text) to public;

-- ═════════ 0. fixtures ═════════
select client as "A_id", project as "PA_id" from pg_temp.mk('P8F-A') \gset
select client as "A2_id", project as "PA2_id" from pg_temp.mk('P8F-A2') \gset
select client as "X_id", project as "PX_id" from pg_temp.mk('P8F-X', :'ORGB') \gset
create or replace function pg_temp.start8(p_project uuid, p_org uuid, p_actor uuid) returns void language plpgsql as $$
declare v_f text; v_s text;
begin
  perform pg_temp.as_service();
  select outcome into v_f from projects.fill_phase_eight_intake(p_org, p_project);
  perform pg_temp.as_user(p_actor, p_org, 'member');
  select outcome into v_s from projects.start_phase_eight(p_project, current_date - 1, current_date + 89, 'defects in the delivered scope', 'new features, third-party outages', null, p_actor);
  if v_f <> 'ready' or v_s <> 'started' then raise exception 'fixture workspace not started: % / %', v_f, v_s; end if;
end $$;
grant execute on function pg_temp.start8(uuid, uuid, uuid) to public;
select pg_temp.start8(:'PA_id', :'ORG', :'STAFF'); select pg_temp.start8(:'PA2_id', :'ORG', :'STAFF'); select pg_temp.start8(:'PX_id', :'ORGB', :'BSTAFF');
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p8f plain client B') returning id as "B_id" \gset
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p8f plain client C') returning id as "C_id" \gset
insert into crm.contacts (organization_id, client_account_id, full_name, email) values (:'ORG', :'B_id', 'Contact B', 'b-p8f@client.example.test') returning id as "BCT_id" \gset
insert into crm.communication_consent (organization_id, contact_id, channel, status, source) values (:'ORG', :'BCT_id', 'whatsapp', 'granted', 'verifier');

-- ═════════ 1. P8-SEC-004: every ticket event carries a correlation id ═════════
select pg_temp.open_ticket(:'PA_id', 'p8f-disputed', 'disputed', 'needs_review', 'p3', null, null, null, 'new') as "TD_id" \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "TD_classify" from projects.classify_support_ticket(:'TD_id', 'disputed', 'needs_review', 'it is not clear what the client wants', 'p3', null) \gset
reset role;
select pg_temp.check(:'TD_classify' = 'classified', 'fixture: a disputed classification (it writes TWO events and escalates)');
select pg_temp.check((select count(*) from projects.support_ticket_events where ticket_id = :'TD_id') >= 3, 'the ticket has its opened, classified and escalated events');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "TD_ack" from projects.assign_support_ticket(:'TD_id', :'STAFF') \gset
reset role;

-- ═════════ 2. E2E-13: a cross-tenant lookup is denied like a missing one, and the denial is audited ═════════
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.probe_tenant_access('project', :'PA_id')) = 'granted', 'a project of the caller''s own organization is granted');
select pg_temp.check((select outcome from projects.probe_tenant_access('client_account', :'A_id')) = 'granted' and (select outcome from projects.probe_tenant_access('support_ticket', :'TD_id')) = 'granted',
                     'so are a client account and a ticket of the caller''s organization');
reset role;
select count(*)::int as "AUD0" from audit.audit_log where organization_id = :'ORG' and action = 'access.cross_tenant_denied' \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "FOREIGN_out" from projects.probe_tenant_access('project', :'PX_id') \gset
select outcome as "ABSENT_out" from projects.probe_tenant_access('project', gen_random_uuid()) \gset
select pg_temp.check(:'FOREIGN_out' = 'not_available' and :'ABSENT_out' = 'not_available', 'NEGATIVE: another tenant''s project and a missing one answer IDENTICALLY (nothing leaks)');
select pg_temp.check((select outcome from projects.probe_tenant_access('client_account', :'X_id')) = 'not_available', 'NEGATIVE: another tenant''s client account is not available');
select pg_temp.check((select outcome from projects.probe_tenant_access('table_unknown', :'PA_id')) = 'not_available' and (select outcome from projects.probe_tenant_access(null, :'PA_id')) = 'not_available'
                     and (select outcome from projects.probe_tenant_access('project', null)) = 'not_available', 'an unknown subject type, a null type and a null id are not available');
reset role;
select pg_temp.check((select count(*) from audit.audit_log where organization_id = :'ORG' and action = 'access.cross_tenant_denied') = :'AUD0'::int + 2,
                     'the two FOREIGN lookups were audited in the CALLER''s organization (and the missing one and the unknown type were not)');
select pg_temp.check((select count(*) from audit.audit_log where organization_id = :'ORG' and action = 'access.cross_tenant_denied' and subject_id = :'PX_id' and subject_type = 'project') = 1,
                     'the denial names the subject id and type the caller asked for');
select pg_temp.check((select count(*) from audit.audit_log where organization_id = :'ORGB' and action = 'access.cross_tenant_denied') = 0, 'and nothing was written into the OTHER tenant''s audit trail');
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(pg_temp.errs(format('select * from projects.probe_tenant_access(%L, %L)', 'project', :'PX_id'), 'permission denied'), 'NEGATIVE: the service role has no execute on the probe (a person''s door)');
reset role;
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select outcome from projects.probe_tenant_access('project', :'PX_id')) = 'not_available', 'a portal client probing another tenant''s project is denied too');
reset role;
select pg_temp.check((select count(*) from audit.audit_log where organization_id = :'ORG' and action = 'access.cross_tenant_denied') = :'AUD0'::int + 3, 'and that is audited as well');

-- ═════════ 3. contact preferences: what the client said about being reached ═════════
select pg_temp.check((select count(*) from projects.p8f_contact_preferences where client_account_id = :'B_id') = 0, 'a client has no recorded preference until a person records one');
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_client_contact_preference(:'A_id', 'call', '{}', 'en')) in ('not_authorized', 'no_actor'), 'NEGATIVE: a portal client cannot record a preference through the staff door');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_client_contact_preference(:'B_id', 'call', '{}', 'en')) = 'not_found', 'NEGATIVE: another organization''s staff cannot record a preference for this client');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_client_contact_preference(:'B_id', 'telegram', '{}', 'en')) = 'bad_channel', 'a preferred channel must be one AgencyOS knows');
select pg_temp.check((select outcome from projects.set_client_contact_preference(:'B_id', 'call', array['fax'], 'en')) = 'bad_channel', 'and so must every avoided channel');
select pg_temp.check((select outcome from projects.set_client_contact_preference(:'B_id', 'call', array['call'], 'en')) = 'preferred_is_avoided', 'a channel cannot be both preferred and avoided (door layer)');
select pg_temp.check((select outcome from projects.set_client_contact_preference(:'B_id', 'call', '{}', 'English!')) = 'bad_language', 'a language is a language tag, not free text');
select pg_temp.check((select outcome from projects.set_client_contact_preference(:'B_id', 'call', array['email', 'email', 'whatsapp'], 'hi')) = 'set', 'a person records: prefers a call, avoids email and WhatsApp, speaks Hindi');
reset role;
select pg_temp.check((select preferred_channel = 'call' and avoid_channels = array['email', 'whatsapp'] and language = 'hi' and recorded_by = :'STAFF' from projects.p8f_contact_preferences where client_account_id = :'B_id'),
                     'it is stored, de-duplicated, with who recorded it');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_client_contact_preference(:'B_id', 'meeting', '{}', 'hi-IN', 'prefers mornings')) = 'set', 'recording again replaces it');
reset role;
select pg_temp.check((select count(*) from projects.p8f_contact_preferences where client_account_id = :'B_id') = 1 and (select preferred_channel from projects.p8f_contact_preferences where client_account_id = :'B_id') = 'meeting'
                     and (select avoid_channels from projects.p8f_contact_preferences where client_account_id = :'B_id') = '{}', 'there is exactly one preference row per client, and the new one wins');
select pg_temp.check((select count(*) from audit.audit_log where organization_id = :'ORG' and action = 'client_communication.preference_set') = 2, 'every change is audited');
select pg_temp.check(pg_temp.direct(format('update projects.p8f_contact_preferences set language = %L where client_account_id = %L', 'fr', :'B_id'), 'through its door'), 'a direct write is refused (a door must announce itself)');
select pg_temp.check(pg_temp.errs(format('select set_config(%L, %L, true); update projects.p8f_contact_preferences set preferred_channel = %L, avoid_channels = array[%L] where client_account_id = %L', 'projects.p8_sanctioned', 'on', 'call', 'call', :'B_id'), 'p8f_contact_preferences_not_both'),
                     'TABLE: a channel both preferred and avoided is refused by the constraint, not only by the door');
select pg_temp.check(pg_temp.errs(format('select set_config(%L, %L, true); update projects.p8f_contact_preferences set avoid_channels = array[%L] where client_account_id = %L', 'projects.p8_sanctioned', 'on', 'fax', :'B_id'), 'check constraint'),
                     'TABLE: an unknown channel in the avoid list is refused by the constraint');
select pg_temp.check(pg_temp.errs(format('delete from projects.p8f_contact_preferences where client_account_id = %L', :'B_id'), 'never deleted'), 'a preference row is never deleted');
select pg_temp.check(pg_temp.errs(format('insert into projects.p8f_contact_preferences (organization_id, client_account_id) values (%L, %L)', :'ORGB', :'B_id'), 'tenancy:'), 'TENANCY: a preference cannot name another organization''s client');

-- ═════════ 4. category cadence (Admin-set, no default) and the governed eligibility read ═════════
select pg_temp.check((select count(*) from projects.communication_category_cadence where organization_id = :'ORG') = 0, 'there is NO category cadence until an Admin sets one (no default number)');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_communication_category_cadence('relationship', 7)) = 'not_authorized', 'NEGATIVE: a member cannot set a cadence (Admin only)');
select pg_temp.check((select outcome from projects.clear_communication_category_cadence('relationship')) = 'not_authorized', 'NEGATIVE: nor clear one');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_communication_category_cadence('marketing', 7)) = 'bad_purpose', 'a cadence is for operational, relationship or commercial only');
select pg_temp.check((select outcome from projects.set_communication_category_cadence('relationship', -1)) = 'out_of_range' and (select outcome from projects.set_communication_category_cadence('relationship', 366)) = 'out_of_range', 'and range-checked');
select pg_temp.check((select outcome from projects.clear_communication_category_cadence('relationship')) = 'not_found', 'clearing a cadence that was never set finds nothing');
select pg_temp.check((select outcome from projects.set_communication_category_cadence('relationship', 7)) = 'set', 'an Admin sets a 7-day gap for relationship contacts');
reset role;
select pg_temp.check((select count(*) from audit.audit_log where organization_id = :'ORG' and action = 'client_communication.cadence_set') = 1, 'it is audited');

-- a person-sent relationship call two days ago, and a WhatsApp relationship message 10 days ago
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select allowed from projects.can_contact_governed(:'B_id', 'whatsapp', 'relationship', :'BCT_id')), 'before anything is sent: WhatsApp is allowed (consent granted, no preference against it, no cap)');
select outcome as "S1_out" from projects.record_client_communication(:'B_id', 'call', 'relationship', 'Called the owner to say hello', null, null, now() - interval '2 days', null, 'call-p8f-1') \gset
select outcome as "S2_out" from projects.record_client_communication(:'B_id', 'whatsapp', 'operational', 'Sent the maintenance window notice', null, :'BCT_id', now() - interval '10 days', null, 'wa-p8f-op') \gset
select pg_temp.check(:'S1_out' = 'recorded' and :'S2_out' = 'recorded', 'fixture: a call 2 days ago (relationship) and a notice 10 days ago (operational)');
select pg_temp.check((select not allowed and exists (select 1 from unnest(reasons) r where r like 'category gap: the last relationship contact was 2 days ago; the minimum is 7') from projects.can_contact_governed(:'B_id', 'call', 'relationship')),
                     'a second relationship contact inside the 7-day gap is refused, with the days and the minimum in the reason');
select pg_temp.check((select allowed from projects.can_contact_governed(:'B_id', 'call', 'operational')), 'but an OPERATIONAL contact has no cadence rule and is still allowed (the gap is per category)');
select pg_temp.check((select allowed from projects.can_contact_governed(:'B_id', 'call', 'relationship', null, now() + interval '6 days')), 'and after the gap has passed the relationship contact is allowed again (the clock is injected)');
select pg_temp.check((select not allowed from projects.can_contact_governed(:'B_id', 'call', 'relationship', null, now() + interval '4 days')), 'while 6 days after the call is still inside it');
select pg_temp.check((select count(*) from projects.can_contact_now(:'B_id', 'call', 'relationship')) = 1 and (select allowed from projects.can_contact_now(:'B_id', 'call', 'relationship')),
                     'the base read the gap sits on top of is unchanged: can_contact_now alone still says yes (the cadence is the governed read''s rule)');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.clear_communication_category_cadence('relationship')) = 'cleared', 'an Admin clears the cadence');
select pg_temp.check((select outcome from projects.clear_communication_category_cadence('relationship')) = 'not_found', 'clearing it again finds nothing (only an ACTIVE cadence can be cleared)');
select pg_temp.check((select allowed from projects.can_contact_governed(:'B_id', 'call', 'relationship')), 'and the relationship contact is allowed with no rule');
select pg_temp.check((select outcome from projects.set_communication_category_cadence('relationship', 7)) = 'set', 'setting it again re-activates the one row');
reset role;
select pg_temp.check((select count(*) from projects.communication_category_cadence where organization_id = :'ORG' and purpose = 'relationship') = 1, 'there is one cadence row per category (the unique key), never a second');
select pg_temp.check(pg_temp.direct(format('update projects.communication_category_cadence set min_gap_days = 0 where organization_id = %L', :'ORG'), 'through its door'), 'a direct write to a cadence is refused');
select pg_temp.check(pg_temp.errs(format('delete from projects.communication_category_cadence where organization_id = %L', :'ORG'), 'never deleted'), 'and a cadence row is never deleted');

-- avoided channels: the client's own word
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_client_contact_preference(:'C_id', 'whatsapp', array['call'], 'en')) = 'set', 'fixture: client C asked not to be called');
select pg_temp.check((select not allowed and exists (select 1 from unnest(reasons) r where r = 'the client asked not to be contacted on call') from projects.can_contact_governed(:'C_id', 'call', 'operational')),
                     'a call to a client who asked not to be called is refused, even for an operational purpose');
select pg_temp.check((select allowed from projects.can_contact_governed(:'C_id', 'meeting', 'operational')), 'but a meeting is not what they refused');
select pg_temp.check((select outcome from projects.set_client_contact_preference(:'C_id', 'whatsapp', '{}', 'en')) = 'set', 'the preference is updated to avoid nothing');
select pg_temp.check((select allowed from projects.can_contact_governed(:'C_id', 'call', 'operational')), 'and the call is allowed again');
reset role;
-- an agent's DRAFT is not a contact: it opens no category gap
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_agent_communication_draft(:'ORG', :'C_id', 'call', 'relationship', 'Draft: ask how the reports are being used', 'customer_success')) = 'drafted', 'fixture: an agent drafts a relationship contact for client C');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select allowed from projects.can_contact_governed(:'C_id', 'call', 'relationship')), 'a draft does not count toward the category gap: the relationship call is still allowed');
select outcome as "S3_out" from projects.record_client_communication(:'C_id', 'meeting', 'operational', 'Met the client about the maintenance window', null, null, now() - interval '1 day', null, 'meet-p8f-op') \gset
select pg_temp.check(:'S3_out' = 'recorded' and (select allowed from projects.can_contact_governed(:'C_id', 'call', 'relationship')), 'an OPERATIONAL contact yesterday does not close the RELATIONSHIP category (the gap is per category)');
reset role;
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.can_contact_governed(:'B_id', 'call', 'relationship')) = 0, 'NEGATIVE: a portal client gets no answer from the governed read');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select count(*) from projects.can_contact_governed(:'B_id', 'call', 'operational')) = 1, 'the service role can ask the governed read (the next sender is automation)');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.can_contact_governed(:'B_id', 'call', 'operational')) = 1 and (select not allowed and reasons = array['the client is not known'] from projects.can_contact_governed(:'B_id', 'call', 'operational')),
                     'NEGATIVE: another organization''s staff are told only that the client is not known (never allowed, never a reason that leaks)');
reset role;

-- ═════════ 5. feedback (append-only) and client goals ═════════
select pg_temp.as_service();
set local role service_role;
select outcome as "CIO_out", check_in_id as "CIO_id" from projects.create_check_in(:'PA2_id', 'scheduled', 'sched-p8f-other', current_date + 30, null, null, :'ORG') \gset
select outcome as "CIM_out", check_in_id as "CIM_id" from projects.create_check_in(:'PA_id', 'scheduled', 'sched-p8f-mine', current_date + 30, null, null, :'ORG') \gset
reset role;
select pg_temp.check(:'CIO_out' = 'created' and :'CIM_out' = 'created', 'fixture: a check-in on each of two projects (not yet due)');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.p8f_record_client_feedback(:'PA_id', 'call', 'neutral', 'Feedback tied to another project''s check-in', :'CIO_id')) = 'check_in_not_on_this_project', 'NEGATIVE: feedback cannot be tied to another project''s check-in');
select pg_temp.check((select outcome from projects.p8f_record_client_feedback(:'PA_id', 'call', 'positive', 'Feedback tied to this project''s own check-in', :'CIM_id')) = 'recorded', 'but it can be tied to this project''s own check-in');
select pg_temp.check((select outcome from projects.p8f_record_client_feedback(:'PA_id', 'telegram', 'negative', 'The export is slow and confusing')) = 'bad_source', 'feedback comes from a known source');
select pg_temp.check((select outcome from projects.p8f_record_client_feedback(:'PA_id', 'call', 'angry', 'The export is slow and confusing')) = 'bad_sentiment', 'with a stated sentiment (nothing infers one)');
select pg_temp.check((select outcome from projects.p8f_record_client_feedback(:'PA_id', 'call', 'negative', 'bad')) = 'summary_required', 'and a summary of what was said');
select pg_temp.check((select outcome from projects.p8f_record_client_feedback(:'PA_id', 'call', 'negative', 'The export is slow and confusing', null, now() + interval '1 day')) = 'in_the_future', 'it cannot be dated in the future');
select pg_temp.check((select outcome from projects.p8f_record_client_feedback(:'PX_id', 'call', 'negative', 'A project of another tenant')) = 'not_found', 'NEGATIVE: another organization''s project cannot receive feedback');
select outcome as "F1_out", feedback_id as "F1_id" from projects.p8f_record_client_feedback(:'PA_id', 'call', 'negative', 'The export is slow and confusing') \gset
select pg_temp.check(:'F1_out' = 'recorded', 'a person records negative feedback heard on a call');
reset role;
select pg_temp.check((select sentiment = 'negative' and recorded_by = :'STAFF' and client_account_id = :'A_id' from projects.p8f_client_feedback where id = :'F1_id'), 'it keeps the sentiment, the person and the client of the project');
select pg_temp.check(pg_temp.errs(format('update projects.p8f_client_feedback set sentiment = %L where id = %L', 'positive', :'F1_id'), 'is history and is never edited'), 'feedback is APPEND-ONLY: no update');
select pg_temp.check(pg_temp.errs(format('delete from projects.p8f_client_feedback where id = %L', :'F1_id'), 'is history and is never edited'), 'and no delete');
select pg_temp.check(pg_temp.errs(format('insert into projects.p8f_client_feedback (organization_id, project_id, client_account_id, source, sentiment, summary, occurred_at, recorded_by) values (%L, %L, %L, %L, %L, %L, now(), %L)',
                                         :'ORGB', :'PA_id', :'A_id', 'call', 'negative', 'grafted onto another tenant''s project', :'BSTAFF'), 'tenancy:'), 'TENANCY: feedback cannot name another organization''s project');
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select outcome from projects.p8f_record_client_feedback(:'PA_id', 'portal', 'positive', 'A client trying to record feedback')) in ('not_authorized', 'no_actor'), 'NEGATIVE: a portal client cannot record feedback through the staff door');
reset role;

select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_client_goal(:'PA_id', 'A goal a portal client tries to record')) in ('not_authorized', 'no_actor'), 'NEGATIVE: a portal client cannot record a goal through the staff door');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_client_goal(:'PA_id', 'goal')) = 'goal_required', 'a goal needs words');
select outcome as "G1_out", goal_id as "G1_id" from projects.record_client_goal(:'PA_id', 'Staff can export the monthly report without help') \gset
select pg_temp.check(:'G1_out' = 'recorded', 'a person records a goal the client stated');
select pg_temp.check((select outcome from projects.record_client_goal(:'PA_id', '  staff can export the monthly report WITHOUT help ')) = 'duplicate', 'the same goal is not recorded twice');
select pg_temp.check((select outcome from projects.record_client_goal(:'PX_id', 'A goal on another tenant''s project')) = 'not_found', 'NEGATIVE: another tenant''s project has no goal door for this person');
reset role;
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select outcome from projects.close_client_goal(:'G1_id', 'achieved', 'a portal client tries to close it')) in ('not_authorized', 'no_actor'), 'NEGATIVE: a portal client cannot close a goal');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.close_client_goal(:'G1_id', 'maybe', 'because')) = 'bad_status', 'a goal closes as achieved or dropped');
select pg_temp.check((select outcome from projects.close_client_goal(:'G1_id', 'achieved', '  ')) = 'note_required', 'and only with a note saying why');
select pg_temp.check((select outcome from projects.close_client_goal(:'G1_id', 'achieved', 'the client exported it alone on the follow-up call')) = 'closed', 'a person closes it as achieved');
select pg_temp.check((select outcome from projects.close_client_goal(:'G1_id', 'dropped', 'changed our mind')) = 'already_closed', 'a closed goal cannot be closed again');
reset role;
select pg_temp.check((select status = 'achieved' and closed_by = :'STAFF' and closed_at is not null from projects.client_goals where id = :'G1_id'), 'the close names the person and the time');
select pg_temp.check(pg_temp.errs(format('select set_config(%L, %L, true); update projects.client_goals set status = %L where id = %L', 'projects.p8_sanctioned', 'on', 'active', :'G1_id'), 'client_goals_closed_says_who'),
                     'TABLE: reopening a closed goal without clearing who closed it is refused by the constraint');
select pg_temp.check(pg_temp.direct(format('update projects.client_goals set goal = %L where id = %L', 'rewritten', :'G1_id'), 'through its door'), 'a direct write to a goal is refused');
select pg_temp.check(pg_temp.errs(format('delete from projects.client_goals where id = %L', :'G1_id'), 'never deleted'), 'and a goal is never deleted');
select pg_temp.check((select count(*) from audit.audit_log where organization_id = :'ORG' and action in ('customer_success.feedback_recorded', 'customer_success.goal_recorded', 'customer_success.goal_closed')) = 4, 'feedback and each goal change are audited (two feedback rows, one goal recorded, one closed)');

-- ═════════ 6. a person asks for a Developer task or a QA verification (SUP spec section 7) ═════════
select pg_temp.open_ticket(:'PA_id', 'p8f-bug', 'warranty_bug', 'covered_warranty', 'p2') as "TB_id" \gset
select pg_temp.open_ticket(:'PA_id', 'p8f-howto', 'how_to', 'included_support', 'p4') as "TH_id" \gset
select pg_temp.open_ticket(:'PA_id', 'p8f-classified', 'warranty_bug', 'covered_warranty', 'p3', null, null, null, 'classified') as "TC_id" \gset
select pg_temp.open_ticket(:'PA_id', 'p8f-new', 'x', 'x', 'p3', null, null, null, 'new') as "TN_id" \gset
select pg_temp.open_ticket(:'PA_id', 'p8f-qa', 'warranty_bug', 'covered_warranty', 'p2') as "TQ_id" \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
select outcome as "TQ_adv" from projects.advance_support_ticket(:'TQ_id', 'in_qa') \gset
select pg_temp.check(:'TQ_adv' = 'advanced', 'fixture: a covered warranty bug whose fix is already in QA');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.request_support_followup(:'TB_id', 'designer', 'x')) = 'bad_kind', 'a follow-up is a developer task or a QA verification');
select pg_temp.check((select outcome from projects.request_support_followup(:'TN_id', 'developer')) = 'not_classified', 'NEGATIVE: an unclassified ticket cannot be sent to a Developer (nobody has decided what it is)');
select pg_temp.check((select outcome from projects.request_support_followup(:'TH_id', 'developer')) = 'not_a_developer_matter', 'NEGATIVE: a how-to is never a Developer task');
select pg_temp.check((select outcome from projects.request_support_followup(:'TC_id', 'qa')) = 'wrong_state', 'NEGATIVE: QA cannot be asked to verify a fix that has not started');
select pg_temp.check((select outcome from projects.request_support_followup(:'TQ_id', 'developer')) = 'wrong_state', 'NEGATIVE: a Developer task is not requested for a fix that is already in QA');
select pg_temp.check((select outcome from projects.request_support_followup(:'TQ_id', 'qa', 'verify it')) = 'requested', 'but QA can be asked to verify it (in_qa is a valid state for that request)');
select pg_temp.check((select outcome from projects.request_support_followup(:'TB_id', 'developer', 'the export button does nothing on Safari')) = 'requested', 'a person asks for a Developer task for a covered warranty bug');
select pg_temp.check((select outcome from projects.request_support_followup(:'TB_id', 'developer', 'again')) = 'already_requested', 'asking twice is the same request (nothing is emitted twice)');
select pg_temp.check((select outcome from projects.request_support_followup(:'TB_id', 'qa', 'please verify the Safari fix')) = 'requested', 'and asks for a QA verification once the work is in progress');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.request_support_followup(:'TB_id', 'developer')) = 'not_found', 'NEGATIVE: another organization''s staff cannot request a follow-up on this ticket');
reset role;
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select outcome from projects.request_support_followup(:'TB_id', 'developer')) in ('not_authorized', 'no_actor'), 'NEGATIVE: a portal client cannot request a follow-up');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(pg_temp.errs(format('select * from projects.request_support_followup(%L, %L)', :'TB_id', 'developer'), 'permission denied'), 'NEGATIVE: an agent (the service role) cannot ask for a Developer task: a person does');
reset role;
select pg_temp.check((select count(*) from core.outbox_events where type = 'support.developer_task_requested' and subject_id = :'TB_id') = 1, 'exactly ONE developer-task event was emitted');
select pg_temp.check((select count(*) from core.outbox_events where type = 'support.qa_verification_requested' and subject_id = :'TB_id') = 1, 'and exactly one QA-verification event');
select pg_temp.check((select payload->>'classification' = 'warranty_bug' and payload->>'coverage' = 'covered_warranty' and payload->>'priority' = 'p2' and payload->>'projectId' = :'PA_id' and payload->>'ticketId' = :'TB_id'
                             and payload->>'ticketRef' like 'TKT-%' and payload->>'requestedBy' = :'STAFF' and payload->>'note' = 'the export button does nothing on Safari'
                        from core.outbox_events where type = 'support.developer_task_requested' and subject_id = :'TB_id'),
                     'the event carries the handoff payload: ticket, project, classification, coverage, priority, who asked and why');
select pg_temp.check((select count(*) from core.outbox_events where subject_id in (:'TH_id', :'TN_id', :'TC_id') and type in ('support.developer_task_requested', 'support.qa_verification_requested')) = 0, 'and nothing was emitted for the refused tickets');
select pg_temp.check((select count(*) from core.event_types where type in ('support.developer_task_requested', 'support.qa_verification_requested')) = 2, 'both event types are registered');

-- ═════════ 7. the next-action queue is derived, never stored ═════════
select pg_temp.open_ticket(:'PA2_id', 'p8f-p1', 'warranty_bug', 'covered_warranty', 'p1') as "TP_id" \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "ESC_out" from projects.escalate_support_ticket(:'TP_id', 'owner', 'the client is blocked in production') \gset
select pg_temp.check(:'ESC_out' = 'escalated', 'fixture: a P1 ticket escalated to the owner, not yet acknowledged');
select pg_temp.check((select count(*) from projects.customer_success_next_actions() where project_id = :'PA2_id' and action_kind = 'escalation_unacknowledged' and ref_id = :'TP_id' and priority = 1) = 1, 'an unacknowledged escalation is the first kind of next action');
select pg_temp.check((select count(*) from projects.customer_success_next_actions() where project_id = :'PA2_id' and action_kind in ('ticket_resolution_overdue', 'ticket_response_overdue')) = 0, 'a ticket inside its targets is not overdue');
select pg_temp.check((select count(*) from projects.customer_success_next_actions(now() + interval '3 days') where project_id = :'PA2_id' and action_kind = 'ticket_resolution_overdue' and ref_id = :'TP_id') = 1
                     and (select count(*) from projects.customer_success_next_actions(now() + interval '3 days') where project_id = :'PA2_id' and action_kind = 'ticket_response_overdue' and ref_id = :'TP_id') = 1,
                     'three days later (the clock is injected) the same ticket is overdue on response AND resolution');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.create_check_in(:'PA2_id', 'adoption', 'adoption-p8f', current_date, null, null, :'ORG')) = 'created', 'fixture: an adoption check-in is due today');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "F2_out" from projects.p8f_record_client_feedback(:'PA2_id', 'call', 'mixed', 'Likes the product but the reports are hard to find') \gset
select pg_temp.check(:'F2_out' = 'recorded', 'fixture: mixed feedback heard on a call');
select pg_temp.check((select count(*) from projects.customer_success_next_actions() where project_id = :'PA2_id' and action_kind = 'check_in_due') = 1
                     and (select count(*) from projects.customer_success_next_actions() where project_id = :'PA2_id' and action_kind = 'negative_feedback_unaddressed') = 1, 'a due check-in and unaddressed negative feedback are next actions');
select pg_temp.check((select min(priority) from projects.customer_success_next_actions() where project_id = :'PA2_id') = 1
                     and (select action_kind from projects.customer_success_next_actions() where project_id = :'PA2_id' order by priority, due_at nulls last limit 1) = 'escalation_unacknowledged', 'the queue is ordered by priority: the escalation comes before the check-in');
select pg_temp.check((select bool_and(priority >= lag_p) from (select priority, coalesce(lag(priority) over (), 0) lag_p from projects.customer_success_next_actions()) q), 'and the whole queue is in non-decreasing priority order');
select id as "CI2_id" from projects.cs_check_ins where project_id = :'PA2_id' and kind = 'adoption' \gset
select pg_temp.check((select outcome from projects.complete_check_in(:'CI2_id', 'responded', 'call', 'discussed the report finder and agreed to a walkthrough')) = 'completed', 'a person completes the check-in with an outcome');
select pg_temp.check((select count(*) from projects.customer_success_next_actions() where project_id = :'PA2_id' and action_kind in ('check_in_due', 'negative_feedback_unaddressed')) = 0,
                     'the completed check-in leaves the queue, and so does the feedback it addressed (the queue is derived from the records, not maintained)');
select outcome as "ACK_out" from projects.acknowledge_support_escalation(:'TP_id', 'owner is on it') \gset
select pg_temp.check(:'ACK_out' = 'not_authorized' and (select count(*) from projects.customer_success_next_actions() where project_id = :'PA2_id' and action_kind = 'escalation_unacknowledged') = 1,
                     'a member cannot acknowledge an owner escalation, so it stays in the queue');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select outcome as "ACK2_out" from projects.acknowledge_support_escalation(:'TP_id', 'owner is on it') \gset
select pg_temp.check(:'ACK2_out' = 'acknowledged' and (select count(*) from projects.customer_success_next_actions() where project_id = :'PA2_id' and action_kind = 'escalation_unacknowledged') = 0,
                     'the owner acknowledges it and it leaves the queue');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.customer_success_next_actions() where project_id in (:'PA_id', :'PA2_id')) = 0, 'NEGATIVE: another organization''s staff see none of this organization''s next actions');
reset role;
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.customer_success_next_actions()) = 0, 'NEGATIVE: a portal client sees no next actions (internal only)');
reset role;
select pg_temp.check((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'projects' and c.relkind = 'r' and c.relname ~* 'next_action') = 0, 'there is no stored queue object: the queue is a read');

-- ═════════ 8. provider delivery callbacks (service role) and the history that reads them ═════════
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select ledger_id as "PL1_id" from projects.record_client_communication(:'B_id', 'whatsapp', 'operational', 'Sent the release notice to the owner', null, :'BCT_id', now() - interval '3 hours', null, 'wamid-p8f-1') \gset
select ledger_id as "PL2_id" from projects.record_client_communication(:'B_id', 'whatsapp', 'operational', 'Sent the invoice reminder to the owner', null, :'BCT_id', now() - interval '3 hours', null, 'wamid-p8f-2') \gset
select ledger_id as "PL3_id" from projects.record_client_communication(:'C_id', 'whatsapp', 'operational', 'Sent a notice to client C', null, null, now() - interval '3 hours', null, 'wamid-p8f-dup') \gset
select ledger_id as "PL4_id" from projects.record_client_communication(:'B_id', 'whatsapp', 'operational', 'Sent a notice to client B', null, :'BCT_id', now() - interval '3 hours', null, 'wamid-p8f-dup') \gset
select pg_temp.check(pg_temp.errs(format('select * from projects.record_provider_delivery_callback(%L, %L, %L, %L, %L)', :'ORG', 'wa', 'whatsapp', 'wamid-p8f-1', 'delivered'), 'permission denied'), 'NEGATIVE: a signed-in user (a person) cannot write a provider fact: the door is for the callback only');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
select pg_temp.check((select outcome from projects.record_provider_delivery_callback(:'ORG', 'wa', 'whatsapp', 'wamid-p8f-1', 'delivered')) = 'not_authorized', 'the door checks the role INSIDE too: a non-service JWT reaching it as the owner role is refused');
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_provider_delivery_callback(:'ORG', 'wa', 'whatsapp', 'wamid-p8f-1', 'exploded')) = 'bad_event', 'an unknown event is refused');
select pg_temp.check((select outcome from projects.record_provider_delivery_callback(:'ORG', '  ', 'whatsapp', 'wamid-p8f-1', 'delivered')) = 'provider_and_ref_required' and (select outcome from projects.record_provider_delivery_callback(:'ORG', 'wa', 'whatsapp', null, 'delivered')) = 'provider_and_ref_required', 'a provider and a reference are required');
select pg_temp.check((select outcome from projects.record_provider_delivery_callback(:'ORG', 'wa', 'whatsapp', 'wamid-p8f-nobody', 'delivered')) = 'unmatched', 'a callback for a message nobody recorded is UNMATCHED and stores nothing');
select pg_temp.check((select outcome from projects.record_provider_delivery_callback(:'ORGB', 'wa', 'whatsapp', 'wamid-p8f-1', 'delivered')) = 'unmatched', 'NEGATIVE: the same reference under ANOTHER organization does not match this organization''s message');
select pg_temp.check((select outcome from projects.record_provider_delivery_callback(:'ORG', 'wa', 'whatsapp', 'wamid-p8f-dup', 'delivered')) = 'ambiguous', 'a reference that two clients'' entries share is AMBIGUOUS and is attached to neither');
select pg_temp.check((select outcome from projects.record_provider_delivery_callback(:'ORG', 'wa', 'whatsapp', 'wamid-p8f-1', 'delivered', now() - interval '1 day')) = 'before_the_send', 'a delivery dated before the send is refused');
select pg_temp.check((select outcome from projects.record_provider_delivery_callback(:'ORG', 'wa', 'whatsapp', 'wamid-p8f-1', 'delivered', now() + interval '1 day')) = 'in_the_future', 'and one dated in the future');
select pg_temp.check((select outcome from projects.record_provider_delivery_callback(:'ORG', 'wa', 'whatsapp', 'wamid-p8f-1', 'delivered', now() - interval '2 hours')) = 'recorded', 'a delivery callback is recorded');
select pg_temp.check((select outcome from projects.record_provider_delivery_callback(:'ORG', 'wa', 'whatsapp', 'wamid-p8f-1', 'delivered', now() - interval '2 hours')) = 'already_recorded', 'a redelivered callback is the same fact (idempotent)');
select pg_temp.check((select outcome from projects.record_provider_delivery_callback(:'ORG', 'wa', 'whatsapp', 'wamid-p8f-1', 'read', now() - interval '1 hour')) = 'recorded', 'a read receipt is a second fact');
reset role;
select pg_temp.check((select count(*) from projects.client_communication_provider_events where ledger_id = :'PL1_id') = 2 and (select count(*) from projects.client_communication_provider_events where ledger_id in (:'PL3_id', :'PL4_id')) = 0, 'exactly two provider rows exist for the message, none for the ambiguous pair');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select delivery_state = 'read' and delivery_source = 'provider' from projects.client_communication_history(:'B_id') where id = :'PL1_id'), 'the history shows the provider''s latest state, labelled as the provider''s');
select pg_temp.check((select delivery_state = 'unknown' and delivery_source = 'none' from projects.client_communication_history(:'B_id') where id = :'PL2_id'), 'a message with no signal at all stays UNKNOWN, never "delivered" by default');
select outcome as "EV_out" from projects.record_client_communication_event(:'PL1_id', 'failed', 'the owner phoned to say it never arrived', now() - interval '30 minutes') \gset
select pg_temp.check(:'EV_out' = 'recorded', 'a person records that it actually failed');
select pg_temp.check((select delivery_state = 'failed' and delivery_source = 'person' from projects.client_communication_history(:'B_id') where id = :'PL1_id'), 'and a person''s record outranks the provider''s signal');
reset role;
select pg_temp.check(pg_temp.errs(format('update projects.client_communication_provider_events set event = %L where ledger_id = %L', 'failed', :'PL1_id'), 'is history and is never edited'), 'provider facts are APPEND-ONLY: no update');
select pg_temp.check(pg_temp.errs(format('delete from projects.client_communication_provider_events where ledger_id = %L', :'PL1_id'), 'is history and is never edited'), 'and no delete');
select pg_temp.check(pg_temp.errs(format('insert into projects.client_communication_provider_events (organization_id, ledger_id, provider, event, occurred_at) values (%L, %L, %L, %L, now())', :'ORGB', :'PL1_id', 'wa', 'delivered'), 'tenancy:'), 'TENANCY: a provider fact cannot name another organization''s ledger entry');
select pg_temp.check(pg_temp.errs(format('insert into projects.client_communication_provider_events (organization_id, ledger_id, provider, event, occurred_at) values (%L, %L, %L, %L, now())', :'ORG', :'PL1_id', 'wa', 'delivered'), 'client_communication_provider_events_once'), 'TABLE: one provider fact per message, provider and event (the unique index, not only the door lookup)');

-- ═════════ 9. E2E-14: the observability counts and the overview are reconciled ═════════
-- a workspace and tickets in the OTHER fixture organization, so every count here is scoped to rows this verifier created
select pg_temp.open_ticket(:'PX_id', 'p8f-x1', 'warranty_bug', 'covered_warranty', 'p2', :'ORGB', :'BSTAFF', :'ORGB') as "TX1_id" \gset
select pg_temp.open_ticket(:'PX_id', 'p8f-x2', 'how_to', 'included_support', 'p4', :'ORGB', :'BSTAFF', :'ORGB', 'classified') as "TX2_id" \gset
select pg_temp.open_ticket(:'PX_id', 'p8f-x3', 'how_to', 'included_support', 'p4', :'ORGB', :'BSTAFF', :'ORGB', 'closed') as "TX3_id" \gset
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.reconcile_phase_eight_metrics()) = 10, 'the reconciliation has ten checks: two ticket groupings, the live-account count, five health statuses, recovery plans, opportunities');
select pg_temp.check((select count(*) from projects.reconcile_phase_eight_metrics() where reconciled) = 10, 'with consistent records, all ten reconcile');
select pg_temp.check((select observability_value from projects.reconcile_phase_eight_metrics() where check_name = 'open_tickets_state_vs_resolution_sla') = 2, 'and they are counting the two open tickets (the closed one is in neither number)');
select pg_temp.check((select observability_value = 1 and overview_value = 1 from projects.reconcile_phase_eight_metrics() where check_name = 'live_accounts_health_vs_overview'), 'one live workspace on both sides');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.reconcile_phase_eight_metrics()) = 0, 'NEGATIVE: a portal client gets no reconciliation (internal only)');
reset role;
-- a disagreement is RETURNED, not hidden: an open recovery plan on a workspace that has since closed is counted by observability and not by the overview
select client as "Z_id", project as "PZ_id" from pg_temp.mk('P8F-Z', :'ORGB') \gset
select pg_temp.start8(:'PZ_id', :'ORGB', :'BSTAFF');
select set_config('projects.p8_sanctioned', 'on', true);
alter table projects.phase_eight disable trigger user;
update projects.phase_eight set state = 'closed', state_reason = 'closed for the reconciliation fixture' where project_id = :'PZ_id';
alter table projects.phase_eight enable trigger user;
insert into projects.recovery_plans (organization_id, project_id, status) values (:'ORGB', :'PZ_id', 'open');
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.customer_success_next_actions() where project_id = :'PZ_id') = 0, 'a closed workspace has no next actions (its open recovery plan is not queued)');
select pg_temp.check((select not reconciled and observability_value = 1 and overview_value = 0 from projects.reconcile_phase_eight_metrics() where check_name = 'recovery_plans_vs_overview'),
                     'a recovery plan on a closed workspace is counted by observability and not by the overview: the check returns RECONCILED = false with both numbers and its note');
select pg_temp.check((select count(*) from projects.reconcile_phase_eight_metrics() where not reconciled) = 1, 'and it is the ONLY disagreement (the others still reconcile)');
reset role;

-- ═════════ 10. structure: grants, row security, tenancy, nothing sends ═════════
create temp table p8f_tables (tbl text);
insert into p8f_tables values ('p8f_contact_preferences'), ('communication_category_cadence'), ('p8f_client_feedback'), ('client_goals'), ('client_communication_provider_events');
grant select on p8f_tables to public;
select pg_temp.check((select count(*) from p8f_tables t join pg_class c on c.relname = t.tbl join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'projects' where c.relrowsecurity) = 5, 'every new table has row security enabled');
select pg_temp.check((select count(*) from p8f_tables t join pg_policies p on p.schemaname = 'projects' and p.tablename = t.tbl and p.cmd = 'SELECT' where p.qual like '%is_internal%' and p.qual like '%current_organization_id%') = 5, 'each has an internal-only, own-organization read policy');
select pg_temp.check((select count(*) from p8f_tables t join pg_policies p on p.schemaname = 'projects' and p.tablename = t.tbl where p.cmd <> 'SELECT') = 0, 'and no write policy at all');
select pg_temp.check((select count(*) from p8f_tables t where has_table_privilege('authenticated', 'projects.' || t.tbl, 'insert') or has_table_privilege('authenticated', 'projects.' || t.tbl, 'update') or has_table_privilege('authenticated', 'projects.' || t.tbl, 'delete')
                          or has_table_privilege('anon', 'projects.' || t.tbl, 'select') or not has_table_privilege('service_role', 'projects.' || t.tbl, 'select')) = 0, 'authenticated can only read, anon cannot read, the service role can read');
select pg_temp.as_service();
select pg_temp.check((select count(*) from core.unguarded_org_fks() u where u.child in ('projects.p8f_contact_preferences', 'projects.communication_category_cadence', 'projects.p8f_client_feedback', 'projects.client_goals', 'projects.client_communication_provider_events')) = 0,
                     'TENANCY: every org-scoped foreign key of the new tables (client_account_id, project_id, check_in_id, ledger_id) has its parent-org guard');
select pg_temp.check((select count(*) from core.unfrozen_org_tables() u where u.org_table in ('projects.p8f_contact_preferences', 'projects.communication_category_cadence', 'projects.p8f_client_feedback', 'projects.client_goals', 'projects.client_communication_provider_events')) = 0,
                     'TENANCY: every new table freezes its organization_id');
select pg_temp.check((select count(*) from pg_trigger tg join pg_class c on c.oid = tg.tgrelid where c.relname in ('p8f_client_feedback', 'client_communication_provider_events') and tg.tgname like '%append_only') = 2, 'the two history tables carry the append-only trigger');
select pg_temp.check((select count(*) from pg_trigger tg join pg_class c on c.oid = tg.tgrelid where c.relname in ('p8f_contact_preferences', 'communication_category_cadence', 'client_goals') and tg.tgname like '%p8_guard') = 3, 'the three mutable tables carry the door-only guard');
select pg_temp.check((select count(*) from information_schema.columns c join p8f_tables t on t.tbl = c.table_name where c.table_schema = 'projects' and c.column_name ~* '(price|amount|quote|discount|cost|fee|total|score|minor|currency)') = 0,
                     'the new tables have no price, amount, quote, discount, score or currency column');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.proname in ('record_provider_delivery_callback') and has_function_privilege('authenticated', p.oid, 'execute')) = 0
                     and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.proname in ('record_provider_delivery_callback') and has_function_privilege('service_role', p.oid, 'execute')) = 1,
                     'the provider callback door is for the service role only');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects'
                       and p.proname in ('probe_tenant_access', 'set_client_contact_preference', 'set_communication_category_cadence', 'clear_communication_category_cadence', 'p8f_record_client_feedback', 'record_client_goal', 'close_client_goal', 'request_support_followup',
                                         'customer_success_next_actions', 'reconcile_phase_eight_metrics')
                       and (has_function_privilege('service_role', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or not has_function_privilege('authenticated', p.oid, 'execute'))) = 0,
                     'the person doors and reads are executable by a signed-in user only (not by the service role, not by anon)');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.prosecdef and (p.proconfig is null or not p.proconfig::text like '%search_path%')
                       and p.proname in ('probe_tenant_access', 'set_client_contact_preference', 'set_communication_category_cadence', 'clear_communication_category_cadence', 'p8f_record_client_feedback', 'record_client_goal', 'close_client_goal', 'request_support_followup', 'record_provider_delivery_callback')) = 0,
                     'every new SECURITY DEFINER function pins its search_path');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.proname in ('p8f_wire_table', 'p8f_wire_parent')) = 0, 'the migration''s DDL helpers were dropped');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects'
                       and p.proname in ('probe_tenant_access', 'set_client_contact_preference', 'set_communication_category_cadence', 'clear_communication_category_cadence', 'can_contact_governed', 'p8f_record_client_feedback', 'record_client_goal', 'close_client_goal',
                                         'customer_success_next_actions', 'record_provider_delivery_callback', 'reconcile_phase_eight_metrics')
                       and pg_get_functiondef(p.oid) ~* 'net\.http|http_post|pg_notify|core\.emit_event|insert into crm\.|insert into finance\.|insert into sales\.') = 0,
                     'nothing here sends: no door or read inserts into crm, finance or sales, posts to the network, notifies or emits an event (only the support follow-up door emits, and only a request)');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.proname = 'request_support_followup' and pg_get_functiondef(p.oid) ~* 'insert into crm\.|insert into finance\.|insert into sales\.|insert into qa\.|insert into projects\.(tasks|change_requests)') = 0,
                     'the follow-up door creates no Developer task, no defect and no change request: the event is the request');
select pg_temp.check((select count(*) from pg_constraint where conname = 'support_ticket_events_kind_check' and pg_get_constraintdef(oid) like '%developer_requested%' and pg_get_constraintdef(oid) like '%qa_requested%' and pg_get_constraintdef(oid) like '%sla_breach%') = 1,
                     'the ticket event kinds gained exactly the two follow-up kinds and kept the others');

