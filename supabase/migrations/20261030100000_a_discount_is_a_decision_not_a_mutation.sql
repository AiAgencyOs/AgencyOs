-- ═══════════════════════════════════════════════════════════════════════════
-- A discount is a decision, not a mutation — Business Phase 1-4 audit,
-- step 1.27 ("Discount (limit + admin approval)"), 2026-09-28.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The audit's own finding, quoted rather than paraphrased: *"sales.objections
-- explicitly has no discount column, no amount, no floor, no cap"* — confirmed
-- by that table's own header in 20260822230000, which refused to invent a
-- number because none of Doc 09 section 21's nine negotiation limits was yet
-- configurable. Four of nine became configurable in 20260904120000
-- (`negotiation_max_rounds`, `negotiation_min_price_rupees`,
-- `negotiation_max_discount_pct`, `negotiation_max_autonomous_quote_rupees`),
-- through `core.set_organization_setting()`. Nothing since has used
-- `negotiation_max_discount_pct` to bound a discount as it happens — the one
-- read of it in this schema (`sales.set_approved_offer`) bounds what the OWNER
-- may pre-author as a standing concession, not what gets recorded when a
-- discount is actually decided during a live negotiation. There is still no
-- discount decision audit row anywhere: no original amount, no reason, no
-- approver, no expiry, no final amount.
--
-- This migration is that row, and the one door that writes it.
--
-- ── this is not a new pricing tool, and the DDL says so rather than a comment ─
--
-- `src/modules/agents/tools.ts` states the standing rule in its own words:
-- *"There is no pricing tool. ... Business rules 08 section 5.1 makes it
-- absolute — 'They do not become permissible at a higher autonomy level' —
-- so an L2-classed pricing tool is not a safer version of a forbidden one, it
-- is the forbidden one with a class label."* `sales.approved_offers` (ADM-98)
-- is the one narrow exception this repository has ever built, and it is
-- narrow in a specific way: the OWNER authors the number, in advance, and the
-- agent only ever applies that pre-decided concession — it never decides one
-- itself, at any cap, at any autonomy level.
--
-- `negotiation_max_discount_pct` names a ceiling, and a ceiling is not the
-- same grant as a floor of trust. Recording a discount "autonomously" — no
-- fresh approval — is safe only when a HUMAN is the one who decided the
-- number, because a human deciding a number within a cap the owner
-- configured is the ordinary case ADM-07 already allows (the owner or any
-- staff member with `proposal.draft` could always call
-- `sales.set_proposal_pricing` with an arbitrary discount, with no audit
-- trail and no cap — that gap, not agent authority, is what step 1.27 flags).
-- An AGENT deciding its own number, however small, is the exact shape
-- ADM-22/BR08-section-5.1 refuse. So the constraint below is not a business
-- policy invented here: it is the standing one, enforced in a place a second
-- door cannot get around — a CHECK constraint refuses the row itself from
-- ever recording an agent-requested discount as autonomous, whatever the
-- configured cap says. An agent-requested discount always raises a real
-- approval through the existing engine, exactly as `sales.submit_proposal`
-- already does for the quotation as a whole.
--
-- ── where this plugs in ────────────────────────────────────────────────────
--
-- `sales.set_proposal_pricing` is the one place ANY discount is written onto
-- a draft quotation today, called by `setProposalPricing` in
-- `src/modules/sales/service.ts` — currently a human-only action (there is no
-- agent tool bound to it; see tools.ts's own list). This migration re-points
-- that function so a discount increase on a draft goes through
-- `sales.record_discount_decision` first: whichever workflow calls it next —
-- a human today, or an agent's `draftProposal`/quotation-revision workflow if
-- and when that is separately authorised — inherits the audit trail and the
-- cap/approval gate automatically, because it is the same underlying write
-- path. Nothing in the TOOLS registry or agent-enablement surface changes
-- here; that is a distinct decision for whoever owns it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the row ──────────────────────────────────────────────────────────────

create table if not exists sales.discount_decisions (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,

  -- The proposal VERSION this discount was decided against. Proposals are
  -- versioned rows (sales.proposals.version), so naming the version is naming
  -- the proposal id: a new version is a new row.
  proposal_id           uuid not null references sales.proposals(id) on delete cascade,

  -- What it was a discount off of, and how much — both in the quotation's own
  -- minor-unit currency, matching sales.proposals.subtotal_minor /
  -- discount_minor rather than inventing a second unit convention.
  original_amount_minor bigint not null check (original_amount_minor >= 0),
  discount_minor        bigint not null check (discount_minor > 0),
  -- Derived and stored rather than recomputed by every reader: it is the
  -- number `negotiation_max_discount_pct` is compared against, and a reader
  -- of the audit trail should see the percentage a person would have reasoned
  -- about, not just the two amounts it came from.
  discount_pct          numeric(5, 2) not null check (discount_pct > 0 and discount_pct <= 100),

  reason                text not null check (length(btrim(reason)) between 3 and 500),

  -- Who asked for it. Mirrors sales.objections.raised_by_agent /
  -- approvals.approval_requests.requested_by_type in spirit: a closed pair,
  -- and exactly one identity column is ever populated for either branch.
  requested_by_type     text not null check (requested_by_type in ('agent', 'human')),
  requested_by_agent    text references ai.agents(key),
  requested_by_user     uuid references core.users(id),

  status                text not null check (status in
                          ('autonomous', 'pending_approval', 'approved', 'rejected', 'cancelled')),
  approval_request_id   uuid references approvals.approval_requests(id) on delete set null,

  -- Human only, and null whenever nobody had to decide — an autonomous,
  -- within-cap, human-requested discount approves itself the same way a
  -- human calling set_proposal_pricing always could.
  approved_by           uuid references core.users(id),

  -- How long the discount stands before it needs deciding again. Optional:
  -- a discount is a legitimate standing choice too (mirrors
  -- sales.approved_offers.valid_until, which is also nullable for the same
  -- reason).
  expiry                date,

  -- Set once the decision is settled (immediately for 'autonomous', on
  -- approval for anything that needed one); null while pending.
  final_amount_minor    bigint,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  decided_at            timestamptz,

  -- Exactly one requester identity, matching requested_by_type.
  constraint discount_decisions_one_requester check (
    (requested_by_type = 'agent' and requested_by_agent is not null and requested_by_user is null)
    or
    (requested_by_type = 'human' and requested_by_user is not null and requested_by_agent is null)
  ),

  -- THE rule this migration exists to hold in DDL rather than in a form: an
  -- agent-requested discount can never be autonomous, at any configured cap.
  -- ADM-22 / Business rules 08 section 5.1 — "they do not become permissible
  -- at a higher autonomy level" — and a form is one door.
  constraint discount_decisions_no_autonomous_agent check (
    not (requested_by_type = 'agent' and status = 'autonomous')
  ),

  -- A human approves a decision only when one was needed. An 'autonomous' row
  -- with an approver would be a decision nobody actually made being credited
  -- to somebody.
  constraint discount_decisions_approved_by_needs_decision check (
    approved_by is null or status in ('approved', 'rejected')
  ),

  -- A discount cannot exceed what it is a discount off of — the same
  -- arithmetic sales.proposals.proposals_total_is_arithmetic already assumes
  -- for the quotation as a whole.
  constraint discount_decisions_within_amount check (discount_minor <= original_amount_minor)
);

comment on table sales.discount_decisions is
  'Business Phase 1-4 audit step 1.27: the discount audit row that did not exist anywhere. One row per decision: original amount, discount amount and percentage, reason, who asked, who approved (human only, and only when an approval was needed), an optional expiry and the final amount. discount_decisions_no_autonomous_agent holds ADM-22 / Business rules 08 section 5.1 at the row: an agent-requested discount is never autonomous, however small the configured cap.';

comment on column sales.discount_decisions.status is
  '''autonomous'': a human requested a discount at or below the organization''s configured negotiation_max_discount_pct, recorded without a fresh approval — the same authority a human calling sales.set_proposal_pricing always had, now audited and capped. ''pending_approval''/''approved''/''rejected'': routed through the existing approvals engine (subject_type = ''discount_decision''), required for every agent-requested discount regardless of size, and for any human-requested discount above the configured cap or while no cap is configured at all (unconfigured is not a default-open, matching core.set_organization_setting''s own rule for these limits).';

create index if not exists discount_decisions_org_proposal_idx
  on sales.discount_decisions (organization_id, proposal_id, created_at desc);

create index if not exists discount_decisions_approval_idx
  on sales.discount_decisions (approval_request_id)
  where approval_request_id is not null;

drop trigger if exists set_updated_at on sales.discount_decisions;
create trigger set_updated_at
  before update on sales.discount_decisions
  for each row execute function core.set_updated_at();

-- ── 2. tenancy — enforce_parent_org + freeze_organization_id, the pair every
--      org-scoped table in this schema carries ──────────────────────────────

alter table sales.discount_decisions enable row level security;
alter table sales.discount_decisions force row level security;

drop trigger if exists org_match_discount_decisions_proposal on sales.discount_decisions;
create trigger org_match_discount_decisions_proposal
  before insert or update of proposal_id, organization_id on sales.discount_decisions
  for each row execute function core.enforce_parent_org('proposal_id', 'sales.proposals');

-- The approval request this decision raised is a parent row too: without this guard a decision in one organization could point at another
-- organization's approval (found by db:verify:tenancyguards, which fails any org-scoped foreign key that has no guard).
drop trigger if exists org_match_discount_decisions_approval on sales.discount_decisions;
create trigger org_match_discount_decisions_approval
  before insert or update of approval_request_id, organization_id on sales.discount_decisions
  for each row execute function core.enforce_parent_org('approval_request_id', 'approvals.approval_requests');

-- No org_match on requested_by_user / approved_by, the same reason
-- sales.approved_offers.created_by carries none: core.users is global and has
-- no organization_id to match against. Membership, not the user row, binds a
-- person to an organization.

drop trigger if exists freeze_org_discount_decisions on sales.discount_decisions;
create trigger freeze_org_discount_decisions
  before update of organization_id on sales.discount_decisions
  for each row execute function core.freeze_organization_id();

-- Read-only to staff; every write goes through record_discount_decision /
-- decide_discount_decision below (both SECURITY DEFINER, so no INSERT/UPDATE
-- policy is needed for a direct write — matching core.set_organization_setting's
-- own shape rather than approved_offers' policy-plus-sanctioned-trigger shape,
-- because unlike an offer, nobody signs a discount decision by hand in a
-- settings form: every write is one of these two functions or nothing).
drop policy if exists discount_decisions_select on sales.discount_decisions;
create policy discount_decisions_select on sales.discount_decisions
  for select using (
    core.is_internal() and organization_id = core.current_organization_id()
  );

grant select on sales.discount_decisions to authenticated;
grant select, insert, update on sales.discount_decisions to service_role;

-- ── 3. the approvals engine already has a vocabulary; discount_decision joins it ─
--
-- Same shape 20260923130000 used for `ui_version`: add the subject type to
-- both CHECK constraints rather than inventing a second approval mechanism.

alter table approvals.approval_requests drop constraint if exists approval_requests_subject_type_check;
alter table approvals.approval_requests add constraint approval_requests_subject_type_check
  check (subject_type in ('proposal', 'deliverable', 'invoice', 'refund',
                          'scope_change', 'prototype', 'agent_action', 'ticket_plan',
                          'handover', 'ui_version', 'discount_decision'));

alter table approvals.approval_policies drop constraint if exists approval_policies_subject_type_check;
alter table approvals.approval_policies add constraint approval_policies_subject_type_check
  check (subject_type in ('proposal', 'deliverable', 'invoice', 'refund',
                          'scope_change', 'prototype', 'agent_action', 'ticket_plan',
                          'handover', 'ui_version', 'discount_decision'));

-- No policy row is seeded here, for the same reason 20260923130000 seeded
-- none for `ui_version`: approval_policies is per-organization data an owner
-- sets through the Admin Panel (approvals.set_policy). Until an owner
-- configures a discount_decision policy, record_discount_decision answers
-- 'no_policy' for anything routed to approval — a named, correct refusal, not
-- a silent default-open.

-- ── 4. the event vocabulary ───────────────────────────────────────────────

insert into core.event_types (type, description, canonical)
values (
  'discount.recorded',
  'A discount decision was recorded against a draft quotation, autonomously or pending approval (Business Phase 1-4 audit step 1.27).',
  null
)
on conflict (type) do nothing;

-- ── 5. recording one ────────────────────────────────────────────────────────

create or replace function sales.record_discount_decision(
  p_proposal_id        uuid,
  p_discount_minor     bigint,
  p_reason             text,
  p_requested_by_type  text,
  p_requested_by_agent text default null,
  p_expiry             date default null
)
returns table (
  -- 'autonomous' | 'pending_approval' | 'not_found' | 'not_draft' | 'no_amount'
  -- | 'invalid_discount' | 'invalid_requester' | 'no_requester' | 'forbidden'
  -- | 'already_expired' | 'no_policy'
  outcome             text,
  decision_id         uuid,
  status              text,
  approval_request_id uuid,
  final_amount_minor  bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_row      sales.proposals;
  v_cap      numeric;
  v_pct      numeric;
  v_id       uuid;
  v_final    bigint;
  v_status   text;
  v_reason   text := btrim(coalesce(p_reason, ''));
  v_approval record;
begin
  if p_requested_by_type not in ('agent', 'human') then
    return query select 'invalid_requester'::text, null::uuid, null::text, null::uuid, null::bigint;
    return;
  end if;

  -- A signed-in caller must be internal staff — the same gate submit_proposal
  -- and request_approval both hold. A caller with no identity (service_role
  -- running a job or an agent workflow) is exempt, exactly as those two are.
  if v_actor is not null and not coalesce((select core.is_internal()), false) then
    return query select 'forbidden'::text, null::uuid, null::text, null::uuid, null::bigint;
    return;
  end if;

  -- An agent-requested row names the agent and comes from an identity-less
  -- caller: a signed-in person cannot pose as an agent's request, the same
  -- distinction sales.objections.raised_by_agent / answered_by keeps.
  if p_requested_by_type = 'agent' then
    if p_requested_by_agent is null or v_actor is not null then
      return query select 'no_requester'::text, null::uuid, null::text, null::uuid, null::bigint;
      return;
    end if;
  else
    if v_actor is null then
      return query select 'no_requester'::text, null::uuid, null::text, null::uuid, null::bigint;
      return;
    end if;
  end if;

  if length(v_reason) < 3 then
    return query select 'invalid_discount'::text, null::uuid, null::text, null::uuid, null::bigint;
    return;
  end if;

  if p_expiry is not null and p_expiry < current_date then
    return query select 'already_expired'::text, null::uuid, null::text, null::uuid, null::bigint;
    return;
  end if;

  select p.* into v_row from sales.proposals p where p.id = p_proposal_id for update;
  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::text, null::uuid, null::bigint;
    return;
  end if;

  if v_row.status <> 'draft' then
    return query select 'not_draft'::text, null::uuid, null::text, null::uuid, null::bigint;
    return;
  end if;

  if v_row.subtotal_minor <= 0 then
    return query select 'no_amount'::text, null::uuid, null::text, null::uuid, null::bigint;
    return;
  end if;

  if p_discount_minor is null or p_discount_minor <= 0 or p_discount_minor > v_row.subtotal_minor then
    return query select 'invalid_discount'::text, null::uuid, null::text, null::uuid, null::bigint;
    return;
  end if;

  v_pct   := round((p_discount_minor::numeric / v_row.subtotal_minor::numeric) * 100, 2);
  v_final := v_row.subtotal_minor - p_discount_minor;

  -- G-195's cap, read the same way sales.set_approved_offer reads it.
  -- Unconfigured is not a default-open (core.set_organization_setting's own
  -- rule for every one of these four limits): with no cap set, there is no
  -- autonomous lane at all, and every discount is routed to approval.
  select nullif(o.settings->>'negotiation_max_discount_pct', '')::numeric into v_cap
    from core.organizations o
   where o.id = v_row.organization_id;

  -- THE rule (see header): an agent-requested discount is never autonomous.
  if p_requested_by_type = 'human' and v_cap is not null and v_pct <= v_cap then
    v_status := 'autonomous';
  else
    v_status := 'pending_approval';
  end if;

  insert into sales.discount_decisions (
    organization_id, proposal_id, original_amount_minor, discount_minor, discount_pct,
    reason, requested_by_type, requested_by_agent, requested_by_user,
    status, expiry, final_amount_minor,
    decided_at
  ) values (
    v_row.organization_id, v_row.id, v_row.subtotal_minor, p_discount_minor, v_pct,
    v_reason, p_requested_by_type, p_requested_by_agent,
    case when p_requested_by_type = 'human' then v_actor end,
    v_status, p_expiry,
    case when v_status = 'autonomous' then v_final end,
    case when v_status = 'autonomous' then now() end
  )
  returning id into v_id;

  if v_status = 'autonomous' then
    perform core.record_audit(
      v_row.organization_id, 'discount.recorded', 'proposal', v_row.id,
      jsonb_build_object('subtotal_minor', v_row.subtotal_minor),
      jsonb_build_object(
        'discount_decision_id', v_id, 'discount_minor', p_discount_minor,
        'discount_pct', v_pct, 'final_amount_minor', v_final, 'status', v_status
      ),
      null
    );
    return query select 'autonomous'::text, v_id, v_status, null::uuid, v_final;
    return;
  end if;

  -- Above the cap, or the requester is an agent, or there is no cap
  -- configured at all: a real approval, through the engine that already
  -- exists — not a parallel mechanism.
  -- 'system', not 'agent': approval_requests_requester_shape requires a
  -- non-null requested_by_id for 'agent', and an agent's identity here is
  -- ai.agents.key (text) — there is no uuid to give it. submit_proposal takes
  -- the identical fallback for the identical reason. WHICH agent asked is
  -- preserved on THIS table (requested_by_agent), not replicated into the
  -- approvals engine's own requester vocabulary.
  select * into v_approval from approvals.request_approval(
    v_row.organization_id, 'discount_decision', v_id,
    case when v_actor is null then 'system' else 'user' end,
    v_actor,
    'Discount ' || v_pct || '% on quotation v' || v_row.version || ' — ' || v_row.title,
    jsonb_build_object(
      'proposal_id', v_row.id, 'original_amount_minor', v_row.subtotal_minor,
      'discount_minor', p_discount_minor, 'discount_pct', v_pct, 'reason', v_reason,
      'requested_by_type', p_requested_by_type, 'requested_by_agent', p_requested_by_agent
    ),
    v_final
  );

  if v_approval.outcome not in ('requested', 'already_pending') then
    -- 'no_policy' or 'forbidden' from the engine itself. The decision row
    -- stays — a discount somebody proposed and nobody could route is still a
    -- fact worth keeping — but nothing is applied and nobody is told to wait.
    update sales.discount_decisions set status = 'cancelled', updated_at = now() where id = v_id;
    return query select v_approval.outcome::text, v_id, 'cancelled'::text, null::uuid, v_final;
    return;
  end if;

  update sales.discount_decisions
     set approval_request_id = v_approval.request_id
   where id = v_id;

  perform core.record_audit(
    v_row.organization_id, 'discount.recorded', 'proposal', v_row.id,
    jsonb_build_object('subtotal_minor', v_row.subtotal_minor),
    jsonb_build_object(
      'discount_decision_id', v_id, 'discount_minor', p_discount_minor,
      'discount_pct', v_pct, 'status', 'pending_approval',
      'approval_request_id', v_approval.request_id
    ),
    null
  );

  return query select 'pending_approval'::text, v_id, 'pending_approval'::text, v_approval.request_id, v_final;
end;
$$;

comment on function sales.record_discount_decision(uuid, bigint, text, text, text, date) is
  'Business Phase 1-4 audit step 1.27. Records a discount decision against a DRAFT quotation. A human-requested discount at or below the organization''s configured negotiation_max_discount_pct is autonomous (audited, no fresh approval, the same authority a human already had via sales.set_proposal_pricing). Everything else — an agent-requested discount at any size, a human-requested discount above the cap, or any discount while no cap is configured — raises a REAL approval through approvals.request_approval, subject_type = discount_decision. An agent can never be recorded as autonomous: discount_decisions_no_autonomous_agent holds that at the row too.';

-- ── 6. settling one ─────────────────────────────────────────────────────────
--
-- The engine's own `approval.decided` event already fires whenever
-- approvals.decide_approval settles anything (20260824120000). This is the
-- consumer for subject_type = 'discount_decision', called the same way
-- sales.handlers.ts's proposal consumer is: read what the owner decided,
-- carry it onto the row this schema owns.

create or replace function sales.sync_discount_decision(p_decision_id uuid)
returns table (outcome text, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_decision sales.discount_decisions;
  v_request  approvals.approval_requests;
begin
  select d.* into v_decision from sales.discount_decisions d where d.id = p_decision_id for update;
  if v_decision.id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  if v_decision.approval_request_id is null then
    return query select 'no_request'::text, v_decision.status;
    return;
  end if;

  select r.* into v_request
    from approvals.approval_requests r
   where r.id = v_decision.approval_request_id;

  if v_request.id is null or v_request.state = 'pending' then
    return query select 'unsettled'::text, v_decision.status;
    return;
  end if;

  if v_decision.status not in ('pending_approval') then
    return query select 'already_synced'::text, v_decision.status;
    return;
  end if;

  if v_request.state = 'approved' then
    update sales.discount_decisions
       set status             = 'approved',
           approved_by        = v_request.decided_by,
           final_amount_minor = v_decision.original_amount_minor - v_decision.discount_minor,
           decided_at         = coalesce(v_request.decided_at, now())
     where id = v_decision.id;

    perform core.record_audit(
      v_decision.organization_id, 'discount.recorded', 'proposal', v_decision.proposal_id,
      jsonb_build_object('status', 'pending_approval'),
      jsonb_build_object('discount_decision_id', v_decision.id, 'status', 'approved', 'approved_by', v_request.decided_by),
      null
    );

    return query select 'settled'::text, 'approved'::text;
    return;
  end if;

  -- rejected / changes_requested / cancelled: the discount does not apply.
  update sales.discount_decisions
     set status      = 'rejected',
         approved_by = v_request.decided_by,
         decided_at  = coalesce(v_request.decided_at, now())
   where id = v_decision.id;

  return query select 'settled'::text, 'rejected'::text;
end;
$$;

comment on function sales.sync_discount_decision(uuid) is
  'The discount_decision consumer of the approvals engine''s approval.decided event, the same shape sales.handlers.ts already uses for subject_type = proposal. Carries an owner''s decision onto the row: approved sets approved_by and final_amount_minor; anything else settles as rejected. A pending request is a no-op (unsettled). SECURITY DEFINER: it is the job runner''s function, called with the admin client from sales.syncDiscountDecision in handlers.ts, and there is no signed-in caller it should ever have.';

-- No signed-in caller should ever settle a sync directly — it is driven by
-- the approval.decided event and the job runner alone, the same posture
-- apply_approved_offer takes for the same reason.
revoke execute on function sales.sync_discount_decision(uuid) from public;
revoke execute on function sales.sync_discount_decision(uuid) from anon, authenticated;
grant execute on function sales.sync_discount_decision(uuid) to service_role;

-- ── 7. the existing pricing door now goes through the decision, not around it ─
--
-- set_proposal_pricing is the one place ANY discount is written onto a draft
-- today. Re-pointed here rather than left as a silent alternative path, so a
-- discount increase is always a recorded decision, whichever caller reaches
-- it — a human via the UI action today, or an agent's revision workflow if
-- that is ever separately authorised. A discount DECREASE (including to
-- zero) is not a concession and is not routed through the door: withdrawing
-- money nobody gets is not the act this audit trail exists for.

-- The live signature gains a fourth, optional parameter. `create or replace`
-- cannot widen a parameter list in place — Postgres resolves overloads by
-- signature, so the old three-argument form would survive alongside this one
-- rather than being replaced by it, and a PostgREST call naming only the
-- first three arguments could still resolve to the stale copy. Dropped
-- explicitly first, the way an argument addition to a live RPC needs to be.
drop function if exists sales.set_proposal_pricing(uuid, bigint, bigint);

create or replace function sales.set_proposal_pricing(
  p_proposal_id uuid,
  p_discount_minor bigint default null,
  p_tax_minor bigint default null,
  p_reason text default null
)
returns table (
  outcome text,
  subtotal_minor bigint,
  discount_minor bigint,
  tax_minor bigint,
  total_minor bigint
)
language plpgsql
set search_path = ''
as $$
declare
  v_row      sales.proposals;
  v_discount bigint;
  v_tax      bigint;
  v_total    bigint;
  v_decision record;
begin
  select p.* into v_row from sales.proposals p where p.id = p_proposal_id for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::bigint, null::bigint, null::bigint, null::bigint;
    return;
  end if;

  if v_row.status <> 'draft' then
    return query select 'not_draft'::text, v_row.subtotal_minor, v_row.discount_minor, v_row.tax_minor, v_row.total_minor;
    return;
  end if;

  v_discount := coalesce(p_discount_minor, v_row.discount_minor);
  v_tax      := coalesce(p_tax_minor, v_row.tax_minor);

  if v_discount > v_row.subtotal_minor then
    return query select 'discount_exceeds_subtotal'::text, v_row.subtotal_minor, v_row.discount_minor, v_row.tax_minor, v_row.total_minor;
    return;
  end if;

  -- A genuine increase in the discount is a concession decided just now, and
  -- it goes through the door: audited, cap-checked, approval-routed above the
  -- cap. record_discount_decision holds its own lock on this same row (`for
  -- update`) — safe here because Postgres row locks are re-entrant within one
  -- transaction for the same session.
  if v_discount > coalesce(v_row.discount_minor, 0) and p_proposal_id is not null then
    select * into v_decision from sales.record_discount_decision(
      p_proposal_id,
      v_discount - coalesce(v_row.discount_minor, 0),
      coalesce(nullif(btrim(p_reason), ''), 'Quotation pricing updated'),
      case when (select auth.uid()) is null then 'agent' else 'human' end,
      null,
      null
    );
    -- A decision that could not even be recorded (bad input, forbidden
    -- caller) refuses the price change with it; one that is merely awaiting
    -- approval does not block setting the number on the draft — the draft is
    -- not yet client-facing, and submit_proposal's own approval gate still
    -- stands between it and a client either way.
    if v_decision.outcome in ('forbidden', 'no_requester', 'invalid_discount', 'already_expired', 'no_policy') then
      return query select v_decision.outcome::text, v_row.subtotal_minor, v_row.discount_minor, v_row.tax_minor, v_row.total_minor;
      return;
    end if;
  end if;

  v_total := v_row.subtotal_minor - v_discount + v_tax;

  update sales.proposals
     set discount_minor = v_discount,
         tax_minor      = v_tax,
         total_minor    = v_total
   where id = v_row.id;

  return query select 'priced'::text, v_row.subtotal_minor, v_discount, v_tax, v_total;
end;
$$;

comment on function sales.set_proposal_pricing(uuid, bigint, bigint, text) is
  'Sets discount and tax on a DRAFT quotation (section 15). Since the Business Phase 1-4 audit (step 1.27): a discount INCREASE now routes through sales.record_discount_decision first, so every concession is audited, cap-checked against negotiation_max_discount_pct, and approval-gated above the cap or when requested by an agent. A discount decrease (including to zero) is not a concession and bypasses the door.';
