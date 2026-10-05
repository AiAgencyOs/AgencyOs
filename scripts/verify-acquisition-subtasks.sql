-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 5 — a Scheduler or Quotation task is a subtask, and
-- control returns to the conversation owner. Driven through the REAL meeting
-- doors and the real proposals table; nothing here re-implements either.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-acquisition-subtasks.sql
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

create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '{"role":"service_role"}', true); end $$;
grant execute on function pg_temp.as_service() to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000000b2'
\set ADMIN '00000000-0000-4000-8000-00000000a002'
\set MEMBER '00000000-0000-4000-8000-00000000a003'
\set OTHER '00000000-0000-4000-8000-00000000a004'

insert into core.organizations (id, name, slug) values (:'ORGB', 'Other Agency', 'other-agency') on conflict do nothing;
insert into auth.users (id, email) values
  (:'ADMIN', 'lg-admin@example.test'), (:'MEMBER', 'lg-member@example.test'), (:'OTHER', 'lg-other-owner@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values
  (:'ADMIN', 'lg-admin@example.test', 'LG Admin'), (:'MEMBER', 'lg-member@example.test', 'LG Member'), (:'OTHER', 'lg-other-owner@example.test', 'LG Other') on conflict do nothing;
create temp table fx (k text primary key, v uuid);
grant all on fx to public;

-- ── fixtures: a lead owned by the email agent, with CONFIRMED requirements and a deal ──
insert into crm.contacts (id, organization_id, full_name, email) values ('00000000-0000-4000-8000-0000000000f1', :'ORG', 'Subtask Person', 'subtask@example.org');
insert into crm.leads (id, organization_id, contact_id, title, source, source_ref, status) values
  ('00000000-0000-4000-8000-0000000000d1', :'ORG', '00000000-0000-4000-8000-0000000000f1', 'Subtask lead', 'email', 'outreach:s1', 'qualifying');
insert into crm.conversations (id, organization_id, lead_id, contact_id, channel, external_ref, status)
  values ('00000000-0000-4000-8000-0000000000e1', :'ORG', '00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000f1', 'email', 'subtask-conv', 'active');
insert into crm.requirement_versions (id, organization_id, conversation_id, version, source, status, payload) values
  ('00000000-0000-4000-8000-0000000000a1', :'ORG', '00000000-0000-4000-8000-0000000000e1', 1, 'human', 'accepted', '{"scope":"shop site"}'),
  ('00000000-0000-4000-8000-0000000000a2', :'ORG', '00000000-0000-4000-8000-0000000000e1', 2, 'human', 'proposed', '{"scope":"changed"}');
insert into sales.opportunities (id, organization_id, lead_id, name, stage) values ('00000000-0000-4000-8000-0000000000b1', :'ORG', '00000000-0000-4000-8000-0000000000d1', 'Subtask deal', 'discovery');

-- a second lead with NO owner, and a third with a live client-requested meeting
insert into crm.contacts (id, organization_id, full_name, email) values
  ('00000000-0000-4000-8000-0000000000f2', :'ORG', 'No Owner', 'noowner@example.org'),
  ('00000000-0000-4000-8000-0000000000f3', :'ORG', 'Live Meeting', 'live@example.org'),
  ('00000000-0000-4000-8000-0000000000f4', :'ORG', 'Other Lead Person', 'otherlead@example.org');
insert into crm.leads (id, organization_id, contact_id, title, source, source_ref, status) values
  ('00000000-0000-4000-8000-0000000000d2', :'ORG', '00000000-0000-4000-8000-0000000000f2', 'No owner lead', 'email', 'outreach:s2', 'new'),
  ('00000000-0000-4000-8000-0000000000d3', :'ORG', '00000000-0000-4000-8000-0000000000f3', 'Live meeting lead', 'email', 'outreach:s3', 'new'),
  ('00000000-0000-4000-8000-0000000000d4', :'ORG', '00000000-0000-4000-8000-0000000000f4', 'Other lead', 'email', 'outreach:s4', 'new');
insert into crm.conversations (id, organization_id, lead_id, contact_id, channel, external_ref, status)
  values ('00000000-0000-4000-8000-0000000000e4', :'ORG', '00000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-0000000000f4', 'email', 'subtask-conv4', 'active');
insert into crm.requirement_versions (id, organization_id, conversation_id, version, source, status, payload)
  values ('00000000-0000-4000-8000-0000000000a4', :'ORG', '00000000-0000-4000-8000-0000000000e4', 1, 'human', 'accepted', '{}');
insert into sales.opportunities (id, organization_id, lead_id, name, stage) values ('00000000-0000-4000-8000-0000000000b4', :'ORG', '00000000-0000-4000-8000-0000000000d4', 'Other deal', 'discovery');

set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome from crm.transfer_conversation_owner(:'ORG', '00000000-0000-4000-8000-0000000000d1', null, 'email_outreach', 'fixture')) = 'transferred', 'fixture: the email agent owns lead 1');
select crm.transfer_conversation_owner(:'ORG', '00000000-0000-4000-8000-0000000000d3', null, 'email_outreach', 'fixture');
select crm.transfer_conversation_owner(:'ORG', '00000000-0000-4000-8000-0000000000d4', null, 'email_outreach', 'fixture');

