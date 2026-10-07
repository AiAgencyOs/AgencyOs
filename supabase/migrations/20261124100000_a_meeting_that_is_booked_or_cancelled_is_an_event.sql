-- ═══════════════════════════════════════════════════════════════════════════
-- P1-FLOW-028/029/030, P1-SCHED-030/052 (traceability: docs/phase-1-3-implementation-traceability.md).
--
-- A meeting that was booked or cancelled left an AUDIT row and nothing else: no outbox event, so nobody subscribed and the admin was never told. This adds
-- the two events, written by a trigger on crm.meetings rather than by editing each booking door (book_meeting, the reschedule door, the adapter paths all
-- change `status`, and a trigger cannot be forgotten by the next one):
--
--   meeting.booked      the row became 'booked' (insert or update). Carries what the admin needs to know: which lead, when, which mode, the purpose.
--   meeting.cancelled   the row became 'cancelled', with the reason (a reschedule cancels the old row with a reason that says so).
--
-- Nothing is sent from here. The reaction (an internal-channel announcement, and the meeting.reminder sender) lives in src/modules/crm/meeting-announcements.ts.
-- The payload names ids and times, never the client's words; the handler re-reads the row (row authority over event payload).
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('meeting.booked', 'A meeting became booked (a time, a mode and a provider reference are settled). Nothing was sent to the client by this event.', true),
  ('meeting.cancelled', 'A booked or proposed meeting was cancelled, with its reason. A reschedule cancels the old row and mints a new one.', true)
on conflict (type) do nothing;

create or replace function crm.emit_meeting_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'booked' and (tg_op = 'INSERT' or old.status is distinct from 'booked') then
    perform core.emit_event(
      new.organization_id, 'meeting.booked', 'meeting', new.id,
      jsonb_build_object(
        'meetingId', new.id, 'leadId', new.lead_id, 'opportunityId', new.opportunity_id,
        'confirmedStartAt', new.confirmed_start_at, 'confirmedEndAt', new.confirmed_end_at,
        'timezone', new.timezone, 'mode', new.booked_mode, 'purpose', new.purpose,
        'provider', new.provider, 'supersedesId', new.supersedes_id)
    );
  elsif new.status = 'cancelled' and tg_op = 'UPDATE' and old.status is distinct from 'cancelled' then
    perform core.emit_event(
      new.organization_id, 'meeting.cancelled', 'meeting', new.id,
      jsonb_build_object(
        'meetingId', new.id, 'leadId', new.lead_id, 'wasBooked', old.status = 'booked',
        'confirmedStartAt', new.confirmed_start_at, 'reason', left(coalesce(new.cancellation_reason, ''), 500))
    );
  end if;
  return new;
end $$;

drop trigger if exists meetings_emit_transition on crm.meetings;
create trigger meetings_emit_transition
  after insert or update of status on crm.meetings
  for each row execute function crm.emit_meeting_transition();

comment on function crm.emit_meeting_transition() is
  'P1-SCHED-030. Writes meeting.booked / meeting.cancelled to the outbox in the same transaction as the status change, whichever door made it. Names ids and times only.';

notify pgrst, 'reload schema';
