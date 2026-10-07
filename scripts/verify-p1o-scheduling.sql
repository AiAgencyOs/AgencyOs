-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 Scheduler: policy, working hours, offer expiry, contact timezone, flags for a person, metrics (migration 20261127100000).
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p1o-scheduling.sql     Rolls back. Any failed check raises.
-- ═══════════════════════════════════════════════════════════════════════════
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
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '{"role":"service_role"}', true); end $$;
grant execute on function pg_temp.as_service() to public;
create or replace function pg_temp.fails_with(stmt text, code text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when others then return sqlstate = code; end $$;
grant execute on function pg_temp.fails_with(text, text) to public;
create or replace function pg_temp.p1o_mutate(fn regprocedure, from_text text, to_text text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(fn); n text;
begin
  n := replace(d, from_text, to_text);
  if n = d then raise exception 'RED-PROOF MUTATION CHANGED NOTHING: % / %', fn, from_text; end if;
  execute n;
end $$;
grant execute on function pg_temp.p1o_mutate(regprocedure, text, text) to public;

\set SORG '00000000-0000-4000-8000-0000000a0200'
\set SOWN '00000000-0000-4000-8000-0000000a0201'
\set SMEM '00000000-0000-4000-8000-0000000a0202'
\set SOTH '00000000-0000-4000-8000-0000000a0210'
\set SOTHU '00000000-0000-4000-8000-0000000a0211'

insert into auth.users (id, email) values (:'SOWN', 'p1o-s-owner@example.test'), (:'SMEM', 'p1o-s-member@example.test'), (:'SOTHU', 'p1o-s-other@example.test');
insert into core.users (id, email, full_name) values (:'SOWN', 'p1o-s-owner@example.test', 'S Owner'), (:'SMEM', 'p1o-s-member@example.test', 'S Member'), (:'SOTHU', 'p1o-s-other@example.test', 'S Other') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'SORG', 'zztest p1o sched', 'zztest-p1o-sched'), (:'SOTH', 'zztest p1o sched other', 'zztest-p1o-sched-other');
insert into core.memberships (organization_id, user_id, role) values (:'SORG', :'SOWN', 'owner'), (:'SORG', :'SMEM', 'member'), (:'SOTH', :'SOTHU', 'owner');
insert into crm.leads (organization_id, title) values (:'SORG', 'zztest p1o sched lead') returning id as lead \gset
insert into crm.contacts (organization_id, full_name, email) values (:'SORG', 'zztest p1o contact', 'p1o-contact@example.test') returning id as contact \gset

-- ── defaults: an organisation with no row behaves as before ───────────────
select pg_temp.as_service();
select pg_temp.check((select not configured and min_notice_minutes = 60 and buffer_minutes = 15 and durations = '{30,45,60}' from crm.p1o_scheduling_policy_for(:'SORG')), 'no policy row: the old hard-coded rules are the defaults');
select pg_temp.check(crm.p1o_within_working_hours(:'SORG', timestamptz '2026-12-06 03:00+00', timestamptz '2026-12-06 04:00+00'), 'no hours configured: nothing is outside them');

-- ── setting the policy is an administrator's act ──────────────────────────
select pg_temp.as_user(:'SMEM', :'SORG', 'member');
select pg_temp.check((select outcome from crm.p1o_set_scheduling_policy(:'SORG', '{"min_notice_minutes":30}')) = 'forbidden', 'a plain member cannot set the policy');
select pg_temp.as_user(:'SOTHU', :'SOTH', 'owner');
select pg_temp.check((select outcome from crm.p1o_set_scheduling_policy(:'SORG', '{"min_notice_minutes":30}')) = 'forbidden', 'another organisation''s owner cannot');
select pg_temp.as_user(:'SOWN', :'SORG', 'owner');
select pg_temp.check((select outcome from crm.p1o_set_scheduling_policy(:'SORG', '{"working_hours":{"mon":[{"start":"19:00","end":"10:00"}]}}')) = 'refused', 'hours that end before they start are refused');
select pg_temp.check((select outcome from crm.p1o_set_scheduling_policy(:'SORG', '{"enforce_working_hours":true}')) = 'refused', 'enforcement with no hours to enforce is refused');
select pg_temp.check((select outcome from crm.p1o_set_scheduling_policy(:'SORG', '{"timezone":"Mars/Olympus"}')) = 'refused', 'an unknown timezone is refused');
select pg_temp.check((select outcome from crm.p1o_set_scheduling_policy(:'SORG', '{"working_hours":{"mon":[{"start":"10:00","end":"19:00"}],"tue":[{"start":"10:00","end":"19:00"}],"wed":[{"start":"10:00","end":"19:00"}],"thu":[{"start":"10:00","end":"19:00"}],"fri":[{"start":"10:00","end":"19:00"}]},"enforce_working_hours":true,"proposal_ttl_hours":24,"durations":[20,40],"min_notice_minutes":120}')) = 'set', 'an administrator sets the policy');
select pg_temp.check((select configured and min_notice_minutes = 120 and durations = '{20,40}' and proposal_ttl_hours = 24 and enforce_working_hours from crm.p1o_scheduling_policy_for(:'SORG')), 'the policy reads back');
select pg_temp.check((select count(*) from audit.audit_log where organization_id = :'SORG' and action = 'scheduling_policy.set') = 1, 'setting it is audited');

-- ── working hours ─────────────────────────────────────────────────────────
select pg_temp.as_service();
select pg_temp.check(crm.p1o_within_working_hours(:'SORG', timestamptz '2026-12-02 05:00+00', timestamptz '2026-12-02 05:45+00'), 'Wednesday 10:30 IST is inside Mon-Fri 10-19');
select pg_temp.check(not crm.p1o_within_working_hours(:'SORG', timestamptz '2026-12-06 05:00+00', timestamptz '2026-12-06 05:45+00'), 'Sunday is outside');
select pg_temp.check(not crm.p1o_within_working_hours(:'SORG', timestamptz '2026-12-02 13:00+00', timestamptz '2026-12-02 14:00+00'), 'Wednesday 18:30-19:30 IST runs past closing');
select pg_temp.check(not crm.p1o_within_working_hours(:'SORG', timestamptz '2026-12-02 03:00+00', timestamptz '2026-12-02 04:00+00'), 'Wednesday 08:30 IST is before opening');
insert into crm.meetings (organization_id, lead_id, requested_mode, status) values (:'SORG', :'lead', 'video_meeting', 'requested') returning id as m1 \gset
select pg_temp.check(pg_temp.fails_with(format($f$update crm.meetings set status = 'booked', booked_mode = 'video_meeting', confirmed_start_at = timestamptz '2026-12-06 05:00+00', confirmed_end_at = timestamptz '2026-12-06 05:30+00',
  timezone = 'Asia/Kolkata', availability_source = 'v', availability_read_at = now() where id = %L$f$, :'m1'), '23514'), 'a Sunday booking is refused where enforcement is on');
update crm.meetings set status = 'booked', booked_mode = 'video_meeting', confirmed_start_at = timestamptz '2026-12-02 05:00+00', confirmed_end_at = timestamptz '2026-12-02 05:30+00',
  timezone = 'Asia/Kolkata', availability_source = 'v', availability_read_at = now() where id = :'m1';
select pg_temp.check((select status from crm.meetings where id = :'m1') = 'booked', 'a Wednesday booking is accepted');
-- an organisation with no policy is unaffected
insert into crm.leads (organization_id, title) values (:'SOTH', 'zztest p1o other lead') returning id as olead \gset
insert into crm.meetings (organization_id, lead_id, requested_mode, status, booked_mode, confirmed_start_at, confirmed_end_at, timezone, availability_source, availability_read_at)
  values (:'SOTH', :'olead', 'call', 'booked', 'call', timestamptz '2026-12-06 05:00+00', timestamptz '2026-12-06 05:30+00', 'Asia/Kolkata', 'v', now());
select pg_temp.check((select count(*) from crm.meetings where organization_id = :'SOTH' and status = 'booked') = 1, 'an organisation with no policy can still book a Sunday: nothing changed for it');

-- ── an offer expires ──────────────────────────────────────────────────────
insert into crm.meetings (organization_id, lead_id, requested_mode, status) values (:'SORG', :'lead', 'call', 'requested') returning id as m2 \gset
update crm.meetings set status = 'proposed', proposed_slots = '[{"startAt":"2026-12-03T05:00:00Z","endAt":"2026-12-03T05:30:00Z"}]'::jsonb,
  availability_source = 'v', availability_read_at = now(), duration_minutes = 30 where id = :'m2';
select pg_temp.check((select proposal_expires_at between now() + interval '23 hours' and now() + interval '25 hours' from crm.meetings where id = :'m2'), 'an offer is stamped to expire after the policy''s 24 hours');
update crm.meetings set proposal_expires_at = now() - interval '1 hour' where id = :'m2';
select pg_temp.check(pg_temp.fails_with(format($f$update crm.meetings set status = 'booked', booked_mode = 'call', confirmed_start_at = timestamptz '2026-12-03 05:00+00', confirmed_end_at = timestamptz '2026-12-03 05:30+00', timezone = 'Asia/Kolkata' where id = %L$f$, :'m2'), '23514'), 'booking an expired offer is refused');
select pg_temp.as_user(:'SOWN', :'SORG', 'owner');
select pg_temp.check(pg_temp.fails_with(format($f$select * from crm.p1o_expire_stale_proposals(%L)$f$, :'SORG'), '42501'), 'the expiry sweep is a runner door');
select pg_temp.as_service();
select expired as ex from crm.p1o_expire_stale_proposals(:'SORG') \gset
select pg_temp.check(:'ex' = '1' and (select status from crm.meetings where id = :'m2') = 'cancelled', 'the sweep cancels the lapsed offer');
select pg_temp.check((select count(*) from crm.p1o_meeting_flags where meeting_id = :'m2' and kind = 'proposal_expired' and state = 'open') = 1, 'and leaves a flag for a person to offer new times');
select pg_temp.check((select count(*) from core.outbox_events where organization_id = :'SORG' and type = 'meeting.cancelled' and subject_id = :'m2' and (payload->>'wasBooked')::boolean is false) = 1, 'the cancellation event says it was never booked, so no one is told a meeting was cancelled');

-- ── contact timezone ──────────────────────────────────────────────────────
select pg_temp.check((select basis from crm.p1o_meeting_timezone(:'m1')) = 'meeting_timezone' and not (select must_ask from crm.p1o_meeting_timezone(:'m1')), 'a meeting that already has a zone keeps it');
insert into crm.meetings (organization_id, lead_id, contact_id, requested_mode, status) values (:'SORG', :'lead', :'contact', 'call', 'requested') returning id as m3 \gset
select pg_temp.check((select must_ask and basis = 'agency_default_unconfirmed' from crm.p1o_meeting_timezone(:'m3')), 'no zone anywhere: a person must ask, the agency default is flagged as a guess');
select pg_temp.as_user(:'SOWN', :'SORG', 'owner');
select pg_temp.check((select outcome from crm.p1o_set_contact_timezone(:'contact', 'Nowhere/Land', 'staff_entered')) = 'unknown_timezone', 'an unknown zone is refused');
select pg_temp.check((select outcome from crm.p1o_set_contact_timezone(:'contact', 'America/New_York', 'location_inferred', true)) = 'set', 'an inferred zone is stored');
select pg_temp.check(not (select timezone_verified from crm.contacts where id = :'contact'), 'an inferred zone is never marked verified, even if asked');
select pg_temp.check((select basis from crm.p1o_meeting_timezone(:'m3')) = 'stored_contact_timezone_unverified' and not (select must_ask from crm.p1o_meeting_timezone(:'m3')), 'a stored but unverified zone is used and labelled so');
select pg_temp.check((select outcome from crm.p1o_set_contact_timezone(:'contact', 'Europe/London', 'client_stated', true)) = 'set', 'the client states their zone');
select pg_temp.check((select basis from crm.p1o_meeting_timezone(:'m3')) = 'verified_contact_timezone' and (select timezone from crm.p1o_meeting_timezone(:'m3')) = 'Europe/London', 'a verified zone wins');

-- ── flags: what needs a person ────────────────────────────────────────────
select flag_id as f1 from crm.p1o_flag_meeting(:'m1', 'reschedule_request', 'client wants to move it to Thursday') \gset
select pg_temp.check(:'f1' is not null, 'a reschedule request becomes a flag for a person');
select pg_temp.check((select outcome from crm.p1o_flag_meeting(:'m1', 'reschedule_request', 'again')) = 'already_open', 'the same request is not flagged twice');
select pg_temp.check((select outcome from crm.p1o_flag_meeting(:'m1', 'ambiguous_cancel', 'which one?')) = 'needs_candidates', 'an ambiguous cancel must name the candidates');
select pg_temp.check((select outcome from crm.p1o_flag_meeting(:'m1', 'ambiguous_cancel', 'which one?', array[:'m1'::uuid, :'m3'::uuid])) = 'flagged', 'with candidates it is flagged');
select pg_temp.check((select outcome from crm.p1o_flag_meeting(:'m2', 'cancel_request', 'x')) = 'settled', 'a meeting that is already cancelled is not asked to be cancelled again');
select pg_temp.check((select outcome from crm.p1o_flag_meeting(:'m1', 'made_up', 'x')) = 'bad_kind', 'an unknown kind is refused');
select pg_temp.check((select count(*) from crm.p1o_open_meeting_flags()) = 3, 'the person sees the three open flags (reschedule, ambiguous cancel, expired offer)');
select pg_temp.as_user(:'SOTHU', :'SOTH', 'owner');
select pg_temp.check((select count(*) from crm.p1o_open_meeting_flags()) = 0 and (select outcome from crm.p1o_flag_meeting(:'m1', 'cancel_request', 'x')) = 'forbidden', 'another organisation sees none and cannot add');
select pg_temp.as_user(:'SOWN', :'SORG', 'owner');
select pg_temp.check((select outcome from crm.p1o_handle_meeting_flag(:'f1', '')) = 'missing_note', 'handling a flag needs a note');
select pg_temp.check((select outcome from crm.p1o_handle_meeting_flag(:'f1', 'rebooked for Thursday by phone')) = 'handled', 'a person handles it');
select pg_temp.check((select outcome from crm.p1o_handle_meeting_flag(:'f1', 'again')) = 'already_handled', 'once');
select pg_temp.check((select status from crm.meetings where id = :'m1') = 'booked', 'flagging and handling moved nothing: the meeting is still as the doors left it');

-- ── metrics ───────────────────────────────────────────────────────────────
select pg_temp.check((select requests from crm.p1o_scheduler_metrics()) = 3, 'requests are counted');
select pg_temp.check((select booked_ever from crm.p1o_scheduler_metrics()) = (select count(*) from crm.meetings where organization_id = :'SORG' and booked_at is not null), 'booked is counted from the door''s own stamp');
update crm.meetings set booked_at = now() where id = :'m1';
select pg_temp.check((select booked_ever from crm.p1o_scheduler_metrics()) = 1 and (select booking_rate from crm.p1o_scheduler_metrics()) = 0.333, 'booking rate is booked over requests');
select pg_temp.check((select cancelled from crm.p1o_scheduler_metrics()) = 1 and (select flags_open from crm.p1o_scheduler_metrics()) = 2 and (select proposals_expired from crm.p1o_scheduler_metrics()) = 1, 'cancellations, open flags and expired offers are counted');

-- ═══ red-proofs ═══
select pg_temp.as_service();
select pg_temp.p1o_mutate('crm.p1o_enforce_working_hours()', 'if coalesce(v_enforce, false) and', 'if false and');
insert into crm.meetings (organization_id, lead_id, requested_mode, status) values (:'SORG', :'lead', 'call', 'requested') returning id as m9 \gset
select pg_temp.check(not pg_temp.fails_with(format($f$update crm.meetings set status = 'booked', booked_mode = 'call', confirmed_start_at = timestamptz '2026-12-06 05:00+00', confirmed_end_at = timestamptz '2026-12-06 05:30+00', timezone = 'Asia/Kolkata', availability_source = 'v', availability_read_at = now() where id = %L$f$, :'m9'), '23514'), 'RED-PROOF: without the enforcement a Sunday booking goes through');
select pg_temp.p1o_mutate('crm.p1o_stamp_proposal_expiry()', 'and old.proposal_expires_at is not null and old.proposal_expires_at < now() then', 'and false then');
insert into crm.meetings (organization_id, lead_id, requested_mode, status) values (:'SORG', :'lead', 'call', 'requested') returning id as m10 \gset
update crm.meetings set status = 'proposed', proposed_slots = '[{"startAt":"2026-12-03T05:00:00Z","endAt":"2026-12-03T05:30:00Z"}]'::jsonb, availability_source = 'v', availability_read_at = now(), duration_minutes = 30 where id = :'m10';
update crm.meetings set proposal_expires_at = now() - interval '1 hour' where id = :'m10';
select pg_temp.check(not pg_temp.fails_with(format($f$update crm.meetings set status = 'booked', booked_mode = 'call', confirmed_start_at = timestamptz '2026-12-02 06:00+00', confirmed_end_at = timestamptz '2026-12-02 06:30+00', timezone = 'Asia/Kolkata' where id = %L$f$, :'m10'), '23514'), 'RED-PROOF: without the expiry check an expired offer is booked');
select pg_temp.p1o_mutate('ai.p1o_door_refusal(uuid,boolean)', 'if p_admin_only then', 'if false then');
select pg_temp.as_user(:'SMEM', :'SORG', 'member');
select pg_temp.check((select outcome from crm.p1o_set_scheduling_policy(:'SORG', '{"min_notice_minutes":5}')) = 'set', 'RED-PROOF: without the admin-only rule a plain member rewrites the policy');

rollback;
\echo 'verify-p1o-scheduling: all checks passed'
