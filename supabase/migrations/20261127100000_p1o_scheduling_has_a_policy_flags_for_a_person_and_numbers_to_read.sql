-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 Scheduler gap closure (traceability: docs/phase-1-orchestrator-quotation-gaps-log.md).
-- Rows: P1-SCHED-014/015/018/020/026/036/038/041/062/065/068/069, and the routing half of P1-SCHED-006/011/024.
--
-- The Scheduler's rules were constants in booking.ts ("no policy rows yet"): an hour's notice, a quarter-hour buffer, three durations. There was no working-hours
-- rule at all, no expiry on an offer, no client timezone, no place to put "the client wants to move it" except a person remembering, and no numbers about how the
-- scheduling is going. This adds, on top of the existing meeting doors (none of which is edited):
--
--   * crm.p1o_scheduling_policy        one row per organisation, written only by an administrator through crm.p1o_set_scheduling_policy: the zone the hours are
--                                      in, working hours per weekday, the earliest and latest local time, dayparts, notice, buffer, durations, how long an offer
--                                      stays open, and whether a booking outside working hours is refused. An organisation with no row behaves exactly as before.
--   * an offer expires                 crm.meetings.proposal_expires_at is stamped when slots are offered; a booking after it is refused; the runner door
--                                      crm.p1o_expire_stale_proposals cancels what lapsed (the meeting.cancelled event is not news for a never-booked meeting).
--   * working hours                    a booking that falls outside them is refused, but only for an organisation that turned enforcement on.
--   * contact timezone                 crm.contacts.timezone (+ source and whether the client verified it) and crm.p1o_meeting_timezone, which says which zone to
--                                      use, on what basis, and whether a person must ask first.
--   * crm.p1o_meeting_flags            what needs a PERSON: the client wants to reschedule or cancel, a question about availability or reminders, an ambiguous
--                                      cancel (several candidate meetings), a provider/AgencyOS conflict, a slot that became busy, a booking that needs an
--                                      escalation. One open flag per meeting per kind. Nothing here moves a meeting; it asks a person to.
--   * crm.p1o_scheduler_metrics        the counts the Scheduler document lists, from rows that already exist.
-- Nothing is sent to anyone. Names ids and times only.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── contact timezone ───────────────────────────────────────────────────────
alter table crm.contacts
  add column if not exists timezone text,
  add column if not exists timezone_source text,
  add column if not exists timezone_verified boolean not null default false;
alter table crm.contacts drop constraint if exists p1o_contacts_timezone_shape;
alter table crm.contacts add constraint p1o_contacts_timezone_shape check (
  (timezone is null and timezone_source is null and not timezone_verified)
  or (timezone is not null and core.is_known_timezone(timezone) and timezone_source in ('client_stated', 'location_inferred', 'staff_entered'))
);

create or replace function crm.p1o_set_contact_timezone(p_contact_id uuid, p_timezone text, p_source text, p_verified boolean default false)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_refusal text;
begin
  select c.organization_id into v_org from crm.contacts c where c.id = p_contact_id;
  if v_org is null then return query select 'unknown_contact'::text; return; end if;
  v_refusal := ai.p1o_door_refusal(v_org, false);
  if v_refusal is not null then return query select v_refusal; return; end if;
  if p_timezone is null or not core.is_known_timezone(p_timezone) then return query select 'unknown_timezone'::text; return; end if;
  if p_source not in ('client_stated', 'location_inferred', 'staff_entered') then return query select 'bad_source'::text; return; end if;
  -- an inferred zone is never "verified": only the client saying so, or a person confirming it, makes it so
  update crm.contacts set timezone = p_timezone, timezone_source = p_source, timezone_verified = coalesce(p_verified, false) and p_source <> 'location_inferred'
   where id = p_contact_id;
  perform core.record_audit(v_org, 'contact.timezone_set', 'contact', p_contact_id, null,
    jsonb_build_object('timezone', p_timezone, 'source', p_source, 'verified', coalesce(p_verified, false) and p_source <> 'location_inferred'));
  return query select 'set'::text;
end $$;

