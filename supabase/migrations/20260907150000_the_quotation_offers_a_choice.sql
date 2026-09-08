-- ═══════════════════════════════════════════════════════════════════════════
-- The quotation offers a choice — G-166, ADM-97.
--
-- The Master Quotation System's Part H says when a client should be shown 2–3
-- priced plans rather than one: a HIGH-complexity engagement with a genuine
-- feature ladder, or a client whose budget signal is unknown and who is best
-- served by naming the rungs and letting them point. The engine could not do
-- it. `sales.proposals` models ONE proposal = one price, and every step
-- downstream leans on that: `submit_proposal` raises one approval carrying one
-- total, `approval_policies_money_floor` resolves the approver from that one
-- number, `send_proposal` dispatches one total, `record_proposal_response`
-- records one answer, and `proposals_live_version_key` allows exactly one live
-- version per opportunity. Three plans would collide with all of it.
--
-- G-165 deferred this deliberately rather than smuggling three prices into a
-- jsonb blob, and named the question as ADM-97. The owner has now chosen the
-- shape: a PLAN-SET SITS ABOVE proposals. Each plan is a real proposal row —
-- so it keeps its own document, its own money-floor note, its own frozen
-- terms — and a new `sales.proposal_plan_sets` row binds two or three of them
-- into one offer with one recommended plan.
--
-- ── ADM-97, the decisions this encodes ────────────────────────────────────
--
-- WHICH MODEL: a plan-set table above proposals, not plans inside the document
-- jsonb (where the total goes murky the moment the client picks a tier other
-- than the recommended one) and not free sibling proposals (which
-- `proposals_live_version_key` forbids from all being live at once). The
-- plan-set owns the "one live offer" invariant; its members are real proposals.
--
-- HOW MANY: two or three. A CHECK refuses a fourth, because Part H names 2–3
-- and a set of six is not a ladder a client climbs, it is a wall they bounce
-- off. Enforced in the database so a mistyped set is refused where it is made.
--
-- THE RECOMMENDED PLAN IS REQUIRED: every set names one. It is the amount that
-- selects the approver (so the set reuses the EXISTING `proposal` money-floor
-- policy, on a real proposal row — no new subject type, no new policy to seed),
-- and it is the plan a client sees defaulted. A set with no recommendation is
-- refused at submit, because an approval with no amount has no approver and a
-- choice with no default is three questions rather than one offer.
--
-- APPROVAL IS OF THE SET: the owner approves the offer, once, at the
-- recommended plan's price. The members move in lockstep — the recommended
-- plan carries the approval request (subject_id = its own id, so the existing
-- forge guard holds unchanged) and every member is verified against it.
--
-- ACCEPTANCE MINTS ONE WINNER: the client picks a plan. The chosen proposal
-- becomes `accepted`, its siblings `superseded`, the set `accepted`, and
-- `plan_set.accepted` fires with the chosen id and amount — so everything that
-- watches for an accepted proposal today fires on exactly one winner, as if a
-- single quote had been accepted. Declining the whole set rejects every member.
--
-- ── The invariant reconciliation ──────────────────────────────────────────
--
-- `proposals_live_version_key` keyed "live" on `opportunity_id` alone, which
-- assumed one live proposal. Re-keyed to `(opportunity_id, coalesce(plan_slot,
-- 0))`: a standalone quote is slot 0 (unchanged), the plan-set members are
-- slots 1..3, and a new `plan_sets_live_key` allows one live SET per
-- opportunity. A standalone quote and a plan-set can never both be live because
-- `draft_proposal` and `draft_plan_set` each supersede the other kind first,
-- under the opportunity lock — carried forward verbatim with the edit marked.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The plan-set, above proposals ──────────────────────────────────────

create table if not exists sales.proposal_plan_sets (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references core.organizations(id) on delete cascade,
  opportunity_id         uuid not null references sales.opportunities(id) on delete cascade,

  -- The confirmed requirement the whole ladder was priced against. Shared by
  -- every member; a plan is a different price for the same understood scope,
  -- not a different scope. `on delete set null` mirrors sales.proposals.
  requirement_version_id uuid references crm.requirement_versions(id) on delete set null,

  status                 text not null default 'draft' check (status in
                           ('draft', 'pending_approval', 'approved', 'sent',
                            'accepted', 'rejected', 'superseded', 'lapsed')),

  -- The plan whose price selects the approver and defaults for the client.
  -- Required by submit; nullable at draft time while the plans are still being
  -- assembled. Points at one of this set's own members (enforced in code under
  -- the opportunity lock, where the members are visible).
  recommended_proposal_id uuid references sales.proposals(id) on delete set null,

  -- The set's single approval request, raised on the recommended plan.
  approval_request_id    uuid,

  conversation_id        uuid,
  sent_at                timestamptz,
  sent_message_ref       text,

  -- The client's answer: which member won, when, and who said it.
  chosen_proposal_id     uuid references sales.proposals(id) on delete set null,
  decided_at             timestamptz,
  responded_by_contact_id uuid references crm.contacts(id) on delete set null,
  response_note          text,

  created_by             uuid references core.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists proposal_plan_sets_org_status_idx
  on sales.proposal_plan_sets (organization_id, status, created_at desc);

create index if not exists proposal_plan_sets_opportunity_idx
  on sales.proposal_plan_sets (opportunity_id);

-- One live SET per opportunity — the plan-set's half of the "one live offer"
-- invariant, the mirror of proposals_live_version_key. Settled sets
-- (accepted/rejected/superseded/lapsed) pile up as history.
create unique index if not exists plan_sets_live_key
  on sales.proposal_plan_sets (opportunity_id)
  where status in ('draft', 'pending_approval', 'approved', 'sent');

alter table sales.proposal_plan_sets enable row level security;

drop policy if exists proposal_plan_sets_select on sales.proposal_plan_sets;
create policy proposal_plan_sets_select on sales.proposal_plan_sets
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists proposal_plan_sets_write on sales.proposal_plan_sets;
create policy proposal_plan_sets_write on sales.proposal_plan_sets
  for all to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id())
         and (select core.can_write()));

-- The tenancy guards. One org_match per org-scoped FK, and core.unguarded_org_fks
-- demands one for EVERY single-column FK whose parent also carries
-- organization_id (or db:verify:tenancyguards fails). That is five here:
-- opportunity, requirement version, the recommended and chosen plans (both
-- sales.proposals), and the responding contact. `approval_request_id`,
-- `conversation_id` and `created_by` are deliberately plain uuid columns with
-- no FK constraint (created_by's parent core.users has no organization_id at
-- all), so the completeness check does not reach them.
drop trigger if exists org_match_plan_sets_opportunity on sales.proposal_plan_sets;
create trigger org_match_plan_sets_opportunity
  before insert or update of opportunity_id, organization_id on sales.proposal_plan_sets
  for each row execute function core.enforce_parent_org('opportunity_id', 'sales.opportunities');

drop trigger if exists org_match_plan_sets_requirement on sales.proposal_plan_sets;
create trigger org_match_plan_sets_requirement
  before insert or update of requirement_version_id, organization_id on sales.proposal_plan_sets
  for each row execute function core.enforce_parent_org('requirement_version_id', 'crm.requirement_versions');

