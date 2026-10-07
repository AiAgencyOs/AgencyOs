-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 Scheduler, round 4 (traceability: docs/phase-1-orchestrator-quotation-round4-log.md).
-- Rows: P1-SCHED-036 (overlap prevention), P1-SCHED-041 (provider vs AgencyOS reconcile), P1-SCHED-011/024/025/027/029 (the client-facing messages, as DRAFTS),
--       P1-SCHED-069 / P1-FLOW-035 (reminder delivery metrics).
--
--   * OVERLAP. crm.book_meeting says it "does NOT prevent two different meetings overlapping - that needs an owner or resource column nothing has yet decided on".
--     The owner has still not decided per-owner calendars, so this does not invent one. It builds the guard for the one resource that exists: the organisation's
--     single booking calendar (the one availability is read from). WHERE THE RULE IS ON, a booked meeting that overlaps another booked meeting of the same
--     organisation is refused, under a per-organisation lock so two bookings cannot race past each other; the meeting a new booking SUPERSEDES (a reschedule) is
--     excluded. It is OFF until an administrator switches it on (crm.p1r_set_overlap_rule, with a reason): whether the agency has one calendar or several is the
--     owner's decision, and defaulting it on would silently forbid a legitimate parallel meeting while defaulting it off keeps today's behaviour. The Scheduling
--     policy screen carries the switch. An organisation that later models several calendars replaces this with a per-resource guard.
--   * RECONCILE. A service-role door records what the calendar provider says about a booked meeting's event and compares it with the AgencyOS row. Equal: in sync.
--     Different, cancelled or missing at the provider: a provider_conflict flag for a person (the existing p1o flag), never an automatic change either way.
--     An unreadable provider is recorded as unreadable, not as a conflict and not as in sync.
--   * DRAFTS. The proposal of times, the confirmation, the "nothing is free" message and the clarification question are composed and stored as drafts. Nothing sends
--     them: only a signed-in person records that they sent one, and the service role is refused that door. The message itself goes through the ordinary outbound
--     path when a person presses send.
--   * REMINDERS. The numbers of the reminder jobs and the delivery receipts of the reminder messages.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── overlap prevention ─────────────────────────────────────────────────────
create table if not exists crm.p1r_overlap_rule (
  organization_id uuid primary key references core.organizations(id) on delete cascade,
  prevent_overlap boolean not null default false,
  reason          text not null check (length(btrim(reason)) between 1 and 500),
  set_by          uuid references core.users(id) on delete set null,
  set_at          timestamptz not null default now()
);
alter table crm.p1r_overlap_rule enable row level security;
drop policy if exists p1r_overlap_rule_select on crm.p1r_overlap_rule;
create policy p1r_overlap_rule_select on crm.p1r_overlap_rule for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
drop trigger if exists p1r_freeze_org_overlap_rule on crm.p1r_overlap_rule;
create trigger p1r_freeze_org_overlap_rule before update of organization_id on crm.p1r_overlap_rule for each row execute function core.freeze_organization_id();
drop trigger if exists p1r_overlap_rule_reject_delete on crm.p1r_overlap_rule;
create trigger p1r_overlap_rule_reject_delete before delete on crm.p1r_overlap_rule for each row execute function core.reject_end_user_delete();
drop trigger if exists p1r_overlap_rule_no_truncate on crm.p1r_overlap_rule;
create trigger p1r_overlap_rule_no_truncate before truncate on crm.p1r_overlap_rule for each statement execute function crm.reject_truncate();
revoke all on crm.p1r_overlap_rule from public, anon, authenticated;
grant select on crm.p1r_overlap_rule to authenticated;
grant all on crm.p1r_overlap_rule to service_role;

