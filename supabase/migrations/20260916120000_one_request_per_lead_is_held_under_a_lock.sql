-- ═══════════════════════════════════════════════════════════════════════════
-- One request per lead is held under a lock — Scheduler §3.1, review of G-249
-- ═══════════════════════════════════════════════════════════════════════════
--
-- §3.1: *"Create a scheduling request only once per logical inbound request."*
-- `crm.request_meeting` enforces it by reading the lead's live meetings and
-- then inserting — a check-then-write with nothing holding the gap. There is
-- no unique index behind it either: `crm.meetings` carries exactly two unique
-- indexes, on the booking key and the provider event id, and neither says
-- anything about how many live meetings a lead may have.
--
-- While the only caller was a person clicking a form the window was narrow
-- enough to be theoretical. G-249 made the caller a JOB, and two jobs for two
-- messages from the same lead can be claimed by two overlapping runner
-- invocations — an overlapping cron tick, or a cron tick and a manual kick.
-- Both read "no live meeting", both insert, and the lead has two.
--
-- ── the lead row is the lock ─────────────────────────────────────────────
--
-- `for update` on `crm.leads`, which the function already reads. Two callers
-- asking about the same lead serialise; callers on different leads do not meet.
-- The alternative — a partial unique index over the live statuses — is the
-- stronger guarantee and is NOT taken here on purpose: it would fail to build
-- on any deployment that already has a lead with two live meetings, and this
-- migration cannot know whether one does. A lock that cannot fail to apply is
-- worth more today than an index that might refuse to.
--
-- Carried forward VERBATIM from 20260914130000 with ONE marked edit. Every
-- guard, every refusal name, the canonical-zone read, the evidence checks and
-- both grants are unchanged and must stay that way.

