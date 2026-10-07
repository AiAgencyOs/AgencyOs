-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 round 4, Scheduler (migration 20261203100000): overlap prevention, the provider-to-AgencyOS reconcile, scheduling messages as drafts a person sends, and
-- the reminder delivery metrics.
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p1r-scheduler.sql     Rolls back. Any failed check raises.
-- No replication-role switch; every count is scoped to this script's own organisation; helper names are prefixed p1r_.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.p1r_check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok  %', what;
end $$;
grant execute on function pg_temp.p1r_check(boolean, text) to public;
create or replace function pg_temp.p1r_as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
    'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true);
end $$;
grant execute on function pg_temp.p1r_as_user(uuid, uuid, text) to public;
create or replace function pg_temp.p1r_as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '{"role":"service_role"}', true); end $$;
grant execute on function pg_temp.p1r_as_service() to public;
create or replace function pg_temp.p1r_fails_with(stmt text, code text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when others then return sqlstate = code; end $$;
grant execute on function pg_temp.p1r_fails_with(text, text) to public;
create or replace function pg_temp.p1r_mutate(fn regprocedure, from_text text, to_text text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(fn); n text;
begin
  n := replace(d, from_text, to_text);
  if n = d then raise exception 'RED-PROOF MUTATION CHANGED NOTHING: % / %', fn, from_text; end if;
  execute n;
end $$;
grant execute on function pg_temp.p1r_mutate(regprocedure, text, text) to public;

\set SORG '00000000-0000-4000-8000-0000000b0200'
\set SOWN '00000000-0000-4000-8000-0000000b0201'
\set SMEM '00000000-0000-4000-8000-0000000b0202'
\set SOTH '00000000-0000-4000-8000-0000000b0210'
\set SOTHU '00000000-0000-4000-8000-0000000b0211'

insert into auth.users (id, email) values (:'SOWN', 'p1r-s-owner@example.test'), (:'SMEM', 'p1r-s-member@example.test'), (:'SOTHU', 'p1r-s-other@example.test');
insert into core.users (id, email, full_name) values (:'SOWN', 'p1r-s-owner@example.test', 'S Owner'), (:'SMEM', 'p1r-s-member@example.test', 'S Member'), (:'SOTHU', 'p1r-s-other@example.test', 'S Other') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'SORG', 'zztest p1r sched', 'zztest-p1r-sched'), (:'SOTH', 'zztest p1r sched other', 'zztest-p1r-sched-other');
insert into core.memberships (organization_id, user_id, role) values (:'SORG', :'SOWN', 'owner'), (:'SORG', :'SMEM', 'member'), (:'SOTH', :'SOTHU', 'owner');
insert into crm.leads (organization_id, title) values (:'SORG', 'zztest p1r sched lead') returning id as lead \gset
insert into crm.leads (organization_id, title) values (:'SOTH', 'zztest p1r other lead') returning id as olead \gset

create or replace function pg_temp.p1r_book(p_org uuid, p_lead uuid, p_start timestamptz, p_minutes int, p_supersedes uuid default null) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into crm.meetings (organization_id, lead_id, requested_mode, status, booked_mode, confirmed_start_at, confirmed_end_at, timezone, availability_source, availability_read_at,
                            provider, provider_event_id, supersedes_id, booked_at)
  values (p_org, p_lead, 'call', 'booked', 'call', p_start, p_start + make_interval(mins => p_minutes), 'Asia/Kolkata', 'v', now(),
          'google', 'p1r-ev-' || gen_random_uuid()::text, p_supersedes, now())
  returning id into v_id;
  return v_id;
end $$;
grant execute on function pg_temp.p1r_book(uuid, uuid, timestamptz, int, uuid) to public;

-- ── overlap prevention ─────────────────────────────────────────────────────
select pg_temp.p1r_as_service();
-- off until an administrator switches it on: today's behaviour is unchanged for an organisation that has not decided
select pg_temp.p1r_book(:'SORG', :'lead', timestamptz '2026-12-08 05:00+00', 30) as m0a \gset
select pg_temp.p1r_check((select pg_temp.p1r_book(:'SORG', :'lead', timestamptz '2026-12-08 05:10+00', 30)) is not null, 'with no rule set, two meetings may overlap: nothing changed for an organisation that has not decided');
select pg_temp.p1r_as_user(:'SOWN', :'SORG', 'owner');
select pg_temp.p1r_check((select outcome from crm.p1r_set_overlap_rule(:'SORG', true, 'the agency has one booking calendar')) = 'set', 'an administrator switches the guard on');
select pg_temp.p1r_check((select prevent_overlap and configured and reason like 'the agency has one%' from crm.p1r_overlap_rule_for()), 'the screen reads the rule in force and who gave the reason');
select pg_temp.p1r_as_user(:'SOTHU', :'SOTH', 'owner');
select pg_temp.p1r_check((select not prevent_overlap and not configured from crm.p1r_overlap_rule_for()), 'an organisation nobody has decided for reads as undecided, guard off');
select pg_temp.p1r_as_service();
select pg_temp.p1r_book(:'SORG', :'lead', timestamptz '2026-12-09 05:00+00', 30) as ma \gset
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$select pg_temp.p1r_book(%L, %L, timestamptz '2026-12-09 05:15+00', 30)$f$, :'SORG', :'lead'), '23514'), 'a booking that overlaps another booked meeting is refused');
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$select pg_temp.p1r_book(%L, %L, timestamptz '2026-12-09 04:45+00', 30)$f$, :'SORG', :'lead'), '23514'), 'whether it starts inside the other');
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$select pg_temp.p1r_book(%L, %L, timestamptz '2026-12-09 04:00+00', 180)$f$, :'SORG', :'lead'), '23514'), 'or contains it');
select pg_temp.p1r_check((select pg_temp.p1r_book(:'SORG', :'lead', timestamptz '2026-12-09 05:30+00', 30)) is not null, 'a meeting that starts exactly when the other ends is fine');
select pg_temp.p1r_check((select pg_temp.p1r_book(:'SOTH', :'olead', timestamptz '2026-12-09 05:00+00', 30)) is not null, 'another organisation''s calendar is not this one''s');
select pg_temp.p1r_check((select pg_temp.p1r_book(:'SORG', :'lead', timestamptz '2026-12-09 05:00+00', 30, :'ma')) is not null, 'a reschedule may take the slot of the meeting it supersedes');
-- a request is not a booking; a cancelled booking frees its time
insert into crm.meetings (organization_id, lead_id, requested_mode, status, requested_start_at) values (:'SORG', :'lead', 'call', 'requested', timestamptz '2026-12-09 05:00+00') returning id as mreq \gset
select pg_temp.p1r_check((select status from crm.meetings where id = :'mreq') = 'requested', 'a request for the same time is not refused: it is not a booking');
update crm.meetings set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'zztest' where id = :'ma';
update crm.meetings set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'zztest' where supersedes_id = :'ma';
select pg_temp.p1r_check((select pg_temp.p1r_book(:'SORG', :'lead', timestamptz '2026-12-09 05:00+00', 30)) is not null, 'a cancelled meeting no longer blocks its time');
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$update crm.meetings set status = 'booked', booked_mode = 'call', confirmed_start_at = timestamptz '2026-12-09 05:10+00', confirmed_end_at = timestamptz '2026-12-09 05:40+00', timezone = 'Asia/Kolkata', availability_source = 'v', availability_read_at = now() where id = %L$f$, :'mreq'), '23514'), 'booking a request into an occupied time is refused through the real update too');
select * from crm.p1r_meeting_overlaps(timestamptz '2026-12-09 05:10+00', timestamptz '2026-12-09 05:40+00') limit 0;
select pg_temp.p1r_as_user(:'SMEM', :'SORG', 'member');
select pg_temp.p1r_check((select count(*) from crm.p1r_meeting_overlaps(timestamptz '2026-12-09 05:10+00', timestamptz '2026-12-09 05:40+00')) = 2, 'a person can ask what a window would overlap (the booked meetings at 05:00-05:30 and 05:30-06:00)');
select pg_temp.p1r_as_user(:'SOTHU', :'SOTH', 'owner');
select pg_temp.p1r_check((select count(*) from crm.p1r_meeting_overlaps(timestamptz '2026-12-09 05:10+00', timestamptz '2026-12-09 05:40+00')) = 1, 'and sees only their own organisation''s');
-- the rule is the owner's to switch
select pg_temp.p1r_as_user(:'SMEM', :'SORG', 'member');
select pg_temp.p1r_check((select outcome from crm.p1r_set_overlap_rule(:'SORG', false, 'two calendars')) = 'forbidden', 'a plain member cannot switch the overlap rule');
select pg_temp.p1r_as_service();
select pg_temp.p1r_check((select outcome from crm.p1r_set_overlap_rule(:'SORG', false, 'two calendars')) = 'person_required', 'nor can the service role');
select pg_temp.p1r_as_user(:'SOWN', :'SORG', 'owner');
select pg_temp.p1r_check((select outcome from crm.p1r_set_overlap_rule(:'SORG', false, '')) = 'missing_reason', 'switching it needs a reason');
select pg_temp.p1r_check((select outcome from crm.p1r_set_overlap_rule(:'SORG', false, 'the agency now runs two calendars')) = 'set', 'an administrator switches it off');
select pg_temp.p1r_as_service();
select pg_temp.p1r_check((select pg_temp.p1r_book(:'SORG', :'lead', timestamptz '2026-12-09 05:10+00', 30)) is not null, 'with the rule off an overlap is allowed (the owner modelled it)');
select pg_temp.p1r_as_user(:'SOWN', :'SORG', 'owner');
select pg_temp.p1r_check((select outcome from crm.p1r_set_overlap_rule(:'SORG', true, 'back to one calendar')) = 'set', 'and back on');
select pg_temp.p1r_as_service();
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$select pg_temp.p1r_book(%L, %L, timestamptz '2026-12-09 05:20+00', 30)$f$, :'SORG', :'lead'), '23514'), 'the rule applies again');
select pg_temp.p1r_check((select count(*) from audit.audit_log where organization_id = :'SORG' and action = 'meeting.overlap_rule_set') = 3, 'each change is audited');

