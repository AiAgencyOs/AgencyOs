-- ═══════════════════════════════════════════════════════════════════════════
-- A reminder for a meeting that moved — G-228
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Scheduler specification §7.2 asks five things of a reminder, and three of
-- them are about the reminder being WRONG by the time it fires:
--
--   "Re-check current schedule state immediately before sending."
--   "Suppress reminders for cancelled events."
--   "Replace obsolete reminders after rescheduling."
--
-- Sales Flow §6 says it from the client's side: a reminder "must be re-checked
-- at execution time so it does not fire after the event is cancelled or
-- rescheduled".
--
-- ── the lesson this is an instance of ─────────────────────────────────────
--
-- G-191 was this exact failure in the outbound worker: the sending window was
-- applied when a message was SCHEDULED and never again, so a follow-up
-- computed at 18:00 arrived at three in the morning. The answer was to ask the
-- same question again at the moment of sending.
--
-- A reminder is the same shape with a worse blast radius, because the client
-- has been told somebody is coming. So the decision is made twice: here, to
-- work out when the job should run, and in `reminderVerdict` against the row
-- as it is when it does.
--
-- ── two halves, and why both ──────────────────────────────────────────────
--
-- **Proactive** — this migration. When a meeting is cancelled or its time
-- moves, the queued reminder is deleted rather than left to fail politely
-- later. A queue full of jobs that will decline to act is a queue nobody can
-- read, and §7.2 asks for reminders to be REPLACED rather than merely ignored.
--
-- **At fire time** — `src/lib/scheduling/reminders.ts`. The proactive half
-- cannot catch a job that was already claimed when the meeting moved, and that
-- race is exactly when a client gets told about a meeting that is not
-- happening. Neither half is sufficient; this is not redundancy.
--
-- ── the key, and what it deliberately omits ───────────────────────────────
--
-- `core.jobs.dedupe_key` is unique, so the key is what makes re-scheduling
-- REPLACE rather than accumulate. It carries the meeting and the lead time and
-- NOT the start: a key carrying the start would mint a fresh job every time a
-- meeting moved and leave the old one queued, which is the accumulation §7.2
-- exists to prevent. The start travels in the payload, where the fire-time
-- check reads it.
--
-- Two lead times are two reminders, not one overwriting the other — §7.2
-- permits an Admin reminder and a client reminder at different offsets.
--
-- ── carried forward, with two marked edits ────────────────────────────────
--
-- `core.set_organization_setting` is regenerated from its latest definition
-- (20260911120000) VERBATIM, with exactly two changes: `meeting_reminder_minutes`
-- joins the whitelist and gets its own validation.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Scheduling a reminder, idempotently ────────────────────────────────

create or replace function crm.schedule_meeting_reminder(
  p_meeting_id   uuid,
  p_lead_minutes int default null
)
returns table (
  -- 'scheduled' | 'replaced' | 'in_flight' | 'not_booked' | 'not_found' | 'in_the_past' | 'forbidden'
  outcome text,
  run_at  timestamptz
)
language plpgsql
volatile
-- DEFINER, not invoker. core.jobs admits exactly one INSERT kind from an
-- authenticated caller ('requirement.extract') and no UPDATE at all — so an
-- invoker function could never write a reminder, and the first draft's
-- 'replaced' branch silently matched zero rows while reporting success. Every
-- pre-existing writer of core.jobs (crm.ingest_whatsapp_message,
-- crm.emit_media_read) is definer for the same reason. Found by review, and
-- by core.audit_invoker_writes_without_policy(), which db:verify:invokerrls
-- asserts is empty.
security definer
set search_path = ''
as $$
declare
  -- Definer means RLS does not filter the meeting read, so the tenancy check
  -- below is the guard, and it follows the repository's idiom: an
  -- authenticated caller must own the row; the service role (no auth.uid)
  -- is the worker and is trusted.
  v_actor    uuid := (select auth.uid());
  v_meeting  crm.meetings;
  v_minutes  int;
  v_key      text;
  v_run_at   timestamptz;
  v_inserted boolean;
