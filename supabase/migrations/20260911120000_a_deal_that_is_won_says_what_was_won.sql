-- ═══════════════════════════════════════════════════════════════════════════
-- A deal that is won says what was won — G-230
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `setOpportunityStage()` moves a deal to `won` when the caller holds
-- `lead.write` and the transition is legal. It checks a legal transition and
-- does a compare-and-swap so a concurrent move is not clobbered. It does not
-- check that a quotation version was ever accepted.
--
-- The losing path does. `opportunities_lost_says_why` refuses a lost deal with
-- no category and no sentence, at the row, so a direct PostgREST write cannot
-- settle one with nothing recorded. The winning path — the one that creates a
-- client, a project and an invoice schedule — required nothing at all.
--
-- ── what the sources ask for, and which half is a decision ─────────────────
--
-- Every Phase 1 document puts two conditions in front of WON:
--
--   Agent Responsibility Master Matrix §12, §17 · Final Gap-Closure §8 (F-13)
--   and §10 · Agent Interaction & Handoff §16 · Coordination Agent §16 ·
--   Implementation/Testing/DoD §33 · Master Development Plan V3 §13.3, §25
--   and Appendix A.
--
--   1. An ACCEPTED QUOTATION VERSION. Unambiguous in all six: acceptance is
--      exact-version, and WON carries `quote_id + quote_version` in its packet.
--      Mandatory here, and not configurable.
--
--   2. PAYMENT or an AUTHORIZED EXCEPTION. Every source describes this half as
--      *configured* — Doc 09 §23, V3 §13.3. So it is a switch, and it is OFF
--      until an owner throws it (`won_requires_payment_evidence`). Defaulting
--      it on would write a business rule nobody chose, and would refuse deals
--      that are legitimately won on terms this repository has never been told.
--
-- ── why acceptance already declines to do this itself ──────────────────────
--
-- `sales.record_proposal_response` deliberately does not move the deal stage;
-- its own comment cites Doc 09 §22 — payment sits between acceptance and WON.
-- That separation is correct and is left exactly as it is. What was missing is
-- the gate on the other side of it, which is this.
--
-- ── where the payment half can point ───────────────────────────────────────
--
-- At the WON boundary there is usually no invoice: `finance.invoices` hang off
-- a project's milestones, and the project does not exist until conversion. So
-- the evidence this gate accepts is the evidence that can exist *there*:
--
--   • an APPROVED approval request naming the accepted proposal — Doc 09 §23's
--     authorized exception, and the one the no-advance case actually uses; or
--   • a CAPTURED payment against an invoice for the same client account — the
--     advance, when a returning client is billed before the project opens.
--
-- A claimed payment is not one: `finance.payment_submissions` is a claim, and
-- G-140 already made the claim and the verification separate acts.
--
-- ── firing point ───────────────────────────────────────────────────────────
--
-- `before update ... when (new.stage = 'won' and old.stage is distinct from
-- 'won')`: it binds the TRANSITION, so deals already won are left alone. That
-- is the same choice `opportunities_lost_says_why` made with `not valid`, for
-- the same reason — backfilling a judgement nobody made is worse than a rule
-- that starts today (ADM-76).
--
-- ── carried forward, with two marked edits ────────────────────────────────
--
-- `core.set_organization_setting` is regenerated from its latest definition
-- (20260909120000) VERBATIM, with exactly two changes: the new key joins the
-- whitelist, and gets its own validation. Regenerating from an older copy is
-- how a function silently reverts — the lesson G-126 and D16 both paid for.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The verdict, as a readable reason ──────────────────────────────────
--
-- Returns the reason a deal may NOT be won, or null when it may. Split out
-- from the trigger so the service can ask the same question the row will ask
-- and say something useful BEFORE attempting the write — the row keeps the
-- guarantee, the service keeps the sentence. Exactly how `lost` is arranged.

create or replace function sales.won_gate_verdict(p_opportunity_id uuid)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_opp       sales.opportunities;
  v_accepted  uuid;
  v_required  text;
