-- ═══════════════════════════════════════════════════════════════════════════
-- A meeting is concluded by a person — G-237
--
-- Scheduler Agent Complete Responsibilities §8 (cancel: validate
-- authorization, do not delete history, cancel reminders; no-show: allow
-- authorized marking, do not infer completion from time alone), §9.1 (an
-- authorized user marks COMPLETED; capture actor, timestamp and outcome —
-- completed, no-show, cancelled, failed, follow-up required; never because
-- the end time passed), §9.2 (evidence linked to the exact meeting with
-- uploader, moment and classification, internal kept apart from
-- client-visible), §9.3 (MARK COMPLETED → VALIDATE EVIDENCE → LINK ARTIFACTS
-- → CREATE AI ANALYSIS TASK) and §13.2 (audit reschedule/cancellation,
-- completion marking, evidence upload).
--
-- G-225 put the state machine and the completion constraints at the row;
-- G-229 put the analysis gate behind a function. What was missing was a DOOR
-- for each conclusion. A09 (G-234) rendered cancel, complete, no-show and
-- attach-evidence as BLOCKED controls naming these four functions; a Server
-- Action writing crm.meetings directly would be exactly the shortcut Blueprint
-- §7 forbids. Four SECURITY DEFINER functions, each with the tenancy guard
-- explicit, each audited in the transaction, each answering a NAME.
--
-- Two rules the commands add that the row did not hold:
--
--   • A worker cannot conclude a meeting. crm.complete_meeting and
--     crm.record_no_show refuse a caller with no auth.uid() ('no_actor'):
--     §9.1's completion is a person's statement, and the constraint
--     meetings_completion_is_authorized already demands completed_by. The
--     cancel and evidence doors admit the service role — the Scheduler agent
--     cancels on a client's request and files a chat export.
--
--   • A meeting cannot have happened before it began. Completion or a
--     no-show recorded before confirmed_start_at answers 'not_yet_started'.
--     This is not the elapsed-time inference §8 forbids (nothing here marks
--     anything because time passed); it is the one direction of the clock
--     that cannot be argued with.
--
-- And two rules at the row: crm.meetings.timezone was free text with no
-- CHECK — a trigger now refuses a zone pg_timezone_names does not carry
-- (case-insensitively, through core.is_known_timezone), and crm.book_meeting,
-- carried forward VERBATIM with one marked edit, answers 'invalid_timezone'
-- by name when it raises; and a conclusion recorded before the agreed start
-- is refused by a trigger as well as by the doors, so a direct write cannot
-- do what the doors refuse.
--
-- Authorization: an authenticated caller needs core.can_write() — the same
-- rule the row policies hold — not core.is_internal(); review found the
-- first draft admitting a contractor the row refuses.
--
-- Audit only, no outbox event, for the reason crm.book_meeting gave: an
-- event type with no consumer is the object the next module reaches for.
-- The analysis task §9.3 asks for goes through crm.request_meeting_analysis,
-- which already exists and already refuses an empty room.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. the zone is a zone ─────────────────────────────────────────────────
--
-- ONE predicate, shared by the trigger below and by crm.book_meeting's
-- handler, case-insensitive because Postgres itself resolves zone names
-- that way (`now() at time zone 'asia/kolkata'` works) and so does Intl in
-- the pages. Review found the first draft comparing case-sensitively in two
-- places and scanning pg_timezone_names twice per booking.