begin
  select m.* into v_meeting
    from crm.meetings m
   where m.id = p_meeting_id;

  if v_meeting.id is null then
    return query select 'not_found'::text, null::timestamptz; return;
  end if;

  if v_actor is not null
     and v_meeting.organization_id is distinct from (select core.current_organization_id()) then
    return query select 'forbidden'::text, null::timestamptz; return;
  end if;

  -- Only a booking has a time to count back from. Inventing one is how a
  -- reminder fires for a meeting nobody agreed to.
  if v_meeting.status <> 'booked' or v_meeting.confirmed_start_at is null then
    return query select 'not_booked'::text, null::timestamptz; return;
  end if;

  -- The configured policy, with the code's default when unset. Bounded here
  -- as well as in the setter, because a job may call this without going
  -- through the settings form.
  v_minutes := coalesce(
    p_lead_minutes,
    nullif((select o.settings->>'meeting_reminder_minutes'
              from core.organizations o
             where o.id = v_meeting.organization_id), '')::int,
    10
  );
  v_minutes := least(greatest(v_minutes, 1), 1440);

  v_run_at := v_meeting.confirmed_start_at - make_interval(mins => v_minutes);

  -- A reminder whose moment has already passed is not scheduled at all. The
  -- alternative -- queueing it to run immediately -- sends a client a reminder
  -- about a meeting that has started, which §7.2 would rather we did not.
  if v_run_at <= clock_timestamp() then
    return query select 'in_the_past'::text, v_run_at; return;
  end if;

  v_key := 'meeting.reminder:' || v_meeting.id::text || ':' || v_minutes::text;

  -- ONE statement, not a probe and then a write. jobs_dedupe_key_key is unique
  -- over EVERY status, and the first draft probed for status='queued' only —
  -- so a reminder whose job had already run (or failed, or died) left a row
  -- holding the key, the probe saw nothing, and the INSERT raised a raw
  -- unique_violation. The upsert reuses that row the way core.requeue_job
  -- does: back to queued, attempts reset, lock and error cleared. It declines
  -- to touch a RUNNING job — that is somebody else's in-flight work, and the
  -- fire-time check in reminderVerdict is what stops it if the meeting moved.
  insert into core.jobs (organization_id, kind, payload, run_at, dedupe_key)
  values (
    v_meeting.organization_id,
    'meeting.reminder',
    jsonb_build_object(
      'meeting_id', v_meeting.id,
      'scheduled_for_start_at', v_meeting.confirmed_start_at,
      'lead_minutes', v_minutes
    ),
    v_run_at,
    v_key
  )
  on conflict (dedupe_key) where dedupe_key is not null
  do update
     set run_at     = excluded.run_at,
         payload    = excluded.payload,
         status     = 'queued',
         attempts   = 0,
         locked_at  = null,
         locked_by  = null,
         last_error = null
   where core.jobs.status <> 'running'
  returning (xmax = 0) into v_inserted;

  if not found then
    return query select 'in_flight'::text, v_run_at; return;
  end if;

  return query select (case when v_inserted then 'scheduled' else 'replaced' end)::text, v_run_at;
end;
$$;
comment on function crm.schedule_meeting_reminder(uuid, int) is
  'G-228. Queues or REPLACES the reminder for a booked meeting. The dedupe key carries the meeting and the lead time but not the start, so a moved meeting updates one job instead of leaving the old one queued beside a new one (Scheduler specification section 7.2). A reminder whose moment has already passed is not scheduled at all, because queueing it to run immediately sends a client a reminder about a meeting that has started.';

revoke all on function crm.schedule_meeting_reminder(uuid, int) from public, anon;
grant execute on function crm.schedule_meeting_reminder(uuid, int) to authenticated, service_role;


