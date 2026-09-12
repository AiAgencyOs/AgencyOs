-- ═══════════════════════════════════════════════════════════════════════════
-- A retry that books twice — G-227
-- ═══════════════════════════════════════════════════════════════════════════
--
-- P0, and the failure the Scheduler specification returns to more than any
-- other. §6.3: "Use idempotency to prevent duplicate bookings" and "Verify
-- provider response before reporting success." §14: "Provider timeout | Retry
-- transiently, VERIFY ACTUAL PROVIDER STATE BEFORE RETRY | Avoid
-- double-booking." Master Development Plan V3 §19 makes "Worker crash during
-- booking → second booking created" a HARD FAIL.
--
-- The shape is familiar, because this repository has fixed it before: D1, D2
-- and D4 were all check-then-write gaps closed with a lock, and
-- `proposals_live_version_key`, `jobs_dedupe_key_key` and "one live invoice
-- per milestone" are all partial unique indexes doing what an application
-- pre-check cannot. Booking is the same problem wearing a calendar.
--
-- ── three rules, and what each is for ─────────────────────────────────────
--
-- 1. **The booking key.** One logical attempt carries one key; a retry of that
--    attempt carries the same one. `meetings_booking_key` makes two rows with
--    it unrepresentable, so the SECOND attempt cannot create a second booking
--    even if the first one's answer was lost on the wire — which is precisely
--    the case a timeout leaves behind.
--
-- 2. **The provider event.** `meetings_provider_event_key` makes one external
--    event map to exactly one meeting. The API specification's own rule:
--    external IDs map to stable internal IDs, and provider state is kept
--    separate from domain state. Without it, a reconciliation that re-reads
--    the calendar can attach the same event to a second row and call it a
--    second meeting.
--
-- 3. **A booking that names a provider must name the event.**
--    `meetings_booked_provider_is_evidenced`. "We think we created it" is the
--    false success §14 exists to forbid: either the provider confirmed and
--    there is an id, or nothing was confirmed and this is not a booking.
--
-- ── the re-check, and why staleness is measured rather than assumed ───────
--
-- §5.1 ends with "Re-check availability immediately before committing the
-- booking." G-226 stored `availability_read_at` for exactly this moment.
-- `crm.book_meeting` refuses an answer older than the caller's freshness
-- bound rather than trusting it — because the gap between reading a calendar
-- and writing to it is where the other party's booking lands, and §14's "Slot
-- changes during booking | Provider conflict | Recheck + alternatives" is
-- that gap named.
--
-- The bound is the CALLER's, with a ceiling here that the caller cannot
-- raise. A generous freshness is a slower way of not checking.
--
-- ── what this deliberately does NOT do ────────────────────────────────────
--
-- It does not prevent two DIFFERENT meetings overlapping in time. §8's "Never
-- overwrite another booking" is about a second write to one calendar slot, and
-- deciding whether two meetings collide needs an owner or resource — which
-- attendee's calendar is being filled — and `crm.meetings` has no owner column
-- because nothing has yet said whether a meeting belongs to a sales owner, a
-- resource, or the agency as a whole. Inventing one here to satisfy a
-- constraint would be inventing a business fact. Recorded rather than quietly
-- skipped; it belongs with the provider adapter (BLK-005), which is where
-- "whose calendar" is finally answered.
-- ═══════════════════════════════════════════════════════════════════════════

alter table crm.meetings
  add column if not exists booking_key text,
  add column if not exists booked_at timestamptz;

comment on column crm.meetings.booking_key is
  'One logical booking attempt. A retry of the same attempt carries the same key, and meetings_booking_key makes a second row holding it unrepresentable - so a lost answer cannot become a second meeting (Scheduler specification section 6.3).';

comment on column crm.meetings.booked_at is
  'When this became a booking. Distinct from created_at (the request arrived) and from confirmed_start_at (when the meeting is), both of which answer different questions.';

-- ── 1. one attempt, one booking ──────────────────────────────────────────
create unique index if not exists meetings_booking_key
  on crm.meetings (organization_id, booking_key)
  where booking_key is not null;

-- ── 2. one external event, one meeting ───────────────────────────────────
create unique index if not exists meetings_provider_event_key
  on crm.meetings (provider, provider_event_id)
  where provider is not null and provider_event_id is not null;

