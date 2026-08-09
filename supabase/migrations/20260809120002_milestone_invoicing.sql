-- ═══════════════════════════════════════════════════════════════════════════
-- 014 — Milestone → invoice: the money link, enforced by the database
--
-- Covers PAYMENT MILESTONE → DRAFT INVOICE → ISSUED → PAID → NEXT STAGE.
--
-- finance.invoices already carries milestone_id, project_id, client_account_id
-- and the full status vocabulary, so no table is added and no column changes
-- meaning. What was missing is the set of invariants that make milestone
-- billing safe to run:
--
--   1. A milestone can have at most ONE live invoice. Application checks race;
--      an index does not.
--   2. A milestone invoice must also name its project, so the money link is
--      never half-connected.
--   3. Manually recorded payments need a write path that is not "service role
--      only" — there is no gateway yet, and a human recording a bank transfer
--      is the mechanism, not a workaround.
--   4. Domain events need a write path, so `invoice.paid` can later unlock the
--      next milestone without finance knowing what listens.
--
-- No payment provider is contacted anywhere in this migration or the code that
-- uses it. finance.payments.provider = 'manual' is the only value humans may
-- write; gateway rows keep arriving under service_role when that day comes.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. One live invoice per milestone ─────────────────────────────────────
-- Idempotency for invoice generation, enforced where concurrency cannot dodge
-- it. `void` is excluded on purpose: voiding an invoice is how a mistaken bill
-- is withdrawn, and the milestone must then be billable again.
create unique index if not exists invoices_milestone_live_key
  on finance.invoices (milestone_id)
  where milestone_id is not null and status <> 'void';

comment on index finance.invoices_milestone_live_key is
  'At most one non-void invoice per milestone. Makes generateInvoiceFromMilestone idempotent under concurrent calls, not merely usually-idempotent.';

-- ── 1b. A draft can be withdrawn ──────────────────────────────────────────
-- Migration 007 required issued_at for every status except draft and
-- pending_approval, which quietly made a draft impossible to void: voiding
-- moved it out of the exempt set while there was no issue date to supply, and
-- the check refused the write.
--
-- That is backwards. A draft that is withdrawn was *never issued*, so demanding
-- the moment it was issued is asking for a fact that does not exist — and the
-- invoice it blocks is precisely the one most likely to be wrong. `void` joins
-- the exemption; every other status still has to say when it went out.
alter table finance.invoices drop constraint if exists invoices_issued_at_set;
alter table finance.invoices add constraint invoices_issued_at_set
  check (status in ('draft', 'pending_approval', 'void') or issued_at is not null);

-- ── 2. A milestone invoice always names its project ───────────────────────
-- projects.milestones.project_id is NOT NULL, so an invoice that knows the
-- milestone but not the project is necessarily a bug in the writer.
alter table finance.invoices drop constraint if exists invoices_milestone_implies_project;
alter table finance.invoices add constraint invoices_milestone_implies_project
  check (milestone_id is null or project_id is not null);

-- Billing views load every invoice for a project at once.
create index if not exists invoices_project_idx
  on finance.invoices (project_id)
  where project_id is not null;

-- ── 3. Manual payments ────────────────────────────────────────────────────
-- Until a gateway is integrated, "payment received" is a human asserting that
-- money landed, with the bank/UPI reference as evidence. That assertion is a
-- real record with a real actor, so it is written by the user's own session
-- under RLS rather than smuggled in through the service role.
--
-- INSERT only, and only for provider = 'manual':
--   • a recorded payment is an immutable fact — corrections are a refund or a
--     void, never an edit;
--   • gateway rows (provider = 'razorpay', …) stay unreachable from a browser
--     session, so no user can fabricate a capture that never happened.
--
-- unique (provider, provider_payment_id) already exists and does double duty:
-- webhook idempotency for gateways, and duplicate-reference protection here.
drop policy if exists payments_manual_insert on finance.payments;
create policy payments_manual_insert on finance.payments
  for insert to authenticated
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) in ('owner', 'ops_admin')
    and provider = 'manual'
  );

comment on column finance.payments.provider is
  'Payment source. ''manual'' is a human-recorded bank/UPI/cheque receipt and is the only value an authenticated session may insert; gateway providers are written by the webhook handler under service_role.';

-- ── 4. Domain events ──────────────────────────────────────────────────────
-- ARCHITECTURE.md §9: modules publish events, never call each other. The
-- outbox previously had no INSERT policy because only the job runner wrote to
-- it, which made `invoice.paid` unemittable from a request.
--
-- Scoped tightly: an author may only stamp their own organization, and only
-- the two roles that already move money may publish at all. published_at must
-- be null, so a caller cannot insert an event that is pre-marked as delivered
-- and therefore never dispatched.
drop policy if exists outbox_insert on core.outbox_events;
create policy outbox_insert on core.outbox_events
  for insert to authenticated
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) in ('owner', 'ops_admin')
    and published_at is null
  );

comment on table core.outbox_events is
  'Events are written alongside the state change they describe. Owners and ops admins may publish from a request (finance emits invoice.issued / invoice.paid here); everything else writes under service_role.';

-- ── RLS otherwise unchanged ───────────────────────────────────────────────
-- finance.invoices and finance.invoice_items keep the policies from migration
-- 007 exactly as they are: staff read their organization, clients read their
-- own account's invoices once they leave draft, and only owner/ops_admin
-- write. Issuing an invoice is therefore also what makes it visible in the
-- client portal — no separate "share" mechanism exists or is needed.