-- ── the provider is compared with AgencyOS ─────────────────────────────────
select (date_trunc('day', now()) + interval '3 days 5 hours')::text as T0 \gset
select pg_temp.p1r_book(:'SORG', :'lead', :'t0'::timestamptz, 30) as mp \gset
select pg_temp.p1r_as_user(:'SOWN', :'SORG', 'owner');
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$select * from crm.p1r_record_provider_check(%L, 'cancelled')$f$, :'mp'), '42501'), 'recording a provider check is a runner door: a person is refused');
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$select * from crm.p1r_meetings_to_reconcile(%L)$f$, :'SORG'), '42501'), 'and so is listing the meetings to check');
select pg_temp.p1r_as_service();
select pg_temp.p1r_check((select count(*) from crm.p1r_meetings_to_reconcile(:'SORG', 50, interval '6 hours', interval '30 days') where meeting_id = :'mp') = 1, 'a booked meeting with a provider event is due a look');
select pg_temp.p1r_check((select count(*) from crm.p1r_meetings_to_reconcile(:'SORG', 50, interval '6 hours', interval '30 days') where meeting_id = :'mreq') = 0, 'a request with no provider event is not');
select outcome as o1 from crm.p1r_record_provider_check(:'mp', 'confirmed', :'t0'::timestamptz + interval '20 seconds', :'t0'::timestamptz + interval '30 minutes', 'google answered') \gset
select pg_temp.p1r_check(:'o1' = 'in_sync', 'the same times (within a minute) are in sync');
select pg_temp.p1r_check((select count(*) from crm.p1o_meeting_flags where meeting_id = :'mp') = 0, 'and raise nothing');
select pg_temp.p1r_check((select count(*) from crm.p1r_meetings_to_reconcile(:'SORG', 50, interval '6 hours', interval '30 days') where meeting_id = :'mp') = 0, 'a meeting just checked is not asked again inside the interval');
select pg_temp.p1r_check((select count(*) from crm.p1r_meetings_to_reconcile(:'SORG', 50, interval '0 seconds', interval '30 days') where meeting_id = :'mp') = 1, 'but is when the interval has passed');
select outcome as o2, flag_id as f2 from crm.p1r_record_provider_check(:'mp', 'confirmed', :'t0'::timestamptz + interval '1 hour', :'t0'::timestamptz + interval '90 minutes') \gset
select pg_temp.p1r_check(:'o2' = 'conflict_flagged' and :'f2' is not null, 'a moved event is a conflict flagged for a person');
select pg_temp.p1r_check((select note from crm.p1o_meeting_flags where id = :'f2') like '%Decide which is right; nothing was changed.%' and (select kind from crm.p1o_meeting_flags where id = :'f2') = 'provider_conflict', 'the flag says what differs and that nothing was changed');
select pg_temp.p1r_check((select status from crm.meetings where id = :'mp') = 'booked' and (select confirmed_start_at from crm.meetings where id = :'mp') = :'t0'::timestamptz, 'the AgencyOS meeting is untouched: a person decides which side is right');
select outcome as o3 from crm.p1r_record_provider_check(:'mp', 'cancelled') \gset
select pg_temp.p1r_check(:'o3' = 'conflict_flagged' and (select count(*) from crm.p1o_meeting_flags where meeting_id = :'mp' and state = 'open') = 1, 'cancelled at the provider is a conflict; the open flag is reused, not duplicated');
select outcome as o4 from crm.p1r_record_provider_check(:'mp', 'missing') \gset
select pg_temp.p1r_check(:'o4' = 'conflict_flagged', 'missing at the provider is a conflict');
select outcome as o5, coalesce(flag_id::text, '') as f5 from crm.p1r_record_provider_check(:'mp', 'unreadable', null, null, 'Google did not answer') \gset
select pg_temp.p1r_check(:'o5' = 'unreadable' and :'f5' = '', 'an unreadable provider is neither in sync nor a conflict');
select pg_temp.p1r_check((select result from crm.p1r_provider_checks where meeting_id = :'mp' order by checked_at desc, id limit 1) in ('unreadable', 'conflict'), 'every look is a row');
select pg_temp.p1r_check((select outcome from crm.p1r_record_provider_check(:'mreq', 'confirmed', now(), now())) = 'not_checkable', 'a meeting that is not booked with a provider event is not checkable');
select pg_temp.p1r_check((select outcome from crm.p1r_record_provider_check(:'mp', 'weird')) = 'bad_state', 'an unknown provider state is refused');
select pg_temp.p1r_check((select outcome from crm.p1r_record_provider_check(:'mp', 'confirmed')) = 'bad_times', 'a confirmed event without times is refused');
select pg_temp.p1r_check((select outcome from crm.p1r_record_provider_check(gen_random_uuid(), 'cancelled')) = 'unknown_meeting', 'an unknown meeting is named');
select pg_temp.p1r_as_user(:'SMEM', :'SORG', 'member');
select pg_temp.p1r_check((select checked >= 5 and in_sync = 1 and conflicts = 3 and unreadable = 1 from crm.p1r_provider_check_summary(30)), 'the summary counts in-sync, conflicts and unreadable looks');
select pg_temp.p1r_as_user(:'SOTHU', :'SOTH', 'owner');
select pg_temp.p1r_check((select count(*) from crm.p1r_provider_check_summary(30)) = 1 and (select checked from crm.p1r_provider_check_summary(30)) = 0, 'another organisation counts none of them');