create or replace function crm.p1r_set_overlap_rule(p_organization_id uuid, p_prevent boolean, p_reason text)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refusal text := ai.p1o_door_refusal(p_organization_id, true);
begin
  if v_refusal is not null then return query select v_refusal; return; end if;
  if (select auth.uid()) is null then return query select 'person_required'::text; return; end if;
  if p_prevent is null then return query select 'bad_value'::text; return; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then return query select 'missing_reason'::text; return; end if;
  insert into crm.p1r_overlap_rule as r (organization_id, prevent_overlap, reason, set_by, set_at)
  values (p_organization_id, p_prevent, left(btrim(p_reason), 500), (select auth.uid()), now())
  on conflict (organization_id) do update set prevent_overlap = excluded.prevent_overlap, reason = excluded.reason, set_by = excluded.set_by, set_at = excluded.set_at;
  perform core.record_audit(p_organization_id, 'meeting.overlap_rule_set', 'organization', p_organization_id, null, jsonb_build_object('prevent', p_prevent, 'reason', left(btrim(p_reason), 500)));
  return query select 'set'::text;
end $$;

create or replace function crm.p1r_enforce_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prevent boolean;
  v_other uuid;
begin
  if new.status <> 'booked' or new.confirmed_start_at is null or new.confirmed_end_at is null then return new; end if;
  -- an unrelated update of a meeting that is already booked at the same time is not a booking
  if tg_op = 'UPDATE' and old.status = 'booked' and old.confirmed_start_at is not distinct from new.confirmed_start_at
     and old.confirmed_end_at is not distinct from new.confirmed_end_at then
    return new;
  end if;
  select r.prevent_overlap into v_prevent from crm.p1r_overlap_rule r where r.organization_id = new.organization_id;
  if not coalesce(v_prevent, false) then return new; end if;

  -- two bookings for one organisation take this lock in turn: the second sees the first
  perform pg_advisory_xact_lock(hashtextextended('p1r_overlap:' || new.organization_id::text, 0));
  select m.id into v_other
    from crm.meetings m
   where m.organization_id = new.organization_id
     and m.status = 'booked'
     and m.id <> new.id
     and (new.supersedes_id is null or m.id <> new.supersedes_id)
     and m.confirmed_start_at < new.confirmed_end_at
     and m.confirmed_end_at > new.confirmed_start_at
   limit 1;
  if v_other is not null then
    raise exception 'meeting_policy: this time overlaps another booked meeting (%); never overwrite another booking', v_other using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists p1r_meetings_no_overlap on crm.meetings;
create trigger p1r_meetings_no_overlap
  before insert or update of status, confirmed_start_at, confirmed_end_at on crm.meetings
  for each row execute function crm.p1r_enforce_no_overlap();

-- what a person sees before choosing a time: the booked meetings a proposed window would overlap
create or replace function crm.p1r_meeting_overlaps(p_start timestamptz, p_end timestamptz, p_exclude_meeting_id uuid default null)
returns table (meeting_id uuid, lead_id uuid, confirmed_start_at timestamptz, confirmed_end_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) or (select core.current_organization_id()) is null then return; end if;
  return query
  select m.id, m.lead_id, m.confirmed_start_at, m.confirmed_end_at
    from crm.meetings m
   where m.organization_id = (select core.current_organization_id()) and m.status = 'booked'
     and (p_exclude_meeting_id is null or m.id <> p_exclude_meeting_id)
     and m.confirmed_start_at < p_end and m.confirmed_end_at > p_start
   order by m.confirmed_start_at;
end $$;

-- ── the provider is compared with AgencyOS ─────────────────────────────────
create table if not exists crm.p1r_provider_checks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  meeting_id      uuid not null references crm.meetings(id) on delete cascade,
  provider        text not null,
  provider_event_id text not null,
  provider_state  text not null check (provider_state in ('confirmed', 'cancelled', 'missing', 'unreadable')),
  provider_start_at timestamptz,
  provider_end_at   timestamptz,
  result          text not null check (result in ('in_sync', 'conflict', 'unreadable')),
  detail          text check (detail is null or length(detail) <= 1000),
  flag_id         uuid references crm.p1o_meeting_flags(id) on delete set null,
  checked_at      timestamptz not null default now(),
  constraint p1r_provider_check_confirmed_has_times check (provider_state <> 'confirmed' or (provider_start_at is not null and provider_end_at is not null))
);
create index if not exists p1r_provider_checks_idx on crm.p1r_provider_checks (meeting_id, checked_at desc);
create index if not exists p1r_provider_checks_org_idx on crm.p1r_provider_checks (organization_id, checked_at desc);
alter table crm.p1r_provider_checks enable row level security;
drop policy if exists p1r_provider_checks_select on crm.p1r_provider_checks;
create policy p1r_provider_checks_select on crm.p1r_provider_checks for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
drop trigger if exists p1r_org_match_provider_checks_meeting on crm.p1r_provider_checks;
create trigger p1r_org_match_provider_checks_meeting before insert or update of meeting_id, organization_id on crm.p1r_provider_checks
  for each row execute function core.enforce_parent_org('meeting_id', 'crm.meetings');
