-- ═══════════════════════════════════════════════════════════════════════════
-- The limits the owner can set — G-195 (Doc 09 §21, Doc 07 §6)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- §21 lists nine negotiation limits and ends: *"All limits are configurable in
-- the Admin Approval & Policy Engine."* Migration 156 recorded the honest
-- state — **none is configured** — and refused to invent one, because a
-- maximum discount this repository chose would be this repository writing the
-- agency's commercial policy. That refusal was right.
--
-- It was also only half an answer. What §21 asks for is CONFIGURABILITY, and
-- the absence of the mechanism is not the same as the absence of a number: an
-- owner who wanted a round cap had nowhere to put one.
--
-- ── which four, and why not nine ──────────────────────────────────────────
--
-- A limit is only real where something would otherwise act without it. These
-- four each bound an act the system takes ON ITS OWN:
--
--   negotiation_max_rounds                    the agent redrafting a quotation
--                                             for the Nth time, unasked
--   negotiation_min_price_rupees              the standing offer discounting
--                                             below what the agency will take
--   negotiation_max_discount_pct              the owner's own cap on the
--                                             concession they pre-authorise
--   negotiation_max_autonomous_quote_rupees   the value above which no number
--                                             reaches a client unasked
--
-- The rest of §21's list — minimum advance, maximum deferral, maximum free
-- scope — has nowhere in this system to bind yet: payment terms are still
-- computed from the amount rather than configured (Doc 07 §11, open), and
-- there is no autonomous act that gives scope away. A column for a rule
-- nothing consults is the shape G-130 and G-133 both record. They are named
-- here and not built, which is the same posture migration 156 took and the
-- reason this one can be trusted about the four it does build.
--
-- ── and none of them can stop a person ────────────────────────────────────
--
-- ADM-07 puts the decision with a human, and a limit that refused an owner's
-- own approval would be this system overruling the person it exists to serve.
-- Every enforcement below sits on an autonomous path: what the agent may do
-- while nobody is looking.

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
    -- ── G-195 — Doc 09 §21's negotiation limits, at last configurable ──────
    --
    -- §21 lists them and ends "All limits are configurable in the Admin
    -- Approval & Policy Engine". Until now none was, so none was enforced —
    -- and none was invented either, which was the right refusal and only half
    -- an answer. These four are the ones with somewhere to BITE: each bounds
    -- an act the system takes on its own, and none of them can stop a person.
    --
    -- Every one is UNSET by default and inert when unset. A limit with a
    -- default would be this repository choosing the agency's commercial
    -- policy, which is exactly what ADM-22 and ADM-88 each refused.
    'negotiation_max_rounds',
    'negotiation_min_price_rupees',
    'negotiation_max_discount_pct',
    'negotiation_max_autonomous_quote_rupees'
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
    -- Twenty is far past any negotiation anybody wants and far below a
    -- number that means the field was misunderstood.
    if p_key = 'negotiation_max_rounds' then
      if v_value !~ '^[0-9]{1,2}$' or v_value::numeric < 1 or v_value::numeric > 20 then
        return query select 'invalid_value'::text; return;
      end if;
    end if;

    -- Doc 07 §6's minimum acceptable price, in whole rupees. It bounds what
    -- the AGENT may hand a client through a standing offer; a person may
    -- still approve anything, which is ADM-07 and is not this limit's
    -- business.
    if p_key = 'negotiation_min_price_rupees' then
      if v_value !~ '^[0-9]{1,8}$' or v_value::numeric < 1 then
        return query select 'invalid_value'::text; return;
      end if;
    end if;

    -- Never above the 1–50 the offers table itself enforces: a configured
    -- cap of 80 would read as permission the DDL would then refuse, and a
    -- limit that cannot be reached is a limit nobody can rely on.
    if p_key = 'negotiation_max_discount_pct' then
      if v_value !~ '^[0-9]{1,2}$' or v_value::numeric < 1 or v_value::numeric > 50 then
        return query select 'invalid_value'::text; return;
      end if;
    end if;

    -- Doc 07 §6's maximum autonomous quote value, in whole rupees: above it,
    -- no number reaches a client without a fresh decision — which in this
    -- system means the standing offer stops applying itself.
    if p_key = 'negotiation_max_autonomous_quote_rupees' then
      if v_value !~ '^[0-9]{1,9}$' or v_value::numeric < 1 then
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
  'The one door for an operational setting: owner or ops_admin only, a whitelist the database owns rather than the form, per-key validation, and an audit row carrying the old value and the new. Since G-195 it also carries Doc 09 section 21''s four enforceable negotiation limits, each unset by default and inert when unset - the mechanism section 21 asks for, with the numbers left to the owner.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Where they bite