-- ═══ A. who may ask, and for what ═════════════════════════════════════════
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d1', 'schedule_meeting', 'social_media', 'meet the buyer', '{"mode":"call","timezone":"Asia/Kolkata"}', 'req-key-not-owner')) = 'not_owner', 'an agent that does NOT own the conversation cannot ask for a subtask');
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d2', 'schedule_meeting', 'email_outreach', 'meet the buyer', '{"mode":"call","timezone":"Asia/Kolkata"}', 'req-key-no-owner')) = 'no_owner', 'a lead nobody owns takes no subtask (an owner must be assigned first)');
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d1', 'schedule_meeting', 'scheduler', 'meet the buyer', '{"mode":"call","timezone":"Asia/Kolkata"}', 'req-key-scheduler')) = 'invalid', 'the Scheduler is not even a valid requester');
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d1', 'schedule_meeting', 'email_outreach', 'meet the buyer', '{"mode":"call","timezone":"Asia/Kolkata","details":{"offer":{"price":50000}}}', 'req-key-price-1')) = 'pricing_not_allowed', 'a meeting request carrying a PRICE (nested) is refused');
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d1', 'schedule_meeting', 'email_outreach', 'meet the buyer', '{"mode":"call","timezone":"Asia/Kolkata","items":[{"Discount":10}]}', 'req-key-price-2')) = 'pricing_not_allowed', '…including inside an array, and whatever the capitalisation');
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d1', 'schedule_meeting', 'email_outreach', 'meet the buyer', '{"mode":"telepathy","timezone":"Asia/Kolkata"}', 'req-key-mode')) = 'invalid', 'an unknown meeting mode is refused');
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d1', 'schedule_meeting', 'email_outreach', 'meet the buyer', '{"mode":"call","timezone":"Mars/Olympus"}', 'req-key-tz')) = 'meeting_invalid_timezone', 'an unknown timezone is refused by the existing meeting door');
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d1', 'schedule_meeting', 'email_outreach', 'x', '{"mode":"call","timezone":"Asia/Kolkata"}', 'req-key-objective')) = 'invalid', 'an objective of one letter is refused');
select pg_temp.check((select count(*) from crm.subtask_requests) = 0, 'none of the refusals left a subtask behind');