drop trigger if exists p1r_org_match_provider_checks_flag on crm.p1r_provider_checks;
create trigger p1r_org_match_provider_checks_flag before insert or update of flag_id, organization_id on crm.p1r_provider_checks
  for each row execute function core.enforce_parent_org('flag_id', 'crm.p1o_meeting_flags');
drop trigger if exists p1r_freeze_org_provider_checks on crm.p1r_provider_checks;
create trigger p1r_freeze_org_provider_checks before update of organization_id on crm.p1r_provider_checks for each row execute function core.freeze_organization_id();
drop trigger if exists p1r_provider_checks_reject_delete on crm.p1r_provider_checks;
create trigger p1r_provider_checks_reject_delete before delete on crm.p1r_provider_checks for each row execute function core.reject_end_user_delete();
drop trigger if exists p1r_provider_checks_no_truncate on crm.p1r_provider_checks;
create trigger p1r_provider_checks_no_truncate before truncate on crm.p1r_provider_checks for each statement execute function crm.reject_truncate();
revoke all on crm.p1r_provider_checks from public, anon, authenticated;
grant select on crm.p1r_provider_checks to authenticated;
grant all on crm.p1r_provider_checks to service_role;

-- the booked meetings whose provider event is worth looking at now (service role)
create or replace function crm.p1r_meetings_to_reconcile(p_organization_id uuid, p_limit int default 20, p_min_interval interval default interval '6 hours', p_horizon interval default interval '30 days')
returns table (meeting_id uuid, provider text, provider_event_id text, confirmed_start_at timestamptz, confirmed_end_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'crm.p1r_meetings_to_reconcile is a runner door' using errcode = 'insufficient_privilege';
  end if;
  return query
  select m.id, m.provider, m.provider_event_id, m.confirmed_start_at, m.confirmed_end_at
    from crm.meetings m
   where m.organization_id = p_organization_id and m.status = 'booked'
     and m.provider is not null and m.provider_event_id is not null
     and m.confirmed_end_at > now() - interval '1 day' and m.confirmed_start_at < now() + p_horizon
     and not exists (select 1 from crm.p1r_provider_checks c where c.meeting_id = m.id and c.checked_at > now() - p_min_interval)
   order by m.confirmed_start_at
   limit least(greatest(coalesce(p_limit, 20), 1), 100);
end $$;

create or replace function crm.p1r_record_provider_check(
  p_meeting_id uuid, p_provider_state text, p_provider_start timestamptz default null, p_provider_end timestamptz default null, p_detail text default null
)
returns table (outcome text, flag_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m crm.meetings;
  v_result text;
  v_note text;
  v_flag uuid;
  v_flag_outcome text;
  c_tolerance constant interval := interval '60 seconds';
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'crm.p1r_record_provider_check is a runner door' using errcode = 'insufficient_privilege';
  end if;
  select m.* into v_m from crm.meetings m where m.id = p_meeting_id;
  if v_m.id is null then return query select 'unknown_meeting'::text, null::uuid; return; end if;
  if p_provider_state not in ('confirmed', 'cancelled', 'missing', 'unreadable') then return query select 'bad_state'::text, null::uuid; return; end if;
  if v_m.status <> 'booked' or v_m.provider is null or v_m.provider_event_id is null then return query select 'not_checkable'::text, null::uuid; return; end if;
  if p_provider_state = 'confirmed' and (p_provider_start is null or p_provider_end is null) then return query select 'bad_times'::text, null::uuid; return; end if;

  v_result := case
    when p_provider_state = 'unreadable' then 'unreadable'
    when p_provider_state = 'confirmed'
         and abs(extract(epoch from (p_provider_start - v_m.confirmed_start_at))) <= extract(epoch from c_tolerance)
         and abs(extract(epoch from (p_provider_end - v_m.confirmed_end_at))) <= extract(epoch from c_tolerance) then 'in_sync'
    else 'conflict'
  end;

  if v_result = 'conflict' then
    v_note := case p_provider_state
      when 'cancelled' then 'The calendar says this event was cancelled, but AgencyOS still has the meeting booked for ' || to_char(v_m.confirmed_start_at at time zone coalesce(v_m.timezone, 'UTC'), 'YYYY-MM-DD HH24:MI') || ' (' || coalesce(v_m.timezone, 'UTC') || ').'
      when 'missing' then 'The calendar has no such event any more, but AgencyOS still has the meeting booked for ' || to_char(v_m.confirmed_start_at at time zone coalesce(v_m.timezone, 'UTC'), 'YYYY-MM-DD HH24:MI') || ' (' || coalesce(v_m.timezone, 'UTC') || ').'
      else 'The calendar has this event at ' || to_char(p_provider_start at time zone coalesce(v_m.timezone, 'UTC'), 'YYYY-MM-DD HH24:MI') || ' to ' || to_char(p_provider_end at time zone coalesce(v_m.timezone, 'UTC'), 'HH24:MI')
           || ', AgencyOS has it at ' || to_char(v_m.confirmed_start_at at time zone coalesce(v_m.timezone, 'UTC'), 'YYYY-MM-DD HH24:MI') || ' to ' || to_char(v_m.confirmed_end_at at time zone coalesce(v_m.timezone, 'UTC'), 'HH24:MI')
           || ' (' || coalesce(v_m.timezone, 'UTC') || '). Decide which is right; nothing was changed.'
    end;
    select f.outcome, f.flag_id into v_flag_outcome, v_flag from crm.p1o_flag_meeting(v_m.id, 'provider_conflict', v_note) f;
    if v_flag is null then raise exception 'the provider conflict could not be flagged (%)', v_flag_outcome; end if;
  end if;

  insert into crm.p1r_provider_checks (organization_id, meeting_id, provider, provider_event_id, provider_state, provider_start_at, provider_end_at, result, detail, flag_id)
  values (v_m.organization_id, v_m.id, v_m.provider, v_m.provider_event_id, p_provider_state, p_provider_start, p_provider_end, v_result, left(p_detail, 1000), v_flag);
  return query select case v_result when 'in_sync' then 'in_sync' when 'unreadable' then 'unreadable' else 'conflict_flagged' end::text, v_flag;
end $$;

-- the last look at each booked meeting's event, for the meeting page and the attention screen
create or replace function crm.p1r_provider_check_summary(p_days int default 30)
returns table (checked int, in_sync int, conflicts int, unreadable int, last_checked_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
begin
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) or v_org is null then return; end if;
  return query
  select count(*)::int, (count(*) filter (where c.result = 'in_sync'))::int, (count(*) filter (where c.result = 'conflict'))::int,
         (count(*) filter (where c.result = 'unreadable'))::int, max(c.checked_at)
    from crm.p1r_provider_checks c
   where c.organization_id = v_org and c.checked_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
end $$;

-- ── scheduling messages are drafts a person sends ──────────────────────────
create table if not exists crm.p1r_scheduling_drafts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  meeting_id      uuid not null references crm.meetings(id) on delete cascade,
  kind            text not null check (kind in ('proposal', 'confirmation', 'no_availability', 'clarification')),
  language        text not null check (language in ('en', 'hinglish')),
  body            text not null check (length(btrim(body)) between 1 and 1500),
  status          text not null default 'draft' check (status in ('draft', 'sent', 'discarded')),
  flag_id         uuid references crm.p1o_meeting_flags(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sent_by         uuid references core.users(id) on delete set null,
  sent_at         timestamptz,
  sent_message_id uuid,
  discarded_by    uuid references core.users(id) on delete set null,
  discarded_at    timestamptz,
  discard_reason  text check (discard_reason is null or length(discard_reason) <= 500),
  constraint p1r_drafts_sent_shape check (status <> 'sent' or (sent_by is not null and sent_at is not null)),
  constraint p1r_drafts_discarded_shape check (status <> 'discarded' or (discarded_at is not null and discard_reason is not null))
);
create unique index if not exists p1r_scheduling_drafts_one_open on crm.p1r_scheduling_drafts (meeting_id, kind) where status = 'draft';
create index if not exists p1r_scheduling_drafts_queue on crm.p1r_scheduling_drafts (organization_id, status, created_at desc);
alter table crm.p1r_scheduling_drafts enable row level security;
drop policy if exists p1r_scheduling_drafts_select on crm.p1r_scheduling_drafts;
create policy p1r_scheduling_drafts_select on crm.p1r_scheduling_drafts for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
drop trigger if exists p1r_org_match_drafts_meeting on crm.p1r_scheduling_drafts;
create trigger p1r_org_match_drafts_meeting before insert or update of meeting_id, organization_id on crm.p1r_scheduling_drafts
  for each row execute function core.enforce_parent_org('meeting_id', 'crm.meetings');
drop trigger if exists p1r_org_match_drafts_flag on crm.p1r_scheduling_drafts;
create trigger p1r_org_match_drafts_flag before insert or update of flag_id, organization_id on crm.p1r_scheduling_drafts
  for each row execute function core.enforce_parent_org('flag_id', 'crm.p1o_meeting_flags');
drop trigger if exists p1r_freeze_org_drafts on crm.p1r_scheduling_drafts;
create trigger p1r_freeze_org_drafts before update of organization_id on crm.p1r_scheduling_drafts for each row execute function core.freeze_organization_id();
drop trigger if exists p1r_drafts_reject_delete on crm.p1r_scheduling_drafts;
create trigger p1r_drafts_reject_delete before delete on crm.p1r_scheduling_drafts for each row execute function core.reject_end_user_delete();
drop trigger if exists p1r_drafts_no_truncate on crm.p1r_scheduling_drafts;
create trigger p1r_drafts_no_truncate before truncate on crm.p1r_scheduling_drafts for each statement execute function crm.reject_truncate();
revoke all on crm.p1r_scheduling_drafts from public, anon, authenticated;
grant select on crm.p1r_scheduling_drafts to authenticated;
grant all on crm.p1r_scheduling_drafts to service_role;

-- A draft is stored by the service or by a member of the organisation. It is a row, not a message: nothing here writes to a conversation or calls a provider.
create or replace function crm.p1r_save_scheduling_draft(p_meeting_id uuid, p_kind text, p_language text, p_body text, p_flag_id uuid default null)
returns table (outcome text, draft_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m crm.meetings;
  v_refusal text;
  v_id uuid;
  v_body text := nullif(btrim(coalesce(p_body, '')), '');
begin
  select m.* into v_m from crm.meetings m where m.id = p_meeting_id;
  if v_m.id is null then return query select 'unknown_meeting'::text, null::uuid; return; end if;
  v_refusal := ai.p1o_door_refusal(v_m.organization_id, false);
  if v_refusal is not null then return query select v_refusal, null::uuid; return; end if;
  if p_kind is null or p_kind not in ('proposal', 'confirmation', 'no_availability', 'clarification') then return query select 'bad_kind'::text, null::uuid; return; end if;
  if p_language is null or p_language not in ('en', 'hinglish') then return query select 'bad_language'::text, null::uuid; return; end if;
  if v_body is null or length(v_body) > 1500 then return query select 'bad_body'::text, null::uuid; return; end if;
  -- a message about a meeting that is in a state it does not fit would mislead the client
  if (p_kind = 'proposal' and v_m.status <> 'proposed')
     or (p_kind = 'confirmation' and v_m.status <> 'booked')
     or (p_kind = 'no_availability' and v_m.status not in ('requested', 'proposed'))
     or (p_kind = 'clarification' and v_m.status not in ('requested', 'proposed', 'booked')) then
    return query select 'wrong_state'::text, null::uuid; return;
  end if;

  select d.id into v_id from crm.p1r_scheduling_drafts d where d.meeting_id = v_m.id and d.kind = p_kind and d.status = 'draft' for update;
  if v_id is not null then
    update crm.p1r_scheduling_drafts set body = v_body, language = p_language, flag_id = coalesce(p_flag_id, flag_id), updated_at = now() where id = v_id;
    return query select 'replaced'::text, v_id; return;
  end if;
  begin
    insert into crm.p1r_scheduling_drafts (organization_id, meeting_id, kind, language, body, flag_id)
    values (v_m.organization_id, v_m.id, p_kind, p_language, v_body, p_flag_id) returning id into v_id;
  exception when foreign_key_violation or check_violation then
    return query select 'refused'::text, null::uuid; return;
  end;
  perform core.record_audit(v_m.organization_id, 'meeting.draft_saved', 'meeting', v_m.id, null, jsonb_build_object('kind', p_kind, 'draftId', v_id));
  return query select 'saved'::text, v_id;
end $$;

-- Only a signed-in person records that a draft was sent (the sending itself is the ordinary outbound path, pressed by that person). The service role is refused:
-- an agent can compose a draft, never send one.
create or replace function crm.p1r_record_scheduling_draft_sent(p_draft_id uuid, p_message_id uuid default null)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d crm.p1r_scheduling_drafts;
  v_refusal text;
begin
  select d.* into v_d from crm.p1r_scheduling_drafts d where d.id = p_draft_id for update;
  if v_d.id is null then return query select 'unknown_draft'::text; return; end if;
  if (select auth.uid()) is null then return query select 'person_required'::text; return; end if;
  v_refusal := ai.p1o_door_refusal(v_d.organization_id, false);
  if v_refusal is not null then return query select v_refusal; return; end if;
  if v_d.status <> 'draft' then return query select 'not_a_draft'::text; return; end if;
  update crm.p1r_scheduling_drafts set status = 'sent', sent_by = (select auth.uid()), sent_at = now(), sent_message_id = p_message_id, updated_at = now() where id = v_d.id;
  perform core.record_audit(v_d.organization_id, 'meeting.draft_sent', 'meeting', v_d.meeting_id, null, jsonb_build_object('kind', v_d.kind, 'draftId', v_d.id));
  return query select 'recorded'::text;
end $$;

create or replace function crm.p1r_discard_scheduling_draft(p_draft_id uuid, p_reason text)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d crm.p1r_scheduling_drafts;
  v_refusal text;
begin
  select d.* into v_d from crm.p1r_scheduling_drafts d where d.id = p_draft_id for update;
  if v_d.id is null then return query select 'unknown_draft'::text; return; end if;
  if (select auth.uid()) is null then return query select 'person_required'::text; return; end if;
  v_refusal := ai.p1o_door_refusal(v_d.organization_id, false);
  if v_refusal is not null then return query select v_refusal; return; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then return query select 'missing_reason'::text; return; end if;
  if v_d.status <> 'draft' then return query select 'not_a_draft'::text; return; end if;
  update crm.p1r_scheduling_drafts set status = 'discarded', discarded_by = (select auth.uid()), discarded_at = now(), discard_reason = left(btrim(p_reason), 500), updated_at = now() where id = v_d.id;
  return query select 'discarded'::text;
end $$;

create or replace function crm.p1r_open_scheduling_drafts(p_limit int default 100)
returns table (draft_id uuid, meeting_id uuid, lead_id uuid, conversation_id uuid, kind text, language text, body text, meeting_status text, flag_id uuid, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) or (select core.current_organization_id()) is null then return; end if;
  return query
  select d.id, d.meeting_id, m.lead_id, m.conversation_id, d.kind, d.language, d.body, m.status, d.flag_id, d.created_at
    from crm.p1r_scheduling_drafts d join crm.meetings m on m.id = d.meeting_id
   where d.organization_id = (select core.current_organization_id()) and d.status = 'draft'
   order by d.created_at
   limit least(greatest(coalesce(p_limit, 100), 1), 300);
end $$;

-- ── reminder delivery metrics ──────────────────────────────────────────────
-- Reminder JOBS (core.jobs kind meeting.reminder) and reminder MESSAGES (the internal-group message the sender wrote, external_ref meeting-reminder:...) and what
-- the wire said about them (delivery receipts). A reminder that was dropped because the meeting moved or was cancelled is a settled job with no message: it is not a failure.
create or replace function crm.p1r_reminder_metrics(p_from timestamptz default now() - interval '30 days', p_to timestamptz default now())
returns table (
  jobs int, jobs_queued int, jobs_done int, jobs_failed int, jobs_dead int,
  messages int, handed_off int, send_failed int, send_pending int, delivered int, read int, wire_failed int, awaiting_receipt int,
  delivery_rate numeric, failure_rate numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
begin
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) or v_org is null then return; end if;
  return query
  with j as (
    select x.status from core.jobs x where x.organization_id = v_org and x.kind = 'meeting.reminder' and x.run_at >= p_from and x.run_at <= p_to
  ), msg as (
    select cm.metadata ->> 'delivery' as delivery, cm.metadata ->> 'wire_status' as wire
      from crm.conversation_messages cm
     where cm.organization_id = v_org and cm.external_ref like 'meeting-reminder:%' and cm.occurred_at >= p_from and cm.occurred_at <= p_to
  )
  select (select count(*) from j)::int,
         (select count(*) from j where status in ('queued', 'running'))::int,
         (select count(*) from j where status = 'succeeded')::int,
         (select count(*) from j where status = 'failed')::int,
         (select count(*) from j where status = 'dead')::int,
         (select count(*) from msg)::int,
         (select count(*) from msg where delivery = 'sent')::int,
         (select count(*) from msg where delivery = 'failed')::int,
         (select count(*) from msg where delivery = 'pending')::int,
         (select count(*) from msg where wire in ('delivered', 'read'))::int,
         (select count(*) from msg where wire = 'read')::int,
         (select count(*) from msg where wire = 'failed')::int,
         (select count(*) from msg where delivery = 'sent' and wire is null)::int,
         round((select count(*) filter (where wire in ('delivered', 'read'))::numeric / nullif(count(*) filter (where delivery = 'sent'), 0) from msg), 3),
         round((select count(*) filter (where delivery = 'failed' or wire = 'failed')::numeric / nullif(count(*), 0) from msg), 3);
end $$;

-- ── grants ─────────────────────────────────────────────────────────────────
revoke all on function crm.p1r_set_overlap_rule(uuid, boolean, text), crm.p1r_meeting_overlaps(timestamptz, timestamptz, uuid), crm.p1r_provider_check_summary(int),
  crm.p1r_save_scheduling_draft(uuid, text, text, text, uuid), crm.p1r_record_scheduling_draft_sent(uuid, uuid), crm.p1r_discard_scheduling_draft(uuid, text),
  crm.p1r_open_scheduling_drafts(int), crm.p1r_reminder_metrics(timestamptz, timestamptz) from public, anon;
grant execute on function crm.p1r_set_overlap_rule(uuid, boolean, text), crm.p1r_meeting_overlaps(timestamptz, timestamptz, uuid), crm.p1r_provider_check_summary(int),
  crm.p1r_save_scheduling_draft(uuid, text, text, text, uuid), crm.p1r_record_scheduling_draft_sent(uuid, uuid), crm.p1r_discard_scheduling_draft(uuid, text),
  crm.p1r_open_scheduling_drafts(int), crm.p1r_reminder_metrics(timestamptz, timestamptz) to authenticated, service_role;
revoke all on function crm.p1r_meetings_to_reconcile(uuid, int, interval, interval), crm.p1r_record_provider_check(uuid, text, timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function crm.p1r_meetings_to_reconcile(uuid, int, interval, interval), crm.p1r_record_provider_check(uuid, text, timestamptz, timestamptz, text) to service_role;

notify pgrst, 'reload schema';
