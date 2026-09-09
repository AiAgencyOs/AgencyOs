-- ═══════════════════════════════════════════════════════════════════════════
-- A reactivation tick has a ceiling — G-223 (Phase 10 rate control)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADM-87 makes reactivation opt-in: a gate off by default, and per-lead
-- enrolment on top of it. G-216 then bounds what the agency STARTS — per
-- contact per day, per organization per day, and a fatigue cooldown — and the
-- send chokepoint enforces all of it. Those are the DAILY ceilings, persisted
-- and checked in `crm.send_outbound_message`.
--
-- What none of them bounds is THROUGHPUT WITHIN A TICK. The follow-up worker
-- runs from the cron tick, and its BATCH (50) is the only thing between an
-- enrolled cohort and a burst: the day the pilot is switched on for twelve
-- hundred historical leads, the first tick that finds them due sends as many as
-- the batch and the daily limits allow, all at once. The daily limit stops the
-- SECOND message to a person; it does not smooth the FIRST across the hundreds
-- who are due together. A number reported for a burst is a number reported
-- however polite each individual message was.
--
-- This adds one setting — `reactivation_max_per_run` — the most `inactive_lead`
-- follow-ups a single worker invocation will SEND for one organization. Unset,
-- there is no ceiling and the worker behaves exactly as it does today: this is
-- a throttle somebody turns on, not a default this repository chose (ADM-88's
-- posture, and G-195's before it). It is enforced in the worker, not the
-- database, because "per run" is a fact about an invocation and only the
-- invocation can count itself — G-216's limits live in the chokepoint because
-- they are facts about a day, which any writer can read from the rows.
--
-- It is NOT a second copy of G-216. A rate stops a burst to ONE person over a
-- day; this stops a burst to MANY people in one tick. A capped tick blocks the
-- overflow (no attempt consumed, tried again next tick), so the cohort drains
-- a ceiling at a time rather than all at once — the sequence is throttled, not
-- stopped.
--
-- ── carried forward, with one marked edit ─────────────────────────────────
--
-- `core.set_organization_setting` is regenerated from its latest definition
-- (20260904120000) VERBATIM, with exactly one change: `reactivation_max_per_run`
-- is added to the whitelist and given its own bounded-integer validation. The
-- alternative — an ALTER that appends to the whitelist — cannot be expressed for
-- a plpgsql body, and regenerating from an older copy is how a function silently
-- reverts (the lesson G-126 and D16 both paid for). Every other key, guard flag,
-- audit call and grant below is unchanged.
-- ═══════════════════════════════════════════════════════════════════════════

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
    'reactivation_max_per_run'
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
  'The one door for an operational setting: owner or ops_admin only, a whitelist the database owns rather than the form, per-key validation, and an audit row carrying the old value and the new. Since G-223 it also carries reactivation_max_per_run, the most inactive_lead follow-ups one worker invocation will send for an organization - unset by default and inert when unset, enforced in the follow-up worker because only an invocation can count its own run.';

revoke all on function core.set_organization_setting(uuid, text, text) from public;
grant execute on function core.set_organization_setting(uuid, text, text) to authenticated, service_role;