create or replace function crm.request_meeting(
  p_lead_id              uuid,
  p_mode                 text,
  p_timezone             text,
  p_purpose              text    default null,
  p_conversation_id      uuid    default null,
  p_requested_message_id uuid    default null,
  p_contact_id           uuid    default null,
  p_opportunity_id       uuid    default null,
  p_requested_start_at   timestamptz default null,
  p_requested_window_end timestamptz default null,
  p_duration_minutes     int     default null
)
returns table (
  -- 'requested' | 'already_requested' | 'invalid_request' | 'invalid_timezone'
  -- | 'unknown_lead' | 'unknown_thread' | 'unknown_message' | 'no_actor'
  -- | 'unknown_actor' | 'forbidden'
  outcome     text,
  meeting_id  uuid,
  lead_id     uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_lead  crm.leads;
  v_open  uuid;
  v_new   uuid;
  v_zone  text := btrim(coalesce(p_timezone, ''));
begin
  -- §9.1's shape, as every other door has it: a request is somebody's
  -- statement that a client asked. The service role is admitted because the
  -- Scheduler agent records a request the client made in a thread it was
  -- reading — the same reason cancel admits it and completion does not.
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid, null::uuid; return;
  end if;

  -- ── argument-only refusals, before any row is locked ──────────────────
  if p_mode is null or p_mode not in ('call', 'video_meeting', 'in_person_meeting', 'other') then
    return query select 'invalid_request'::text, null::uuid, null::uuid; return;
  end if;
  if not (select core.is_known_timezone(v_zone)) then
    return query select 'invalid_timezone'::text, null::uuid, null::uuid; return;
  end if;
  -- Stored in the CANONICAL spelling, not the caller's. `is_known_timezone`
  -- compares case-insensitively, so `asia/kolkata` passes and would then be
  -- printed to a person exactly like that on every meeting page. The name is
  -- read back from the same catalogue the predicate consulted.
  select z.name into v_zone
    from pg_catalog.pg_timezone_names z
   where lower(z.name) = lower(v_zone)
   limit 1;
  if p_duration_minutes is not null and p_duration_minutes <= 0 then
    return query select 'invalid_request'::text, null::uuid, null::uuid; return;
  end if;
  -- §4.1: a window without a start is not a window, and one that ends before
  -- it begins is not a time. The row's own CHECK says so too; refusing by name
  -- here means a caller is told which argument was wrong.
  if p_requested_window_end is not null
     and (p_requested_start_at is null or p_requested_window_end < p_requested_start_at) then
    return query select 'invalid_request'::text, null::uuid, null::uuid; return;
  end if;
  if length(coalesce(p_purpose, '')) > 2000 then
    return query select 'invalid_request'::text, null::uuid, null::uuid; return;
  end if;

  -- [G-249 review edit 1 of 1] `for update`. The lead row is the lock that
  -- makes "one live meeting per lead" true under concurrency: two jobs from
  -- two messages by the same client, claimed by two overlapping runner
  -- invocations, both read no-live-meeting and both insert without it.
  select l.* into v_lead from crm.leads l where l.id = p_lead_id for update;
  if v_lead.id is null then
    return query select 'unknown_lead'::text, null::uuid, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_lead.organization_id is distinct from (select core.current_organization_id())
          or not (select core.can_write())) then
    return query select 'forbidden'::text, null::uuid, v_lead.id; return;
  end if;

  if v_actor is not null and not exists (select 1 from core.users u where u.id = v_actor) then
    return query select 'unknown_actor'::text, null::uuid, v_lead.id; return;
  end if;

  -- The thread, the message and the contact must belong to this tenant, and
  -- the message to the thread. A foreign key alone would admit another
  -- organization's row and another conversation's message.
  if p_conversation_id is not null and not exists (
       select 1 from crm.conversations c
        where c.id = p_conversation_id and c.organization_id = v_lead.organization_id) then
    return query select 'unknown_thread'::text, null::uuid, v_lead.id; return;
  end if;
  if p_requested_message_id is not null and not exists (
       select 1 from crm.conversation_messages m
        where m.id = p_requested_message_id
          and m.organization_id = v_lead.organization_id
          and (p_conversation_id is null or m.conversation_id = p_conversation_id)) then
    return query select 'unknown_message'::text, null::uuid, v_lead.id; return;
  end if;
  if p_contact_id is not null and not exists (
       select 1 from crm.contacts ct
        where ct.id = p_contact_id and ct.organization_id = v_lead.organization_id) then
    return query select 'invalid_request'::text, null::uuid, v_lead.id; return;
  end if;
  if p_opportunity_id is not null and not exists (
       select 1 from sales.opportunities o
        where o.id = p_opportunity_id and o.organization_id = v_lead.organization_id) then
    return query select 'invalid_request'::text, null::uuid, v_lead.id; return;
  end if;

  -- ── one live request per lead ─────────────────────────────────────────
  select m.id into v_open
    from crm.meetings m
   where m.lead_id = v_lead.id
     and m.organization_id = v_lead.organization_id
     and m.status in ('requested', 'proposed', 'booked')
   order by m.created_at
   limit 1;
  if v_open is not null then
    return query select 'already_requested'::text, v_open, v_lead.id; return;
  end if;

  insert into crm.meetings (
    organization_id, lead_id, contact_id, opportunity_id, conversation_id, requested_message_id,
    requested_mode, requested_start_at, requested_window_end,
    timezone, duration_minutes, purpose, created_by, status
  ) values (
    v_lead.organization_id, v_lead.id, p_contact_id, p_opportunity_id, p_conversation_id, p_requested_message_id,
    p_mode, p_requested_start_at, p_requested_window_end,
    v_zone, p_duration_minutes, nullif(btrim(coalesce(p_purpose, '')), ''), v_actor, 'requested'
  )
  returning id into v_new;

  perform core.record_audit(
    v_lead.organization_id,
    'meeting.requested',
    'meeting',
    v_new,
    null::jsonb,
    jsonb_build_object(
      'status', 'requested',
      'lead_id', v_lead.id,
      'mode', p_mode,
      'timezone', v_zone,
      -- What the client named, kept apart from anything agreed (§4.1).
      'requested_start_at', p_requested_start_at,
      'requested_window_end', p_requested_window_end,
      'conversation_id', p_conversation_id,
      'requested_message_id', p_requested_message_id,
      'recorded_by', v_actor
    )
  );

  return query select 'requested'::text, v_new, v_lead.id;
end;
$$;

comment on function crm.request_meeting(uuid, text, text, text, uuid, uuid, uuid, uuid, timestamptz, timestamptz, int) is
  'Scheduler sections 3.1 and 4. Records that a client ASKED for a meeting: a row in `requested` carrying the mode, the zone, what they named as a time (never as an agreement - section 4.1 keeps requested_* and confirmed_* apart), and the message the request came in on, checked to belong to this organization and to the named thread. One live meeting per lead, held under a lock on the lead row so two concurrent callers cannot both pass the check. A second request while one is live answers already_requested with the meeting that is open; a concluded meeting blocks nothing. Does NOT decide from a client''s words that a meeting was asked for - that is the reading in app/api/jobs/run/workflows.ts, which passes the message it read.';

revoke all on function crm.request_meeting(uuid, text, text, text, uuid, uuid, uuid, uuid, timestamptz, timestamptz, int) from public, anon;
grant execute on function crm.request_meeting(uuid, text, text, text, uuid, uuid, uuid, uuid, timestamptz, timestamptz, int) to authenticated, service_role;

notify pgrst, 'reload schema';
