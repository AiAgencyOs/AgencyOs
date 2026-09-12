-- ═══════════════════════════════════════════════════════════════════════════
-- A meeting is a thing the system knows about — G-225
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The Phase 1 source set locks FIVE agents: Sales, **Scheduler**, Quotation
-- Master, Coordination, Orchestrator/Router. Four of them have something in
-- this repository. The Scheduler has nothing — not a table among the 86, not a
-- module, not a route, not a key in the agent registry, and until the audit of
-- 2026-09-11 not even a gap saying so. Every one of the fifteen gaps matching
-- /schedul|meeting|calendar/ was about the JOB QUEUE or follow-up timing.
--
-- It was invisible because this roadmap was built from the 23-document
-- business set, where scheduling is implicit, rather than from the Phase 1
-- set, where it is one fifth of the workforce.
--
-- This is the first unit: the domain a meeting lives in. Not availability
-- (G-226), not booking idempotency (G-227), not reminders (G-228), not
-- completion analysis (G-229) — the ROW, its state machine, and the rules that
-- hold both. Deliberately first, and deliberately credential-free: no calendar
-- provider has been chosen (BLK-005), and the Scheduler specification §12
-- requires provider behaviour to sit behind an adapter anyway, so the domain
-- is what can and should exist before one does.
--
-- ── the states, and why proposal is one of them ────────────────────────────
--
-- §6.2 is explicit: "Treat proposal and confirmation as different states." A
-- slot that was offered is not a slot that was taken, and the whole failure
-- this separation prevents is an agent telling a client a meeting is booked
-- because it suggested a time.
--
--   requested  an intent was read; nothing has been offered
--   proposed   slots were offered; waiting for an unambiguous selection
--   booked     a slot was confirmed and this record is the booking
--   completed  an authorized person said it happened
--   no_show    an authorized person said it did not
--   cancelled  called off before it happened
--
-- ── time passing is not completion ─────────────────────────────────────────
--
-- §9.1: "Do not mark completed merely because the scheduled end time has
-- passed." §14: "No-show | No completion evidence | Controlled no-show
-- workflow". So `completed` and `no_show` both require an ACTOR and a
-- TIMESTAMP at the row — there is no path to either that a clock can take on
-- its own, which is the point. `meetings_completion_is_authorized` is that
-- rule, and it is a CHECK rather than application code because a clock with
-- database access is exactly the caller that would not run application code.
--
-- ── requested vs booked, kept apart ────────────────────────────────────────
--
-- §4.1: "Capture requested mode separately from final booked mode so later
-- changes are auditable." The same argument applies to the time: what the
-- client ASKED for and what was AGREED are different facts, and collapsing
-- them loses the only evidence that a client was moved off their request.
--
-- ── history is preserved, not overwritten ──────────────────────────────────
--
-- §8: a reschedule must "preserve old booking history" and a cancellation must
-- "not delete history". So a reschedule does not edit times in place — it
-- mints a NEW row carrying `supersedes_id`, and the old one is cancelled. The
-- same shape sales.proposals uses for a revised quotation, for the same
-- reason: the previous state of a commitment somebody was told about is not
-- the system's to quietly rewrite.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists crm.meetings (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,

  -- The relationship the meeting belongs to. A meeting without a lead is not a
  -- sales meeting, so this is the one required link.
  lead_id               uuid not null references crm.leads(id) on delete cascade,

  -- Who is meeting, and which deal it is about. Both optional: §3.2 forbids
  -- choosing between plausible identities without evidence, and a discovery
  -- call often precedes the opportunity it opens.
  contact_id            uuid references crm.contacts(id) on delete set null,
  opportunity_id        uuid references sales.opportunities(id) on delete set null,

  -- §3.1: "Preserve original source message/reference." The request is
  -- evidence, and a scheduling record that cannot show what was actually asked
  -- for is a record of somebody's interpretation.
  conversation_id       uuid references crm.conversations(id) on delete set null,
  requested_message_id  uuid references crm.conversation_messages(id) on delete set null,

  -- ── §4.1 mode: asked for, and agreed ──
  requested_mode        text not null check (requested_mode in
                          ('call', 'video_meeting', 'in_person_meeting', 'other')),
  booked_mode           text check (booked_mode in
                          ('call', 'video_meeting', 'in_person_meeting', 'other')),

  -- ── §4.2–4.3 what was asked for ──
  --
  -- All nullable: §4.2's "If no date is provided, invoke the configured
  -- earliest-availability rule" means a request with no date at all is a
  -- normal request, not a malformed one. `requested_window_end` carries a
  -- range such as "6–8 PM".
  requested_start_at    timestamptz,
  requested_window_end  timestamptz,

  -- ── §6 what was agreed ──
  confirmed_start_at    timestamptz,
  confirmed_end_at      timestamptz,

  -- §4.4: "Store the timezone used for the final booking." An IANA name, not
  -- an offset — an offset loses the daylight-saving rule that made it, which
  -- is the fact a reminder computed months ahead depends on.
  timezone              text,
  duration_minutes      int check (duration_minutes is null or duration_minutes > 0),

  -- ── §6.3 the provider, empty until one is chosen (BLK-005) ──
  --
  -- Present and null rather than absent: G-227 maps a provider event onto this
  -- row, and a column added later is a migration against live scheduling data.
  provider              text,
  provider_event_id     text,
  meeting_url           text,

  status                text not null default 'requested' check (status in
                          ('requested', 'proposed', 'booked',
                           'completed', 'no_show', 'cancelled')),

  -- §9.1's outcome vocabulary, beside the status rather than inside it: the
  -- status is where the record IS, the outcome is what a person concluded.
  outcome               text check (outcome in
                          ('completed', 'no_show', 'cancelled', 'failed', 'follow_up_required')),

  -- §9.1: "Capture completion actor and timestamp."
  completed_at          timestamptz,
  completed_by          uuid references core.users(id) on delete set null,

  cancelled_at          timestamptz,
  cancellation_reason   text,

  -- §8: a reschedule mints a new row rather than editing this one.
  supersedes_id         uuid references crm.meetings(id) on delete set null,

  purpose               text,
  created_by            uuid references core.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- ── the shape rules, held at the row ──

  -- A booking that does not say when, for how long, in which timezone or in
  -- what form is not a booking. §6.3 lists exactly these as what the record
  -- must store.
  constraint meetings_booked_is_specific check (
    status <> 'booked'
    or (confirmed_start_at is not null
        and confirmed_end_at is not null
        and timezone is not null
        and booked_mode is not null)
  ),

  constraint meetings_ends_after_it_starts check (
    confirmed_start_at is null
    or confirmed_end_at is null
    or confirmed_end_at > confirmed_start_at
  ),

  constraint meetings_window_ends_after_it_starts check (
    requested_start_at is null
    or requested_window_end is null
    or requested_window_end >= requested_start_at
  ),

  -- §9.1, and the rule the whole Scheduler specification repeats: TIME PASSING
  -- IS NOT COMPLETION. Both terminal outcomes need a person and a moment.
  constraint meetings_completion_is_authorized check (
    status not in ('completed', 'no_show')
    or (completed_at is not null and completed_by is not null)
  ),

  constraint meetings_cancellation_is_dated check (
    status <> 'cancelled' or cancelled_at is not null
  ),

  -- A meeting cannot supersede itself; a reschedule points at the row before.
  constraint meetings_supersedes_another check (supersedes_id is distinct from id)
);

