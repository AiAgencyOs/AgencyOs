-- ═══════════════════════════════════════════════════════════════════════════
-- A reschedule is a new row — G-244
--
-- Scheduler Agent Complete Responsibilities §8: "Reschedule request →
-- identify current booking → parse new requirement → availability check →
-- rebook → update reminders → notify. Critical control: preserve old booking
-- history." G-225 decided the shape: a reschedule mints a NEW row carrying
-- supersedes_id rather than editing the booked one, so what was agreed
-- before stays exactly as it was recorded. This is the door that mints it.
--
-- One transaction: the booked row is cancelled with a reason that says it
-- was rescheduled (its queued reminder is dropped by the existing trigger,
-- its provider event is returned for the adapter to cancel), and a new
-- REQUESTED row is written that carries the lead, contact, deal, thread,
-- the original request message, zone, duration and purpose — and, when the
-- client named a new time, that. The new row then goes through the offer
-- and the booking like any other (G-243): a reschedule offers nothing it
-- did not read.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.reschedule_meeting(
  p_meeting_id           uuid,
  p_reason               text        default null,
  p_requested_start_at   timestamptz default null,
  p_requested_window_end timestamptz default null,
  p_requested_mode       text        default null
)
returns table (
  -- 'rescheduled' | 'wrong_state' | 'invalid_request' | 'unknown_actor' | 'not_found' | 'forbidden'
  outcome           text,
  meeting_id        uuid,
  new_meeting_id    uuid,
  lead_id           uuid,
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
  v_new    uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_mode   text := coalesce(nullif(btrim(coalesce(p_requested_mode, '')), ''), null);
begin
  select m.* into v_row from crm.meetings m where m.id = p_meeting_id for update;
  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::text; return;
  end if;
  -- The service role is the Scheduler agent acting on a client's request;
  -- an authenticated caller needs the row policy's own write.
  if v_actor is not null
     and (v_row.organization_id is distinct from (select core.current_organization_id())
          or not (select core.can_write())) then
    return query select 'forbidden'::text, null::uuid, null::uuid, null::uuid, null::text; return;
  end if;
  -- §8 "identify current booking": only a booking is rescheduled. A request
  -- or a proposal is re-offered through the offer door; a concluded meeting
  -- is history.
  if v_row.status <> 'booked' then
    return query select 'wrong_state'::text, v_row.id, null::uuid, v_row.lead_id, v_row.provider_event_id; return;
  end if;
  if v_mode is not null and v_mode not in ('call', 'video_meeting', 'in_person_meeting', 'other') then
    return query select 'invalid_request'::text, v_row.id, null::uuid, v_row.lead_id, v_row.provider_event_id; return;
  end if;
  if p_requested_window_end is not null and (p_requested_start_at is null or p_requested_window_end < p_requested_start_at) then
    return query select 'invalid_request'::text, v_row.id, null::uuid, v_row.lead_id, v_row.provider_event_id; return;
  end if;
  -- created_by references core.users: a token whose subject has no row is
  -- named, not a foreign-key error after the old row was already cancelled.
  if v_actor is not null and not exists (select 1 from core.users u where u.id = v_actor) then
    return query select 'unknown_actor'::text, v_row.id, null::uuid, v_row.lead_id, v_row.provider_event_id; return;
  end if;

  -- The old booking, kept: cancelled with the reason, every other column as
  -- it was. meetings_drop_stale_reminders drops its queued reminder.
  update crm.meetings
     set status              = 'cancelled',
         outcome             = 'cancelled',
         cancelled_at        = clock_timestamp(),
         cancellation_reason = left('rescheduled' || coalesce(': ' || v_reason, ''), 2000)
   where crm.meetings.id = v_row.id;

  -- The new request, carrying what identifies the meeting. `requested_mode`
  -- is what the client now asks for, else what was booked, else what was
  -- first asked. `timezone` and `duration_minutes` are carried so the offer
  -- can be made in the same terms; `created_by` is the person who did this.
  insert into crm.meetings (
    organization_id, lead_id, contact_id, opportunity_id, conversation_id, requested_message_id,
    requested_mode, requested_start_at, requested_window_end,
    timezone, duration_minutes, purpose, created_by, supersedes_id, status
  ) values (
    v_row.organization_id, v_row.lead_id, v_row.contact_id, v_row.opportunity_id, v_row.conversation_id, v_row.requested_message_id,
    coalesce(v_mode, v_row.booked_mode, v_row.requested_mode), p_requested_start_at, p_requested_window_end,
    v_row.timezone, v_row.duration_minutes, v_row.purpose, v_actor, v_row.id, 'requested'
  )
  returning id into v_new;

  perform core.record_audit(
    v_row.organization_id,
    'meeting.rescheduled',
    'meeting',
    v_row.id,
    jsonb_build_object('status', v_row.status, 'confirmed_start_at', v_row.confirmed_start_at, 'confirmed_end_at', v_row.confirmed_end_at),
    jsonb_build_object(
      'status', 'cancelled',
      'reason', v_reason,
      'new_meeting_id', v_new,
      'requested_start_at', p_requested_start_at,
      'requested_window_end', p_requested_window_end,
      'lead_id', v_row.lead_id,
      'provider_event_id', v_row.provider_event_id,
      'provider_event_cancelled', false
    )
  );

  return query select 'rescheduled'::text, v_row.id, v_new, v_row.lead_id, v_row.provider_event_id;
end;
$$;

comment on function crm.reschedule_meeting(uuid, text, timestamptz, timestamptz, text) is
  'G-244. Scheduler specification section 8, in G-225''s shape: the booked row is cancelled with a reason that says rescheduled (history preserved, its reminder dropped by the existing trigger, its provider event returned for the adapter to cancel) and a NEW requested row is minted carrying supersedes_id, the lead, contact, deal, thread, request message, zone, duration and purpose, and the new time the client named when they named one. The new row is offered and booked through G-243''s doors: a reschedule offers nothing it did not read. Only a booking is rescheduled; a request or proposal is re-offered. Audited as meeting.rescheduled on the old row.';

revoke all on function crm.reschedule_meeting(uuid, text, timestamptz, timestamptz, text) from public, anon;
grant execute on function crm.reschedule_meeting(uuid, text, timestamptz, timestamptz, text) to authenticated, service_role;

notify pgrst, 'reload schema';
