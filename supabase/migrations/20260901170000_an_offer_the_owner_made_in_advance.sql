-- An offer the owner made in advance — G-184, decision ADM-98.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THIS MIGRATION REDUCES A CONTROL. Read the next thirty lines before the SQL.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADM-22, granted 2026-08-13, is titled *"Approved service and offer catalog"*
-- and its answer was no:
--
--     There is no price catalog. Every price is quoted per client by a human.
--     AgencyOS may identify an opportunity and tell the team; it must never
--     state a price, and there is no list for it to state one from.
--
-- On the zero-trust audit of 2026-09-01 the owner was asked the same question
-- again, with the trade-off spelled out, and answered differently. ADM-98
-- records that. **This is the owner overriding their own earlier decision, and
-- it is written down as an override rather than as a clarification**, because
-- the next person to read ADM-22 must not be left wondering whether it still
-- holds.
--
-- ── what changes, stated as narrowly as it can be ─────────────────────────
--
-- An offer is authored BY THE OWNER, IN ADVANCE, with a cap and a condition
-- they wrote themselves. The agent may apply that one offer. It cannot invent
-- a concession, cannot choose between several, cannot exceed the cap, and
-- still has no pricing tool of its own.
--
-- So "every price is quoted by a human" survives in substance: a human quoted
-- this one, before the conversation, and the row records which human. What
-- genuinely goes is *"per client"* — the same concession may now reach more
-- than one client without a fresh decision. That is the control being given
-- up, and it is the whole of it.
--
-- ── what does NOT change ──────────────────────────────────────────────────
--
--   · consent (ADM-70) — a client who has not consented is still not written to
--   · crm.refuse_unread_price — the message stating the discounted price is
--     authored by the offer's creator, which satisfies the rule by being TRUE:
--     a human really did decide this number
--   · the audit trail — every application is an audit row and an announcement
--   · the arithmetic — the discount goes through discount_minor, which
--     proposals_total_is_arithmetic has always checked
--   · the approval engine — the proposal still passes through submit_proposal
--     and a real approval request; the offer settles it, so the request names
--     a decider who genuinely decided
--
-- ── the four guards, and why each one exists ──────────────────────────────
--
--   ONE ACTIVE OFFER per organization. Several would make the agent choose,
--   and choosing between concessions is the judgement ADM-22 was protecting.
--
--   ONE APPLICATION per opportunity, ever. Without it a client who pushes
--   twice gets the discount twice, which is a negotiation the agent is having
--   on its own.
--
--   NEVER BELOW THE OWNER'S OWN FLOOR. When the G-179 cost model is
--   configured, a discounted total below the minimum band is refused. The
--   owner's cap says how much they will give away; the floor says what they
--   cannot afford to. Unconfigured, there is no floor and the cap is the only
--   bound — which the settings page says plainly.
--
--   IT EXPIRES. An offer with no end date is a price list, which is the thing
--   ADM-22 refused. `valid_until` may be null only because a standing
--   concession is a legitimate choice; the owner sets it either way and the
--   application re-checks it every time.

-- ── 1. the offer ──────────────────────────────────────────────────────────

create table if not exists sales.approved_offers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  -- What the owner calls it, and what the client has to do to earn it. Both
  -- are the owner's words; neither is generated.
  label           text not null check (length(btrim(label)) between 3 and 80),
  condition       text not null check (length(btrim(condition)) between 5 and 200),
  -- The cap. Bounded in DDL rather than in a form, because a form is one
  -- door and this number is the whole of what the owner is giving away.
  discount_pct    integer not null check (discount_pct between 1 and 50),
  valid_until     date,
  active          boolean not null default true,
  -- NOT NULL, and it is the load-bearing column: this is the human whose
  -- decision the agent is applying, and the name that authors the client
  -- message carrying the discounted price.
  created_by      uuid not null references core.users(id) on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table sales.approved_offers is
  'A concession the OWNER authored in advance, which the agent may apply without asking again (ADM-98, overriding ADM-22). One active row per organization: several would make the agent choose between concessions, which is the judgement ADM-22 existed to protect. created_by is not null because it is the human whose decision is being applied and the author of the client message that states the discounted price.';

comment on column sales.approved_offers.discount_pct is
  'The cap, 1-50, bounded in DDL rather than in a form: a form is one door and this number is the whole of what the owner is giving away.';

comment on column sales.approved_offers.condition is
  'What the client has to do to earn it, in the owner''s words — printed to the client with the revised quotation, so the concession is never silent.';

