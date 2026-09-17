-- ═══════════════════════════════════════════════════════════════════════════
-- A bill with nothing to collect.
--
-- Finance §9, *"Phase 7 Completion → ₹0 Free-Maintenance Invoice"*, eight
-- checkboxes, none of which anything in AgencyOS could answer:
--
--   "When Phase 7 completes, check whether free maintenance/support was
--    included for the client. … Generate a maintenance invoice/document with
--    ₹0 charges … No payment collection is required. No Admin payment
--    verification is required because payable amount is ₹0. … Record the
--    free-maintenance entitlement/period so later renewal logic knows when it
--    ends."
--
-- G-034 and its correction built `projects.maintenance_plans` from Doc 18 —
-- versions, coverage, a period, a state machine, an accepted proposal where
-- the price lives. **Nothing on it can say the maintenance was free.** So the
-- first checkbox has no column to read, and the seven after it never start.
--
-- ── the sentence this migration is really about ─────────────────────────
--
-- *"No Admin payment verification is required because payable amount is ₹0."*
--
-- That reads as an exemption from ADM-04 — *a client saying "I paid" is a
-- claim; the Admin confirms it* — and this repository has refused to bypass
-- Admin verification everywhere it has come up. **It is not an exemption.**
--
-- G-007 made `status = 'paid'` follow `verified_minor`, not `paid_minor`: an
-- invoice is paid when **confirmed money less refunds covers its total**. At a
-- total of zero that condition is already true, of nothing. There is no
-- verification to skip, because there is no claim: nobody asserts that ₹0
-- arrived. The rule is not weakened here, it is **evaluated at zero** — and a
-- test asserts exactly that, against `finance.net_verified_minor`, rather than
-- asserting that this door is allowed to write `paid`.
--
-- The safety property follows from the shape rather than from a check: **this
-- door takes no amount.** There is no parameter, anywhere in its signature,
-- that could make the invoice non-zero, so there is no input that turns it
-- into a way of marking a real bill paid without an Admin. A `p_total_minor`
-- defaulted to 0 would have been the same function with a hole in it.
--
-- ── what it will not pretend ────────────────────────────────────────────
--
-- **Phase 7 completion is recorded nowhere.** §9's trigger is *"when Phase 7
-- completes"*, and this deployment has no Phase 7 — G-268 says *may open*
-- rather than *is open* for the same reason. So this is a door a person
-- calls, not a trigger that fires. What it CAN prove is §8's necessary
-- condition, that the project reached 100% verified, and it refuses without
-- it: Phase 7 cannot have completed if it could not have started.
--
-- **It does not share anything.** §9 asks for the invoice to go to the client
-- email and the project WhatsApp group. There is no email channel on this
-- deployment (BLK-007) and no production WhatsApp number (BLK-003). The
-- invoice is raised and recorded; sending it is the same manual step every
-- other document on this deployment takes.
--
-- **Phase 8 is announced, not started.** §9's last action is *"directly
-- trigger/allow Phase 8"*. Phase 8 does not exist, so the event is emitted
-- with no subscriber — exactly as Phase 1 emitted `opportunity.handed_off`
-- into nothing until Phase 2 existed, and as `project.phase_three_ready` does
-- today.
--
-- Worth recording alongside: **Phase 8 appears in the Finance specification
-- and in none of the other three.** The plan phase vocabulary G-256 and G-262
-- built stops at `phase_7`, and that remains right — Phase 8 is the customer
-- success and maintenance life of a delivered project, not a phase a delivery
-- plan schedules work into.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── §9, checkbox 1: something to check ───────────────────────────────────
--
-- Nullable, with no default. A default of 'paid' would assert something about
-- every maintenance plan already recorded, and nobody has been asked. Null
-- means *nobody has said*, which is the honest state of every existing row.
alter table projects.maintenance_plans
  add column if not exists entitlement text
    check (entitlement in ('free_included', 'paid'));

comment on column projects.maintenance_plans.entitlement is
  'Finance section 9 checkbox 1 - whether this maintenance was INCLUDED with the project or sold. free_included is what makes the zero-rupee invoice applicable. NULL means nobody has said: no default, because a default would answer for every plan recorded before this column existed. Where it was agreed is accepted_proposal_id, which is also where ADM-22 puts the price of a plan that is not free.';

-- §9's last checkbox: "record the free-maintenance entitlement/period so later
-- renewal logic knows when it ends." The period columns already exist (§9 of
-- Doc 18, "track plan start/end dates"); what was missing is that a FREE
-- entitlement without an end is one no renewal can ever be triggered from.
alter table projects.maintenance_plans
  drop constraint if exists maintenance_plans_free_entitlement_ends;