-- which zone does this meeting use, and must a person ask first? (Scheduler s4.4)
create or replace function crm.p1o_meeting_timezone(p_meeting_id uuid)
returns table (timezone text, basis text, must_ask boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_m crm.meetings;
  v_c crm.contacts;
  v_agency text;
begin
  select m.* into v_m from crm.meetings m where m.id = p_meeting_id;
  if v_m.id is null then return; end if;
  if (select auth.uid()) is not null and v_m.organization_id is distinct from (select core.current_organization_id()) then return; end if;
  if v_m.contact_id is not null then select c.* into v_c from crm.contacts c where c.id = v_m.contact_id; end if;
  select p.timezone into v_agency from crm.p1o_scheduling_policy p where p.organization_id = v_m.organization_id;
  if v_c.timezone is not null and v_c.timezone_verified then
    return query select v_c.timezone, 'verified_contact_timezone'::text, false;
  elsif v_c.timezone is not null then
    return query select v_c.timezone, 'stored_contact_timezone_unverified'::text, false;
  elsif v_m.timezone is not null then
    return query select v_m.timezone, 'meeting_timezone'::text, false;
  else
    -- the zone is ambiguous and can change the booking materially: ask, do not guess
    return query select coalesce(v_agency, 'Asia/Kolkata'), 'agency_default_unconfirmed'::text, true;
  end if;
end $$;

-- ── the policy ─────────────────────────────────────────────────────────────
create table if not exists crm.p1o_scheduling_policy (
  organization_id      uuid primary key references core.organizations(id) on delete cascade,
  timezone             text not null default 'Asia/Kolkata' check (core.is_known_timezone(timezone)),
  working_hours        jsonb,
  earliest_local_time  time,
  latest_local_time    time,
  dayparts             jsonb not null default '{"morning":{"start":"09:00","end":"12:00"},"afternoon":{"start":"12:00","end":"17:00"},"evening":{"start":"17:00","end":"21:00"}}'::jsonb,
  min_notice_minutes   int not null default 60 check (min_notice_minutes between 0 and 10080),
  buffer_minutes       int not null default 15 check (buffer_minutes between 0 and 240),
  durations            int[] not null default '{30,45,60}' check (cardinality(durations) between 1 and 6),
  proposal_ttl_hours   int not null default 48 check (proposal_ttl_hours between 1 and 720),
  enforce_working_hours boolean not null default false,
  updated_by           uuid references core.users(id) on delete set null,
  updated_at           timestamptz not null default now(),
  constraint p1o_policy_bounds check (earliest_local_time is null or latest_local_time is null or earliest_local_time < latest_local_time),
  constraint p1o_policy_enforcement_needs_hours check (not enforce_working_hours or working_hours is not null)
);

create or replace function crm.p1o_valid_hours(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text; w jsonb; s time; e time;
begin
  if p is null then return true; end if;
  if jsonb_typeof(p) <> 'object' then return false; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') then return false; end if;
    if jsonb_typeof(p -> k) <> 'array' or jsonb_array_length(p -> k) > 4 then return false; end if;
    for w in select * from jsonb_array_elements(p -> k) loop
      begin s := (w ->> 'start')::time; e := (w ->> 'end')::time; exception when others then return false; end;
      if s is null or e is null or s >= e then return false; end if;
    end loop;
  end loop;
  return true;
end $$;

create or replace function crm.p1o_valid_dayparts(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text; s time; e time;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return false; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('morning', 'afternoon', 'evening', 'night') then return false; end if;
    begin s := (p -> k ->> 'start')::time; e := (p -> k ->> 'end')::time; exception when others then return false; end;
    if s is null or e is null or s >= e then return false; end if;
  end loop;
  return true;
end $$;

alter table crm.p1o_scheduling_policy drop constraint if exists p1o_policy_shapes;
alter table crm.p1o_scheduling_policy add constraint p1o_policy_shapes check (crm.p1o_valid_hours(working_hours) and crm.p1o_valid_dayparts(dayparts));

alter table crm.p1o_scheduling_policy enable row level security;
drop policy if exists p1o_scheduling_policy_select on crm.p1o_scheduling_policy;
create policy p1o_scheduling_policy_select on crm.p1o_scheduling_policy for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
drop trigger if exists p1o_freeze_org_scheduling_policy on crm.p1o_scheduling_policy;
create trigger p1o_freeze_org_scheduling_policy before update of organization_id on crm.p1o_scheduling_policy for each row execute function core.freeze_organization_id();
drop trigger if exists p1o_scheduling_policy_reject_delete on crm.p1o_scheduling_policy;
create trigger p1o_scheduling_policy_reject_delete before delete on crm.p1o_scheduling_policy for each row execute function core.reject_end_user_delete();
drop trigger if exists p1o_scheduling_policy_no_truncate on crm.p1o_scheduling_policy;
create trigger p1o_scheduling_policy_no_truncate before truncate on crm.p1o_scheduling_policy for each statement execute function crm.reject_truncate();

-- The policy an organisation runs on: its own row, or the defaults the Scheduler used to hard-code.
create or replace function crm.p1o_scheduling_policy_for(p_organization_id uuid)
returns table (timezone text, working_hours jsonb, earliest_local_time time, latest_local_time time, dayparts jsonb, min_notice_minutes int, buffer_minutes int,
               durations int[], proposal_ttl_hours int, enforce_working_hours boolean, configured boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select p.timezone, p.working_hours, p.earliest_local_time, p.latest_local_time, p.dayparts, p.min_notice_minutes, p.buffer_minutes, p.durations,
         p.proposal_ttl_hours, p.enforce_working_hours, true
    from crm.p1o_scheduling_policy p
   where p.organization_id = p_organization_id
     and ((select auth.uid()) is null or p.organization_id = (select core.current_organization_id()))
  union all
  select 'Asia/Kolkata', null::jsonb, null::time, null::time,
         '{"morning":{"start":"09:00","end":"12:00"},"afternoon":{"start":"12:00","end":"17:00"},"evening":{"start":"17:00","end":"21:00"}}'::jsonb,
         60, 15, '{30,45,60}'::int[], 48, false, false
   where not exists (select 1 from crm.p1o_scheduling_policy p where p.organization_id = p_organization_id)
     and ((select auth.uid()) is null or p_organization_id = (select core.current_organization_id()));
$$;

create or replace function crm.p1o_set_scheduling_policy(p_organization_id uuid, p_policy jsonb)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refusal text := ai.p1o_door_refusal(p_organization_id, true);
  v_cur record;
  v_tz text;
  v_hours jsonb;
  v_earliest time;
  v_latest time;
  v_dayparts jsonb;
  v_durations int[];
begin
  if v_refusal is not null then return query select v_refusal; return; end if;
  if p_policy is null or jsonb_typeof(p_policy) <> 'object' then return query select 'bad_policy'::text; return; end if;
  select * into v_cur from crm.p1o_scheduling_policy_for(p_organization_id);
  begin
    v_tz := coalesce(p_policy ->> 'timezone', v_cur.timezone);
    v_hours := case when p_policy ? 'working_hours' then nullif(p_policy -> 'working_hours', 'null'::jsonb) else v_cur.working_hours end;
    v_earliest := case when p_policy ? 'earliest_local_time' then nullif(p_policy ->> 'earliest_local_time', '')::time else v_cur.earliest_local_time end;
    v_latest := case when p_policy ? 'latest_local_time' then nullif(p_policy ->> 'latest_local_time', '')::time else v_cur.latest_local_time end;
    v_dayparts := coalesce(p_policy -> 'dayparts', v_cur.dayparts);
    v_durations := case when p_policy ? 'durations' then (select array_agg(x::int order by x::int) from jsonb_array_elements_text(p_policy -> 'durations') x) else v_cur.durations end;
  exception when others then
    return query select 'bad_policy'::text; return;
  end;
  begin
    insert into crm.p1o_scheduling_policy as sp (organization_id, timezone, working_hours, earliest_local_time, latest_local_time, dayparts, min_notice_minutes, buffer_minutes,
                                                 durations, proposal_ttl_hours, enforce_working_hours, updated_by, updated_at)
    values (p_organization_id, v_tz, v_hours, v_earliest, v_latest, v_dayparts,
            coalesce((p_policy ->> 'min_notice_minutes')::int, v_cur.min_notice_minutes), coalesce((p_policy ->> 'buffer_minutes')::int, v_cur.buffer_minutes),
            v_durations, coalesce((p_policy ->> 'proposal_ttl_hours')::int, v_cur.proposal_ttl_hours),
            coalesce((p_policy ->> 'enforce_working_hours')::boolean, v_cur.enforce_working_hours), (select auth.uid()), now())
    on conflict (organization_id) do update
      set timezone = excluded.timezone, working_hours = excluded.working_hours, earliest_local_time = excluded.earliest_local_time,
          latest_local_time = excluded.latest_local_time, dayparts = excluded.dayparts, min_notice_minutes = excluded.min_notice_minutes,
          buffer_minutes = excluded.buffer_minutes, durations = excluded.durations, proposal_ttl_hours = excluded.proposal_ttl_hours,
          enforce_working_hours = excluded.enforce_working_hours, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  exception when check_violation or invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
    return query select 'refused'::text; return;
  end;
  perform core.record_audit(p_organization_id, 'scheduling_policy.set', 'organization', p_organization_id,
    to_jsonb(v_cur) - 'configured', p_policy);
  return query select 'set'::text;
end $$;

-- is this booking inside the agency's working hours? true when no hours are configured (nothing to break)
create or replace function crm.p1o_within_working_hours(p_organization_id uuid, p_start timestamptz, p_end timestamptz)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_p crm.p1o_scheduling_policy;
  v_ls timestamp;
  v_le timestamp;
  v_day text;
begin
  select p.* into v_p from crm.p1o_scheduling_policy p where p.organization_id = p_organization_id;
  if v_p.organization_id is null or v_p.working_hours is null then return true; end if;
  v_ls := p_start at time zone v_p.timezone;
  v_le := p_end at time zone v_p.timezone;
  if v_ls::date <> v_le::date then return false; end if;
  if v_p.earliest_local_time is not null and v_ls::time < v_p.earliest_local_time then return false; end if;
  if v_p.latest_local_time is not null and v_le::time > v_p.latest_local_time then return false; end if;
  v_day := lower(to_char(v_ls, 'dy'));
  return exists (
    select 1 from jsonb_array_elements(coalesce(v_p.working_hours -> v_day, '[]'::jsonb)) w
     where (w ->> 'start')::time <= v_ls::time and (w ->> 'end')::time >= v_le::time);
end $$;

-- ── a booking outside working hours is refused, for an organisation that turned it on ──
create or replace function crm.p1o_enforce_working_hours()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enforce boolean;
begin
  if new.status <> 'booked' or new.confirmed_start_at is null or new.confirmed_end_at is null then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'booked' and old.confirmed_start_at is not distinct from new.confirmed_start_at
     and old.confirmed_end_at is not distinct from new.confirmed_end_at then
    return new;
  end if;
  select p.enforce_working_hours into v_enforce from crm.p1o_scheduling_policy p where p.organization_id = new.organization_id;
  if coalesce(v_enforce, false) and not crm.p1o_within_working_hours(new.organization_id, new.confirmed_start_at, new.confirmed_end_at) then
    raise exception 'meeting_policy: this time is outside the agency''s working hours' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists p1o_meetings_enforce_working_hours on crm.meetings;
create trigger p1o_meetings_enforce_working_hours
  before insert or update of status, confirmed_start_at, confirmed_end_at on crm.meetings
  for each row execute function crm.p1o_enforce_working_hours();

-- ── an offer expires ───────────────────────────────────────────────────────
alter table crm.meetings add column if not exists proposal_expires_at timestamptz;

create or replace function crm.p1o_stamp_proposal_expiry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ttl int;
begin
  if new.status = 'proposed' and new.proposed_slots is not null
     and (tg_op = 'INSERT' or old.proposed_slots is distinct from new.proposed_slots or old.status is distinct from 'proposed') then
    select coalesce((select p.proposal_ttl_hours from crm.p1o_scheduling_policy p where p.organization_id = new.organization_id), 48) into v_ttl;
    new.proposal_expires_at := now() + make_interval(hours => v_ttl);
  end if;
  -- booking an offer that lapsed: the lead was shown times that may no longer be free
  if new.status = 'booked' and tg_op = 'UPDATE' and old.status = 'proposed'
     and old.proposal_expires_at is not null and old.proposal_expires_at < now() then
    raise exception 'meeting_policy: the offer expired at %; propose again', old.proposal_expires_at using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists p1o_meetings_proposal_expiry on crm.meetings;
create trigger p1o_meetings_proposal_expiry
  before insert or update of status, proposed_slots on crm.meetings
  for each row execute function crm.p1o_stamp_proposal_expiry();

create or replace function crm.p1o_expire_stale_proposals(p_organization_id uuid)
returns table (expired int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int := 0;
  v_id uuid;
begin
  if (select auth.role()) is distinct from 'service_role' and (select auth.uid()) is not null then
    raise exception 'crm.p1o_expire_stale_proposals is a runner door' using errcode = 'insufficient_privilege';
  end if;
  for v_id in select m.id from crm.meetings m
               where m.organization_id = p_organization_id and m.status = 'proposed' and m.proposal_expires_at is not null and m.proposal_expires_at < now()
  loop
    update crm.meetings set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'the offered times expired without an answer' where id = v_id;
    insert into crm.p1o_meeting_flags (organization_id, meeting_id, kind, note)
    select m.organization_id, m.id, 'proposal_expired', 'The offered times lapsed. Offer new times if the lead is still interested.'
      from crm.meetings m where m.id = v_id
    on conflict do nothing;
    perform core.record_audit(p_organization_id, 'meeting.proposal_expired', 'meeting', v_id, null, '{}'::jsonb);
    v_n := v_n + 1;
  end loop;
  return query select v_n;
end $$;

-- ── what needs a person ────────────────────────────────────────────────────
create table if not exists crm.p1o_meeting_flags (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  meeting_id      uuid not null references crm.meetings(id) on delete cascade,
  kind            text not null check (kind in ('reschedule_request', 'cancel_request', 'availability_question', 'reminder_question', 'ambiguous_cancel', 'ambiguous_reschedule',
                                                'provider_conflict', 'slot_busy', 'timezone_ambiguous', 'needs_escalation', 'proposal_expired')),
  note            text not null check (length(btrim(note)) between 1 and 1000),
  candidate_meeting_ids uuid[] not null default '{}',
  state           text not null default 'open' check (state in ('open', 'handled')),
  raised_by       uuid references core.users(id) on delete set null,
  raised_at       timestamptz not null default now(),
  handled_by      uuid references core.users(id) on delete set null,
  handled_at      timestamptz,
  handled_note    text check (handled_note is null or length(handled_note) <= 1000),
  constraint p1o_flags_handled_shape check (state = 'open' or (handled_at is not null and handled_note is not null))
);
create unique index if not exists p1o_meeting_flags_one_open on crm.p1o_meeting_flags (meeting_id, kind) where state = 'open';
create index if not exists p1o_meeting_flags_queue on crm.p1o_meeting_flags (organization_id, state, raised_at desc);
alter table crm.p1o_meeting_flags enable row level security;
drop policy if exists p1o_meeting_flags_select on crm.p1o_meeting_flags;
create policy p1o_meeting_flags_select on crm.p1o_meeting_flags for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
drop trigger if exists p1o_org_match_flags_meeting on crm.p1o_meeting_flags;
create trigger p1o_org_match_flags_meeting before insert or update of meeting_id, organization_id on crm.p1o_meeting_flags
  for each row execute function core.enforce_parent_org('meeting_id', 'crm.meetings');
drop trigger if exists p1o_freeze_org_flags on crm.p1o_meeting_flags;
create trigger p1o_freeze_org_flags before update of organization_id on crm.p1o_meeting_flags for each row execute function core.freeze_organization_id();
drop trigger if exists p1o_flags_reject_delete on crm.p1o_meeting_flags;
create trigger p1o_flags_reject_delete before delete on crm.p1o_meeting_flags for each row execute function core.reject_end_user_delete();
drop trigger if exists p1o_flags_no_truncate on crm.p1o_meeting_flags;
create trigger p1o_flags_no_truncate before truncate on crm.p1o_meeting_flags for each statement execute function crm.reject_truncate();

create or replace function crm.p1o_flag_meeting(p_meeting_id uuid, p_kind text, p_note text, p_candidate_meeting_ids uuid[] default '{}')
returns table (outcome text, flag_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m crm.meetings;
  v_refusal text;
  v_id uuid;
begin
  select m.* into v_m from crm.meetings m where m.id = p_meeting_id;
  if v_m.id is null then return query select 'unknown_meeting'::text, null::uuid; return; end if;
  v_refusal := ai.p1o_door_refusal(v_m.organization_id, false);
  if v_refusal is not null then return query select v_refusal, null::uuid; return; end if;
  if p_kind is null or p_kind not in ('reschedule_request', 'cancel_request', 'availability_question', 'reminder_question', 'ambiguous_cancel', 'ambiguous_reschedule',
                                      'provider_conflict', 'slot_busy', 'timezone_ambiguous', 'needs_escalation') then
    return query select 'bad_kind'::text, null::uuid; return;
  end if;
  if p_note is null or length(btrim(p_note)) = 0 then return query select 'missing_note'::text, null::uuid; return; end if;
  if p_kind in ('ambiguous_cancel', 'ambiguous_reschedule') and coalesce(cardinality(p_candidate_meeting_ids), 0) < 2 then return query select 'needs_candidates'::text, null::uuid; return; end if;
  if v_m.status in ('completed', 'no_show', 'cancelled') and p_kind in ('reschedule_request', 'cancel_request') then
    return query select 'settled'::text, null::uuid; return;
  end if;
  insert into crm.p1o_meeting_flags (organization_id, meeting_id, kind, note, candidate_meeting_ids, raised_by)
  values (v_m.organization_id, v_m.id, p_kind, left(btrim(p_note), 1000), coalesce(p_candidate_meeting_ids, '{}'), (select auth.uid()))
  on conflict (meeting_id, kind) where state = 'open' do nothing
  returning id into v_id;
  if v_id is null then
    select f.id into v_id from crm.p1o_meeting_flags f where f.meeting_id = v_m.id and f.kind = p_kind and f.state = 'open';
    return query select 'already_open'::text, v_id; return;
  end if;
  perform core.record_audit(v_m.organization_id, 'meeting.flagged', 'meeting', v_m.id, null, jsonb_build_object('kind', p_kind, 'flagId', v_id));
  return query select 'flagged'::text, v_id;
end $$;

create or replace function crm.p1o_handle_meeting_flag(p_flag_id uuid, p_note text)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_f crm.p1o_meeting_flags;
  v_refusal text;
begin
  select f.* into v_f from crm.p1o_meeting_flags f where f.id = p_flag_id for update;
  if v_f.id is null then return query select 'unknown_flag'::text; return; end if;
  v_refusal := ai.p1o_door_refusal(v_f.organization_id, false);
  if v_refusal is not null then return query select v_refusal; return; end if;
  if p_note is null or length(btrim(p_note)) = 0 then return query select 'missing_note'::text; return; end if;
  if v_f.state = 'handled' then return query select 'already_handled'::text; return; end if;
  update crm.p1o_meeting_flags set state = 'handled', handled_by = (select auth.uid()), handled_at = now(), handled_note = left(btrim(p_note), 1000) where id = v_f.id;
  perform core.record_audit(v_f.organization_id, 'meeting.flag_handled', 'meeting', v_f.meeting_id, null, jsonb_build_object('flagId', v_f.id, 'kind', v_f.kind));
  return query select 'handled'::text;
end $$;

create or replace function crm.p1o_open_meeting_flags(p_limit int default 100)
returns table (flag_id uuid, meeting_id uuid, lead_id uuid, kind text, note text, candidate_meeting_ids uuid[], raised_at timestamptz, age_minutes int, meeting_status text, confirmed_start_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) or (select core.current_organization_id()) is null then return; end if;
  return query
  select f.id, f.meeting_id, m.lead_id, f.kind, f.note, f.candidate_meeting_ids, f.raised_at, (extract(epoch from (now() - f.raised_at)) / 60)::int, m.status, m.confirmed_start_at
    from crm.p1o_meeting_flags f join crm.meetings m on m.id = f.meeting_id
   where f.organization_id = (select core.current_organization_id()) and f.state = 'open'
   order by f.raised_at
   limit least(greatest(coalesce(p_limit, 100), 1), 300);
end $$;

-- ── the numbers the Scheduler document lists (s16), from rows that already exist ──
create or replace function crm.p1o_scheduler_metrics(p_from timestamptz default now() - interval '30 days', p_to timestamptz default now())
returns table (
  requests int, calls int, video_meetings int, in_person int, other_mode int, booked_ever int, booking_rate numeric, median_hours_request_to_booking numeric,
  rescheduled int, cancelled int, completed int, no_show int, reschedule_rate numeric, cancel_rate numeric, no_show_rate numeric,
  proposals_expired int, flags_open int, flags_handled int
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
  with m as (select * from crm.meetings x where x.organization_id = v_org and x.created_at >= p_from and x.created_at <= p_to)
  select (select count(*) from m)::int,
         (select count(*) from m where requested_mode = 'call')::int,
         (select count(*) from m where requested_mode = 'video_meeting')::int,
         (select count(*) from m where requested_mode = 'in_person_meeting')::int,
         (select count(*) from m where requested_mode = 'other')::int,
         (select count(*) from m where booked_at is not null)::int,
         round((select count(*) filter (where booked_at is not null)::numeric / nullif(count(*), 0) from m), 3),
         round((select (percentile_cont(0.5) within group (order by extract(epoch from (booked_at - created_at)) / 3600))::numeric from m where booked_at is not null), 2),
         (select count(*) from m where supersedes_id is not null)::int,
         (select count(*) from m where status = 'cancelled')::int,
         (select count(*) from m where status = 'completed')::int,
         (select count(*) from m where status = 'no_show')::int,
         round((select count(*) filter (where supersedes_id is not null)::numeric / nullif(count(*) filter (where booked_at is not null), 0) from m), 3),
         round((select count(*) filter (where status = 'cancelled' and booked_at is not null)::numeric / nullif(count(*) filter (where booked_at is not null), 0) from m), 3),
         round((select count(*) filter (where status = 'no_show')::numeric / nullif(count(*) filter (where status in ('completed', 'no_show')), 0) from m), 3),
         (select count(*) from crm.p1o_meeting_flags f where f.organization_id = v_org and f.kind = 'proposal_expired' and f.raised_at >= p_from and f.raised_at <= p_to)::int,
         (select count(*) from crm.p1o_meeting_flags f where f.organization_id = v_org and f.state = 'open')::int,
         (select count(*) from crm.p1o_meeting_flags f where f.organization_id = v_org and f.state = 'handled' and f.handled_at >= p_from and f.handled_at <= p_to)::int;
end $$;

-- ── grants ─────────────────────────────────────────────────────────────────
revoke all on function
  crm.p1o_set_contact_timezone(uuid, text, text, boolean), crm.p1o_meeting_timezone(uuid), crm.p1o_scheduling_policy_for(uuid),
  crm.p1o_set_scheduling_policy(uuid, jsonb), crm.p1o_within_working_hours(uuid, timestamptz, timestamptz), crm.p1o_expire_stale_proposals(uuid),
  crm.p1o_flag_meeting(uuid, text, text, uuid[]), crm.p1o_handle_meeting_flag(uuid, text), crm.p1o_open_meeting_flags(int), crm.p1o_scheduler_metrics(timestamptz, timestamptz)
  from public, anon;
grant execute on function
  crm.p1o_set_contact_timezone(uuid, text, text, boolean), crm.p1o_meeting_timezone(uuid), crm.p1o_scheduling_policy_for(uuid),
  crm.p1o_set_scheduling_policy(uuid, jsonb), crm.p1o_within_working_hours(uuid, timestamptz, timestamptz),
  crm.p1o_flag_meeting(uuid, text, text, uuid[]), crm.p1o_handle_meeting_flag(uuid, text), crm.p1o_open_meeting_flags(int), crm.p1o_scheduler_metrics(timestamptz, timestamptz)
  to authenticated, service_role;
grant execute on function crm.p1o_expire_stale_proposals(uuid) to service_role;

notify pgrst, 'reload schema';