-- ── 2. A cancelled or moved meeting drops its reminder ────────────────────
--
-- The proactive half. A queue full of jobs that will politely decline to act
-- is a queue nobody can read, and §7.2 asks for reminders to be REPLACED
-- rather than merely ignored.
--
-- Deliberately a DELETE of queued rows only: a reminder already claimed is
-- somebody else's in-flight work, and the fire-time check is what stops that
-- one. Nothing here touches history.

create or replace function crm.drop_stale_meeting_reminders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'cancelled'
     or new.status in ('completed', 'no_show')
     or new.confirmed_start_at is distinct from old.confirmed_start_at
  then
    delete from core.jobs
     where kind = 'meeting.reminder'
       and status = 'queued'
       and organization_id = new.organization_id
       and (payload->>'meeting_id')::uuid = new.id;
  end if;

  return new;
end;
$$;

comment on function crm.drop_stale_meeting_reminders() is
  'G-228. Removes QUEUED reminders when a meeting is cancelled, settled or moved. Queued only: a claimed reminder is in-flight work somebody else owns, and reminderVerdict is what stops that one at fire time. Security definer because core.jobs is not writable by the role editing a meeting, and it deletes only rows whose payload names this meeting in this organization.';

drop trigger if exists meetings_drop_stale_reminders on crm.meetings;
create trigger meetings_drop_stale_reminders
  after update of status, confirmed_start_at on crm.meetings
  for each row execute function crm.drop_stale_meeting_reminders();


-- ── 3. The setting, carried forward verbatim with two marked edits ────────

create or replace function core.set_organization_setting(
  p_organization_id uuid,
  p_key text,
  p_value text
)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_value text := nullif(btrim(coalesce(p_value, '')), '');
  v_old   text;
  v_settings jsonb;