alter table projects.maintenance_plans
  add constraint maintenance_plans_free_entitlement_ends
    check (entitlement is distinct from 'free_included' or ends_on is not null)
    not valid;

comment on constraint maintenance_plans_free_entitlement_ends on projects.maintenance_plans is
  'Finance section 9 last checkbox. A free entitlement with no end date is one later renewal logic can never fire from, which is the whole reason section 9 asks for the period to be recorded. NOT VALID deliberately: it governs rows written from now on, and no existing row can carry entitlement at all because the column did not exist.';

-- ── which plan a bill is for ─────────────────────────────────────────────
--
-- `finance.invoices` could point at a project and at a delivery milestone, and
-- at nothing else. A free-maintenance invoice belongs to neither: it bills no
-- milestone, and a project may hold more than one maintenance plan over its
-- life. Without this column "has this plan already been invoiced?" has no
-- answer, and the door would raise a second zero-rupee document every time
-- somebody clicked twice.
alter table finance.invoices
  add column if not exists maintenance_plan_id uuid
    references projects.maintenance_plans(id) on delete set null;

comment on column finance.invoices.maintenance_plan_id is
  'Finance section 9 - the maintenance plan this invoice bills, which is how a free-maintenance invoice is found again. Null for every other invoice, including a milestone invoice: the milestone is named by milestone_id and the two are never both set.';

-- One LIVE invoice per plan. A voided one does not occupy the plan, the same
-- rule and the same shape as invoices_milestone_live_key.
create unique index if not exists invoices_maintenance_plan_live_key
  on finance.invoices (maintenance_plan_id)
  where maintenance_plan_id is not null and status <> 'void';

-- An org-scoped foreign key, so it needs the guard every other one carries or
-- an invoice could name a plan belonging to another agency.
drop trigger if exists org_match_invoices_maintenance_plan on finance.invoices;
create trigger org_match_invoices_maintenance_plan
  before insert or update of maintenance_plan_id, organization_id on finance.invoices
  for each row execute function core.enforce_parent_org('maintenance_plan_id', 'projects.maintenance_plans');