drop trigger if exists org_match_plan_sets_recommended on sales.proposal_plan_sets;
create trigger org_match_plan_sets_recommended
  before insert or update of recommended_proposal_id, organization_id on sales.proposal_plan_sets
  for each row execute function core.enforce_parent_org('recommended_proposal_id', 'sales.proposals');

drop trigger if exists org_match_plan_sets_chosen on sales.proposal_plan_sets;
create trigger org_match_plan_sets_chosen
  before insert or update of chosen_proposal_id, organization_id on sales.proposal_plan_sets
  for each row execute function core.enforce_parent_org('chosen_proposal_id', 'sales.proposals');

drop trigger if exists org_match_plan_sets_contact on sales.proposal_plan_sets;
create trigger org_match_plan_sets_contact
  before insert or update of responded_by_contact_id, organization_id on sales.proposal_plan_sets
  for each row execute function core.enforce_parent_org('responded_by_contact_id', 'crm.contacts');

drop trigger if exists freeze_org_plan_sets on sales.proposal_plan_sets;
create trigger freeze_org_plan_sets
  before update on sales.proposal_plan_sets
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at on sales.proposal_plan_sets;
create trigger set_updated_at
  before update on sales.proposal_plan_sets
  for each row execute function core.set_updated_at();

grant select on sales.proposal_plan_sets to authenticated, service_role;
grant insert, update, delete on sales.proposal_plan_sets to authenticated, service_role;

comment on table sales.proposal_plan_sets is
  'A 2-3 plan quotation offer (G-166, ADM-97, Master Quotation System Part H). Sits above sales.proposals: each plan is a real proposal row (plan_set_id, plan_slot), this row binds them into one offer with one recommended plan whose price selects the approver. One live set per opportunity (plan_sets_live_key), the mirror of proposals_live_version_key.';

-- The events the set emits. Closed registry (core.event_types), so a typo in an
-- emitter is refused rather than producing a durable row nothing matches. None
-- maps to a Doc 23 §7 canonical name — a plan-set is an AgencyOS shape, not one
-- §7 named — so `canonical` is null, the same honest null as proposal.sent.
insert into core.event_types (type, description, canonical) values
  ('plan_set.sent',     'A 2-3 plan quotation was sent to a client (G-166).',            null),
  ('plan_set.accepted', 'A client chose one plan from a quotation offer (G-166).',        null),
  ('plan_set.rejected', 'A client declined a whole 2-3 plan quotation offer (G-166).',    null)
on conflict (type) do nothing;

-- ── 2. Each plan is a real proposal row ───────────────────────────────────
--
-- The membership columns. Nullable, so a standalone quote — every proposal
-- that exists today and every one drafted without a plan-set — has plan_set_id
-- null, plan_slot null, plan_label null, and behaves exactly as before. A
-- member carries its set, its slot (1..3, the CHECK matching the set's 2-3 cap
-- from the top), and the label a client reads ('Essential', 'Growth', ...).
alter table sales.proposals
  add column if not exists plan_set_id uuid references sales.proposal_plan_sets(id) on delete set null,
  add column if not exists plan_slot   int  check (plan_slot between 1 and 3),
  add column if not exists plan_label  text;

create index if not exists proposals_plan_set_idx
  on sales.proposals (plan_set_id)
  where plan_set_id is not null;

-- The org-match guard for the new FK, in the style of the proposals table's
-- other guards (20260815140000) — the set a plan belongs to is the same tenant
-- as the plan. core.unguarded_org_fks demands it: plan_set_id's parent
-- sales.proposal_plan_sets carries organization_id.
drop trigger if exists org_match_proposals_plan_set_id on sales.proposals;
create trigger org_match_proposals_plan_set_id
  before insert or update of plan_set_id, organization_id on sales.proposals
  for each row execute function core.enforce_parent_org('plan_set_id', 'sales.proposal_plan_sets');

-- Re-key the "one live proposal" invariant so a plan-set's members can coexist.
-- Live WAS keyed on opportunity_id alone (20260813120019), which assumed one
-- live proposal per deal. Now keyed on (opportunity_id, coalesce(plan_slot, 0)):
--   • a standalone quote is slot 0 — one live standalone per opportunity, exactly
--     the old rule, unchanged;
--   • the plan-set members are slots 1..3 — each slot at most one live, so a set
--     holds one live plan per rung and no more.
-- A standalone quote (slot 0) and a plan-set (slots 1..3) never coexist live
-- because draft_proposal and draft_plan_set each supersede the other kind first,
-- under the opportunity lock (see §4 and the draft_proposal carry-forward below).
drop index if exists sales.proposals_live_version_key;
create unique index if not exists proposals_live_version_key
  on sales.proposals (opportunity_id, coalesce(plan_slot, 0))
  where status in ('draft', 'pending_approval', 'approved', 'sent');