-- ═══════════════════════════════════════════════════════════════════════════

/**
 * A concession the owner pre-authorises, bounded by the owner's own cap.
 *
 * The table already refuses anything outside 1-50 in its DDL, which is the
 * hard bound of the mechanism. This is the SOFT one, and it is the owner's:
 * an agency that has decided it never gives more than ten per cent away can
 * now say so in one place instead of remembering it at each authorisation.
 *
 * Refused rather than clamped. Silently writing 10 when somebody asked for 25
 * would be the system deciding a concession on their behalf, and the whole
 * point of this row is whose decision it carries.
 */
create or replace function sales.set_approved_offer(
  p_organization_id uuid,
  p_label text,
  p_condition text,
  p_discount_pct integer,
  p_valid_until date default null
)
returns table (outcome text, offer_id uuid)
language plpgsql
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_id    uuid;
  v_cap   numeric;
begin
  if v_actor is not null and not (select core.is_owner()) then
    return query select 'forbidden'::text, null::uuid;
    return;
  end if;

  -- The INPUT is judged before the caller is resolved, so a bad date reports
  -- itself as a bad date. The first version checked the author first and
  -- answered `no_author` to an expired offer, which is a true statement about
  -- a different problem.
  --
  -- An offer that has already expired is a mistake, not a configuration.
  if p_valid_until is not null and p_valid_until < current_date then
    return query select 'already_expired'::text, null::uuid;
    return;
  end if;

  -- G-195. Unconfigured, the DDL's 1-50 is the only bound and this is a no-op.
  select nullif(o.settings->>'negotiation_max_discount_pct', '')::numeric into v_cap
    from core.organizations o
   where o.id = p_organization_id;
  if v_cap is not null and p_discount_pct > v_cap then
    return query select 'above_configured_cap'::text, null::uuid;
    return;
  end if;

  /**
   * An author is required, and there is no sensible fallback: the whole point
   * of the row is whose decision it carries.
   *
   * A signed-in owner names themselves. An identity-less caller — the service
   * role, the verification scripts — falls back to the organization's owner
   * MEMBERSHIP, which is what binds a person to an organization (core.users is
   * global and carries no organization at all). An organization with no owner
   * yet cannot author an offer, and says so rather than writing one nobody
   * decided.
   */
  if v_actor is null then
    select m.user_id into v_actor
      from core.memberships m
     where m.organization_id = p_organization_id and m.role = 'owner'
     order by m.created_at
     limit 1;
  end if;
  if v_actor is null then
    return query select 'no_author'::text, null::uuid;
    return;
  end if;

  -- Retire the standing one first. Not deleted: a concession that was once
  -- made is part of the record of what this agency offered.
  perform set_config('sales.offer_write', 'on', true);

  update sales.approved_offers
     set active = false
   where organization_id = p_organization_id and active;

  insert into sales.approved_offers (
    organization_id, label, condition, discount_pct, valid_until, created_by
  )
  values (
    p_organization_id, btrim(p_label), btrim(p_condition), p_discount_pct, p_valid_until, v_actor
  )
  returning id into v_id;

  perform core.record_audit(
    p_organization_id, 'offer.authorised', 'approved_offer', v_id,
    null,
    jsonb_build_object('label', btrim(p_label), 'discount_pct', p_discount_pct, 'valid_until', p_valid_until),
    null
  );

  return query select 'set'::text, v_id;
end;
$$;

comment on function sales.set_approved_offer(uuid, text, text, integer, date) is
  'Authorises the one standing concession an agent may apply without asking again (ADM-98), in the name of the person who decided it. Since G-195 a discount above the organization''s own configured cap is REFUSED rather than clamped: writing a smaller number than somebody asked for would be the system deciding a concession on their behalf.';