create or replace function core.is_known_timezone(p_zone text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select p_zone is not null
     and exists (select 1 from pg_catalog.pg_timezone_names z where lower(z.name) = lower(p_zone));
$$;

comment on function core.is_known_timezone(text) is
  'G-237. True when pg_timezone_names carries the zone, compared case-insensitively as Postgres resolves it. The one predicate every timezone rule uses.';

revoke all on function core.is_known_timezone(text) from public, anon;
grant execute on function core.is_known_timezone(text) to authenticated, service_role;

create or replace function crm.meeting_timezone_is_known()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- `update of timezone` fires whenever the column is in the SET list, changed
  -- or not; an unchanged value was validated when it was written.
  if tg_op = 'UPDATE' and new.timezone is not distinct from old.timezone then
    return new;
  end if;
  if new.timezone is not null and not core.is_known_timezone(new.timezone) then
    raise exception 'meeting_timezone: "%" is not a zone Postgres knows', new.timezone
      using errcode = 'check_violation',
            hint = 'an IANA name from pg_timezone_names, e.g. Asia/Kolkata';
  end if;
  return new;
end;
$$;

comment on function crm.meeting_timezone_is_known() is
  'G-237. Refuses a crm.meetings.timezone that pg_timezone_names does not carry (case-insensitively). The column was free text; A08/A09 learned to survive an unknown zone and this makes one unwritable. Existing rows are not re-validated - the trigger fires on insert and on a CHANGE of the column.';

drop trigger if exists meetings_timezone_is_known on crm.meetings;
create trigger meetings_timezone_is_known
  before insert or update of timezone on crm.meetings
  for each row execute function crm.meeting_timezone_is_known();


-- ── 1b. a meeting cannot be concluded before it began — at the row ────────
--
-- Review: the doors below answer 'not_yet_started' by name, but a rule only
-- a function holds is one a direct write walks past, which is the reason
-- G-225 put meetings_completion_is_authorized at the row. A conclusion is
-- refused when the clock has not reached the agreed start, and when the
-- completion moment it carries precedes that start.

create or replace function crm.meeting_concludes_after_it_began()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status in ('completed', 'no_show')
     and new.status is distinct from old.status
     and new.confirmed_start_at is not null
     and (clock_timestamp() < new.confirmed_start_at
          or coalesce(new.completed_at, clock_timestamp()) < new.confirmed_start_at) then
    raise exception 'meeting_conclusion: a meeting cannot be % before its agreed start %', new.status, new.confirmed_start_at
      using errcode = 'check_violation',
            hint = 'the agreed start has to have passed; time passing is not completion, and completion before time passes is not possible';
  end if;
  return new;
end;
$$;

comment on function crm.meeting_concludes_after_it_began() is
  'G-237. Refuses completed / no_show recorded before the agreed start, at the row, so the rule the doors answer by name (not_yet_started) also holds against a direct write.';

drop trigger if exists meetings_conclude_after_start on crm.meetings;
create trigger meetings_conclude_after_start
  before update of status on crm.meetings
  for each row execute function crm.meeting_concludes_after_it_began();


-- ── 2. crm.book_meeting, carried forward verbatim with one marked edit ───

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
  -- | 'key_taken' | 'event_taken' | 'forbidden' | 'invalid_timezone' (G-237)
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
  -- [G-237 edit 1 of 1] A zone Postgres does not know is refused by the row
  -- trigger meetings_timezone_is_known; that refusal is answered here by
  -- name rather than pre-checked, so pg_timezone_names is read once per
  -- booking. Any other check_violation is not this function's to translate.
  when check_violation then
    if sqlerrm like 'meeting_timezone:%' then
      return query select 'invalid_timezone'::text, p_meeting_id; return;
    end if;
    raise;
end;
$$;

comment on function crm.book_meeting(uuid, text, timestamptz, timestamptz, text, text, text, text, text, int) is
  'G-227, carried forward by G-237 with one edit: a timezone pg_timezone_names does not know answers invalid_timezone by name. The only door a booking goes through: idempotent on booking_key (a retry of an attempt that already succeeded gets already_booked and its id), refuses an availability answer older than the caller''s freshness bound (Scheduler specification section 5.1 re-check), refuses a provider named without the event id proving it answered (section 6.3), and turns a lost race on either unique index back into a named outcome rather than an exception. Does NOT prevent two different meetings overlapping - that needs an owner or resource column nothing has yet decided on, and inventing one to satisfy a constraint would be inventing a business fact.';



-- ── 3. cancel ─────────────────────────────────────────────────────────────
--
-- Every door returns the row's lead_id: the application revalidates the
-- lead's page from the row, never from a field a form carried (review).

create or replace function crm.cancel_meeting(
  p_meeting_id uuid,
  p_reason     text default null
)
returns table (
  -- 'cancelled' | 'already_cancelled' | 'wrong_state' | 'not_found' | 'forbidden'
  outcome           text,
  meeting_id        uuid,
  lead_id           uuid,
  -- The provider's event, if one was ever recorded. No adapter exists to
  -- cancel it (BLK-005), so the caller is told there is one to cancel by hand.
  provider_event_id text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_row    crm.meetings;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select m.* into v_row from crm.meetings m where m.id = p_meeting_id for update;
  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid, null::text; return;
  end if;

  -- Definer means RLS did not filter that read: an authenticated caller must
  -- own the row and hold the write the row policy (meetings_write) demands —
  -- core.can_write(), not core.is_internal(), because review found the first
  -- draft admitting a contractor the row itself refuses. The service role is
  -- the Scheduler agent acting on a client's request, and is trusted.
  if v_actor is not null
     and (v_row.organization_id is distinct from (select core.current_organization_id())
          or not (select core.can_write())) then
    return query select 'forbidden'::text, null::uuid, null::uuid, null::text; return;
  end if;

  if v_row.status = 'cancelled' then
    return query select 'already_cancelled'::text, v_row.id, v_row.lead_id, v_row.provider_event_id; return;
  end if;
  -- §9.1: a meeting that happened, or was missed, does not un-happen.
  if v_row.status in ('completed', 'no_show') then
    return query select 'wrong_state'::text, v_row.id, v_row.lead_id, v_row.provider_event_id; return;
  end if;

  -- History is not deleted (§8): the agreed time, the booking key and the
  -- provider event stay on the row; only the status and the cancellation
  -- facts change. meetings_drop_stale_reminders removes the queued reminder.
  update crm.meetings
     set status              = 'cancelled',
         outcome             = 'cancelled',
         cancelled_at        = clock_timestamp(),
         cancellation_reason = v_reason
   where crm.meetings.id = v_row.id;

  perform core.record_audit(
    v_row.organization_id,
    'meeting.cancelled',
    'meeting',
    v_row.id,
    jsonb_build_object('status', v_row.status, 'confirmed_start_at', v_row.confirmed_start_at),
    jsonb_build_object(
      'status', 'cancelled',
      'reason', v_reason,
      'lead_id', v_row.lead_id,
      'provider_event_id', v_row.provider_event_id,
      -- Said in the record rather than implied: nothing cancelled it there.
      'provider_event_cancelled', false
    )
  );

  return query select 'cancelled'::text, v_row.id, v_row.lead_id, v_row.provider_event_id;
end;
$$;

comment on function crm.cancel_meeting(uuid, text) is
  'G-237. The cancel door (Scheduler specification section 8): from any live state, never from a concluded one; history kept on the row; reminders dropped by the existing trigger; audited as meeting.cancelled. Returns the provider event id so the caller can say it was NOT cancelled at the provider - no adapter exists (BLK-005), and a cancellation that claims otherwise is the false success section 14 forbids. Admits the service role: the Scheduler agent cancels on a client''s request. An authenticated caller needs core.can_write(), exactly as the row policy does.';

revoke all on function crm.cancel_meeting(uuid, text) from public, anon;
grant execute on function crm.cancel_meeting(uuid, text) to authenticated, service_role;


-- ── 4. evidence ───────────────────────────────────────────────────────────
--
-- Defined before the conclusion doors because they file a typed note
-- THROUGH it: one insert path into crm.meeting_evidence, one audit action,
-- one set of named refusals. Review found the first draft with a second,
-- unaudited path for the note.

create or replace function crm.add_meeting_evidence(
  p_meeting_id   uuid,
  p_kind         text,
  p_body         text   default null,
  p_visibility   text   default 'internal',
  p_artifact_ref text   default null,
  p_media_type   text   default null,
  p_byte_size    bigint default null
)
returns table (
  -- 'attached' | 'invalid_kind' | 'invalid_visibility' | 'nothing_to_attach'
  -- | 'too_long' | 'invalid_size' | 'unknown_actor' | 'not_found' | 'forbidden'
  outcome     text,
  evidence_id uuid,
  lead_id     uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   crm.meetings;
  v_body  text := nullif(btrim(coalesce(p_body, '')), '');
  v_ref   text := nullif(btrim(coalesce(p_artifact_ref, '')), '');
  v_id    uuid;
begin
  select m.* into v_row from crm.meetings m where m.id = p_meeting_id;
  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_row.organization_id is distinct from (select core.current_organization_id())
          or not (select core.can_write())) then
    return query select 'forbidden'::text, null::uuid, null::uuid; return;
  end if;

  -- uploaded_by references core.users; a token whose subject has no row
  -- would fail the write with a foreign-key error. Named instead (review).
  if v_actor is not null and not exists (select 1 from core.users u where u.id = v_actor) then
    return query select 'unknown_actor'::text, null::uuid, v_row.lead_id; return;
  end if;

  -- §9.2's list, the table's CHECK said by name before it is hit.
  if p_kind is null or p_kind not in ('recording', 'transcript', 'image', 'chat_export', 'document', 'notes', 'summary') then
    return query select 'invalid_kind'::text, null::uuid, v_row.lead_id; return;
  end if;
  if p_visibility is null or p_visibility not in ('internal', 'client_visible') then
    return query select 'invalid_visibility'::text, null::uuid, v_row.lead_id; return;
  end if;
  -- meeting_evidence_carries_something, by name: a row with neither a
  -- reference nor a body is a claim that evidence exists.
  if v_body is null and v_ref is null then
    return query select 'nothing_to_attach'::text, null::uuid, v_row.lead_id; return;
  end if;
  if length(coalesce(p_body, '')) > 20000 then
    return query select 'too_long'::text, null::uuid, v_row.lead_id; return;
  end if;
  if p_byte_size is not null and p_byte_size <= 0 then
    return query select 'invalid_size'::text, null::uuid, v_row.lead_id; return;
  end if;

  insert into crm.meeting_evidence
    (organization_id, meeting_id, lead_id, kind, visibility, artifact_ref, body, media_type, byte_size, uploaded_by)
  values
    (v_row.organization_id, v_row.id, v_row.lead_id, p_kind, p_visibility, v_ref, v_body,
     nullif(btrim(coalesce(p_media_type, '')), ''), p_byte_size, v_actor)
  returning id into v_id;

  perform core.record_audit(
    v_row.organization_id,
    'meeting.evidence_added',
    'meeting',
    v_row.id,
    null,
    jsonb_build_object(
      'evidence_id', v_id,
      'kind', p_kind,
      'visibility', p_visibility,
      'has_reference', v_ref is not null,
      'has_body', v_body is not null,
      'lead_id', v_row.lead_id
    )
  );

  return query select 'attached'::text, v_id, v_row.lead_id;
end;
$$;

comment on function crm.add_meeting_evidence(uuid, text, text, text, text, text, bigint) is
  'G-237. The evidence door (Scheduler specification section 9.2), and the ONLY insert path into crm.meeting_evidence the conclusion doors use: a kind from the closed list, internal unless said otherwise, a body or a reference (never neither), bounded, linked to the exact meeting and its lead with the uploader recorded. Accepted on any meeting that exists - what a cancelled meeting left behind is still evidence. A reference is accepted as text: no store signs one (G-229), so the application offers typed notes and summaries only. Audited as meeting.evidence_added. Admits the service role - the Scheduler agent files a chat export - with uploaded_by null and the audit row saying system.';

revoke all on function crm.add_meeting_evidence(uuid, text, text, text, text, text, bigint) from public, anon;
grant execute on function crm.add_meeting_evidence(uuid, text, text, text, text, text, bigint) to authenticated, service_role;


-- ── 5. complete ───────────────────────────────────────────────────────────

create or replace function crm.complete_meeting(
  p_meeting_id uuid,
  p_outcome    text default 'completed',
  p_note       text default null
)
returns table (
  -- 'completed' | 'already_completed' | 'wrong_state' | 'not_yet_started'
  -- | 'invalid_outcome' | 'note_too_long' | 'no_actor' | 'unknown_actor'
  -- | 'not_found' | 'forbidden'
  outcome     text,
  meeting_id  uuid,
  lead_id     uuid,
  evidence_id uuid,
  -- crm.request_meeting_analysis's own answer: 'queued' | 'already_queued'
  -- | 'no_evidence' - the §9.3 chain, said rather than assumed.
  analysis    text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_row      crm.meetings;
  v_evidence uuid;
  v_filed    text;
  v_analysis text;
begin
  -- §9.1: an authorized PERSON marks it. The worker has no auth.uid(), and a
  -- meeting completed by nobody is the inference the specification forbids.
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, null::uuid, null::uuid, null::text; return;
  end if;
  -- Argument-only refusals before the lock: their answer cannot change
  -- while the row is locked, and a mistyped form should not wait behind
  -- another operator's completion (review).
  if p_outcome is null or p_outcome not in ('completed', 'failed', 'follow_up_required') then
    return query select 'invalid_outcome'::text, null::uuid, null::uuid, null::uuid, null::text; return;
  end if;
  if length(coalesce(p_note, '')) > 20000 then
    return query select 'note_too_long'::text, null::uuid, null::uuid, null::uuid, null::text; return;
  end if;
  select m.* into v_row from crm.meetings m where m.id = p_meeting_id for update;
  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text, null::uuid, null::uuid, null::uuid, null::text; return;
  end if;

  -- completed_by references core.users. A token whose subject has no row
  -- would fail the write with a foreign-key error; named instead — after
  -- the tenancy guard, so a stranger is a stranger before anything else.
  if not exists (select 1 from core.users u where u.id = v_actor) then
    return query select 'unknown_actor'::text, v_row.id, v_row.lead_id, null::uuid, null::text; return;
  end if;

  if v_row.status = 'completed' then
    return query select 'already_completed'::text, v_row.id, v_row.lead_id, null::uuid, null::text; return;
  end if;
  -- §9: only a booked meeting can have happened.
  if v_row.status <> 'booked' then
    return query select 'wrong_state'::text, v_row.id, v_row.lead_id, null::uuid, null::text; return;
  end if;
  -- Also held at the row by meetings_conclude_after_start; answered here by name.
  if v_row.confirmed_start_at is not null and clock_timestamp() < v_row.confirmed_start_at then
    return query select 'not_yet_started'::text, v_row.id, v_row.lead_id, null::uuid, null::text; return;
  end if;

  update crm.meetings
     set status       = 'completed',
         outcome      = p_outcome,
         completed_at = clock_timestamp(),
         completed_by = v_actor
   where crm.meetings.id = v_row.id;

  -- The note goes through the evidence door: one insert path, one audit.
  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    select e.outcome, e.evidence_id into v_filed, v_evidence
      from crm.add_meeting_evidence(v_row.id, 'notes', p_note, 'internal') e;
    if v_filed is distinct from 'attached' then
      raise exception 'meeting_note: the evidence door answered %', v_filed;
    end if;
  end if;

  -- §9.3: MARK COMPLETED → VALIDATE EVIDENCE → LINK ARTIFACTS → CREATE AI
  -- ANALYSIS TASK. The gate is the existing one, and its refusal
  -- ('no_evidence') is returned, not swallowed.
  select a.outcome into v_analysis from crm.request_meeting_analysis(v_row.id) a;

  perform core.record_audit(
    v_row.organization_id,
    'meeting.completed',
    'meeting',
    v_row.id,
    jsonb_build_object('status', v_row.status, 'confirmed_start_at', v_row.confirmed_start_at),
    jsonb_build_object(
      'status', 'completed',
      'outcome', p_outcome,
      'completed_by', v_actor,
      'lead_id', v_row.lead_id,
      'evidence_id', v_evidence,
      'analysis', v_analysis
    )
  );

  return query select 'completed'::text, v_row.id, v_row.lead_id, v_evidence, v_analysis;
end;
$$;

comment on function crm.complete_meeting(uuid, text, text) is
  'G-237. The completion door (Scheduler specification section 9.1): a person with auth.uid() and core.can_write() marks a BOOKED meeting completed with an outcome of completed, failed or follow_up_required, never before its agreed start, never twice; a typed note is filed through crm.add_meeting_evidence as internal notes; then section 9.3''s chain runs through crm.request_meeting_analysis and its answer is returned by name. Audited as meeting.completed. The service role is refused: a meeting completed by nobody is the inference section 9.1 forbids.';

revoke all on function crm.complete_meeting(uuid, text, text) from public, anon;
grant execute on function crm.complete_meeting(uuid, text, text) to authenticated, service_role;


-- ── 6. no-show ────────────────────────────────────────────────────────────

create or replace function crm.record_no_show(
  p_meeting_id uuid,
  p_note       text default null
)
returns table (
  -- 'no_show' | 'already_recorded' | 'wrong_state' | 'not_yet_started'
  -- | 'note_too_long' | 'no_actor' | 'unknown_actor' | 'not_found' | 'forbidden'
  outcome     text,
  meeting_id  uuid,
  lead_id     uuid,
  evidence_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_row      crm.meetings;
  v_evidence uuid;
  v_filed    text;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, null::uuid, null::uuid; return;
  end if;
  if length(coalesce(p_note, '')) > 20000 then
    return query select 'note_too_long'::text, null::uuid, null::uuid, null::uuid; return;
  end if;
  select m.* into v_row from crm.meetings m where m.id = p_meeting_id for update;
  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text, null::uuid, null::uuid, null::uuid; return;
  end if;

  if not exists (select 1 from core.users u where u.id = v_actor) then
    return query select 'unknown_actor'::text, v_row.id, v_row.lead_id, null::uuid; return;
  end if;

  if v_row.status = 'no_show' then
    return query select 'already_recorded'::text, v_row.id, v_row.lead_id, null::uuid; return;
  end if;
  if v_row.status <> 'booked' then
    return query select 'wrong_state'::text, v_row.id, v_row.lead_id, null::uuid; return;
  end if;
  -- §8: "Do not infer completion from time alone" - and the other direction:
  -- nobody has failed to attend a meeting that has not begun. Also at the row.
  if v_row.confirmed_start_at is not null and clock_timestamp() < v_row.confirmed_start_at then
    return query select 'not_yet_started'::text, v_row.id, v_row.lead_id, null::uuid; return;
  end if;

  -- completed_at / completed_by carry the MARKING's actor and moment: the
  -- constraint meetings_completion_is_authorized demands them for no_show
  -- precisely so that a no-show is somebody's statement.
  update crm.meetings
     set status       = 'no_show',
         outcome      = 'no_show',
         completed_at = clock_timestamp(),
         completed_by = v_actor
   where crm.meetings.id = v_row.id;

  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    select e.outcome, e.evidence_id into v_filed, v_evidence
      from crm.add_meeting_evidence(v_row.id, 'notes', p_note, 'internal') e;
    if v_filed is distinct from 'attached' then
      raise exception 'meeting_note: the evidence door answered %', v_filed;
    end if;
  end if;

  -- §8 asks for a follow-up. Which follow-up situation a no-show maps to is
  -- not decided (ADM-103) - nothing is queued, and the audit row says so.
  perform core.record_audit(
    v_row.organization_id,
    'meeting.no_show',
    'meeting',
    v_row.id,
    jsonb_build_object('status', v_row.status, 'confirmed_start_at', v_row.confirmed_start_at),
    jsonb_build_object(
      'status', 'no_show',
      'recorded_by', v_actor,
      'lead_id', v_row.lead_id,
      'evidence_id', v_evidence,
      'follow_up', 'none - ADM-103 open'
    )
  );

  return query select 'no_show'::text, v_row.id, v_row.lead_id, v_evidence;
end;
$$;

comment on function crm.record_no_show(uuid, text) is
  'G-237. The no-show door (Scheduler specification section 8): a person with core.can_write() marks a BOOKED meeting as not attended, never before its agreed start, never twice, with the marking''s actor and moment on the row and a typed note filed through crm.add_meeting_evidence. Audited as meeting.no_show. Deliberately queues no analysis (section 10.1: nothing to analyse) and no follow-up: which follow-up situation a no-show maps to is ADM-103, open.';

revoke all on function crm.record_no_show(uuid, text) from public, anon;
grant execute on function crm.record_no_show(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