create index if not exists meetings_org_status_idx
  on crm.meetings (organization_id, status, confirmed_start_at desc nulls last);

create index if not exists meetings_lead_idx
  on crm.meetings (lead_id, created_at desc);

create index if not exists meetings_opportunity_idx
  on crm.meetings (opportunity_id)
  where opportunity_id is not null;

-- The upcoming-meetings read every Scheduler surface starts from (§15's
-- "Upcoming schedule list", admin screen A08).
create index if not exists meetings_upcoming_idx
  on crm.meetings (organization_id, confirmed_start_at)
  where status = 'booked';


-- ── the state machine, at the row ─────────────────────────────────────────
--
-- The Phase 1 contract is blunt about this: "Do not allow invalid
-- transitions." Held here rather than only in the service for the reason the
-- lost-deal rule learned — a direct PostgREST write is a caller too, and a
-- state machine only the application knows is a state machine that a tool, a
-- job or a console can walk straight past.

create or replace function crm.enforce_meeting_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_allowed text[];
begin
  if new.status = old.status then
    return new;
  end if;

  v_allowed := case old.status
    when 'requested' then array['proposed', 'booked', 'cancelled']
    -- proposed → booked is the selection; proposed → proposed is a re-offer
    -- after "none of those work", which §5.3 requires and which is a status
    -- no-op handled above.
    when 'proposed'  then array['booked', 'cancelled']
    -- §9: only a booked meeting can have happened or been missed.
    when 'booked'    then array['completed', 'no_show', 'cancelled']
    else array[]::text[]
  end;

  if not (new.status = any(v_allowed)) then
    raise exception 'meeting_transition: % -> % is not a valid move', old.status, new.status
      using errcode = 'check_violation',
            hint = 'requested → proposed → booked → completed/no_show; cancelled from any live state; the three terminal states are terminal.';
  end if;

  return new;