insert into fx select 'st1', subtask_id from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d1', 'schedule_meeting', 'email_outreach', 'book an intro call', '{"mode":"video_meeting","timezone":"Asia/Kolkata","purpose":"intro"}', 'req-key-meeting-1');
select pg_temp.check((select (status, assignee, requested_by_owner) = ('IN_PROGRESS', 'scheduler', 'email_outreach') from crm.subtask_requests where id = (select v from fx where k = 'st1')), 'the owner''s request becomes an IN_PROGRESS subtask for the Scheduler');
insert into fx select 'm1', meeting_id from crm.subtask_requests where id = (select v from fx where k = 'st1');
select pg_temp.check((select (status, lead_id) = ('requested', '00000000-0000-4000-8000-0000000000d1'::uuid) from crm.meetings where id = (select v from fx where k = 'm1')), 'it created a REAL meeting request through the existing door, on the right lead');
select pg_temp.check((select owner from crm.lead_conversation_owner where lead_id = '00000000-0000-4000-8000-0000000000d1') = 'email_outreach', 'the conversation owner did NOT change: the Scheduler owns only the subtask');
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d1', 'schedule_meeting', 'email_outreach', 'book an intro call', '{"mode":"video_meeting","timezone":"Asia/Kolkata"}', 'req-key-meeting-1')) = 'exists', 'the same idempotency key finds the existing subtask (a replayed job asks once)');
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d1', 'schedule_meeting', 'email_outreach', 'book it again', '{"mode":"call","timezone":"Asia/Kolkata"}', 'req-key-meeting-2')) = 'exists_open', 'a second request while one is open finds the open one');
select pg_temp.check((select count(*) from crm.meetings where lead_id = '00000000-0000-4000-8000-0000000000d1') = 1, '…and there is still exactly one meeting row');

-- a client already asked for a meeting: reuse it, never double-book
select pg_temp.check((select outcome from crm.request_meeting('00000000-0000-4000-8000-0000000000d3', 'call', 'Asia/Kolkata', 'client asked')) = 'requested', 'fixture: the client already asked for a meeting on lead 3');
insert into fx select 'st3', subtask_id from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d3', 'schedule_meeting', 'email_outreach', 'book it', '{"mode":"call","timezone":"Asia/Kolkata"}', 'req-key-reuse-1');
select pg_temp.check((select count(*) from crm.meetings where lead_id = '00000000-0000-4000-8000-0000000000d3') = 1, 'a live meeting is REUSED, not duplicated');
select pg_temp.check((select (progress ->> 'reused_live_meeting')::boolean from crm.subtask_requests where id = (select v from fx where k = 'st3')), '…and the subtask says it reused it');

-- who may ask through a session
reset role;
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d4', 'schedule_meeting', 'email_outreach', 'a member asking', '{"mode":"call","timezone":"Asia/Kolkata"}', 'req-key-member')) = 'forbidden', 'a member cannot request a subtask');
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d4', 'schedule_meeting', 'email_outreach', 'another tenant', '{"mode":"call","timezone":"Asia/Kolkata"}', 'req-key-tenant')) = 'forbidden', 'a session of another organisation cannot request one');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome from crm.request_subtask(:'ORGB', '00000000-0000-4000-8000-0000000000d4', 'schedule_meeting', 'email_outreach', 'wrong org id', '{"mode":"call","timezone":"Asia/Kolkata"}', 'req-key-wrongorg')) = 'unknown_lead', 'naming the wrong organisation for a lead finds no lead');

-- ═══ B. the link follows the existing meeting lifecycle ═══════════════════
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.propose_meeting_slots((select v from fx where k = 'm1'),
  jsonb_build_array(jsonb_build_object('startAt', (now() + interval '2 days')::text, 'endAt', (now() + interval '2 days 30 minutes')::text)),
  'google:test', now(), 30)) is not null, 'the Scheduler offers slots through the existing door');
