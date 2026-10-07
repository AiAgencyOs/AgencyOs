-- ═══════════════════════════════════════════════════════════════════════════
-- P1-SCHED-030 / P1-FLOW-028: a meeting that becomes booked or cancelled writes exactly one outbox event, whichever door moved it.
-- Real table, real trigger, scratch Postgres; rolls back.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-meeting-events.sql
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok  %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'

insert into crm.leads (organization_id, title) values (:'ORG', 'zztest meeting events lead') returning id \gset L_

-- a requested meeting emits nothing
insert into crm.meetings (organization_id, lead_id, requested_mode, status) values (:'ORG', :'L_id', 'video_meeting', 'requested') returning id \gset M1_
select pg_temp.check((select count(*) from core.outbox_events where subject_id = :'M1_id') = 0, 'a requested meeting writes no event');

-- booking it writes meeting.booked once, naming ids and times and no client words
update crm.meetings set status = 'booked', booked_mode = 'video_meeting', confirmed_start_at = now() + interval '2 days', confirmed_end_at = now() + interval '2 days 30 minutes',
       availability_source = 'verifier', availability_read_at = now(), timezone = 'Asia/Kolkata', purpose = 'scope walk-through' where id = :'M1_id';
select pg_temp.check((select count(*) from core.outbox_events where type = 'meeting.booked' and subject_id = :'M1_id') = 1, 'booking writes one meeting.booked');
select pg_temp.check((select payload->>'leadId' from core.outbox_events where type = 'meeting.booked' and subject_id = :'M1_id') = :'L_id'
                     and (select payload->>'purpose' from core.outbox_events where type = 'meeting.booked' and subject_id = :'M1_id') = 'scope walk-through', 'the event names the lead, the time and the purpose');

-- an unrelated update, and a same-status update, write nothing more
update crm.meetings set purpose = 'scope walk-through and budget' where id = :'M1_id';
update crm.meetings set status = 'booked' where id = :'M1_id';
select pg_temp.check((select count(*) from core.outbox_events where type = 'meeting.booked' and subject_id = :'M1_id') = 1, 'an update that does not change status writes no second event');

-- cancelling writes meeting.cancelled with the reason and whether it had been booked
update crm.meetings set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'rescheduled by the client' where id = :'M1_id';
select pg_temp.check((select count(*) from core.outbox_events where type = 'meeting.cancelled' and subject_id = :'M1_id') = 1, 'cancelling writes one meeting.cancelled');
select pg_temp.check((select payload->>'reason' from core.outbox_events where type = 'meeting.cancelled' and subject_id = :'M1_id') = 'rescheduled by the client'
                     and (select (payload->>'wasBooked')::boolean from core.outbox_events where type = 'meeting.cancelled' and subject_id = :'M1_id'), 'it carries the reason and that the meeting had been booked');

-- a meeting inserted already booked is announced too; a proposal that is cancelled was never booked
insert into crm.meetings (organization_id, lead_id, requested_mode, status, booked_mode, confirmed_start_at, confirmed_end_at, availability_source, availability_read_at, timezone)
  values (:'ORG', :'L_id', 'call', 'booked', 'call', now() + interval '3 days', now() + interval '3 days 15 minutes', 'verifier', now(), 'Asia/Kolkata') returning id \gset M2_
select pg_temp.check((select count(*) from core.outbox_events where type = 'meeting.booked' and subject_id = :'M2_id') = 1, 'a meeting inserted already booked is announced');
insert into crm.meetings (organization_id, lead_id, requested_mode, status) values (:'ORG', :'L_id', 'call', 'requested') returning id \gset M3_
update crm.meetings set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'client withdrew' where id = :'M3_id';
select pg_temp.check((select (payload->>'wasBooked')::boolean from core.outbox_events where type = 'meeting.cancelled' and subject_id = :'M3_id') = false, 'a never-booked meeting cancels with wasBooked = false');

rollback;
\echo 'verify-meeting-events: all checks passed'
