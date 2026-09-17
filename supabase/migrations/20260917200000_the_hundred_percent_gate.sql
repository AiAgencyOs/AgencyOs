-- ═══════════════════════════════════════════════════════════════════════════
-- The hundred percent gate.
--
-- Finance §7, §12; ADM-105.
--
-- G-251 wrote the gate as a pure function — `phaseSevenGate(verifiedPercent)`
-- — and **nothing ever computed the number it takes.** Its only caller was its
-- own test. That is the shape this repository calls half a check: a rule
-- stated, tested, and unreachable.
--
-- §12 draws the ladder: *"0% → M1 VERIFIED = 30% → M2 VERIFIED = 50%
-- cumulative → M3 VERIFIED = 80% → M4 VERIFIED = 100% → PHASE7_FINANCE_GATE_
-- OPEN."* This computes where a project actually is on it.
--
-- ── VERIFIED, and verified means net ─────────────────────────────────────
--
-- §6: proof never auto-verifies. So a milestone counts only when its live
-- invoice has been **verified** — `finance.net_verified_minor`, which is
-- captured-and-verified payments **less refunds** (ADM-04).
--
-- That subtraction is the part worth stating: **a refund closes this gate
-- again.** A project at 100% whose advance is refunded drops to 70% and Phase
-- 7 shuts. Any implementation counting `paid_minor`, or summing payments
-- without refunds, would leave it open — which is the difference between a
-- gate and a decoration.
--
-- ── and a percentage nobody can compute is not zero ──────────────────────
--
-- A null `payment_percent` means *this milestone is not part of the payment
-- schedule* — that is what `projects.assert_payment_plan_totals` already
-- decides, by summing only the priced ones and leaving the rest alone, with
-- its own comment saying a project may exist before its plan is agreed. So
-- unpriced milestones are **excluded here too**, rather than treated as a
-- reason the whole plan cannot be measured.
--
-- The first draft of this function got that wrong: it required *every*
-- milestone to carry a percentage, which would have shut the gate on a
-- perfectly ordinary plan of four priced milestones plus an unpriced one. The
-- existing constraint is the authority on what a valid plan looks like, and
-- reading it is how that was caught.
--
-- What genuinely **cannot be measured** is a project with **no priced
-- milestones at all** — and `verified_percent` is NULL there, never 0, because
-- 0% is a claim somebody acts on and "nobody has agreed a payment plan" is a
-- different fact. `measurable` says which, and the gate is forced shut
-- whenever it is false: an unmeasurable plan is exactly where an optimistic
-- answer does the most damage, opening the last phase of a project on
-- arithmetic nobody can check.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function finance.project_payment_progress(p_project_id uuid)
returns table (
  -- The cumulative percentage §12's ladder is drawn in. Null when it cannot
  -- be computed — never 0, which is a different claim.
  verified_percent    numeric,
  -- What the plan's own percentages add up to. 100 for any plan written
  -- through replace_payment_plan; anything else is a plan somebody made by
  -- hand, and is reported rather than corrected.
  plan_total_percent  numeric,
  measurable          boolean,
  -- Priced milestones only — the ones the percentage is computed over.
  milestones          int,
  verified_milestones int
)
language sql
stable
security invoker
set search_path = ''
as $$
  with plan as (
    select
      m.id,
      m.payment_percent,
      -- The live invoice for this milestone, if it has one. `void` is not
      -- live: a voided invoice is a bill that was withdrawn.
      (select i.id from finance.invoices i
        where i.milestone_id = m.id and i.status <> 'void'
        limit 1) as invoice_id,
      (select i.total_minor from finance.invoices i
        where i.milestone_id = m.id and i.status <> 'void'
        limit 1) as total_minor
      from projects.milestones m
     where m.project_id = p_project_id
       -- Only the priced ones. An unpriced milestone is not part of the
       -- payment schedule, which is the same rule
       -- projects.assert_payment_plan_totals applies when it checks the total.
       and m.payment_percent is not null
  ),
  settled as (
    select
      plan.payment_percent,
      -- Verified means NET verified: captured, verified, less refunds. A
      -- milestone whose payment was refunded stops counting, which is what
      -- makes this a gate rather than a high-water mark.
      (plan.invoice_id is not null
        and plan.total_minor is not null
        and finance.net_verified_minor(plan.invoice_id) >= plan.total_minor) as is_verified
      from plan
  )
  select
    case when count(*) > 0 and coalesce(sum(payment_percent), 0) = 100
      then coalesce(sum(payment_percent) filter (where is_verified), 0)
    end,
    sum(payment_percent),
    count(*) > 0 and coalesce(sum(payment_percent), 0) = 100,
    count(*)::int,
    count(*) filter (where is_verified)::int
    from settled;
$$;

comment on function finance.project_payment_progress(uuid) is
  'Finance section 12''s ladder, computed. A milestone counts only when its live invoice is NET verified - captured and verified payments less refunds - so a refund closes the Phase 7 gate again rather than leaving it at a high-water mark. verified_percent is NULL, never 0, when there are no priced milestones or they do not total 100: a percentage nobody can compute is not zero, and reporting it as zero produces a number somebody acts on.';

revoke all on function finance.project_payment_progress(uuid) from public, anon;
grant execute on function finance.project_payment_progress(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