select pg_temp.check((select progress ->> 'meeting_status' from crm.subtask_requests where id = (select v from fx where k = 'st1')) = 'proposed', '…and the subtask''s progress followed it (proposed)');
reset role;
set local role service_role;
select pg_temp.as_service();
select crm.book_meeting((select v from fx where k = 'm1'), 'subtask-book-1', now() + interval '2 days', now() + interval '2 days 30 minutes', 'Asia/Kolkata', 'video_meeting', 'google', 'evt-1', 'https://meet.example/x');
select pg_temp.check((select progress ->> 'meeting_status' from crm.subtask_requests where id = (select v from fx where k = 'st1')) = 'booked', '…then booked');
select pg_temp.check((select status from crm.subtask_requests where id = (select v from fx where k = 'st1')) = 'IN_PROGRESS', 'a booked meeting is still IN_PROGRESS: the subtask ends when the meeting does');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'm1b', new_meeting_id from crm.reschedule_meeting((select v from fx where k = 'm1'), 'client is travelling');
select pg_temp.check((select meeting_id from crm.subtask_requests where id = (select v from fx where k = 'st1')) = (select v from fx where k = 'm1b'), 'RESCHEDULE - the subtask FOLLOWED the new row (a reschedule is a new meeting)');
select pg_temp.check((select status from crm.subtask_requests where id = (select v from fx where k = 'st1')) = 'IN_PROGRESS', '…and was not failed by the old row being cancelled');
select pg_temp.check((select (progress ->> 'rescheduled_from')::uuid from crm.subtask_requests where id = (select v from fx where k = 'st1')) = (select v from fx where k = 'm1'), '…and remembers where it came from');
select pg_temp.check((select lead_id from crm.meetings where id = (select v from fx where k = 'm1b')) = '00000000-0000-4000-8000-0000000000d1', 'the rescheduled meeting is still on the right lead');
select crm.propose_meeting_slots((select v from fx where k = 'm1b'), jsonb_build_array(jsonb_build_object('startAt', (now() + interval '3 days')::text, 'endAt', (now() + interval '3 days 30 minutes')::text)), 'google:test', now(), 30);
reset role;
set local role service_role;
select pg_temp.as_service();
select crm.book_meeting((select v from fx where k = 'm1b'), 'subtask-book-2', now() + interval '3 days', now() + interval '3 days 30 minutes', 'Asia/Kolkata', 'video_meeting', 'google', 'evt-2', 'https://meet.example/y');
-- a transfer of the conversation while the subtask is open: the result must return to the owner AT COMPLETION
select pg_temp.check((select outcome from crm.transfer_conversation_owner(:'ORG', '00000000-0000-4000-8000-0000000000d1', 'email_outreach', 'sales', 'prospect moved to WhatsApp mid-subtask')) = 'transferred', 'the conversation moves to Sales while the meeting is pending');
reset role;
-- time passes: the meeting has now happened (the existing door refuses to complete one that has not started)
update crm.meetings set confirmed_start_at = now() - interval '2 hours', confirmed_end_at = now() - interval '90 minutes' where id = (select v from fx where k = 'm1b');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.complete_meeting((select v from fx where k = 'm1b'), 'completed', 'good call')) = 'completed', 'the meeting is completed through the existing door');
select pg_temp.check((select status from crm.subtask_requests where id = (select v from fx where k = 'st1')) = 'COMPLETED', 'the subtask COMPLETED with it');
select pg_temp.check((select result ->> 'outcome' from crm.subtask_requests where id = (select v from fx where k = 'st1')) = 'completed', '…carrying the meeting outcome');
select pg_temp.check((select (result ->> 'meeting_id')::uuid from crm.subtask_requests where id = (select v from fx where k = 'st1')) = (select v from fx where k = 'm1b'), '…and the exact meeting row');
select pg_temp.check((select (requested_by_owner, returned_to_owner) = ('email_outreach', 'sales') from crm.subtask_requests where id = (select v from fx where k = 'st1')), 'CONTROL RETURNED to the conversation owner at the time it ended (Sales), not whoever asked');

-- a cancellation fails the subtask with a reason; the owner may ask again
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.cancel_meeting((select meeting_id from crm.subtask_requests where id = (select v from fx where k = 'st3')), 'client cancelled')) is not null, 'the client''s meeting (lead 3) is cancelled through the existing door');
select pg_temp.check((select (status, failure_reason) = ('FAILED', 'client cancelled') from crm.subtask_requests where id = (select v from fx where k = 'st3')), 'a CANCELLED meeting fails the subtask, with the reason');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d3', 'schedule_meeting', 'email_outreach', 'try again', '{"mode":"call","timezone":"Asia/Kolkata"}', 'req-key-reuse-2')) = 'created', 'once closed, the owner can ask again (a fresh subtask)');

