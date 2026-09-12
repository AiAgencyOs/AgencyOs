-- ═══════════════════════════════════════════════════════════════════════════
-- Verified is recorded — G-236
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The production-readiness page (G-? the gate of PR #170) holds two items at
-- "configured, not verified": WhatsApp and the AI provider stay amber "until
-- a person confirms them against the real provider". That rule is right. What
-- was missing is anywhere to RECORD that a person did: `verifyWhatsAppAction`
-- asked Meta and showed the answer in a form message that vanished on the next
-- render; no control exercised the AI provider at all; no control made the
-- "test send to a configured internal recipient" the page itself prescribes.
-- So the page could never turn green, and it told the owner to do things the
-- product could not do or could not remember — found on 2026-09-12 when the
-- owner did exactly what it said and the page did not move.
--
-- Five non-secret keys on the organization's settings, through the one door
-- every operational setting already uses. `core.set_organization_setting` is
-- carried forward VERBATIM from 20260911160000 with three marked edits.
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
    'meeting_reminder_minutes',
    -- G-236 (edit 1 of 3) — verification, RECORDED. The readiness page held
    -- WhatsApp and the AI provider at "configured, not verified" with nowhere
    -- to record that a person had verified them, so it told the owner to do
    -- things the product could not remember. These five carry the moment, the
    -- number Meta answered with, the model that answered, and the controlled
    -- first send. None is a secret; all are audited like every key above.
    'whatsapp_verified_at',
    'whatsapp_verified_number',
    'whatsapp_test_sent_at',
    'ai_provider_verified_at',
    'ai_provider_verified_model'
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
    -- G-236 (edit 2 of 3): a moment is an ISO-8601 instant with a zone and
    -- nothing else, so a reader can trust the age it shows; a number or a
    -- model name is short text.
    if p_key in ('whatsapp_verified_at', 'whatsapp_test_sent_at', 'ai_provider_verified_at')
       and v_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
      return query select 'invalid_value'::text; return;
    end if;
    if p_key in ('whatsapp_verified_number', 'ai_provider_verified_model') and length(v_value) > 80 then
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

-- G-236 (edit 3 of 3): the comment names the new keys.
comment on function core.set_organization_setting(uuid, text, text) is
  'The one door for an operational setting: owner or ops_admin only, a whitelist the database owns rather than the form, per-key validation, and an audit row carrying the old value and the new. Since G-228 it also carries meeting_reminder_minutes - how far ahead of a meeting its reminder fires, unset meaning the code default of 10 (Sales Flow section 6 gives 5-10 minutes as the target and says the exact policy is configurable). Since G-236 it also carries the verification record - whatsapp_verified_at and whatsapp_verified_number (what Meta answered when a person verified the number), whatsapp_test_sent_at (the controlled first send), ai_provider_verified_at and ai_provider_verified_model (the model that answered a real call) - so the readiness page can turn green on evidence rather than on a setting existing.';

revoke all on function core.set_organization_setting(uuid, text, text) from public;
grant execute on function core.set_organization_setting(uuid, text, text) to authenticated, service_role;

notify pgrst, 'reload schema';
