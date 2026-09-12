-- ═══════════════════════════════════════════════════════════════════════════
-- A slot is offered, and taken — G-243
--
-- Scheduler Agent Complete Responsibilities §5 (REQUEST → NORMALIZE →
-- TIMEZONE → CALENDAR QUERY → FILTER → RANK → RECHECK → PROPOSE), §6.1 (a
-- proposal presents date, time, timezone, duration and mode; several only
-- when needed), §6.2 (proposal and confirmation are different states;
-- revalidate before booking), §6.3 (the provider event through the adapter,
-- its id captured, the response verified).
--
-- G-226 made the row refuse a proposal that recorded no source and no
-- moment; G-227 made crm.book_meeting the only door a booking goes through,
-- refusing a stale read; G-242 put a calendar behind the port. What was
-- missing was where the OFFER lives and the door that writes it, and a way
-- for §5.1's re-check to be recorded so book_meeting's freshness bound
-- measures the re-check and not the first read.
--
-- Two doors, SECURITY DEFINER with the tenancy guard explicit, admitting an
-- authenticated caller only with core.can_write() (the row policy's rule):
--
--   crm.propose_meeting_slots  the offer — up to three slots the calendar
--                              was READ to have free, with the source and
--                              the moment; from requested or proposed
--                              (§5.3: a re-offer after "none of those work")
--   crm.note_availability_read the re-check, immediately before booking:
--                              the same columns, a fresh moment
--
-- Nothing here calls a provider: the application asks the adapter, and what
-- it writes is what the adapter answered. A slot that was never read has
-- nothing to put in these columns, and the row refuses.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── where the offer lives ─────────────────────────────────────────────────

alter table crm.meetings
  add column if not exists proposed_slots jsonb;

alter table crm.meetings
  drop constraint if exists meetings_proposed_slots_are_a_list;
alter table crm.meetings
  add constraint meetings_proposed_slots_are_a_list check (
    proposed_slots is null
    or (jsonb_typeof(proposed_slots) = 'array' and jsonb_array_length(proposed_slots) between 1 and 3)
  );

comment on column crm.meetings.proposed_slots is
  'The slots offered to the lead (G-243, Scheduler specification section 6.1): up to three {startAt, endAt} in UTC, each one the calendar was READ to have free at availability_read_at. A proposal is a row, not a message; the confirmation is a separate state (section 6.2).';


-- ── the offer ─────────────────────────────────────────────────────────────

create or replace function crm.propose_meeting_slots(
  p_meeting_id           uuid,
  p_slots                jsonb,
  p_availability_source  text,
  p_availability_read_at timestamptz,
  p_duration_minutes     int
)
returns table (
  -- 'proposed' | 'wrong_state' | 'nothing_to_offer' | 'invalid_slots'
  -- | 'never_checked' | 'invalid_duration' | 'not_found' | 'forbidden'
  outcome    text,
  meeting_id uuid,
  lead_id    uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   crm.meetings;
  v_slot  jsonb;
  v_start timestamptz;
  v_end   timestamptz;
begin
  select m.* into v_row from crm.meetings m where m.id = p_meeting_id for update;
  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid; return;
  end if;
  if v_actor is not null
     and (v_row.organization_id is distinct from (select core.current_organization_id())
          or not (select core.can_write())) then
    return query select 'forbidden'::text, null::uuid, null::uuid; return;
  end if;

  -- §6.2: a proposal is made to a request, or re-made after "none of those
  -- work"; a booked or concluded meeting is not offered times.
  if v_row.status not in ('requested', 'proposed') then
    return query select 'wrong_state'::text, v_row.id, v_row.lead_id; return;
  end if;
  -- §5: what is offered was READ. No source, no moment, no offer.
  if nullif(btrim(coalesce(p_availability_source, '')), '') is null or p_availability_read_at is null then
    return query select 'never_checked'::text, v_row.id, v_row.lead_id; return;
  end if;
  if p_duration_minutes is null or p_duration_minutes < 5 or p_duration_minutes > 480 then
    return query select 'invalid_duration'::text, v_row.id, v_row.lead_id; return;
  end if;
  if p_slots is null or jsonb_typeof(p_slots) <> 'array' then
    return query select 'invalid_slots'::text, v_row.id, v_row.lead_id; return;
  end if;
  if jsonb_array_length(p_slots) = 0 then
    -- §5.3: a full calendar is an answer, and it is not this door's to hide.
    return query select 'nothing_to_offer'::text, v_row.id, v_row.lead_id; return;
  end if;
  if jsonb_array_length(p_slots) > 3 then
    return query select 'invalid_slots'::text, v_row.id, v_row.lead_id; return;
  end if;
  -- Each slot is a real instant pair that ends after it starts and is at
  -- least as long as the meeting; anything else is not a slot.
  for v_slot in select * from jsonb_array_elements(p_slots) loop
    begin
      v_start := (v_slot->>'startAt')::timestamptz;
      v_end   := (v_slot->>'endAt')::timestamptz;
    exception when others then
      return query select 'invalid_slots'::text, v_row.id, v_row.lead_id; return;
    end;
    if v_start is null or v_end is null or v_end <= v_start
       or v_end - v_start < make_interval(mins => p_duration_minutes) then
      return query select 'invalid_slots'::text, v_row.id, v_row.lead_id; return;
    end if;
  end loop;

  update crm.meetings
     set status               = 'proposed',
         proposed_slots       = p_slots,
         availability_source  = p_availability_source,
         availability_read_at = p_availability_read_at,
         duration_minutes     = p_duration_minutes
   where crm.meetings.id = v_row.id;

  perform core.record_audit(
    v_row.organization_id,
    'meeting.proposed',
    'meeting',
    v_row.id,
    jsonb_build_object('status', v_row.status, 'proposed_slots', v_row.proposed_slots),
    jsonb_build_object(
      'status', 'proposed',
      'slots', p_slots,
      'availability_source', p_availability_source,
      'availability_read_at', p_availability_read_at,
      'duration_minutes', p_duration_minutes,
      'lead_id', v_row.lead_id
    )
  );

  return query select 'proposed'::text, v_row.id, v_row.lead_id;
end;
$$;

comment on function crm.propose_meeting_slots(uuid, jsonb, text, timestamptz, int) is
  'G-243. The offer (Scheduler specification section 6.1): up to three slots the calendar was READ to have free, recorded with the source and the moment the row already demands (G-226), from a requested or proposed meeting (a re-offer is section 5.3). Refuses an empty offer by name rather than hiding a full calendar, a slot that is not an instant pair long enough for the meeting, and a proposal with no read behind it. Audited as meeting.proposed. Calls no provider: what it writes is what the adapter answered.';

revoke all on function crm.propose_meeting_slots(uuid, jsonb, text, timestamptz, int) from public, anon;
grant execute on function crm.propose_meeting_slots(uuid, jsonb, text, timestamptz, int) to authenticated, service_role;


-- ── the re-check ──────────────────────────────────────────────────────────

create or replace function crm.note_availability_read(
  p_meeting_id           uuid,
  p_availability_source  text,
  p_availability_read_at timestamptz
)
returns table (
  -- 'noted' | 'wrong_state' | 'never_checked' | 'not_found' | 'forbidden'
  outcome    text,
  meeting_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   crm.meetings;
begin
  select m.* into v_row from crm.meetings m where m.id = p_meeting_id for update;
  if v_row.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if v_actor is not null
     and (v_row.organization_id is distinct from (select core.current_organization_id())
          or not (select core.can_write())) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if v_row.status not in ('requested', 'proposed') then
    return query select 'wrong_state'::text, v_row.id; return;
  end if;
  if nullif(btrim(coalesce(p_availability_source, '')), '') is null or p_availability_read_at is null then
    return query select 'never_checked'::text, v_row.id; return;
  end if;
  -- The moment cannot be from the future: a caller claiming a read it has
  -- not made yet is the thing the freshness bound exists to refuse.
  if p_availability_read_at > clock_timestamp() + interval '1 minute' then
    return query select 'never_checked'::text, v_row.id; return;
  end if;

  update crm.meetings
     set availability_source  = p_availability_source,
         availability_read_at = p_availability_read_at
   where crm.meetings.id = v_row.id;

  return query select 'noted'::text, v_row.id;
end;
$$;

comment on function crm.note_availability_read(uuid, text, timestamptz) is
  'G-243. Records section 5.1''s re-check - the calendar asked again immediately before booking - so crm.book_meeting''s freshness bound (G-227) measures the re-check, not the first read. A moment from the future is refused. Not audited on its own: the booking that follows records availability_read_at in its audit row.';

revoke all on function crm.note_availability_read(uuid, text, timestamptz) from public, anon;
grant execute on function crm.note_availability_read(uuid, text, timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