-- ── 3. The proposal guard, carrying the plan-set through ───────────────────
--
-- CARRIED FORWARD VERBATIM from its live definition (20260903120000:59), with
-- every G-166 edit marked. The repository's norm: a re-emitted guard that drops
-- a branch drops a rule silently, so the whole thing is reproduced and the
-- deltas are called out where they sit.
--
-- Two kinds of edit:
--   • plan_set_id / plan_slot / plan_label join the terms frozen once a proposal
--     leaves draft — a member's set, its rung and its client-facing label are as
--     fixed as its price.
--   • a plan-set member reaches pending_approval / approved through its SET's one
--     approval request (raised on the recommended plan), not through a request of
--     its own — so submit_plan_set / sync_plan_set_decision are the only ways a
--     member moves, exactly as submit_proposal / sync_proposal_decision are for a
--     standalone quote. The standalone path (plan_set_id null) is byte-for-byte
--     the original, so a slot-0 quote is guarded precisely as before.
create or replace function sales.proposals_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- A proposal is drafted, never born approved/sent/accepted.
    if new.status <> 'draft' then
      raise exception 'a proposal is created as a draft, not % — use draft_proposal', new.status
        using errcode = 'restrict_violation';
    end if;
    -- And never born signed. The signature is the approval's to write.
    if new.approved_by_name is not null or new.approved_by_role is not null then
      raise exception 'a proposal is not created already approved by somebody'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  -- Never editable, in any state. The version is allocated under a lock and
  -- the opportunity is the document's whole identity.
  if new.organization_id is distinct from old.organization_id
     or new.opportunity_id is distinct from old.opportunity_id
     or new.version        is distinct from old.version
     or new.created_at     is distinct from old.created_at
  then
    raise exception 'a proposal''s identity is fixed; draft version % instead', old.version + 1
      using errcode = 'restrict_violation';
  end if;

  -- ── the signature (G-194) ────────────────────────────────────────────────
  --
  -- Once written, it is a record of something a person did. Not frozen by
  -- status, because the write itself is the status change: frozen by having
  -- happened.
  if (old.approved_by_name is not null and new.approved_by_name is distinct from old.approved_by_name)
     or (old.approved_by_role is not null and new.approved_by_role is distinct from old.approved_by_role)
  then
    raise exception 'who approved proposal v% is a record of what happened, and does not change', old.version
      using errcode = 'restrict_violation';
  end if;

  -- And it can only appear on a proposal that is actually approved. Without
  -- this the column is a free-text field on a draft: a name a client would
  -- read as a sign-off that never happened.
  if (new.approved_by_name is not null or new.approved_by_role is not null)
     and old.approved_by_name is null and old.approved_by_role is null
     and new.status <> 'approved'
  then
    raise exception 'a quotation is signed when it is approved, not while it is %', new.status
      using errcode = 'restrict_violation';
  end if;

  -- The commercial content, frozen once it leaves draft.
  if old.status <> 'draft' then
    if new.title                  is distinct from old.title
       or new.body                is distinct from old.body
       or new.currency            is distinct from old.currency
       or new.subtotal_minor      is distinct from old.subtotal_minor
       or new.discount_minor      is distinct from old.discount_minor
       or new.tax_minor           is distinct from old.tax_minor
       or new.total_minor         is distinct from old.total_minor
       or new.valid_until         is distinct from old.valid_until
       or new.requirement_version_id is distinct from old.requirement_version_id
       -- ── EDIT (G-165): the document is commercial content too ────────────
       -- Understanding, exclusions, assumptions, responsibilities — every
       -- word of it is what the owner approved. A post-approval edit to the
       -- document would be a different quotation wearing an approved stamp.
       or new.document               is distinct from old.document
       -- ── EDIT (G-166): the plan-set membership is content too ────────────
       -- Which offer a plan belongs to, its rung, and the label a client reads
       -- above the price are as fixed as the price. Re-slotting an approved
       -- plan would rearrange an offer the owner already signed.
       or new.plan_set_id            is distinct from old.plan_set_id
       or new.plan_slot              is distinct from old.plan_slot
       or new.plan_label             is distinct from old.plan_label
    then
      raise exception
        'proposal v% is %; its terms cannot change - draft version % instead',
        old.version, old.status, old.version + 1
        using errcode = 'restrict_violation';
    end if;
  end if;

  -- Settled is settled. accepted/rejected are the client's answer and
  -- superseded is the history §16 asks for; none is a state anything leaves.
  if old.status in ('accepted', 'rejected', 'superseded')
     and new.status is distinct from old.status
  then
    raise exception 'proposal v% is already %', old.version, old.status
      using errcode = 'restrict_violation';
  end if;

  -- The transition graph and its approval linkage: the engine-mediated states
  -- can be reached only when approval_request_id points at this proposal's own
  -- 'proposal' approval request in the matching state, so a direct write cannot
  -- forge an approval, a send or an acceptance.
  if new.status is distinct from old.status then
    if new.status = 'pending_approval' then
      if old.status <> 'draft' then
        raise exception 'a proposal enters review only from draft (was %)', old.status
          using errcode = 'restrict_violation';
      end if;
      -- ── EDIT (G-166): a plan-set member enters review with its set ────────
      -- The set raises ONE approval, on the recommended plan. A member has no
      -- request of its own, so it verifies against the SET's request (whose
      -- subject IS the recommended plan) while the set is pending_approval. The
      -- standalone branch below is the original, unchanged.
      if new.plan_set_id is not null then
        if not exists (
          select 1 from sales.proposal_plan_sets s
            join approvals.approval_requests r on r.id = s.approval_request_id
           where s.id = new.plan_set_id
             and s.organization_id = new.organization_id
             and s.status = 'pending_approval'
             and r.subject_type = 'proposal'
             and r.subject_id = s.recommended_proposal_id
             and r.state = 'pending'
        ) then
          raise exception 'a plan-set member enters review only with its set — use submit_plan_set'
            using errcode = 'restrict_violation';
        end if;
      elsif not exists (
        select 1 from approvals.approval_requests r
         where r.id = new.approval_request_id
           and r.organization_id = new.organization_id
           and r.subject_type = 'proposal' and r.subject_id = new.id
           and r.state = 'pending'
      ) then
        raise exception 'a proposal in review must point at its own pending approval — use submit_proposal'
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'approved' then
      if old.status <> 'pending_approval' then
        raise exception 'a proposal is approved only from review (was %)', old.status
          using errcode = 'restrict_violation';
      end if;
      -- ── EDIT (G-166): a plan-set member is approved with its set ──────────
      if new.plan_set_id is not null then
        if not exists (
          select 1 from sales.proposal_plan_sets s
            join approvals.approval_requests r on r.id = s.approval_request_id
           where s.id = new.plan_set_id
             and s.organization_id = new.organization_id
             and s.status = 'approved'
             and r.subject_type = 'proposal'
             and r.subject_id = s.recommended_proposal_id
             and r.state = 'approved'
        ) then
          raise exception 'a plan-set member is approved only when its set is — use sync_plan_set_decision'
            using errcode = 'restrict_violation';
        end if;
      elsif not exists (
        select 1 from approvals.approval_requests r
         where r.id = new.approval_request_id
           and r.organization_id = new.organization_id
           and r.subject_type = 'proposal' and r.subject_id = new.id
           and r.state = 'approved'
      ) then
        raise exception 'a proposal is approved only when its owner approval is — use sync_proposal_decision'
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'draft' then
      -- The rejected/changes-requested return, from sync_proposal_decision.
      if old.status <> 'pending_approval' then
        raise exception 'a proposal returns to draft only from review (was %)', old.status
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'sent' then
      -- ADM-07: the owner approves, then it is sent.
      if old.status <> 'approved' then
        raise exception 'a proposal is sent only after it is approved (was %)', old.status
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'accepted' then
      if old.status <> 'sent' then
        raise exception 'a proposal is accepted only from sent (was %)', old.status
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'rejected' then
      -- The client's decline, of a sent or a lapsed quote (ADM-77).
      if old.status not in ('sent', 'lapsed') then
        raise exception 'a proposal is declined only from sent or lapsed (was %)', old.status
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'lapsed' then
      if old.status <> 'sent' then
        raise exception 'a proposal lapses only from sent (was %)', old.status
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'superseded' then
      -- A newer version supersedes the old; reachable from any non-terminal
      -- state (the terminals are refused above).
      null;

    else
      raise exception 'a proposal cannot be moved to % by hand', new.status
        using errcode = 'restrict_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function sales.proposals_guard() is
  'Freezes a proposal''s identity and (once out of draft) its terms — including, since G-166, its plan-set membership, slot and label — records the approver''s name as unchangeable once written (G-194), keeps accepted/rejected/superseded terminal, and enforces the status transition graph: a standalone proposal reaches pending_approval/approved only when approval_request_id points at its own owner approval in the matching state, and a plan-set member only when its SET''s single approval (raised on the recommended plan) is in that state — so submit_proposal/sync_proposal_decision and submit_plan_set/sync_plan_set_decision are the only ways through, and a direct write cannot forge an approval, a send or an acceptance.';