begin
  select o.* into v_opp
    from sales.opportunities o
   where o.id = p_opportunity_id;

  if v_opp.id is null then
    return 'not_found';
  end if;

  -- ── the mandatory half ──
  --
  -- A plan-set choice mints exactly one accepted member and supersedes its
  -- siblings (G-166), so both the standalone quote and the 2–3 plan offer
  -- arrive here as the same fact: one accepted proposal on this opportunity.
  -- `version desc`, the selector convertToProject uses for the budget and
  -- record_won_handoff falls back to. Review of PH1-CLS-002 found this gate
  -- alone ordering by decided_at, so a re-quoted, re-accepted deal could pass
  -- here on one version and be raised as a project from another.
  select p.id into v_accepted
    from sales.proposals p
   where p.opportunity_id = v_opp.id
     and p.status = 'accepted'
   order by p.version desc
   limit 1;

  if v_accepted is null then
    return 'no_accepted_quotation';
  end if;

  -- ── the configured half ──
  --
  -- Read with `found`, not with a null check. A null `v_required` has two
  -- meanings — the switch is off, or the organization row could not be read —
  -- and collapsing them makes an unreadable row silently mean "off", which is
  -- the one direction this gate must never fail. `organizations_select` admits
  -- an authenticated caller to their own organization and RLS on
  -- `sales.opportunities` already stopped anyone reaching a deal outside it, so
  -- not finding the row here is an anomaly rather than a permission — and an
  -- anomaly at a close gate refuses. This is G-054's rule (a failed read is not
  -- an empty answer) applied to a decision instead of to a page.
  select o.settings->>'won_requires_payment_evidence'
    into v_required
    from core.organizations o
   where o.id = v_opp.organization_id;

  if not found then
    return 'organization_unreadable';
  end if;

  if v_required is distinct from 'on' then
    return null;
  end if;

  -- Doc 09 §23's authorized exception: an approval naming this exact accepted
  -- version AND saying it is a payment exception. The second half matters:
  -- every quotation that reached `accepted` already carries an approved
  -- money-floor approval on the same proposal (submit_proposal raised it), so
  -- an exists() on state alone would be satisfied by every properly-approved
  -- quote — and the switch would pass everything it was turned on to stop.
  -- Found by review while writing the fixture that would have exercised it.
  --
  -- Nothing writes `payload.kind = 'payment_exception'` yet: the no-advance
  -- exception path is ADM-72's open question. Until it exists, a switched-on
  -- gate is satisfied only by a captured payment — which is the honest
  -- reading of "payment OR authorized exception" when no exception can yet be
  -- authorized.
  if exists (
    select 1
      from approvals.approval_requests a
     where a.organization_id = v_opp.organization_id
       and a.subject_type = 'proposal'
       and a.subject_id = v_accepted
       and a.state = 'approved'
       and coalesce(a.payload->>'kind', '') = 'payment_exception'
  ) then
    return null;
  end if;

  -- The advance, where one was billed before the project opened. `captured`
  -- and nothing softer: a submission is a claim, not a payment (G-140).
  if v_opp.client_account_id is not null and exists (
    select 1
      from finance.payments pay
      join finance.invoices inv on inv.id = pay.invoice_id
     where inv.organization_id = v_opp.organization_id
       and inv.client_account_id = v_opp.client_account_id
       and pay.status = 'captured'
  ) then
    return null;
  end if;

  return 'no_payment_evidence';
end;
$$;

comment on function sales.won_gate_verdict(uuid) is
  'G-230. The reason a deal may not be won, or null when it may: no_accepted_quotation (always enforced), no_payment_evidence (only when settings.won_requires_payment_evidence is ''on''), organization_unreadable, not_found. The payment half is satisfied by a captured payment for the client account, or by an approved approval on the accepted proposal whose payload.kind is payment_exception - the quotation''s own money-floor approval does not count, or the switch would pass every properly-approved quote. Read by sales.enforce_won_gate at the row and by setOpportunityStage for the message.';

revoke all on function sales.won_gate_verdict(uuid) from public, anon;
grant execute on function sales.won_gate_verdict(uuid) to authenticated, service_role;


-- ── 2. The guarantee, at the row ──────────────────────────────────────────

create or replace function sales.enforce_won_gate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_reason text;
begin
  -- Only the move INTO won is gated. An UPDATE that leaves a won deal won, or
  -- moves it elsewhere, is not this trigger's business.
  if new.stage <> 'won' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.stage = 'won' then
    return new;
  end if;

  -- A deal cannot be BORN won. On INSERT there is no row for a proposal to
  -- reference yet, so there cannot be an accepted quotation, so the answer is
  -- known without asking. Found by review: the first draft was UPDATE-only,
  -- and a direct POST with stage='won' walked straight past it — the exact
  -- write opportunities_lost_says_why, a CHECK, would have caught.
  if tg_op = 'INSERT' then
    raise exception 'won_gate: no_accepted_quotation'
      using errcode = 'check_violation',
            hint = 'A deal is not created won. Open it, quote it, have the quotation accepted, then close it.';
  end if;

  v_reason := sales.won_gate_verdict(new.id);
  if v_reason is not null then
    raise exception 'won_gate: %', v_reason
      using errcode = 'check_violation',
            hint = 'A deal is won on an accepted quotation version; see sales.won_gate_verdict.';
  end if;
  return new;
end;
$$;

comment on function sales.enforce_won_gate() is
  'G-230. Refuses the move INTO won - on UPDATE when sales.won_gate_verdict has a reason, and on INSERT unconditionally, because a deal cannot be born won. Bound to the transition rather than to the state, so deals already won are untouched (the choice opportunities_lost_says_why made with NOT VALID, ADM-76). Fires on insert as well as update because the first draft did not, and a direct POST with stage=won walked past it.';

drop trigger if exists opportunities_won_gate on sales.opportunities;

-- INSERT as well as UPDATE. A WHEN clause cannot mention OLD on an insert, so
-- the transition test lives in the function body; the trigger fires whenever
-- `stage` is written and the function returns immediately when it is not the
-- move into won.
create trigger opportunities_won_gate
  before insert or update of stage on sales.opportunities
  for each row
  execute function sales.enforce_won_gate();


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
    'won_requires_payment_evidence'
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
  'The one door for an operational setting: owner or ops_admin only, a whitelist the database owns rather than the form, per-key validation, and an audit row carrying the old value and the new. Since G-230 it also carries won_requires_payment_evidence - ''on'' to require payment or an approved exception before a deal may be won, unset (the default) to require only the accepted quotation version that the gate always enforces.';

revoke all on function core.set_organization_setting(uuid, text, text) from public;
grant execute on function core.set_organization_setting(uuid, text, text) to authenticated, service_role;