-- One live offer per organization. `active = false` retires one; nothing is
-- deleted, because a concession that was once made is part of the record of
-- what this agency offered.
create unique index if not exists approved_offers_live_key
  on sales.approved_offers (organization_id)
  where active;

create index if not exists approved_offers_org_idx
  on sales.approved_offers (organization_id, active);

alter table sales.approved_offers enable row level security;

-- Readable by staff, like every other sales row. Never writable directly:
-- authoring one is an owner act and goes through the function below.
drop policy if exists approved_offers_select on sales.approved_offers;
create policy approved_offers_select on sales.approved_offers
  for select using (
    core.is_internal() and organization_id = core.current_organization_id()
  );

-- The tenancy pair every org-scoped table in this schema carries — the freeze
-- half only. There is deliberately no `org_match` on `created_by`: `core.users`
-- is global and has no organization_id to match against, which is why
-- `sales.proposals.created_by` carries no such trigger either. Membership, not
-- the user row, is what binds a person to an organization.
drop trigger if exists freeze_org_approved_offers on sales.approved_offers;
create trigger freeze_org_approved_offers
  before update on sales.approved_offers
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at on sales.approved_offers;
create trigger set_updated_at
  before update on sales.approved_offers
  for each row execute function core.set_updated_at();

-- No `audit_row_change` trigger, and that is a decision rather than an
-- omission. `audit.record_row_change` raises for a table it has no vocabulary
-- for — *"no vocabulary for table %"* — so attaching it would mean editing a
-- shared function every other table depends on, to describe rows whose only
-- writer is the two functions below. Those write `offer.authorised`,
-- `offer.withdrawn` and `offer.applied` explicitly, which name the acts a
-- reader actually cares about rather than the column that moved.

-- ── 2. which quotation an offer was applied to ────────────────────────────
--
-- On the proposal rather than on the offer, because the question anybody asks
-- is "why is this one cheaper?" and that is a fact about the quotation.

alter table sales.proposals
  add column if not exists applied_offer_id uuid references sales.approved_offers(id) on delete set null;

comment on column sales.proposals.applied_offer_id is
  'The pre-authorised offer whose discount this version carries (G-184). Null on every quotation priced the ordinary way. One per opportunity, ever, enforced by sales.apply_approved_offer.';

drop trigger if exists org_match_proposals_applied_offer_id on sales.proposals;
create trigger org_match_proposals_applied_offer_id
  before insert or update on sales.proposals
  for each row execute function core.enforce_parent_org('applied_offer_id', 'sales.approved_offers');

-- ── 3. authoring one ──────────────────────────────────────────────────────
--
-- Owner only, and the check is here rather than only in the service for the
-- reason `link_internal_recipient` states about the money channel: the RPC is
-- reachable by any authenticated caller, so a service-owned gate is one door
-- on a room with two. An identity-less caller (service_role, the verification
-- scripts) passes, because it already holds the whole database.

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
  'Authors the ONE concession the agent may apply without asking again (ADM-98). Owner-only, audited as offer.authorised, and it retires the standing offer rather than deleting it. An already-expired date is refused as the mistake it is.';

create or replace function sales.clear_approved_offer(p_organization_id uuid)
returns table (outcome text)
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if (select auth.uid()) is not null and not (select core.is_owner()) then
    return query select 'forbidden'::text;
    return;
  end if;

  perform set_config('sales.offer_write', 'on', true);

  update sales.approved_offers
     set active = false
   where organization_id = p_organization_id and active
  returning id into v_id;

  if v_id is null then
    return query select 'none_active'::text;
    return;
  end if;

  perform core.record_audit(
    p_organization_id, 'offer.withdrawn', 'approved_offer', v_id, null, null, null
  );

  return query select 'cleared'::text;
end;
$$;

comment on function sales.clear_approved_offer(uuid) is
  'Withdraws the standing offer. The agent applies nothing from the moment this returns, and the row survives as the record of what was once offered.';

-- ── 4. the event vocabulary ───────────────────────────────────────────────

insert into core.event_types (type, description, canonical)
values (
  'offer.applied',
  'A pre-authorised offer was applied to a quotation and it was sent without a fresh decision (ADM-98, G-184). The owner is told after the fact.',
  'OfferApplied'
)
on conflict (type) do nothing;