-- ── scheduling messages are drafts a person sends ──────────────────────────
select pg_temp.p1r_as_service();
insert into crm.meetings (organization_id, lead_id, requested_mode, status, availability_source, availability_read_at, proposed_slots, duration_minutes)
  values (:'SORG', :'lead', 'call', 'proposed', 'v', now(), '[{"startAt":"2026-12-11T05:00:00Z","endAt":"2026-12-11T05:30:00Z"}]'::jsonb, 30) returning id as mprop \gset
select outcome as d1o, draft_id as d1 from crm.p1r_save_scheduling_draft(:'mprop', 'proposal', 'en', 'These times are free: 1) Fri 11 Dec, 10:30 am.') \gset
select pg_temp.p1r_check(:'d1o' = 'saved' and (select status from crm.p1r_scheduling_drafts where id = :'d1') = 'draft', 'the proposal is saved as a draft');
select pg_temp.p1r_check((select count(*) from crm.conversation_messages cm where cm.organization_id = :'SORG') = 0, 'saving a draft wrote no message to anyone');
select outcome as d1b, draft_id as d1bid from crm.p1r_save_scheduling_draft(:'mprop', 'proposal', 'hinglish', 'Ye time free hain: 1) Shukravar 11 Dec.') \gset
select pg_temp.p1r_check(:'d1b' = 'replaced' and :'d1bid' = :'d1' and (select count(*) from crm.p1r_scheduling_drafts where meeting_id = :'mprop' and kind = 'proposal') = 1, 'a second draft of the same kind replaces the first: one open draft per kind');
select pg_temp.p1r_check((select outcome from crm.p1r_save_scheduling_draft(:'mp', 'proposal', 'en', 'x')) = 'wrong_state', 'a proposal for a meeting that is already booked is refused');
select pg_temp.p1r_check((select outcome from crm.p1r_save_scheduling_draft(:'mprop', 'confirmation', 'en', 'x')) = 'wrong_state', 'and a confirmation for one that is not');
select pg_temp.p1r_check((select outcome from crm.p1r_save_scheduling_draft(:'mp', 'confirmation', 'en', 'Booked: Thu 10 Dec 10:30 am IST.')) = 'saved', 'a confirmation for a booked meeting is saved');
select pg_temp.p1r_check((select outcome from crm.p1r_save_scheduling_draft(:'mprop', 'no_availability', 'en', 'Sorry, nothing is free then.')) = 'saved', 'a no-availability message is saved');
select pg_temp.p1r_check((select outcome from crm.p1r_save_scheduling_draft(:'mp', 'clarification', 'en', 'Which meeting do you mean?')) = 'saved', 'a clarification is saved');
select pg_temp.p1r_check((select outcome from crm.p1r_save_scheduling_draft(:'mp', 'clarification', 'fr', 'x')) = 'bad_language', 'a language the drafts do not cover is refused');
select pg_temp.p1r_check((select outcome from crm.p1r_save_scheduling_draft(:'mp', 'clarification', 'en', '   ')) = 'bad_body', 'an empty body is refused');
select pg_temp.p1r_check((select outcome from crm.p1r_save_scheduling_draft(:'mp', 'invoice', 'en', 'x')) = 'bad_kind', 'an unknown kind is refused');
select pg_temp.p1r_check((select outcome from crm.p1r_record_scheduling_draft_sent(:'d1')) = 'person_required', 'the service role cannot record a send: an agent composes, a person sends');
select pg_temp.p1r_as_user(:'SOTHU', :'SOTH', 'owner');
select pg_temp.p1r_check((select outcome from crm.p1r_record_scheduling_draft_sent(:'d1')) = 'forbidden', 'another organisation cannot');
select pg_temp.p1r_check((select outcome from crm.p1r_save_scheduling_draft(:'mprop', 'proposal', 'en', 'x')) = 'forbidden', 'nor save one against this meeting');
select pg_temp.p1r_check((select count(*) from crm.p1r_open_scheduling_drafts()) = 0, 'nor read the queue');
select pg_temp.p1r_as_user(:'SMEM', :'SORG', 'member');
select pg_temp.p1r_check((select count(*) from crm.p1r_open_scheduling_drafts()) = 4, 'a member reads the four open drafts');
select pg_temp.p1r_check((select outcome from crm.p1r_discard_scheduling_draft((select draft_id from crm.p1r_open_scheduling_drafts() where kind = 'no_availability'), '')) = 'missing_reason', 'discarding needs a reason');
select pg_temp.p1r_check((select outcome from crm.p1r_discard_scheduling_draft((select draft_id from crm.p1r_open_scheduling_drafts() where kind = 'no_availability'), 'the lead called instead')) = 'discarded', 'a person discards one with a reason');
select pg_temp.p1r_check((select outcome from crm.p1r_record_scheduling_draft_sent(:'d1')) = 'recorded', 'a person records that they sent a draft');
select pg_temp.p1r_check((select sent_by from crm.p1r_scheduling_drafts where id = :'d1') = :'SMEM' and (select sent_at from crm.p1r_scheduling_drafts where id = :'d1') is not null, 'the draft says who sent it and when');
select pg_temp.p1r_check((select outcome from crm.p1r_record_scheduling_draft_sent(:'d1')) = 'not_a_draft', 'a draft is sent once');
select pg_temp.p1r_check((select count(*) from crm.p1r_open_scheduling_drafts()) = 2, 'sent and discarded drafts leave the queue');
select pg_temp.p1r_check((select count(*) from crm.conversation_messages cm where cm.organization_id = :'SORG') = 0, 'still no message was written by any of it: the send is the ordinary outbound path');
set local role authenticated;
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$update crm.p1r_scheduling_drafts set status = 'sent' where id = %L$f$, :'d1'), '42501'), 'a signed-in role cannot write the drafts table directly: only the doors can');
reset role;

