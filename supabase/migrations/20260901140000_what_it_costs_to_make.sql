-- What it costs to make — G-179.
--
-- A zero-trust audit found two things about pricing, and this closes both.
--
-- ── one: there was no cost model at all ───────────────────────────────────
--
-- The owner's stated principle is production cost × 2 / ×2.5 / ×3. A search
-- of the whole repository for a production cost, an AI cost, a margin, a
-- markup or a multiplier returned nothing outside UI markup and per-run token
-- accounting. So a quotation could sit BELOW what the work costs to build and
-- nothing in the system would know — the one thing the corpus formula cannot
-- see, because the corpus records what this agency CHARGED and not what it
-- cost.
--
-- ── two: pricing was code, not configuration ──────────────────────────────
--
-- `pricing-reference.ts` says so in its own docblock: *"If the agency's
-- pricing moves, this file is WHERE it moves."* Honest, and it means the
-- owner cannot change their own pricing without an engineer and a deploy.
--
-- So every input to the new model is an organization SETTING, written through
-- `core.set_organization_setting` and audited exactly like the WhatsApp number
-- and the quotation contact block before it. Five keys:
--
--   pricing_day_rate_rupees      what a developer-day costs the agency
--   pricing_ai_day_rate_rupees   what AI and tooling cost per developer-day
--   pricing_multiplier_min       the floor band      (the owner's ×2)
--   pricing_multiplier_target    the recommended one (×2.5)
--   pricing_multiplier_max       the premium one     (×3)
--
-- ── why the ORDER is not checked here ─────────────────────────────────────
--
-- `set_organization_setting` writes one key at a time, so it cannot see
-- whether the minimum has just overtaken the premium. Rather than invent a
-- half-check that would refuse a legitimate mid-edit state — an owner raising
-- all three, one field at a time, passes through an incoherent moment on the
-- way — the coherence rule lives with the READER: `costSettingsFrom` returns
-- null for a set that is out of order, and a null cost model says nothing at
-- all. A contradictory configuration produces silence, not a guess.
--
-- What IS checked here is the shape of each value on its own, for the same
-- reason the contact keys are: a rate with a comma in it, or a multiplier
-- somebody typed as a percentage, is a mistake worth catching at the form
-- rather than discovering as an absent note six quotations later.

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
    'pricing_multiplier_max'
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
  'Sets one whitelisted operational setting, owner or ops_admin only, audited as organization.setting_set. G-179 adds the five pricing-model inputs — the day rate, the AI day rate and the three multiplier bands — so the owner can change their own pricing without a deploy. Their ORDER is not checked here because this writes one key at a time and an owner raising all three passes through an incoherent moment; the reader refuses an out-of-order set instead, and says nothing rather than guessing.';

-- ── the guard has to know about them too ──────────────────────────────────
--
-- `org_setting_write_is_sanctioned` refuses a DIRECT write to any whitelisted
-- key. A key added to the setter and not to the guard is a key anybody with
-- `conversations_write` can set over PostgREST, unaudited — which is the whole
-- reason the guard exists. The two lists are the same list, twice, and the
-- test for this gap counts them against each other.

create or replace function core.org_setting_write_is_sanctioned()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_keys text[] := array[
    'whatsapp_phone_number_id',
    'whatsapp_test_recipient',
    'quotation_contact_email',
    'quotation_contact_phone',
    'quotation_contact_location',
    'pricing_day_rate_rupees',
    'pricing_ai_day_rate_rupees',
    'pricing_multiplier_min',
    'pricing_multiplier_target',
    'pricing_multiplier_max'
  ];
  v_key text;
  v_changed boolean := false;
begin
  if tg_op = 'UPDATE' then
    foreach v_key in array v_keys loop
      if new.settings->>v_key is distinct from old.settings->>v_key then
        v_changed := true;
        exit;
      end if;
    end loop;
    if not v_changed then
      return new;
    end if;
  end if;

  if tg_op = 'INSERT' then
    foreach v_key in array v_keys loop
      if (new.settings->>v_key) is not null then
        v_changed := true;
        exit;
      end if;
    end loop;
    if not v_changed then
      return new;
    end if;
  end if;

  if current_setting('crm.org_setting_write', true) = 'on' then
    return new;
  end if;
  if (select auth.uid()) is null then
    return new;
  end if;
  raise exception
    'core.organizations.settings whitelisted operational keys are set only through core.set_organization_setting, not by a direct write'
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function core.org_setting_write_is_sanctioned() is
  'Refuses a direct write to any whitelisted settings key, so every one of them goes through the audited setter. Its list and set_organization_setting''s whitelist are the same list twice; a key in one and not the other is a key that can be set unaudited (G-179 adds the five pricing inputs to both).';