-- ── §9, checkboxes 2-7: the bill ─────────────────────────────────────────
--
-- SECURITY INVOKER, unlike the doors in `projects`, and deliberately.
-- `20260815290000` rejected SECURITY DEFINER for every finance function that
-- writes an invoice: they rely on RLS for tenant isolation, and running them
-- as the owner would open a cross-tenant hole unless an org check were bolted
-- onto each. This one writes an invoice, so it follows that rule rather than
-- the one its neighbours in `projects` follow, and the caller's capability is
-- checked in the service above it exactly as it is for create_milestone_invoice.
create or replace function finance.issue_free_maintenance_invoice(
  p_plan_id uuid,
  p_number  text
)
returns table (
  -- 'issued' | 'already_issued' | 'unknown_plan' | 'not_free'
  --          | 'payment_incomplete' | 'number_taken'
  outcome    text,
  invoice_id uuid,
  number     text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_plan       projects.maintenance_plans;
  v_existing   uuid;
  v_existing_n text;
  v_invoice_id uuid;
  v_progress   record;
begin
  -- The invoices guard (20260815290000). Transaction-scoped, single-use, and
  -- consumed by the one invoice row this function writes.
  perform set_config('finance.sanctioned_write', 'on', true);

  select * into v_plan
    from projects.maintenance_plans
   where id = p_plan_id
   for update;

  if v_plan.id is null then
    return query select 'unknown_plan'::text, null::uuid, null::text; return;
  end if;

  -- Not an error. A paid plan is billed the ordinary way, and a plan nobody
  -- has classified is one somebody still has to look at.
  if v_plan.entitlement is distinct from 'free_included' then
    return query select 'not_free'::text, null::uuid, null::text; return;
  end if;

  -- There is deliberately NO `no_period` branch here, and that is a decision
  -- rather than an omission. The check constraint above makes a free
  -- entitlement without an end date unwritable, so a branch answering
  -- `no_period` could never fire — and a control no test can bite is a
  -- comment with a semicolon. The rule has one holder, at the row.

  -- Idempotent on the plan, not on the project: a project may hold more than
  -- one maintenance plan over its life, and each free one is its own document.
  select i.id, i.number into v_existing, v_existing_n
    from finance.invoices i
   where i.maintenance_plan_id = v_plan.id
     and i.status <> 'void'
   limit 1;
  if v_existing is not null then
    return query select 'already_issued'::text, v_existing, v_existing_n; return;
  end if;

  -- §8: "Phase 7 starts only when required 100% payment is complete/verified."
  -- §9 fires when Phase 7 COMPLETES, which nothing records — so the strongest
  -- provable condition is that it could have started. An unmeasurable plan is
  -- shut here for the same reason G-264 forces its gate shut: a project with
  -- no payment plan has not been proven paid, it has been proven unmeasured.
  select * into v_progress from finance.project_payment_progress(v_plan.project_id);
  if v_progress.measurable is not true or coalesce(v_progress.verified_percent, 0) < 100 then
    return query select 'payment_incomplete'::text, null::uuid, null::text; return;
  end if;

  -- ── the bill ───────────────────────────────────────────────────────────
  --
  -- NO AMOUNT IS PASSED IN. Every money column is the literal zero, written
  -- here, so the signature contains nothing that could make this invoice
  -- non-zero. `status = 'paid'` is not an exemption from ADM-04: G-007 made
  -- paid follow `verified_minor >= total_minor`, and at a total of zero that
  -- is already true. Nobody claimed money arrived, so there is no claim for an
  -- Admin to confirm.
  begin
    insert into finance.invoices (
      organization_id, client_account_id, project_id, maintenance_plan_id,
      number, status, currency,
      subtotal_minor, tax_minor, total_minor, paid_minor, verified_minor,
      issued_at, paid_at, notes
    )
    values (
      v_plan.organization_id, v_plan.client_account_id, v_plan.project_id, v_plan.id,
      p_number, 'paid', 'INR',
      0, 0, 0, 0, 0,
      now(), now(),
      format('Free maintenance included with this project: %s, to %s.', v_plan.name, v_plan.ends_on)
    )
    returning id into v_invoice_id;
  exception
    when unique_violation then
      -- Only the number can collide here: the plan is held under the row lock
      -- taken above, so the live-plan index cannot be raced.
      return query select 'number_taken'::text, null::uuid, null::text; return;
  end;

  -- One line at zero rather than none. §9 asks for an invoice "for the
  -- applicable free-maintenance period/service", and a document with no lines
  -- says what was free nowhere — `create_milestone_invoice` refuses a lineless
  -- invoice outright for the same reason.
  insert into finance.invoice_items (
    organization_id, invoice_id, position, description,
    quantity, unit_price_minor, amount_minor, tax_rate_bp
  )
  values (
    v_plan.organization_id, v_invoice_id, 0,
    format('%s — free maintenance included, %s to %s',
           v_plan.name,
           coalesce(v_plan.starts_on::text, 'project completion'),
           v_plan.ends_on),
    1, 0, 0, 0
  );

  perform core.record_audit(
    v_plan.organization_id,
    'invoice.created',
    'invoice',
    v_invoice_id,
    null,
    jsonb_build_object(
      'number', p_number,
      'maintenancePlanId', v_plan.id,
      'projectId', v_plan.project_id,
      'totalMinor', 0,
      'entitlement', 'free_included'
    )
  );

  perform core.emit_event(
    v_plan.organization_id,
    'maintenance.free_invoice_issued',
    'invoice',
    v_invoice_id,
    jsonb_build_object(
      'number', p_number,
      'maintenancePlanId', v_plan.id,
      'projectId', v_plan.project_id,
      'endsOn', v_plan.ends_on
    )
  );

  return query select 'issued'::text, v_invoice_id, p_number;
end;
$$;

comment on function finance.issue_free_maintenance_invoice(uuid, text) is
  'Finance section 9 - the zero-rupee invoice for maintenance that was included rather than sold. IT TAKES NO AMOUNT: every money column is a literal zero written in the body, so no input exists that could make this a way of marking a real bill paid without an Admin. status = paid is not an exemption from ADM-04 - G-007 made paid follow verified_minor >= total_minor, and at a total of zero that condition is already satisfied of nothing. There is no no_period outcome: the check constraint makes a free entitlement without an end date unwritable, so a branch for it could never fire. Refuses until the project is 100% net verified, which is section 8s necessary condition for Phase 7 having started at all; Phase 7 COMPLETION is recorded nowhere, so this is a door a person calls rather than a trigger. It does not send: BLK-003 and BLK-007.';

revoke all on function finance.issue_free_maintenance_invoice(uuid, text) from public, anon;
grant execute on function finance.issue_free_maintenance_invoice(uuid, text) to authenticated, service_role;

-- ── §9, checkbox 8: Phase 8 is announced, not started ────────────────────
insert into core.event_types (type, description, canonical) values
  ('maintenance.free_invoice_issued',
   'Finance section 9 - the zero-rupee free-maintenance invoice has been raised, which is the specifications signal to "directly trigger/allow Phase 8". NOTHING SUBSCRIBES: Phase 8 does not exist, exactly as project.phase_three_ready has no subscriber and opportunity.handed_off had none until Phase 2 existed.',
   true)
on conflict (type) do nothing;

notify pgrst, 'reload schema';