-- ═══ C. the quotation subtask ═════════════════════════════════════════════
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d1', 'prepare_quotation', 'sales', 'quote the shop site', '{}', 'req-key-quote-0')) = 'requirements_not_confirmed', 'a quotation request must name the confirmed requirements');
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d1', 'prepare_quotation', 'sales', 'quote the shop site', '{"requirement_version_id":"00000000-0000-4000-8000-0000000000a2"}', 'req-key-quote-1')) = 'requirements_not_confirmed', 'a PROPOSED (not accepted) requirement version is refused');
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d1', 'prepare_quotation', 'sales', 'quote the shop site', '{"requirement_version_id":"00000000-0000-4000-8000-0000000000a4"}', 'req-key-quote-2')) = 'requirements_not_confirmed', 'ANOTHER lead''s confirmed requirements are refused');
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d1', 'prepare_quotation', 'sales', 'quote the shop site', '{"requirement_version_id":"00000000-0000-4000-8000-0000000000a1","price":90000}', 'req-key-quote-3')) = 'pricing_not_allowed', 'a quotation request may not carry a price: an agent never decides one');
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d1', 'prepare_quotation', 'email_outreach', 'quote the shop site', '{"requirement_version_id":"00000000-0000-4000-8000-0000000000a1"}', 'req-key-quote-4')) = 'not_owner', 'only the CURRENT owner (Sales now) may ask');
insert into fx select 'st2', subtask_id from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d1', 'prepare_quotation', 'sales', 'quote the shop site', '{"requirement_version_id":"00000000-0000-4000-8000-0000000000a1","notes":"8 pages"}', 'req-key-quote-5');
select pg_temp.check((select (status, assignee, requirement_version_id) is not distinct from ('REQUESTED', null, '00000000-0000-4000-8000-0000000000a1'::uuid) from crm.subtask_requests where id = (select v from fx where k = 'st2')), 'a valid quotation request waits for the Quotation Master, tied to the confirmed requirement version');
select pg_temp.check((select outcome from crm.accept_subtask(:'ORG', (select v from fx where k = 'st2'), 'scheduler')) = 'invalid', 'the Scheduler cannot take a quotation');
select pg_temp.check((select outcome from crm.accept_subtask(:'ORG', (select v from fx where k = 'st2'), 'quotation_master')) = 'accepted', 'the Quotation Master accepts it');
select pg_temp.check((select outcome from crm.accept_subtask(:'ORG', (select v from fx where k = 'st2'), 'quotation_master')) = 'wrong_state', '…once');

-- proposals: one built from the WRONG requirements, one on another lead, one right
reset role;
insert into sales.proposals (id, organization_id, opportunity_id, version, title, requirement_version_id) values
  ('00000000-0000-4000-8000-0000000000c2', :'ORG', '00000000-0000-4000-8000-0000000000b1', 1, 'Built from v2', '00000000-0000-4000-8000-0000000000a2');