end;
$$;

comment on function crm.enforce_meeting_transition() is
  'G-225. Refuses an invalid meeting status move at the row. completed, no_show and cancelled are terminal — a meeting that happened does not un-happen, and re-opening one is a new record (supersedes_id), not an edit, per Scheduler specification section 8.';

drop trigger if exists meetings_transition on crm.meetings;
create trigger meetings_transition
  before update of status on crm.meetings
  for each row execute function crm.enforce_meeting_transition();


-- ── row level security ────────────────────────────────────────────────────

alter table crm.meetings enable row level security;

drop policy if exists meetings_select on crm.meetings;
create policy meetings_select on crm.meetings
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists meetings_write on crm.meetings;
create policy meetings_write on crm.meetings
  for all to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id())
         and (select core.can_write()));


-- ── tenancy guards ────────────────────────────────────────────────────────
--
-- One org_match per org-scoped FK. core.unguarded_org_fks demands one for
-- EVERY single-column FK whose parent also carries organization_id, or
-- db:verify:tenancyguards fails. That is six here. `created_by` and
-- `completed_by` point at core.users, which has no organization_id at all, so
-- the completeness check does not reach them.

drop trigger if exists org_match_meetings_lead on crm.meetings;
create trigger org_match_meetings_lead
  before insert or update of lead_id, organization_id on crm.meetings
  for each row execute function core.enforce_parent_org('lead_id', 'crm.leads');

drop trigger if exists org_match_meetings_contact on crm.meetings;
create trigger org_match_meetings_contact
  before insert or update of contact_id, organization_id on crm.meetings
  for each row execute function core.enforce_parent_org('contact_id', 'crm.contacts');

drop trigger if exists org_match_meetings_opportunity on crm.meetings;
create trigger org_match_meetings_opportunity
  before insert or update of opportunity_id, organization_id on crm.meetings
  for each row execute function core.enforce_parent_org('opportunity_id', 'sales.opportunities');

drop trigger if exists org_match_meetings_conversation on crm.meetings;
create trigger org_match_meetings_conversation
  before insert or update of conversation_id, organization_id on crm.meetings
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');

drop trigger if exists org_match_meetings_message on crm.meetings;
create trigger org_match_meetings_message
  before insert or update of requested_message_id, organization_id on crm.meetings
  for each row execute function core.enforce_parent_org('requested_message_id', 'crm.conversation_messages');

drop trigger if exists org_match_meetings_supersedes on crm.meetings;
create trigger org_match_meetings_supersedes
  before insert or update of supersedes_id, organization_id on crm.meetings
  for each row execute function core.enforce_parent_org('supersedes_id', 'crm.meetings');

drop trigger if exists freeze_org_meetings on crm.meetings;
create trigger freeze_org_meetings
  before update on crm.meetings
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at on crm.meetings;
create trigger set_updated_at
  before update on crm.meetings
  for each row execute function core.set_updated_at();

grant select on crm.meetings to authenticated, service_role;
grant insert, update, delete on crm.meetings to authenticated, service_role;

comment on table crm.meetings is
  'A call or meeting with a lead — the Scheduler agent''s domain (G-225, Phase 1 locked workforce). Proposal and confirmation are different states (Scheduler specification section 6.2); what was REQUESTED is kept apart from what was AGREED (section 4.1); completion needs an actor and a timestamp because time passing is not completion (section 9.1); and a reschedule mints a new row carrying supersedes_id rather than editing history (section 8). Provider columns are present and empty until a calendar is chosen (BLK-005) - G-227 maps a provider event onto this row, and adding the column then would be a migration against live scheduling data.';