-- ── 3. a booking that claims a provider must show the receipt ────────────
alter table crm.meetings
  drop constraint if exists meetings_booked_provider_is_evidenced;

alter table crm.meetings
  add constraint meetings_booked_provider_is_evidenced check (
    status <> 'booked'
    or provider is null
    or provider_event_id is not null
  ) not valid;

comment on constraint meetings_booked_provider_is_evidenced on crm.meetings is
  'Scheduler specification section 6.3: "Verify provider response before reporting success", and section 14: a provider outage must never produce a false booking success. Either the provider confirmed and there is an event id, or nothing was confirmed and this is not a booking. A null provider is the deployment with no calendar (BLK-005), which is a different thing from a provider that did not answer.';


-- ═══════════════════════════════════════════════════════════════════════════
-- crm.book_meeting — the only door a booking goes through
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Everything above is a rule the row holds. This is the one operation that
-- satisfies them together, under a lock, so that the check and the write are
-- not two statements with a gap between them — which is the defect D1, D2 and
-- D4 all were.
--
-- Idempotent by construction: a second call with the same booking key finds
-- the row the first one wrote and answers `already_booked` with its id. That
-- is what makes a retry safe rather than merely bounded.

create or replace function crm.book_meeting(
  p_meeting_id           uuid,
  p_booking_key          text,
  p_start_at             timestamptz,
  p_end_at               timestamptz,
  p_timezone             text,
  p_mode                 text,
  p_provider             text default null,
  p_provider_event_id    text default null,
  p_meeting_url          text default null,
  p_max_staleness_seconds int default 300
)
returns table (
  -- 'booked' | 'already_booked' | 'not_found' | 'wrong_state'
  -- | 'stale_availability' | 'never_checked' | 'incomplete' | 'unverified_provider'
  -- | 'key_taken' | 'event_taken' | 'forbidden'
  outcome    text,
  meeting_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  -- The caller's bound, and the one they cannot raise. A generous freshness is
  -- a slower way of not checking.
  c_max_staleness constant int := 900;
  v_staleness     int := least(greatest(coalesce(p_max_staleness_seconds, 300), 1), c_max_staleness);
  -- Who is asking. Null is the service role — the worker, whose retries are
  -- the whole reason this function is idempotent — and it is trusted, exactly
  -- as crm.commit_import_record, core.set_organization_setting and every
  -- other authority-gated function here treat it. The first draft compared
  -- the row's tenant to core.current_organization_id() unconditionally, and
  -- that helper is null for the service role, so every worker call answered
  -- 'forbidden'. Found by review.
  v_actor         uuid := (select auth.uid());
  v_row           crm.meetings;
  v_other         uuid;
  v_key           text := nullif(btrim(coalesce(p_booking_key, '')), '');
begin
  if v_key is null then
    return query select 'incomplete'::text, null::uuid; return;
  end if;

  -- THE LOCK COMES FIRST, and every decision is made under it. The first
  -- draft answered the idempotent case before locking, "so a retry is cheap"
  -- — and a retry racing the attempt it retried could not see that attempt's
  -- uncommitted row, waited on the lock, then read the booked row and was
  -- told 'wrong_state' about its own success. Cheap and wrong. Found by
  -- review, and by the eight-way race in verify-booking.mjs, which the first
  -- draft could not have passed.
  select m.* into v_row
    from crm.meetings m
   where m.id = p_meeting_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and v_row.organization_id is distinct from (select core.current_organization_id()) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  -- The idempotent answer. Same key on THIS row means this attempt already
  -- succeeded, whether a second ago or a day ago. Deliberately not an error:
  -- the caller asking twice is the caller having been unsure, which is the
  -- situation this whole function exists for.
  if v_row.booking_key = v_key then
    return query select 'already_booked'::text, v_row.id; return;
  end if;

  -- Same key on a DIFFERENT meeting is a caller bug rather than a retry, and
  -- answering 'already_booked' would hide it behind a success. Scoped by the
  -- row's own organization, not the caller's claim about theirs.
  select m.id into v_other
    from crm.meetings m
   where m.organization_id = v_row.organization_id
     and m.booking_key = v_key
     and m.id <> v_row.id;

  if v_other is not null then
    return query select 'key_taken'::text, v_other; return;
  end if;

  -- Only a live request or a standing proposal becomes a booking. `booked`
  -- reaching here with a DIFFERENT key means another attempt already booked
  -- this meeting, which is not this attempt's to overwrite.
  if v_row.status not in ('requested', 'proposed') then
    return query select 'wrong_state'::text, v_row.id; return;
  end if;

  if p_start_at is null or p_end_at is null or p_timezone is null or p_mode is null then
    return query select 'incomplete'::text, v_row.id; return;
  end if;

  if p_end_at <= p_start_at then
    return query select 'incomplete'::text, v_row.id; return;
  end if;

  -- G-226's floor, asked again here: a booking cannot rest on an answer that
  -- was never read.
  if v_row.availability_read_at is null or v_row.availability_source is null then
    return query select 'never_checked'::text, v_row.id; return;
  end if;

  -- §5.1's re-check, as a measurement rather than a hope. The gap between
  -- reading a calendar and writing to it is where the other party's booking
  -- lands.
  if v_row.availability_read_at < (clock_timestamp() - make_interval(secs => v_staleness)) then
    return query select 'stale_availability'::text, v_row.id; return;
  end if;

  -- §6.3. A provider named without the event it created is "we think it
  -- worked", which is the false success §14 forbids. Checked here as well as
  -- at the row so the caller gets a name for it rather than a constraint.
  if p_provider is not null and nullif(btrim(coalesce(p_provider_event_id, '')), '') is null then
    return query select 'unverified_provider'::text, v_row.id; return;
  end if;

  update crm.meetings
     set status            = 'booked',
         booking_key       = v_key,
         booked_at         = clock_timestamp(),
         confirmed_start_at = p_start_at,
         confirmed_end_at   = p_end_at,
         timezone          = p_timezone,
         booked_mode       = p_mode,
         duration_minutes  = greatest(1, (extract(epoch from (p_end_at - p_start_at)) / 60)::int),
         provider          = p_provider,
         provider_event_id = nullif(btrim(coalesce(p_provider_event_id, '')), ''),
         meeting_url       = nullif(btrim(coalesce(p_meeting_url, '')), '')
   where crm.meetings.id = v_row.id;

  perform core.record_audit(
    v_row.organization_id,
    'meeting.booked',
    'meeting',
    v_row.id,
    jsonb_build_object('status', v_row.status),
    jsonb_build_object(
      'status', 'booked',
      'start_at', p_start_at,
      'timezone', p_timezone,
      'mode', p_mode,
      'provider', p_provider,
      'availability_read_at', v_row.availability_read_at
    )
  );

  return query select 'booked'::text, v_row.id;

exception
  -- The two indexes above, turned back into the answer the loser of a race
  -- gets. With the key check now under the row lock this is reachable only
  -- for the provider event, which two DIFFERENT meetings can still contend
  -- for — but the handler stays general, because a handler that assumes it
  -- knows which constraint fired is the next silent misreport.
  when unique_violation then
    if sqlerrm like '%meetings_provider_event_key%' then
      return query select 'event_taken'::text, p_meeting_id; return;
    end if;
    return query select 'key_taken'::text, p_meeting_id; return;
end;
$$;
comment on function crm.book_meeting(uuid, text, timestamptz, timestamptz, text, text, text, text, text, int) is
  'G-227. The only door a booking goes through: idempotent on booking_key (a retry of an attempt that already succeeded gets already_booked and its id), refuses an availability answer older than the caller''s freshness bound (Scheduler specification section 5.1 re-check), refuses a provider named without the event id proving it answered (section 6.3), and turns a lost race on either unique index back into a named outcome rather than an exception. Does NOT prevent two different meetings overlapping - that needs an owner or resource column nothing has yet decided on, and inventing one to satisfy a constraint would be inventing a business fact.';

revoke all on function crm.book_meeting(uuid, text, timestamptz, timestamptz, text, text, text, text, text, int) from public, anon;
grant execute on function crm.book_meeting(uuid, text, timestamptz, timestamptz, text, text, text, text, text, int) to authenticated, service_role;

-- No `core.event_types` row is added here, deliberately.
--
-- `meeting.booked` above is an AUDIT action, which is a record of what
-- happened. An outbox event is a promise that something will consume it, and
-- nothing does yet — the Sales reactivation that would is G-229. G-106 closed
-- exactly this shape on the other side: a publish helper nobody called was not
-- harmless, because it was the one the next module reached for. A declared
-- event type with no emitter and no subscriber is the same object seen from
-- the registry end.