-- ── 5. applying it ────────────────────────────────────────────────────────
--
-- The whole of the new authority lives in this function, deliberately: one
-- place to read, one place to audit, one place to change if the owner changes
-- their mind again.
--
-- It does NOT invent an approval. The quotation goes through
-- `submit_proposal` exactly as any other does, raising a real approval
-- request — and then the offer SETTLES that request, naming the offer's author
-- as the decider. That is honest rather than convenient: the request records a
-- human who genuinely decided this number, in advance, and every downstream
-- consumer (the dispatch, the learning, the audit) works unchanged because
-- nothing about the shape of the decision is faked.

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
  'Applies the organization''s standing pre-authorised offer to a DRAFT quotation and settles its approval in the author''s name (ADM-98, G-184). The whole of the new authority lives here: one place to read, one place to audit, one place to change if the owner changes their mind again. Four refusals guard it — not_draft, already_offered (one per opportunity, ever), no_offer (none active or it expired), and below_floor (the discounted total is under the owner''s own minimum band from G-179). It raises a REAL approval request through submit_proposal rather than inventing one, so the request names a human who genuinely decided this number in advance and every downstream consumer works unchanged.';

-- ── 6. the two write paths, and who each one belongs to ───────────────────
--
-- Added after `db:verify:invokerrls` refused the first version of this
-- migration, which is exactly the class that check exists for: both functions
-- are INVOKER, both write RLS-enabled tables, and neither table had a policy
-- for the write. Against the service role every verification passed; from the
-- settings form, signed in as the owner, the insert would have been refused by
-- RLS and the feature would have been dead in the app while every script
-- stayed green.
--
-- The two functions get OPPOSITE answers, because they have opposite callers.

-- ── 6a. authoring: an owner act, so the owner may write it ────────────────
--
-- `set_approved_offer` and `clear_approved_offer` are called from the settings
-- page with the OWNER'S OWN session. They need policies. Opening a policy
-- opens a direct-write door too, so the pair goes in together the way
-- `core.set_organization_name` does: the policy admits the owner, and the
-- trigger admits only the write those two functions make.

drop policy if exists approved_offers_insert on sales.approved_offers;
create policy approved_offers_insert on sales.approved_offers
  for insert with check (
    core.is_owner() and organization_id = core.current_organization_id()
  );

drop policy if exists approved_offers_update on sales.approved_offers;
create policy approved_offers_update on sales.approved_offers
  for update using (
    core.is_owner() and organization_id = core.current_organization_id()
  ) with check (
    core.is_owner() and organization_id = core.current_organization_id()
  );

create or replace function sales.offer_write_is_sanctioned()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Set by set_approved_offer and clear_approved_offer, and by nothing else.
  if current_setting('sales.offer_write', true) = 'on' then
    return new;
  end if;
  -- The service role holds the whole database already; the gate is about the
  -- door the browser can reach.
  if (select auth.uid()) is null then
    return new;
  end if;
  raise exception
    'sales.approved_offers is written through sales.set_approved_offer and sales.clear_approved_offer, not by a direct write'
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function sales.offer_write_is_sanctioned() is
  'Keeps the RLS policies opened for the settings form from being a forgery surface: a signed-in owner may author an offer only through the functions that audit it, cap it and retire the standing one. Without this, a direct PostgREST insert could write an uncapped row nobody recorded deciding.';

drop trigger if exists offer_write_is_sanctioned on sales.approved_offers;
create trigger offer_write_is_sanctioned
  before insert or update on sales.approved_offers
  for each row execute function sales.offer_write_is_sanctioned();

-- ── 6b. applying: nobody signed in may do this at all ─────────────────────
--
-- `apply_approved_offer` approves a quotation and sends it. It is the AGENT'S
-- function, called by the rework workflow with the admin client, and there is
-- no signed-in caller it should ever have: an authenticated user reaching it
-- could settle an approval request without a decision being taken. Revoked
-- rather than allowlisted — the audit's other exit — because "no end user may
-- call this" is the true statement, and an allowlist entry would only have
-- said the RLS refusal was expected.
revoke execute on function sales.apply_approved_offer(uuid) from public;
revoke execute on function sales.apply_approved_offer(uuid) from anon, authenticated;
-- And granted back to the one caller it has. Revoking from PUBLIC takes the
-- default grant away from every role including this one, so without this line
-- the agent cannot call its own function — which the live verifier said in the
-- plainest possible way: every guard passed and nothing could be applied.
grant execute on function sales.apply_approved_offer(uuid) to service_role;