insert into fx values ('p_wrong', '00000000-0000-4000-8000-0000000000c2');
update sales.proposals set status = 'superseded' where id = '00000000-0000-4000-8000-0000000000c2';
insert into sales.proposals (id, organization_id, opportunity_id, version, title, requirement_version_id) values
  ('00000000-0000-4000-8000-0000000000c3', :'ORG', '00000000-0000-4000-8000-0000000000b4', 1, 'Other lead quote', '00000000-0000-4000-8000-0000000000a4'),
  ('00000000-0000-4000-8000-0000000000c1', :'ORG', '00000000-0000-4000-8000-0000000000b1', 2, 'Shop site v1', '00000000-0000-4000-8000-0000000000a1');
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome from crm.link_subtask_proposal(:'ORG', (select v from fx where k = 'st2'), '00000000-0000-4000-8000-0000000000c2')) = 'requirement_mismatch', 'a proposal built from DIFFERENT requirements cannot satisfy the subtask');
select pg_temp.check((select outcome from crm.link_subtask_proposal(:'ORG', (select v from fx where k = 'st2'), '00000000-0000-4000-8000-0000000000c3')) = 'lead_mismatch', 'a proposal on ANOTHER lead cannot either');
select pg_temp.check((select outcome from crm.link_subtask_proposal(:'ORG', (select v from fx where k = 'st2'), '00000000-0000-4000-8000-0000000000c1')) = 'linked', 'a proposal built from the confirmed requirements links');
-- approval is the existing engine's; to drive MY trigger the engine's own guard is paused here, and ONLY here
reset role;
alter table sales.proposals disable trigger proposals_guard;
update sales.proposals set status = 'pending_approval' where id = '00000000-0000-4000-8000-0000000000c1';
select pg_temp.check((select status from crm.subtask_requests where id = (select v from fx where k = 'st2')) = 'IN_PROGRESS', 'a proposal waiting for approval does not complete the subtask');
update sales.proposals set status = 'approved' where id = '00000000-0000-4000-8000-0000000000c1';
alter table sales.proposals enable trigger proposals_guard;
select pg_temp.check((select status from crm.subtask_requests where id = (select v from fx where k = 'st2')) = 'COMPLETED', 'once the proposal is APPROVED the subtask completes');
select pg_temp.check((select (result ->> 'version')::int from crm.subtask_requests where id = (select v from fx where k = 'st2')) = 2, '…naming the exact version');
select pg_temp.check((select returned_to_owner from crm.subtask_requests where id = (select v from fx where k = 'st2')) = 'sales', '…and control is back with Sales');
select pg_temp.check((select result ->> 'requirement_version_id' from crm.subtask_requests where id = (select v from fx where k = 'st2')) = '00000000-0000-4000-8000-0000000000a1', '…and the requirement version the quote was built from');

-- a revised version while the subtask is still open: the subtask follows the NEW version, the old one stays history
insert into fx select 'st4', subtask_id from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d4', 'prepare_quotation', 'email_outreach', 'quote other', '{"requirement_version_id":"00000000-0000-4000-8000-0000000000a4"}', 'req-key-quote-6');
select crm.accept_subtask(:'ORG', (select v from fx where k = 'st4'), 'quotation_master');
select crm.link_subtask_proposal(:'ORG', (select v from fx where k = 'st4'), '00000000-0000-4000-8000-0000000000c3');
reset role;
-- exactly what the existing draft door does for a revision: the live version is superseded, then the new version is inserted
update sales.proposals set status = 'superseded' where id = '00000000-0000-4000-8000-0000000000c3';
insert into sales.proposals (id, organization_id, opportunity_id, version, title, requirement_version_id) values
  ('00000000-0000-4000-8000-0000000000c4', :'ORG', '00000000-0000-4000-8000-0000000000b4', 2, 'Other lead quote v2', '00000000-0000-4000-8000-0000000000a4');
select pg_temp.check((select proposal_id from crm.subtask_requests where id = (select v from fx where k = 'st4')) = '00000000-0000-4000-8000-0000000000c4', 'QUOTE V2 - the subtask follows the NEW version');
select pg_temp.check((select version from sales.proposals where id = '00000000-0000-4000-8000-0000000000c3') = 1, '…and version 1 remains historical, untouched');
select pg_temp.check((select (progress ->> 'proposal_version')::int from crm.subtask_requests where id = (select v from fx where k = 'st4')) = 2, '…progress names version 2');
alter table sales.proposals disable trigger proposals_guard;
update sales.proposals set status = 'rejected' where id = '00000000-0000-4000-8000-0000000000c4';
alter table sales.proposals enable trigger proposals_guard;
select pg_temp.check((select (status, failure_reason) = ('FAILED', 'the quotation was rejected') from crm.subtask_requests where id = (select v from fx where k = 'st4')), 'a REJECTED quotation fails the subtask with the reason');