create or replace function sales.apply_approved_offer(p_proposal_id uuid)
returns table (outcome text, offer_id uuid, discount_minor bigint, total_minor bigint)
language plpgsql
set search_path = ''
as $$
declare
  v_row      sales.proposals;
  v_offer    sales.approved_offers;
  v_discount bigint;
  v_total    bigint;
  v_floor    bigint;
  -- G-195 — the agency's own two, in minor units like everything beside them.
  v_min_price      bigint;
  v_autonomous_cap bigint;
  v_request  uuid;
  v_submit   record;
begin
  select p.* into v_row
    from sales.proposals p
   where p.id = p_proposal_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::bigint, null::bigint;
    return;
  end if;

  if v_row.status <> 'draft' then
    return query select 'not_draft'::text, null::uuid, null::bigint, v_row.total_minor;
    return;
  end if;

  -- One per opportunity, EVER. Without this a client who pushes twice gets the
  -- discount twice, which is a negotiation the agent is having on its own.
  if exists (
    select 1 from sales.proposals p
     where p.opportunity_id = v_row.opportunity_id
       and p.applied_offer_id is not null
  ) then
    return query select 'already_offered'::text, null::uuid, null::bigint, v_row.total_minor;
    return;
  end if;

  select o.* into v_offer
    from sales.approved_offers o
   where o.organization_id = v_row.organization_id
     and o.active
     and (o.valid_until is null or o.valid_until >= current_date);

  if v_offer.id is null then
    return query select 'no_offer'::text, null::uuid, null::bigint, v_row.total_minor;
    return;
  end if;

  v_discount := round(v_row.subtotal_minor * v_offer.discount_pct / 100.0);
  v_total    := v_row.subtotal_minor - v_discount + v_row.tax_minor;

  /**
   * The owner's own floor, when they have configured one (G-179).
   *
   * Read from the quotation's OWN frozen document rather than recomputed from
   * today's settings, for the reason G-172 and G-179 both chose: the figure
   * that binds is the one that was in front of the decider. Their cap says how
   * much they will give away; this says what they cannot afford to.
   *
   * Unconfigured there is no floor, the cap is the only bound, and the
   * settings page says exactly that.
   */
  v_floor := ((v_row.document->'productionCost'->>'minimumRupees')::numeric * 100)::bigint;
  if v_floor is not null and v_floor > 0 and v_total < v_floor then
    return query select 'below_floor'::text, v_offer.id, v_discount, v_total;
    return;
  end if;

  /**
   * The owner's two standing limits — G-195, Doc 07 §6.
   *
   * Beside the cost floor above rather than instead of it, because they are
   * three different sentences about the same number and any one of them can
   * be the binding one:
   *
   *   the cost floor       what this quotation cannot be built for
   *   the minimum price    what this agency will not sell for, at any size
   *   the autonomous cap   what no client is told without a person deciding
   *
   * Read from the organization's settings rather than from the frozen
   * document, and that difference is deliberate. The cost floor belongs to
   * the quotation — it is what the decider had in front of them. These belong
   * to the AGENCY, and the agency's current policy is the one that binds an
   * act happening now, with nobody watching.
   *
   * Both unset by default, and unset means no bound at all.
   */
  select nullif(o.settings->>'negotiation_min_price_rupees', '')::numeric * 100,
         nullif(o.settings->>'negotiation_max_autonomous_quote_rupees', '')::numeric * 100
    into v_min_price, v_autonomous_cap
    from core.organizations o
   where o.id = v_row.organization_id;

  if v_min_price is not null and v_total < v_min_price then
    return query select 'below_minimum_price'::text, v_offer.id, v_discount, v_total;
    return;
  end if;

  -- The ceiling is read against the total the CLIENT would be shown. A
  -- discount that lands a deal under the cap does not make the deal small:
  -- what the limit is about is the size of the number leaving the building.
  if v_autonomous_cap is not null and v_total > v_autonomous_cap then
    return query select 'above_autonomous_ceiling'::text, v_offer.id, v_discount, v_total;
    return;
  end if;

  -- The owner's own words about the concession, written into the document so
  -- the CLIENT is told what they got and why. A discount that arrives silently
  -- is a discount the client assumes was always available — and the condition
  -- is the whole reason it was offered.
  --
  -- Written while the proposal is still a draft, which is the only moment it
  -- can be: `proposals_guard` freezes the document the instant it leaves.
  update sales.proposals
     set discount_minor   = v_discount,
         -- Written together, because `proposals_total_is_arithmetic` is a CHECK
         -- and not a trigger: it holds `total = subtotal - discount + tax` at
         -- every instant, so a discount written on its own is refused outright.
         -- The live verifier caught this; no unit test could have.
         total_minor      = v_total,
         applied_offer_id = v_offer.id,
         document         = coalesce(document, '{}'::jsonb) || jsonb_build_object(
                              'offerLabel', v_offer.label,
                              'offerCondition', v_offer.condition,
                              'offerDiscountPct', v_offer.discount_pct
                            )
   where id = v_row.id;

  select * into v_submit from sales.submit_proposal(p_proposal_id, null, null);
  if v_submit.outcome <> 'submitted' then
    return query select v_submit.outcome::text, v_offer.id, v_discount, v_total;
    return;
  end if;
  v_request := v_submit.request_id;

  -- The offer settles the request it just raised, naming its AUTHOR. The
  -- decision is real and so is the decider: they made it when they wrote the
  -- offer, which is what ADM-98 permits and what the row now records.
  update approvals.approval_requests
     set state         = 'approved',
         decided_at    = now(),
         decided_by    = v_offer.created_by,
         decision_note = 'Pre-authorised offer applied: ' || v_offer.label
                         || ' (' || v_offer.discount_pct || '% — ' || v_offer.condition || ')'
   where id = v_request;

  perform sales.sync_proposal_decision(p_proposal_id);

  perform core.record_audit(
    v_row.organization_id, 'offer.applied', 'proposal', p_proposal_id,
    jsonb_build_object('total_minor', v_row.total_minor),
    jsonb_build_object(
      'offer_id', v_offer.id,
      'label', v_offer.label,
      'discount_pct', v_offer.discount_pct,
      'discount_minor', v_discount,
      'total_minor', v_total,
      'decided_by', v_offer.created_by
    ),
    null
  );

  -- Two events, and they are different audiences. `approval.decided` is what
  -- every existing consumer already listens to — the dispatch that sends it to
  -- the client, and the learning that records what was decided — so nothing
  -- downstream needs to know an offer was involved. `offer.applied` is the
  -- owner being TOLD, which is the half of ADM-98 they asked for by name.
  perform core.emit_event(
    v_row.organization_id, 'approval.decided', 'approval_request', v_request,
    jsonb_build_object(
      'subjectType', 'proposal',
      'subjectId',   p_proposal_id,
      'decision',    'approved',
      'decidedBy',   v_offer.created_by,
      'note',        'Pre-authorised offer applied: ' || v_offer.label
    ),
    null
  );

  perform core.emit_event(
    v_row.organization_id, 'offer.applied', 'proposal', p_proposal_id,
    jsonb_build_object(
      'offerId', v_offer.id,
      'label', v_offer.label,
      'condition', v_offer.condition,
      'discountPct', v_offer.discount_pct,
      'discountMinor', v_discount,
      'totalMinor', v_total
    ),
    null
  );

  return query select 'applied'::text, v_offer.id, v_discount, v_total;
end;
$$;

comment on function sales.apply_approved_offer(uuid) is
  'Applies the one standing offer to a draft quotation and submits it in the authorising owner''s name (ADM-98) - the only path on which a number reaches a client with no fresh human decision, which is why it carries every bound the agency has: one concession per deal, the offer''s own expiry, the quotation''s cost floor, and since G-195 the organization''s configured minimum price and maximum autonomous quote value. Each limit is unset by default and inert when unset.';

revoke execute on function sales.apply_approved_offer(uuid) from public;
revoke execute on function sales.apply_approved_offer(uuid) from anon, authenticated;
grant execute on function sales.apply_approved_offer(uuid) to service_role;