-- ── reminder delivery metrics ──────────────────────────────────────────────
select pg_temp.p1r_as_service();
insert into crm.conversations (organization_id, channel, kind, title) values (:'SORG', 'whatsapp', 'internal_group', 'zztest internal') returning id as grp \gset
insert into crm.conversation_messages (organization_id, conversation_id, seq, author_type, body, external_ref, metadata, occurred_at) values
  (:'SORG', :'grp', 1, 'system', 'Reminder 1', 'meeting-reminder:a:30:x', '{"direction":"outbound","delivery":"sent","wire_status":"read"}', now() - interval '1 day'),
  (:'SORG', :'grp', 2, 'system', 'Reminder 2', 'meeting-reminder:b:30:x', '{"direction":"outbound","delivery":"sent","wire_status":"delivered"}', now() - interval '1 day'),
  (:'SORG', :'grp', 3, 'system', 'Reminder 3', 'meeting-reminder:c:30:x', '{"direction":"outbound","delivery":"sent"}', now() - interval '1 day'),
  (:'SORG', :'grp', 4, 'system', 'Reminder 4', 'meeting-reminder:d:30:x', '{"direction":"outbound","delivery":"failed"}', now() - interval '1 day'),
  (:'SORG', :'grp', 5, 'system', 'Reminder 5', 'meeting-reminder:e:30:x', '{"direction":"outbound","delivery":"sent","wire_status":"failed"}', now() - interval '1 day'),
  (:'SORG', :'grp', 6, 'system', 'Not a reminder', 'meeting-booked:f', '{"direction":"outbound","delivery":"sent","wire_status":"read"}', now() - interval '1 day');