begin
  if v_actor is not null then
    if (select core.current_user_role()) not in ('owner', 'ops_admin') then
      return query select 'forbidden'::text; return;
    end if;
    if p_organization_id is distinct from (select core.current_organization_id()) then
      return query select 'forbidden'::text; return;
    end if;
  end if;

  -- The whitelist. Anything else — and any attempt to smuggle a token in
  -- through this door — is refused rather than written.
  if p_key not in (
    'whatsapp_phone_number_id',
    'whatsapp_test_recipient',
    'quotation_contact_email',
    'quotation_contact_phone',
    'quotation_contact_location',
    -- G-179 — the pricing model's own inputs.
    'pricing_day_rate_rupees',
    'pricing_ai_day_rate_rupees',
    'pricing_multiplier_min',
    'pricing_multiplier_target',
    'pricing_multiplier_max',
    -- G-188 — the fifth segment of the project group's name.
    'project_group_identifier',
    -- G-195 — Doc 09 §21's four enforceable negotiation limits.
    'negotiation_max_rounds',
    'negotiation_min_price_rupees',
    'negotiation_max_discount_pct',
    'negotiation_max_autonomous_quote_rupees',
    -- ── G-223 — the reactivation per-run ceiling ───────────────────────────
    --
    -- The most inactive_lead follow-ups one worker invocation will send for
    -- this organization. Unset means no ceiling, and the worker behaves as it
    -- does today — a throttle somebody turns on, not a number this repository
    -- chose. Enforced in the follow-up worker, which is the only place that
    -- can count a single run's sends.
    'reactivation_max_per_run',
    -- ── G-230 — the payment half of the WON gate ──────────────────────────
    --
    -- Set to 'on' to additionally require payment or approved-exception
    -- evidence before a deal may be won. Unset means off, and the gate
    -- enforces its mandatory half alone (an accepted quotation version).
    -- Doc 09 section 23 and Master Development Plan V3 section 13.3 both
    -- describe this half as CONFIGURED, so it is a switch an owner throws
    -- rather than a business rule this repository chose.
    'won_requires_payment_evidence',
    -- ── G-228 — how far ahead a meeting is reminded ───────────────────────
    --
    -- Sales Flow section 6 gives 5-10 minutes as the user's stated target and
    -- says plainly that "exact policy can be configurable". Unset means the
    -- code's default of 10, which is the end of the range the owner named --
    -- a default rather than a rule this repository invented.
    'meeting_reminder_minutes'
  ) then
    return query select 'invalid_key'::text; return;
  end if;

  -- Shape the value per key. A non-numeric phone_number_id or a non-phone test
  -- recipient is a mistake worth catching here rather than at send time — and
  -- the three contact keys are printed on a document a client keeps, which is
  -- a worse place to discover a typo than this one.
  if v_value is not null then
    if p_key = 'whatsapp_phone_number_id' and v_value !~ '^[0-9]{5,32}$' then
      return query select 'invalid_value'::text; return;
    end if;
    if p_key = 'whatsapp_test_recipient' and v_value !~ '^\+?[0-9]{6,20}$' then
      return query select 'invalid_value'::text; return;
    end if;
    -- Deliberately loose but not absent: one @, no spaces, a dot after it.
    -- Anything stricter starts refusing addresses that work.
    if p_key = 'quotation_contact_email'
       and v_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' then
      return query select 'invalid_value'::text; return;
    end if;
    -- Digits, spaces, hyphens and an optional leading +: the shapes a person
    -- actually writes a phone number in.
    if p_key = 'quotation_contact_phone' and v_value !~ '^\+?[0-9][0-9 -]{5,24}$' then
      return query select 'invalid_value'::text; return;
    end if;
    if p_key = 'quotation_contact_location' and length(v_value) > 80 then
      return query select 'invalid_value'::text; return;
    end if;

    -- G-179. Whole rupees, no separators: a rate typed as "8,000" would
    -- parse to 8 on the way out and quietly divide the agency's costs by a
    -- thousand. Bounded at ten lakh a day, which is far above any real rate
    -- and far below a slipped decimal point.
    if p_key in ('pricing_day_rate_rupees', 'pricing_ai_day_rate_rupees') then
      if v_value !~ '^[0-9]{1,7}$' then
        return query select 'invalid_value'::text; return;
      end if;
      if v_value::numeric > 1000000 then
        return query select 'invalid_value'::text; return;
      end if;
    end if;

    -- A multiplier, written the way the owner says it: 2, 2.5, 3. Refused
    -- at or below 1, because a "band" that prices at or under cost is not a
    -- band anybody meant to configure — it is a percentage typed into the
    -- wrong field, which is exactly the mistake 250 would be.
    if p_key in ('pricing_multiplier_min', 'pricing_multiplier_target', 'pricing_multiplier_max') then
      if v_value !~ '^[0-9]{1,2}(\.[0-9]{1,2})?$' then
        return query select 'invalid_value'::text; return;
      end if;
      if v_value::numeric <= 1 or v_value::numeric > 10 then
        return query select 'invalid_value'::text; return;
      end if;
    end if;

    -- G-188. The fifth segment of a WhatsApp group's name, which a person
    -- reads on their phone: short enough that the four facts before it are
    -- still visible, and free of the separator the format itself uses.
    if p_key = 'project_group_identifier' then
      if length(v_value) > 40 or v_value like '%//%' then
        return query select 'invalid_value'::text; return;
      end if;
    end if;

    -- ── G-195 ────────────────────────────────────────────────────────────
    --
    -- Bounded the way the pricing rates are, and for the same reason: a
    -- limit typed with a separator or a slipped decimal point is a limit
    -- that silently stops binding. Whole numbers only, no separators.

    -- Rounds of negotiation the agent may redraft through. One is a real
    -- answer — "redraft once, then a person" — so the floor is 1, not 2.
    if p_key = 'negotiation_max_rounds' then
      if v_value !~ '^[0-9]{1,2}$' or v_value::numeric < 1 or v_value::numeric > 20 then
        return query select 'invalid_value'::text; return;
      end if;
    end if;

    -- Doc 07 §6's minimum acceptable price, in whole rupees.
    if p_key = 'negotiation_min_price_rupees' then
      if v_value !~ '^[0-9]{1,8}$' or v_value::numeric < 1 then
        return query select 'invalid_value'::text; return;
      end if;
    end if;

    -- Never above the 1–50 the offers table itself enforces.
    if p_key = 'negotiation_max_discount_pct' then
      if v_value !~ '^[0-9]{1,2}$' or v_value::numeric < 1 or v_value::numeric > 50 then
        return query select 'invalid_value'::text; return;
      end if;
    end if;

    -- Doc 07 §6's maximum autonomous quote value, in whole rupees.
    if p_key = 'negotiation_max_autonomous_quote_rupees' then
      if v_value !~ '^[0-9]{1,9}$' or v_value::numeric < 1 then
        return query select 'invalid_value'::text; return;
      end if;
    end if;

    -- ── G-223 ────────────────────────────────────────────────────────────
    --
    -- A whole number of sends, 1–500. Whole numbers only for the reason the
    -- rates learned expensively — "1,000" parses to 1. Bounded at 500, the
    -- same ceiling the enrolment batch cannot exceed (G-219): a throttle
    -- larger than any single tick could reach is a throttle nobody set on
    -- purpose. Zero is not a value — clearing the setting is how an owner
    -- removes the ceiling, and a stored 0 would read as "send nothing", which
    -- is a stopped campaign wearing a limit's clothes.
    if p_key = 'reactivation_max_per_run' then
      if v_value !~ '^[0-9]{1,3}$' or v_value::numeric < 1 or v_value::numeric > 500 then
        return query select 'invalid_value'::text; return;
      end if;
    end if;

    -- G-230. One word, so the setting cannot be half-on. Anything other
    -- than 'on' is refused rather than stored and quietly read as false --
    -- a gate that silently does nothing is the failure it exists to stop.
    -- Clearing the key is how an owner turns it off.
    if p_key = 'won_requires_payment_evidence' and v_value <> 'on' then
      return query select 'invalid_value'::text; return;
    end if;

    -- G-228. Whole minutes, 1 to 1440. Bounded at a day because past that it
    -- is not a reminder, it is a separate message about next week; floored at
    -- 1 because zero would mean "remind at the meeting", which is a reminder
    -- that has already failed. Whole numbers only, for the reason the rates
    -- learned expensively: "1,440" parses to 1.
    if p_key = 'meeting_reminder_minutes' then
      if v_value !~ '^[0-9]{1,4}$' or v_value::numeric < 1 or v_value::numeric > 1440 then
        return query select 'invalid_value'::text; return;
      end if;
    end if;
  end if;

  select o.settings into v_settings
    from core.organizations o
   where o.id = p_organization_id
   for update;
  if not found then
    return query select 'not_found'::text; return;
  end if;
  v_old := v_settings->>p_key;

  perform set_config('crm.org_setting_write', 'on', true);
  update core.organizations
     set settings = case
       when v_value is null then (coalesce(settings, '{}'::jsonb) - p_key)
       else coalesce(settings, '{}'::jsonb) || jsonb_build_object(p_key, v_value)
     end
   where id = p_organization_id;

  perform core.record_audit(
    p_organization_id,
    'organization.setting_set',
    'organization',
    p_organization_id,
    jsonb_build_object('key', p_key, 'value', v_old),
    jsonb_build_object('key', p_key, 'value', v_value)
  );

  return query select case when v_value is null then 'cleared' else 'set' end;
end;
$$;

comment on function core.set_organization_setting(uuid, text, text) is
  'The one door for an operational setting: owner or ops_admin only, a whitelist the database owns rather than the form, per-key validation, and an audit row carrying the old value and the new. Since G-228 it also carries meeting_reminder_minutes - how far ahead of a meeting its reminder fires, unset meaning the code default of 10 (Sales Flow section 6 gives 5-10 minutes as the target and says the exact policy is configurable).';

revoke all on function core.set_organization_setting(uuid, text, text) from public;
grant execute on function core.set_organization_setting(uuid, text, text) to authenticated, service_role;
