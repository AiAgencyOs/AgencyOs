-- ═══════════════════════════════════════════════════════════════════════════
-- P1-CRM-057, P1-CRM-040, P1-DOD-095: the CRM export log, the lost-deal snapshot and the defect priority. Real doors and triggers; scratch Postgres; rolls back.
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p13-crm-export-lost-snapshot-and-defect-priority.sql
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
create or replace function pg_temp.refused(stmt text) returns boolean language plpgsql as $$
begin execute stmt; return false; exception when restrict_violation then return true; end $$;
grant execute on function pg_temp.refused(text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORG2 '00000000-0000-4000-8000-0000000013e2'
\set ADM '00000000-0000-4000-8000-000000013d01'
\set MEM '00000000-0000-4000-8000-000000013d02'
\set LEAD '00000000-0000-4000-8000-000000013d03'

insert into auth.users (id, email) values (:'ADM', 'p13d-adm@example.test'), (:'MEM', 'p13d-mem@example.test'), (:'LEAD', 'p13d-lead@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'ADM', 'p13d-adm@example.test', 'A'), (:'MEM', 'p13d-mem@example.test', 'M'), (:'LEAD', 'p13d-lead@example.test', 'L') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'ADM', 'ops_admin'), (:'ORG', :'MEM', 'member'), (:'ORG', :'LEAD', 'delivery_lead') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'ORG2', 'zztest p13d other org', 'zztest-p13d-other') on conflict do nothing;

-- ═════════ CRM export log ═════════
select pg_temp.as_user(:'MEM', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(crm.p13_log_crm_export('pipeline_csv', '{"source":"whatsapp"}', 42) = 'logged', 'an internal user''s export is logged (not only an admin''s: the pipeline export is a sales gate)');
select pg_temp.check(crm.p13_log_crm_export('leads_dump', '{}', 1) = 'invalid_kind', 'NEGATIVE: an unknown export kind is refused');
select pg_temp.check(crm.p13_log_crm_export('pipeline_csv', '{}', -1) = 'bad_count', 'NEGATIVE: a negative row count is refused');
select pg_temp.check(crm.p13_log_crm_export('pipeline_csv', '[1]', 1) = 'bad_filters', 'NEGATIVE: filters must be an object');
reset role;
select pg_temp.check((select (after->>'rowCount')::int from audit.audit_log where action = 'crm.exported' and organization_id = :'ORG' and actor_id = :'MEM' order by created_at desc limit 1) = 42, 'the audit row names the actor and the number of rows');
select pg_temp.check((select after->'filters'->>'source' from audit.audit_log where action = 'crm.exported' and actor_id = :'MEM' order by created_at desc limit 1) = 'whatsapp', 'and the filters used');

-- ═════════ lost snapshot ═════════
insert into crm.leads (organization_id, title) values (:'ORG', 'zztest p13d lead') returning id \gset L1_
insert into crm.leads (organization_id, title) values (:'ORG', 'zztest p13d lead two') returning id \gset L2_
insert into crm.conversations (organization_id, lead_id) values (:'ORG', :'L1_id') returning id \gset CV_
insert into crm.conversation_messages (organization_id, conversation_id, seq, author_type, body, occurred_at) values (:'ORG', :'CV_id', 1, 'client', 'too expensive for us', now() - interval '2 days') returning id \gset M1_
insert into crm.conversation_messages (organization_id, conversation_id, seq, author_type, body, occurred_at) values (:'ORG', :'CV_id', 2, 'client', 'we will go with someone else', now() - interval '1 day');
insert into sales.opportunities (organization_id, lead_id, name, stage) values (:'ORG', :'L1_id', 'zztest p13d deal', 'negotiation') returning id \gset O1_
insert into sales.proposals (organization_id, opportunity_id, title, version, status) values (:'ORG', :'O1_id', 'zztest proposal', 1, 'draft') returning id \gset PR1_
set local session_replication_role = replica;
update sales.proposals set status = 'superseded' where id = :'PR1_id';
insert into sales.proposals (organization_id, opportunity_id, title, version, status) values (:'ORG', :'O1_id', 'zztest proposal v2', 2, 'draft');
set local session_replication_role = origin;
insert into sales.objections (organization_id, lead_id, round, kind, concern) values (:'ORG', :'L1_id', 1, 'price', 'too expensive for us');
select pg_temp.check((select count(*) from sales.p13_lost_snapshots where opportunity_id = :'O1_id') = 0, 'an open deal has no snapshot');
update sales.opportunities set stage = 'lost', closed_at = now(), lost_category = 'price_too_high', lost_reason = 'went with a cheaper agency' where id = :'O1_id';
select pg_temp.check((select count(*) from sales.p13_lost_snapshots where opportunity_id = :'O1_id') = 1, 'marking a deal lost writes one snapshot');
select pg_temp.check((select last_message_seq from sales.p13_lost_snapshots where opportunity_id = :'O1_id') = 2, 'it names the last conversation message');
select pg_temp.check((select proposal_version from sales.p13_lost_snapshots where opportunity_id = :'O1_id') = 2 and (select proposal_status from sales.p13_lost_snapshots where opportunity_id = :'O1_id') = 'draft', 'and the live quotation version and its status');
select pg_temp.check((select objection_kinds from sales.p13_lost_snapshots where opportunity_id = :'O1_id') = array['price'], 'and the objection kinds raised');
select pg_temp.check((select nurture_eligible from sales.p13_lost_snapshots where opportunity_id = :'O1_id') is true, 'an ordinary lost lead may be nurtured');
select pg_temp.check((select lost_category from sales.p13_lost_snapshots where opportunity_id = :'O1_id') = 'price_too_high', 'and carries the category it was lost under');
select pg_temp.check(pg_temp.refused($q$update sales.p13_lost_snapshots set lost_reason = 'rewritten'$q$), 'NEGATIVE: a snapshot cannot be edited');

-- a withdrawn consent blocks nurturing
insert into crm.contacts (organization_id, full_name, email) values (:'ORG', 'zztest contact', 'p13d-contact@example.test') returning id \gset CT_
update crm.leads set contact_id = :'CT_id' where id = :'L2_id';
insert into crm.communication_consent (organization_id, contact_id, channel, status) values (:'ORG', :'CT_id', 'whatsapp', 'withdrawn');
insert into sales.opportunities (organization_id, lead_id, name, stage) values (:'ORG', :'L2_id', 'zztest p13d deal two', 'discovery') returning id \gset O2_
update sales.opportunities set stage = 'lost', closed_at = now(), lost_category = 'no_response', lost_reason = 'stopped replying' where id = :'O2_id';
select pg_temp.check((select nurture_eligible from sales.p13_lost_snapshots where opportunity_id = :'O2_id') is false
                     and (select nurture_blocked_by from sales.p13_lost_snapshots where opportunity_id = :'O2_id') = 'consent_withdrawn', 'NEGATIVE: a lead that withdrew consent is not nurture-eligible, and says why');
-- a deal inserted already lost, with no lead
insert into sales.opportunities (organization_id, name, stage, closed_at, lost_category, lost_reason) values (:'ORG', 'zztest p13d imported', 'lost', now(), 'other', 'imported as lost') returning id \gset O3_
select pg_temp.check((select nurture_blocked_by from sales.p13_lost_snapshots where opportunity_id = :'O3_id') = 'no_lead', 'a deal inserted already lost is snapshotted too, with nothing to nurture');
-- moving within terminal states or editing a non-stage column does not write a second snapshot
update sales.opportunities set name = 'zztest p13d deal renamed' where id = :'O1_id';
select pg_temp.check((select count(*) from sales.p13_lost_snapshots where organization_id = :'ORG' and opportunity_id in (:'O1_id', :'O2_id', :'O3_id')) = 3, 'one snapshot per lost deal, no more');

select pg_temp.as_user(:'ADM', :'ORG2', 'ops_admin');
set local role authenticated;
select pg_temp.check((select count(*) from sales.p13_lost_snapshots) = 0, 'NEGATIVE: another organization reads none of it');
reset role;

-- ═════════ do-not-contact ═════════
insert into crm.leads (organization_id, title) values (:'ORG', 'zztest p13d lead dnc') returning id \gset L3_
insert into crm.leads (organization_id, title) values (:'ORG', 'zztest p13d lead nocontact') returning id \gset L4_
insert into crm.contacts (organization_id, full_name, email) values (:'ORG', 'zztest dnc contact', 'p13d-dnc@example.test') returning id \gset CT3_
update crm.leads set contact_id = :'CT3_id' where id = :'L3_id';
insert into crm.leads (organization_id, title) values (:'ORG', 'zztest p13d lead no consent row') returning id \gset L5_
insert into crm.contacts (organization_id, full_name, email) values (:'ORG', 'zztest dnc contact two', 'p13d-dnc2@example.test') returning id \gset CT5_
update crm.leads set contact_id = :'CT5_id' where id = :'L5_id';
insert into crm.communication_consent (organization_id, contact_id, channel, status) values (:'ORG', :'CT3_id', 'whatsapp', 'granted');
select pg_temp.as_user(:'MEM', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(crm.p13_mark_do_not_contact(:'L3_id', 'asked us to stop') = 'not_authorized', 'NEGATIVE: a plain member cannot mark do-not-contact');
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check(crm.p13_mark_do_not_contact(:'L3_id', '') = 'reason_required', 'NEGATIVE: a reason is required');
select pg_temp.check(crm.p13_mark_do_not_contact(:'L4_id', 'x') = 'no_contact', 'a lead with no contact says so rather than pretending');
select pg_temp.check(crm.p13_mark_do_not_contact(:'L3_id', 'asked us to stop on the phone') = 'marked', 'an admin marks a lead do-not-contact');
select pg_temp.check(crm.p13_mark_do_not_contact(:'L3_id', 'again') = 'already', 'and a second time is reported, not repeated');
select pg_temp.check(crm.p13_mark_do_not_contact(:'L5_id', 'never consented, asked not to be contacted') = 'marked', 'a contact with no consent row at all is recorded as withdrawn too');
reset role;
select pg_temp.check((select status from crm.communication_consent where contact_id = :'CT3_id' and channel = 'whatsapp') = 'withdrawn', 'consent is withdrawn (a row, not a deletion)');
select pg_temp.check((select status from crm.communication_consent where contact_id = :'CT5_id' and channel = 'whatsapp') = 'withdrawn', 'and so is the one that never had a row');
select pg_temp.check((select count(*) from audit.audit_log where action = 'lead.do_not_contact' and subject_id = :'L3_id') = 1, 'with one audit row carrying the reason');
select pg_temp.as_user(:'ADM', :'ORG2', 'ops_admin');
set local role authenticated;
select pg_temp.check(crm.p13_mark_do_not_contact(:'L3_id', 'x') = 'not_found', 'NEGATIVE: another organization cannot reach the lead');
reset role;

-- ═════════ defect priority ═════════
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p13d client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p13d', 'ZP13-D') returning id \gset P_
insert into qa.defects (organization_id, project_id, severity, title, reproduction) values (:'ORG', :'P_id', 'minor', 'logo is off-centre', 'open the landing page') returning id \gset D_
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check(qa.p13_set_defect_priority(:'D_id', 'p0', '') = 'reason_required', 'NEGATIVE: a priority needs a reason');
select pg_temp.check(qa.p13_set_defect_priority(:'D_id', 'urgent', 'x') = 'invalid_priority', 'NEGATIVE: an unknown priority is refused');
select pg_temp.check(qa.p13_set_defect_priority(:'D_id', 'p0', 'it is on the launch screen the client will open first') = 'set', 'a delivery lead sets priority p0 on a minor defect');
select pg_temp.check(qa.p13_set_defect_priority(:'D_id', 'p0', 'again') = 'unchanged', 'setting the same priority again changes nothing');
select pg_temp.check(qa.p13_set_defect_priority(:'D_id', 'p2', 'launch moved') = 'set', 'it can be lowered with a reason');
reset role;
select pg_temp.check((select severity from qa.defects where id = :'D_id') = 'minor', 'severity is untouched: the two are separate');
select pg_temp.check((select priority from qa.p13_defect_priorities where defect_id = :'D_id') = 'p2', 'the current priority is p2');
select pg_temp.check((select count(*) from audit.audit_log where action = 'defect.priority_set' and subject_id = :'D_id') = 2, 'both changes are audited');
select pg_temp.as_user(:'MEM', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(qa.p13_set_defect_priority(:'D_id', 'p1', 'x') = 'not_authorized', 'NEGATIVE: a plain member cannot set priority');
reset role;
select pg_temp.as_user(:'ADM', :'ORG2', 'ops_admin');
set local role authenticated;
select pg_temp.check(qa.p13_set_defect_priority(:'D_id', 'p1', 'x') = 'not_found', 'NEGATIVE: another organization cannot reach the defect');
reset role;

rollback;
\echo 'verify-p13-crm-export-lost-snapshot-and-defect-priority: all checks passed'