insert into core.jobs (organization_id, kind, payload, status, run_at, dedupe_key) values
  (:'SORG', 'meeting.reminder', '{}', 'succeeded', now() - interval '1 day', 'p1r:rj:1'),
  (:'SORG', 'meeting.reminder', '{}', 'succeeded', now() - interval '1 day', 'p1r:rj:2'),
  (:'SORG', 'meeting.reminder', '{}', 'failed', now() - interval '1 day', 'p1r:rj:3'),
  (:'SORG', 'meeting.reminder', '{}', 'dead', now() - interval '1 day', 'p1r:rj:4'),
  (:'SORG', 'meeting.reminder', '{}', 'queued', now() - interval '2 hours', 'p1r:rj:5');
select pg_temp.p1r_as_user(:'SMEM', :'SORG', 'member');
select jobs as mj, jobs_done as mjd, jobs_failed as mjf, jobs_dead as mjdead, jobs_queued as mjq, messages as mm, handed_off as mh, send_failed as msf, delivered as md, read as mr, wire_failed as mwf, awaiting_receipt as mar, delivery_rate as mdr, failure_rate as mfr
  from crm.p1r_reminder_metrics() \gset
select pg_temp.p1r_check(:'mj' = 5 and :'mjd' = 2 and :'mjf' = 1 and :'mjdead' = 1 and :'mjq' = 1, 'the reminder jobs are counted by state');
select pg_temp.p1r_check(:'mm' = 5, 'only reminder messages are counted, not the booking announcement');
select pg_temp.p1r_check(:'mh' = 4 and :'msf' = 1 and :'md' = 2 and :'mr' = 1 and :'mwf' = 1 and :'mar' = 1, 'delivery receipts: handed off, delivered, read, failed on the wire, awaiting a receipt');
select pg_temp.p1r_check(:'mdr' = 0.5 and :'mfr' = 0.4, 'delivery rate is delivered over handed off; failure rate is failed over all');
select pg_temp.p1r_as_user(:'SOTHU', :'SOTH', 'owner');
select pg_temp.p1r_check((select messages from crm.p1r_reminder_metrics()) = 0 and (select jobs from crm.p1r_reminder_metrics()) = 0, 'another organisation counts none of them');
select pg_temp.p1r_as_service();
select pg_temp.p1r_check((select count(*) from crm.p1r_reminder_metrics()) = 0, 'the service identity reads none: it is a person''s screen');