-- ═══ D. cancel, closed leads, frozen history ══════════════════════════════
set local role service_role;
select pg_temp.as_service();
insert into fx select 'st5', subtask_id from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d4', 'schedule_meeting', 'email_outreach', 'call again', '{"mode":"call","timezone":"Asia/Kolkata"}', 'req-key-cancel-1');
select pg_temp.check((select outcome from crm.cancel_subtask(:'ORG', (select v from fx where k = 'st5'), '')) = 'needs_reason', 'cancelling needs a reason');
select pg_temp.check((select outcome from crm.cancel_subtask(:'ORG', (select v from fx where k = 'st5'), 'prospect went quiet')) = 'cancelled', 'a subtask can be cancelled');
select pg_temp.check((select outcome from crm.cancel_subtask(:'ORG', (select v from fx where k = 'st5'), 'again')) = 'not_live', '…once');
select pg_temp.check((select (status, returned_to_owner) = ('CANCELLED', 'email_outreach') from crm.subtask_requests where id = (select v from fx where k = 'st5')), '…and control returned to the owner');
reset role;
do $$
declare s uuid;
begin
  -- an OPEN subtask, so the only thing that can refuse the edit is the freeze on what was asked (not the closed-subtask rule)
  select id into s from crm.subtask_requests where status in ('REQUESTED', 'IN_PROGRESS') limit 1;
  if s is null then raise exception 'FAILED: the test needs an open subtask'; end if;
  begin update crm.subtask_requests set objective = 'changed my mind' where id = s; raise exception 'FAILED: a subtask''s objective was edited';
  exception when insufficient_privilege then raise notice 'ok  what a subtask asked for cannot be edited'; end;
  begin update crm.subtask_requests set input = '{"price": 1}' where id = s; raise exception 'FAILED: a subtask''s input was edited';
  exception when insufficient_privilege then raise notice 'ok  its input cannot be edited (a price cannot be added afterwards)'; end;
  begin delete from crm.subtask_requests where id = s; raise exception 'FAILED: a subtask was deleted';
  exception when insufficient_privilege then raise notice 'ok  a subtask is never deleted'; end;
  begin update crm.subtask_requests set status = 'IN_PROGRESS' where status = 'COMPLETED' and id = (select id from crm.subtask_requests where status = 'COMPLETED' limit 1); raise exception 'FAILED: a closed subtask reopened';
  exception when check_violation then raise notice 'ok  a closed subtask cannot be reopened'; end;
end $$;
update crm.leads set status = 'disqualified', disqualified_reason = 'out of scope' where id = '00000000-0000-4000-8000-0000000000d4';
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome from crm.request_subtask(:'ORG', '00000000-0000-4000-8000-0000000000d4', 'schedule_meeting', 'email_outreach', 'call a closed lead', '{"mode":"call","timezone":"Asia/Kolkata"}', 'req-key-closed')) = 'closed', 'a closed lead takes no subtask');

-- ═══ E. tenancy, privileges, audit ════════════════════════════════════════
reset role;
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from crm.subtask_requests) = 0, 'organisation B sees none of organisation A''s subtasks');
select pg_temp.check((select outcome from crm.cancel_subtask(:'ORG', (select v from fx where k = 'st1'), 'x')) = 'forbidden', 'organisation B cannot cancel one');
reset role;
select pg_temp.check(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'crm' and c.relname = 'subtask_requests'
     and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'insert')
          or has_table_privilege('authenticated', c.oid, 'update') or has_table_privilege('authenticated', c.oid, 'delete'))
), 'the table is not readable by anon or writable by authenticated');
select pg_temp.check((select count(*) from audit.audit_log where created_at >= now() and action = 'subtask.requested') >= 5, 'requests are audited');
select pg_temp.check((select count(*) from audit.audit_log where created_at >= now() and action in ('subtask.completed', 'subtask.failed', 'subtask.cancelled')) >= 5, 'every ending is audited, with who it returned to');
select pg_temp.check((select count(*) from audit.audit_log where created_at >= now() and action = 'subtask.carry_failed') = 0, 'no bookkeeping trigger failed silently');

do $$ begin raise notice 'ALL CHECKS PASSED'; end $$;
rollback;