-- ── 4. Superseding a whole set ─────────────────────────────────────────────
--
-- One function, because three callers need it: draft_proposal (a standalone
-- quote replaces a live set), draft_plan_set (a new set replaces the last one),
-- and any future redraft. It moves every member to superseded and the set with
-- them, and cancels the set's one pending approval — the mirror, one level up,
-- of what draft_proposal does to a live standalone version. SECURITY INVOKER
-- like every sales writer: the guard and RLS are what make that safe, and the
-- approval is cancelled through the engine's own function (sales holds no write
-- policy on that table, so a raw UPDATE would match nothing and report success).
create or replace function sales.supersede_plan_set(
  p_plan_set_id uuid,
  p_reason      text default null
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_set sales.proposal_plan_sets;
begin
  select s.* into v_set
    from sales.proposal_plan_sets s
   where s.id = p_plan_set_id
   for update;

  if v_set.id is null then
    return 'not_found';
  end if;

  -- Settled already (accepted/rejected/superseded/lapsed): nothing to do, and
  -- superseding a settled set would rewrite history.
  if v_set.status not in ('draft', 'pending_approval', 'approved', 'sent') then
    return v_set.status;
  end if;

  -- The pending question goes out with the offer it belonged to, before the
  -- members move — an approval left open is a queue entry that can never
  -- resolve, ADM-08's whole objection.
  if v_set.approval_request_id is not null then
    perform approvals.cancel_request(
      v_set.approval_request_id,
      coalesce(p_reason, 'Plan-set superseded')
    );
  end if;

  -- Every live member to superseded. The guard reaches 'superseded' from any
  -- non-terminal state with no approval check, so a member in review moves
  -- cleanly here. Terminal members (an already-accepted winner) are untouched.
  update sales.proposals
     set status = 'superseded'
   where plan_set_id = v_set.id
     and status in ('draft', 'pending_approval', 'approved', 'sent');

  update sales.proposal_plan_sets
     set status = 'superseded'
   where sales.proposal_plan_sets.id = v_set.id;

  return 'superseded';
end;
$$;

comment on function sales.supersede_plan_set(uuid, text) is
  'Retires a live 2-3 plan quotation offer whole: cancels its one pending approval and moves every live member and the set itself to superseded (G-166). The set-level mirror of draft_proposal superseding a live standalone version; called when a standalone quote or a newer set takes the deal.';

-- ── 5. draft_proposal supersedes a live plan-set too ───────────────────────
--
-- CARRIED FORWARD VERBATIM from its live definition (20260824150000:79), with
-- ONE marked edit. A standalone quote is slot 0 and a plan-set's members are
-- slots 1..3, so the re-keyed proposals_live_version_key no longer catches the
-- collision between them — the code must. Drafting a standalone quote on an
-- opportunity that already has a live plan-set supersedes that set first, under
-- the same opportunity lock, so "one live offer per deal" holds across both
-- kinds. (draft_plan_set does the mirror: it supersedes a live standalone.)
create or replace function sales.draft_proposal(
  p_opportunity_id         uuid,
  p_title                  text,
  p_body                   text default null,
  p_valid_until            date default null,
  p_requirement_version_id uuid default null,
  p_created_by             uuid default null,
  -- The one addition to the signature. Appended with a default, so every
  -- existing call means precisely what it meant before.
  p_generated_by_run_id    uuid default null,
  -- ── EDIT (G-163 review, 2026-08-24): the caller can name its base ────────
  -- A drafting job's read of "what is live" is minutes old by the end of a
  -- model call, and two agent cycles against one deal are now ordinary. When
  -- the caller names the version it reworked FROM, this function refuses to
  -- supersede anything else — the check runs under the opportunity lock, so
  -- there is no window left at all. Null keeps the old behaviour for callers
  -- (a person's UI) whose base is "whatever is live right now".
  p_expected_supersede     uuid default null
)
returns table (
  -- 'created' | 'not_found' | 'settled' | 'stale'
  outcome     text,
  proposal_id uuid,
  version     int,
  superseded  uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_opportunity sales.opportunities;
  v_next        int;
  v_live        sales.proposals;
  v_row         sales.proposals;
begin
  -- The lock is on the opportunity, so two people drafting at the same moment
  -- serialise: one allocates v2 and the other v3, and neither loses
  -- `proposals_live_version_key` to the other. The same reason
  -- add_deliverable locks the project.
  select o.* into v_opportunity
    from sales.opportunities o
   where o.id = p_opportunity_id
   for update;

  if v_opportunity.id is null then
    return query select 'not_found'::text, null::uuid, null::int, null::uuid;
    return;
  end if;

  -- A won or lost deal is not one that takes new quotes. Refused here rather
  -- than left to look like it worked, because a quote drafted against a
  -- settled deal is invisible in every pipeline view there is.
  if v_opportunity.stage in ('won', 'lost') then
    return query select 'settled'::text, null::uuid, null::int, null::uuid;
    return;
  end if;

  -- ── EDIT (G-166): a standalone quote replaces a live plan-set ────────────
  -- One live offer per deal spans both kinds. A live plan-set on this
  -- opportunity is superseded whole — every member and the set row — before a
  -- standalone quote takes the floor, under the lock this function already
  -- holds. Done through supersede_plan_set so the set's approval is cancelled
  -- and its members move through the guard, never by a raw UPDATE from here.
  perform sales.supersede_plan_set(s.id, 'Superseded by a standalone quotation')
    from sales.proposal_plan_sets s
   where s.opportunity_id = p_opportunity_id
     and s.status in ('draft', 'pending_approval', 'approved', 'sent');

  select coalesce(max(p.version), 0) + 1 into v_next
    from sales.proposals p
   where p.opportunity_id = p_opportunity_id;

  -- §16: V2 is generated, V1 remains historical. The earlier live version is
  -- superseded rather than deleted, and this is what keeps
  -- `proposals_live_version_key` satisfiable — one live version, always.
  --
  -- Superseding a *sent* quote is deliberate and is what §16 describes: the
  -- client asked for a change, so the number they were looking at is no
  -- longer the number on the table.
  --
  -- ── EDIT (G-166): only the standalone (slot 0) live version ──────────────
  -- The re-keyed index makes "live" per-slot; this function only ever drafts a
  -- standalone quote, so it supersedes the standalone live one and leaves the
  -- (already-superseded above) plan-set members alone.
  select p.* into v_live
    from sales.proposals p
   where p.opportunity_id = p_opportunity_id
     and p.plan_set_id is null
     and p.status in ('draft', 'pending_approval', 'approved', 'sent')
   for update;

  -- ── EDIT (G-163 review, 2026-08-24): the stale gate ──────────────────────
  -- Under the same lock as the supersede itself. `is distinct from` on
  -- purpose: expecting a base that has vanished is as stale as finding a
  -- different one.
  if p_expected_supersede is not null and v_live.id is distinct from p_expected_supersede then
    return query select 'stale'::text, null::uuid, null::int, v_live.id;
    return;
  end if;

  if v_live.id is not null then
    update sales.proposals
       set status = 'superseded'
     where sales.proposals.id = v_live.id;

    -- A version on its way out takes its pending question with it. Leaving the
    -- request open would put a quote in the owner's queue that can never be
    -- sent, and ADM-08's whole point is that the queue means something.
    --
    -- Through the engine's own function, not with an UPDATE from here: sales
    -- has no write policy on that table, so an UPDATE would have matched zero
    -- rows and reported success.
    if v_live.approval_request_id is not null then
      perform approvals.cancel_request(
        v_live.approval_request_id,
        'Superseded by quotation v' || v_next
      );
    end if;
  end if;

  insert into sales.proposals (
    organization_id, opportunity_id, version, title, body,
    valid_until, requirement_version_id, currency, created_by,
    -- The second and last addition. The column has existed since the schema's
    -- first day, commented "set when an AI agent drafted it", and nothing ever
    -- set it - so an agent-drafted quotation was indistinguishable from one a
    -- person typed, which is exactly the provenance an owner approving it
    -- needs.
    generated_by_run_id
  )
  values (
    v_opportunity.organization_id, p_opportunity_id, v_next, p_title, p_body,
    p_valid_until, p_requirement_version_id, v_opportunity.currency, p_created_by,
    p_generated_by_run_id
  )
  returning * into v_row;

  return query select 'created'::text, v_row.id, v_next, v_live.id;
end;
$$;

comment on function sales.draft_proposal(uuid, text, text, date, uuid, uuid, uuid, uuid) is
  'Allocates the next version under the opportunity lock, superseding the live standalone one and (G-166) any live plan-set on the deal; p_expected_supersede lets a drafting job name the base it reworked from, refused as stale when the live standalone version is anything else (G-163).';

-- ── 6. Drafting the set and its members ────────────────────────────────────
--
-- Mints the set and 2-3 draft member proposals in one call, under the
-- opportunity lock, superseding whatever offer is live first. The members are
-- ordinary draft proposals — their line items and pricing are added afterwards
-- through the existing add_proposal_item / set_proposal_pricing, which neither
-- know nor care that a plan belongs to a set. p_plans is a JSON array of 2-3
-- objects, each {title, label, body?, valid_until?}; slot is the array
-- position (1-based) and p_recommended_slot names which is the default.
create or replace function sales.draft_plan_set(
  p_opportunity_id         uuid,
  p_plans                  jsonb,
  p_recommended_slot       int,
  p_requirement_version_id uuid default null,
  p_created_by             uuid default null
)
returns table (
  -- 'created' | 'not_found' | 'settled' | 'bad_count' | 'bad_recommended'
  outcome       text,
  plan_set_id   uuid,
  proposal_ids  uuid[]
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_opportunity sales.opportunities;
  v_count       int;
  v_set         sales.proposal_plan_sets;
  v_plan        jsonb;
  v_slot        int;
  v_next        int;
  v_proposal    sales.proposals;
  v_ids         uuid[] := '{}';
  v_recommended uuid;
begin
  -- Same lock, same serialisation as draft_proposal: two sets drafted at once
  -- cannot both end live, and the version numbers they allocate cannot collide.
  select o.* into v_opportunity
    from sales.opportunities o
   where o.id = p_opportunity_id
   for update;

  if v_opportunity.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid[];
    return;
  end if;

  if v_opportunity.stage in ('won', 'lost') then
    return query select 'settled'::text, null::uuid, null::uuid[];
    return;
  end if;

  -- ADM-97's 2-3 cap, checked where the set is made. jsonb_array_length is null
  -- for a non-array, and null is not between 2 and 3, so a malformed payload is
  -- refused here too rather than reaching the loop.
  v_count := jsonb_array_length(p_plans);
  if v_count is null or v_count < 2 or v_count > 3 then
    return query select 'bad_count'::text, null::uuid, null::uuid[];
    return;
  end if;

  -- The recommended plan is required and must name a real slot. A set that
  -- recommends slot 4 of a 3-plan offer has no default, and submit would have
  -- no amount to select an approver from.
  if p_recommended_slot is null or p_recommended_slot < 1 or p_recommended_slot > v_count then
    return query select 'bad_recommended'::text, null::uuid, null::uuid[];
    return;
  end if;

  -- One live offer per deal, across both kinds. Supersede a live plan-set whole
  -- and a live standalone quote, before this set takes the floor — under the
  -- lock held above, so nothing slips in between.
  perform sales.supersede_plan_set(s.id, 'Superseded by a newer plan-set')
    from sales.proposal_plan_sets s
   where s.opportunity_id = p_opportunity_id
     and s.status in ('draft', 'pending_approval', 'approved', 'sent');

  -- The live standalone (slot 0), if any: superseded and its approval cancelled,
  -- exactly as draft_proposal does to it.
  declare
    v_live sales.proposals;
  begin
    select p.* into v_live
      from sales.proposals p
     where p.opportunity_id = p_opportunity_id
       and p.plan_set_id is null
       and p.status in ('draft', 'pending_approval', 'approved', 'sent')
     for update;

    if v_live.id is not null then
      update sales.proposals set status = 'superseded'
       where sales.proposals.id = v_live.id;
      if v_live.approval_request_id is not null then
        perform approvals.cancel_request(
          v_live.approval_request_id, 'Superseded by a plan-set'
        );
      end if;
    end if;
  end;

  insert into sales.proposal_plan_sets (
    organization_id, opportunity_id, requirement_version_id, status, created_by
  )
  values (
    v_opportunity.organization_id, p_opportunity_id, p_requirement_version_id,
    'draft', p_created_by
  )
  returning * into v_set;

  -- The members. Each is an ordinary draft proposal, allocated its own version
  -- (unique per opportunity) and its slot (unique-per-live via the re-keyed
  -- index). No items yet — those come through add_proposal_item, which the guard
  -- lets through while the member is draft.
  v_slot := 0;
  for v_plan in select * from jsonb_array_elements(p_plans)
  loop
    v_slot := v_slot + 1;

    select coalesce(max(p.version), 0) + 1 into v_next
      from sales.proposals p
     where p.opportunity_id = p_opportunity_id;

    insert into sales.proposals (
      organization_id, opportunity_id, version, title, body,
      valid_until, requirement_version_id, currency, created_by,
      plan_set_id, plan_slot, plan_label
    )
    values (
      v_opportunity.organization_id, p_opportunity_id, v_next,
      v_plan->>'title', v_plan->>'body',
      nullif(v_plan->>'valid_until', '')::date,
      p_requirement_version_id, v_opportunity.currency, p_created_by,
      v_set.id, v_slot, v_plan->>'label'
    )
    returning * into v_proposal;

    v_ids := v_ids || v_proposal.id;
    if v_slot = p_recommended_slot then
      v_recommended := v_proposal.id;
    end if;
  end loop;

  update sales.proposal_plan_sets
     set recommended_proposal_id = v_recommended
   where sales.proposal_plan_sets.id = v_set.id;

  return query select 'created'::text, v_set.id, v_ids;
end;
$$;

comment on function sales.draft_plan_set(uuid, jsonb, int, uuid, uuid) is
  'Mints a 2-3 plan quotation offer and its draft member proposals under the opportunity lock, superseding whatever offer is live first (G-166, ADM-97). The 2-3 cap and the required, in-range recommended slot are refused here; line items and pricing are added afterwards through add_proposal_item / set_proposal_pricing, which treat a member as the ordinary draft proposal it is.';

-- ── 7. Submitting the set for one approval ─────────────────────────────────
--
-- The whole point of ADM-97's model: the owner approves the OFFER once, at the
-- recommended plan's price. So this raises ONE approvals.request_approval, on
-- the recommended plan (subject_type 'proposal', subject_id = the recommended
-- member's id, amount = its total) — reusing the existing proposal money-floor
-- policy verbatim, no new subject type, no new policy to seed. Then it moves
-- the set and every member to pending_approval, and the guard verifies each
-- member against this one request (see §3). Mirrors submit_proposal's gates.
create or replace function sales.submit_plan_set(
  p_plan_set_id  uuid,
  p_requested_by uuid  default null,
  p_summary      text  default null
)
returns table (
  -- 'submitted' | 'already_pending' | 'not_found' | 'not_draft'
  -- | 'no_recommended' | 'no_amount' | 'no_items' | 'no_policy'
  outcome    text,
  request_id uuid,
  status     text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_set       sales.proposal_plan_sets;
  v_recommended sales.proposals;
  v_missing   int;
  v_approval  record;
begin
  select s.* into v_set
    from sales.proposal_plan_sets s
   where s.id = p_plan_set_id
   for update;

  if v_set.id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  if v_set.status = 'pending_approval' then
    return query select 'already_pending'::text, v_set.approval_request_id, v_set.status;
    return;
  end if;

  if v_set.status <> 'draft' then
    return query select 'not_draft'::text, v_set.approval_request_id, v_set.status;
    return;
  end if;

  -- The recommendation is required (ADM-97). Without it there is no amount to
  -- select an approver from and no default for the client — draft_plan_set sets
  -- it, but a member could have been superseded out from under it since.
  if v_set.recommended_proposal_id is null then
    return query select 'no_recommended'::text, null::uuid, v_set.status;
    return;
  end if;

  select p.* into v_recommended
    from sales.proposals p
   where p.id = v_set.recommended_proposal_id
   for update;

  if v_recommended.id is null or v_recommended.plan_set_id is distinct from v_set.id then
    return query select 'no_recommended'::text, null::uuid, v_set.status;
    return;
  end if;

  -- Every member priced. A plan with no lines is not a plan, the same rule
  -- submit_proposal makes of a standalone quote — and a set where one rung has
  -- no price is an offer with a hole in it. total_minor is the item-summed
  -- arithmetic (proposals_total_is_arithmetic), so this reads the same trusted
  -- number the approval will carry.
  select count(*) into v_missing
    from sales.proposals p
   where p.plan_set_id = v_set.id
     and p.status = 'draft'
     and p.total_minor <= 0;

  if v_missing > 0 then
    return query select 'no_items'::text, null::uuid, v_set.status;
    return;
  end if;

  if v_recommended.total_minor <= 0 then
    return query select 'no_amount'::text, null::uuid, v_set.status;
    return;
  end if;

  -- The one approval, on the recommended plan. subject_id is the recommended
  -- member's own id, so the forge guard (§3, and proposals_guard for a
  -- standalone) reads exactly as before: the request's subject IS a real
  -- proposal row. The amount is the recommended total, so the SAME
  -- approval_policies_money_floor ladder that decides a single quote decides
  -- this offer. Audience internal: the owner signing the agency's price, not
  -- the client answering it.
  select * into v_approval
    from approvals.request_approval(
      v_set.organization_id,
      'proposal',
      v_set.recommended_proposal_id,
      case when p_requested_by is null then 'system' else 'user' end,
      p_requested_by,
      coalesce(p_summary, 'Quotation offer — ' || v_recommended.title || ' (recommended) and ' || (
        select count(*) - 1 from sales.proposals p where p.plan_set_id = v_set.id
      ) || ' alternative(s)'),
      jsonb_build_object(
        'planSetId', v_set.id,
        'recommendedProposalId', v_set.recommended_proposal_id,
        'recommendedTotalMinor', v_recommended.total_minor,
        'currency', v_recommended.currency,
        'opportunityId', v_set.opportunity_id,
        -- Every plan's slot, label and total, so the owner approves the offer
        -- they can see rather than a reference to it — the same reason
        -- submit_proposal packs the line items.
        'plans', coalesce(
          (
            select jsonb_agg(
                     jsonb_build_object(
                       'proposalId', p.id,
                       'slot', p.plan_slot,
                       'label', p.plan_label,
                       'title', p.title,
                       'totalMinor', p.total_minor,
                       'recommended', p.id = v_set.recommended_proposal_id
                     )
                     order by p.plan_slot
                   )
              from sales.proposals p
             where p.plan_set_id = v_set.id
          ),
          '[]'::jsonb
        )
      ),
      v_recommended.total_minor,
      'internal',
      null
    );

  if v_approval.outcome = 'no_policy' then
    return query select 'no_policy'::text, null::uuid, v_set.status;
    return;
  end if;

  -- The set carries the request; the members move with it. Order matters: the
  -- guard checks a member against a set that is ALREADY pending_approval, so the
  -- set is updated first, then the members.
  update sales.proposal_plan_sets
     set status = 'pending_approval',
         approval_request_id = v_approval.request_id
   where sales.proposal_plan_sets.id = v_set.id;

  update sales.proposals
     set status = 'pending_approval'
   where plan_set_id = v_set.id
     -- Qualified: this function's RETURNS TABLE declares an OUT column `status`,
     -- so an unqualified `status` here is ambiguous and plpgsql's default
     -- variable_conflict = error raises at run time (submit_proposal has no
     -- such clause, which is why only the set path hit this).
     and sales.proposals.status = 'draft';

  return query select 'submitted'::text, v_approval.request_id, 'pending_approval'::text;
end;
$$;

comment on function sales.submit_plan_set(uuid, uuid, text) is
  'Moves a draft 2-3 plan quotation offer to pending_approval and raises the ONE approval that decides it — on the recommended plan (subject a real proposal row, amount its total), reusing the existing proposal money-floor policy so no new subject type or policy is needed (G-166, ADM-97). Refuses a set with no recommendation, an unpriced member, or no matching policy — the same refusals submit_proposal makes of a single quote.';

-- ── 8. Bringing the decision back onto the set ─────────────────────────────
--
-- Mirrors sync_proposal_decision, one level up: reads the set's one approval,
-- and on approval moves the set and every member to approved (recording WHO
-- signed, G-194 — the same name/role, copied at this moment, onto every member
-- so each plan's document carries the signature); a refusal returns the set and
-- its members to draft and clears the settled request.
create or replace function sales.sync_plan_set_decision(
  p_plan_set_id uuid
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_set     sales.proposal_plan_sets;
  v_state   text;
  v_status  text;
  v_decider uuid;
  v_name    text;
  v_role    text;
begin
  select s.* into v_set
    from sales.proposal_plan_sets s
   where s.id = p_plan_set_id
   for update;

  if v_set.id is null then
    return 'not_found';
  end if;

  if v_set.approval_request_id is null then
    return v_set.status;
  end if;

  select r.state, r.decided_by into v_state, v_decider
    from approvals.approval_requests r
   where r.id = v_set.approval_request_id;

  v_status := case v_state
    when 'approved' then 'approved'
    when 'rejected' then 'draft'
    when 'changes_requested' then 'draft'
    else null
  end;

  -- Only from pending_approval. A set already sent must not be dragged back by
  -- a late sync, and one already accepted/superseded is history.
  if v_status is null or v_set.status <> 'pending_approval' then
    return v_set.status;
  end if;

  if v_status = 'approved' and v_decider is not null then
    select nullif(btrim(u.full_name), ''), m.role
      into v_name, v_role
      from core.users u
      left join core.memberships m
        on m.user_id = u.id
       and m.organization_id = v_set.organization_id
     where u.id = v_decider;
  end if;

  -- The set moves first: the guard checks a member against a set that is
  -- ALREADY in the target status (see §3, mirroring submit).
  update sales.proposal_plan_sets
     set status = v_status,
         approval_request_id = case when v_status = 'draft' then null else v_set.approval_request_id end
   where sales.proposal_plan_sets.id = v_set.id;

  -- Then the members. On approval each is signed (G-194) — the same name/role
  -- onto every plan, because the owner signed the one offer they were shown, and
  -- whichever plan the client later picks must carry that signature. On a
  -- refusal they return to draft alongside the set.
  update sales.proposals
     set status = v_status,
         approved_by_name = case when v_status = 'approved' then v_name else sales.proposals.approved_by_name end,
         approved_by_role = case when v_status = 'approved' then v_role else sales.proposals.approved_by_role end
   where plan_set_id = v_set.id
     and status = 'pending_approval';

  return v_status;
end;
$$;

comment on function sales.sync_plan_set_decision(uuid) is
  'Brings the owner''s one decision on a 2-3 plan offer back onto the set and every member (G-166): approval moves them all to approved and records who signed (G-194) onto each plan''s document, because the client picks after approval and the winner must carry the signature; a refusal returns the whole offer to draft and clears the settled request. The set-level mirror of sync_proposal_decision.';

revoke all on function sales.sync_plan_set_decision(uuid) from public;
grant execute on function sales.sync_plan_set_decision(uuid) to authenticated, service_role;

-- ── 9. Sending the offer ───────────────────────────────────────────────────
--
-- Mirrors send_proposal: ADM-07's gate (approved, then sent), checked under the
-- lock, and the set and every member move to sent together. Emits plan_set.sent
-- with every plan's total and the recommended id — the moment the agency put a
-- priced choice in front of the client.
create or replace function sales.send_plan_set(
  p_plan_set_id     uuid,
  p_conversation_id uuid default null,
  p_message_ref     text default null
)
returns table (
  -- 'sent' | 'not_found' | 'not_approved' | 'already_sent'
  outcome text,
  status  text,
  sent_at timestamptz
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_set sales.proposal_plan_sets;
  v_now timestamptz := clock_timestamp();
begin
  select s.* into v_set
    from sales.proposal_plan_sets s
   where s.id = p_plan_set_id
   for update;

  if v_set.id is null then
    return query select 'not_found'::text, null::text, null::timestamptz;
    return;
  end if;

  if v_set.status = 'sent' then
    return query select 'already_sent'::text, v_set.status, v_set.sent_at;
    return;
  end if;

  -- ADM-07's gate. Checked under the lock, not from the caller's earlier read —
  -- an approval withdrawn between check and write is the gap this repo has
  -- closed many times.
  if v_set.status <> 'approved' then
    return query select 'not_approved'::text, v_set.status, null::timestamptz;
    return;
  end if;

  update sales.proposal_plan_sets
     set status           = 'sent',
         sent_at          = v_now,
         conversation_id  = coalesce(p_conversation_id, sales.proposal_plan_sets.conversation_id),
         sent_message_ref = coalesce(p_message_ref, sales.proposal_plan_sets.sent_message_ref)
   where sales.proposal_plan_sets.id = v_set.id;

  -- The members go sent with the set — each is a real proposal, and a member
  -- left 'approved' while the offer is out would be a live-key ghost the client
  -- was never shown moving.
  update sales.proposals
     set status           = 'sent',
         sent_at          = v_now,
         conversation_id  = coalesce(p_conversation_id, sales.proposals.conversation_id),
         sent_message_ref = coalesce(p_message_ref, sales.proposals.sent_message_ref)
   where plan_set_id = v_set.id
     -- Qualified: OUT column `status` is in scope (see submit_plan_set).
     and sales.proposals.status = 'approved';

  perform core.emit_event(
    v_set.organization_id, 'plan_set.sent', 'plan_set', v_set.id,
    jsonb_build_object(
      'opportunityId', v_set.opportunity_id,
      'recommendedProposalId', v_set.recommended_proposal_id,
      'conversationId', p_conversation_id,
      'plans', coalesce(
        (
          select jsonb_agg(
                   jsonb_build_object(
                     'proposalId', p.id,
                     'slot', p.plan_slot,
                     'label', p.plan_label,
                     'totalMinor', p.total_minor,
                     'currency', p.currency,
                     'recommended', p.id = v_set.recommended_proposal_id
                   )
                   order by p.plan_slot
                 )
            from sales.proposals p
           where p.plan_set_id = v_set.id
        ),
        '[]'::jsonb
      )
    )
  );

  return query select 'sent'::text, 'sent'::text, v_now;
end;
$$;

comment on function sales.send_plan_set(uuid, uuid, text) is
  'Delivers an approved 2-3 plan quotation offer, moving the set and every member to sent and recording when and through which conversation (G-166). Refuses anything the owner has not approved (ADM-07''s gate, under the lock). Emits plan_set.sent with every plan''s total and the recommended id.';

revoke all on function sales.send_plan_set(uuid, uuid, text) from public;
grant execute on function sales.send_plan_set(uuid, uuid, text) to authenticated, service_role;

-- ── 10. The client picks one ───────────────────────────────────────────────
--
-- The crux ADM-97 was about. A sent offer, the client chooses a plan: that plan
-- becomes accepted, its siblings superseded, the set accepted. Then
-- plan_set.accepted fires carrying the CHOSEN plan's id and total — so
-- everything that watches for an accepted quotation today (the close path, the
-- WON arrow) fires on exactly one winner, as if a single quote had been
-- accepted. §18's validity gate holds: a plan past its date cannot be the
-- winner, the same rule record_proposal_response makes.
create or replace function sales.record_plan_set_choice(
  p_plan_set_id       uuid,
  p_chosen_proposal_id uuid,
  p_contact_id        uuid default null,
  p_note              text default null
)
returns table (
  -- 'accepted' | 'not_found' | 'not_answerable' | 'not_a_member' | 'expired'
  outcome     text,
  status      text,
  decided_at  timestamptz
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_set    sales.proposal_plan_sets;
  v_chosen sales.proposals;
  v_now    timestamptz := clock_timestamp();
begin
  select s.* into v_set
    from sales.proposal_plan_sets s
   where s.id = p_plan_set_id
   for update;

  if v_set.id is null then
    return query select 'not_found'::text, null::text, null::timestamptz;
    return;
  end if;

  -- Only a sent offer is answerable. Unlike a single quote there is no 'lapsed'
  -- set state — a whole offer does not lapse; its individual plans carry their
  -- own valid_until, checked below.
  if v_set.status <> 'sent' then
    return query select 'not_answerable'::text, v_set.status, null::timestamptz;
    return;
  end if;

  select p.* into v_chosen
    from sales.proposals p
   where p.id = p_chosen_proposal_id
   for update;

  -- The chosen plan must be one of THIS set's members, and still sent. A client
  -- cannot accept a plan from a different offer, or a sibling already superseded.
  if v_chosen.id is null
     or v_chosen.plan_set_id is distinct from v_set.id
     or v_chosen.status <> 'sent'
  then
    return query select 'not_a_member'::text, v_set.status, null::timestamptz;
    return;
  end if;

  -- §15's validity, on the plan the client actually chose. A rung past its date
  -- cannot be accepted — the same rule record_proposal_response enforces on a
  -- single quote, checked against the date as well as the status.
  if v_chosen.valid_until is not null
     and v_chosen.valid_until < (v_now at time zone 'utc')::date
  then
    return query select 'expired'::text, v_set.status, null::timestamptz;
    return;
  end if;

  -- The siblings lose first (sent -> superseded, reachable with no approval
  -- check), so that when the winner and the set settle, the only live member
  -- left is the one the client picked.
  update sales.proposals
     set status = 'superseded'
   where plan_set_id = v_set.id
     and id <> v_chosen.id
     -- Qualified: OUT column `status` is in scope (see submit_plan_set).
     and sales.proposals.status in ('draft', 'pending_approval', 'approved', 'sent');

  -- The winner: sent -> accepted, carrying who answered and where.
  update sales.proposals
     set status                  = 'accepted',
         decided_at              = v_now,
         responded_by_contact_id = coalesce(p_contact_id, sales.proposals.responded_by_contact_id),
         response_note           = coalesce(p_note, sales.proposals.response_note)
   where sales.proposals.id = v_chosen.id;

  -- The set records the choice and settles.
  update sales.proposal_plan_sets
     set status                  = 'accepted',
         chosen_proposal_id      = v_chosen.id,
         decided_at              = v_now,
         responded_by_contact_id = coalesce(p_contact_id, sales.proposal_plan_sets.responded_by_contact_id),
         response_note           = coalesce(p_note, sales.proposal_plan_sets.response_note)
   where sales.proposal_plan_sets.id = v_set.id;

  -- One winner, one event. The chosen plan's id and total, so a subscriber sees
  -- exactly what a single proposal.accepted would carry — the close path does
  -- not need to know a choice was ever offered.
  perform core.emit_event(
    v_set.organization_id, 'plan_set.accepted', 'plan_set', v_set.id,
    jsonb_build_object(
      'opportunityId', v_set.opportunity_id,
      'chosenProposalId', v_chosen.id,
      'chosenSlot', v_chosen.plan_slot,
      'chosenLabel', v_chosen.plan_label,
      'totalMinor', v_chosen.total_minor,
      'currency', v_chosen.currency,
      'contactId', p_contact_id
    )
  );

  return query select 'accepted'::text, 'accepted'::text, v_now;
end;
$$;

comment on function sales.record_plan_set_choice(uuid, uuid, uuid, text) is
  'Records the client picking one plan from a sent 2-3 plan offer (G-166, ADM-97): the chosen member becomes accepted, its siblings superseded, the set accepted, and plan_set.accepted fires with the CHOSEN plan''s id and total — so the close path fires on one winner exactly as a single accepted quote would. Refuses a plan from another offer, an already-settled sibling, or one past its validity date.';

revoke all on function sales.record_plan_set_choice(uuid, uuid, uuid, text) from public;
grant execute on function sales.record_plan_set_choice(uuid, uuid, uuid, text) to authenticated, service_role;

-- ── 11. The client declines the whole offer ───────────────────────────────
--
-- No plan chosen: the offer is refused entire. The set and every live member go
-- to rejected, and plan_set.rejected fires. The mirror of record_proposal_
-- response's 'rejected' branch, one level up. A sent offer only — there is no
-- lapsed set to decline.
create or replace function sales.record_plan_set_response(
  p_plan_set_id uuid,
  p_response    text,
  p_contact_id  uuid default null,
  p_note        text default null
)
returns table (
  -- 'recorded' | 'invalid_response' | 'not_found' | 'not_answerable'
  outcome    text,
  status     text,
  decided_at timestamptz
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_set sales.proposal_plan_sets;
  v_now timestamptz := clock_timestamp();
begin
  -- Only a decline of the whole offer goes through here. Accepting is choosing a
  -- plan — record_plan_set_choice — because an acceptance with no chosen plan is
  -- the murky total ADM-97 rejected the jsonb model to avoid.
  if p_response <> 'rejected' then
    return query select 'invalid_response'::text, null::text, null::timestamptz;
    return;
  end if;

  select s.* into v_set
    from sales.proposal_plan_sets s
   where s.id = p_plan_set_id
   for update;

  if v_set.id is null then
    return query select 'not_found'::text, null::text, null::timestamptz;
    return;
  end if;

  if v_set.status <> 'sent' then
    return query select 'not_answerable'::text, v_set.status, null::timestamptz;
    return;
  end if;

  -- Every live member declined. sent -> rejected is a client decline the guard
  -- allows; the members were all sent together, so all move together.
  update sales.proposals
     set status                  = 'rejected',
         decided_at              = v_now,
         responded_by_contact_id = coalesce(p_contact_id, sales.proposals.responded_by_contact_id),
         response_note           = coalesce(p_note, sales.proposals.response_note)
   where plan_set_id = v_set.id
     -- Qualified: OUT column `status` is in scope (see submit_plan_set).
     and sales.proposals.status = 'sent';

  update sales.proposal_plan_sets
     set status                  = 'rejected',
         decided_at              = v_now,
         responded_by_contact_id = coalesce(p_contact_id, sales.proposal_plan_sets.responded_by_contact_id),
         response_note           = coalesce(p_note, sales.proposal_plan_sets.response_note)
   where sales.proposal_plan_sets.id = v_set.id;

  perform core.emit_event(
    v_set.organization_id, 'plan_set.rejected', 'plan_set', v_set.id,
    jsonb_build_object(
      'opportunityId', v_set.opportunity_id,
      'recommendedProposalId', v_set.recommended_proposal_id,
      'contactId', p_contact_id
    )
  );

  return query select 'recorded'::text, 'rejected'::text, v_now;
end;
$$;

comment on function sales.record_plan_set_response(uuid, text, uuid, text) is
  'Records a client declining a whole 2-3 plan offer (G-166): the set and every live member move to rejected and plan_set.rejected fires. Accepting is choosing a plan (record_plan_set_choice), so this takes only ''rejected'' — an acceptance with no chosen plan is the murky total ADM-97 rejected.';

revoke all on function sales.record_plan_set_response(uuid, text, uuid, text) from public;
grant execute on function sales.record_plan_set_response(uuid, text, uuid, text) to authenticated, service_role;

-- Grants for the set-level writers whose grants were not written inline above.
revoke all on function sales.supersede_plan_set(uuid, text) from public;
grant execute on function sales.supersede_plan_set(uuid, text) to authenticated, service_role;
revoke all on function sales.draft_plan_set(uuid, jsonb, int, uuid, uuid) from public;
grant execute on function sales.draft_plan_set(uuid, jsonb, int, uuid, uuid) to authenticated, service_role;
revoke all on function sales.submit_plan_set(uuid, uuid, text) from public;
grant execute on function sales.submit_plan_set(uuid, uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