-- ── tenancy ────────────────────────────────────────────────────────────────
select pg_temp.p1r_check((select count(*) from core.unguarded_org_fks() u where u.child in ('crm.p1r_scheduling_drafts', 'crm.p1r_provider_checks', 'crm.p1r_overlap_rule')) = 0, 'TENANCY: every organisation-scoped foreign key of the new tables is guarded');

-- ── red-proofs: remove each control from the LIVE definition and see the check fail ──
select pg_temp.p1r_as_service();
-- 1. the overlap test
select pg_temp.p1r_mutate('crm.p1r_enforce_no_overlap()'::regprocedure, 'if v_other is not null then', 'if false then');
select pg_temp.p1r_check((select pg_temp.p1r_book(:'SORG', :'lead', timestamptz '2026-12-09 05:20+00', 30)) is not null, 'RED-PROOF: without the overlap test two meetings take the same time (the control is what refuses it)');
-- 2. the provider comparison
select pg_temp.p1r_book(:'SORG', :'lead', timestamptz '2026-12-12 05:00+00', 30) as mq \gset
select pg_temp.p1r_mutate('crm.p1r_record_provider_check(uuid,text,timestamptz,timestamptz,text)'::regprocedure, '    else ''conflict''', '    else ''in_sync''');
select outcome as red2 from crm.p1r_record_provider_check(:'mq', 'cancelled') \gset
select pg_temp.p1r_check(:'red2' = 'in_sync' and (select count(*) from crm.p1o_meeting_flags where meeting_id = :'mq') = 0, 'RED-PROOF: without the comparison a cancelled event is called in sync and nobody is told');
-- 3. the person-only send
select pg_temp.p1r_mutate('crm.p1r_record_scheduling_draft_sent(uuid,uuid)'::regprocedure, 'if (select auth.uid()) is null then return query select ''person_required''::text; return; end if;', 'null;');
select draft_id as d3 from crm.p1r_save_scheduling_draft(:'mp', 'clarification', 'en', 'red 3') \gset
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$select * from crm.p1r_record_scheduling_draft_sent(%L)$f$, :'d3'), '23514'),
  'RED-PROOF: with the named person check removed the service role is no longer refused by name; only the table''s own constraint (a send names who sent it) stops it, which is why both layers exist');

rollback;
\echo 'verify-p1r-scheduler: all checks passed'
