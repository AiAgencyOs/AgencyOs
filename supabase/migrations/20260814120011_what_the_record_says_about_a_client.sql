-- ═══════════════════════════════════════════════════════════════════════════
-- What the record says about a client.
--
-- Gap G-037, filed as "client lifetime model".
--
-- ── the name it is deliberately not given ────────────────────────────────
--
-- **Nothing in AgencyOS defines lifetime value.** The words *lifetime*,
-- *LTV*, *retention* and *churn* appear nowhere in any business document —
-- the only occurrence anywhere is the gap's own title.
--
-- So this is not a lifetime-value model, and it is not called one. Naming a
-- sum of past payments "lifetime value" would smuggle in a forecast: the term
-- means *expected* value over a relationship's remaining life, and expecting
-- anything requires assumptions about retention that nobody has made and that
-- this repository has no basis to invent.
--
-- What it is: **the facts already recorded about a client, added up.** Every
-- column is a count, a sum or a date drawn from rows that exist. There is no
-- projection, no score, no probability, and no behaviour model.
--
-- ── a view, not a table, and that is the honesty ─────────────────────────
--
-- A table would be a snapshot, and a snapshot goes stale. The moment a payment
-- is captured, a stored "total received" is wrong until something recomputes
-- it — and for the window in between, the record disagrees with itself while
-- looking authoritative.
--
-- A view cannot be out of date with the rows it reads. It is also free to
-- change: no data migration, no backfill, and no risk that a correction leaves
-- historical rows carrying a number computed by the old definition.
--
-- ── recorded fact versus derived number ──────────────────────────────────
--
-- Every column below is one of two things, and the distinction is kept
-- explicit because §9 of the mandate turns on it:
--
--   RECORDED  a count or sum of rows that exist. `payments_received_minor` is
--             money that actually arrived; a reader can go and find those rows.
--
--   DERIVED   simple arithmetic over recorded values, shown only where the
--             arithmetic is checkable. `net_received_minor` is captured minus
--             refunded — not a judgement, and reproducible by hand.
--
-- Nothing here is *inferred*. There is no third category, and adding one
-- should be a decision rather than a column.
--
-- ── why refunds are subtracted rather than ignored ───────────────────────
--
-- Captured payments alone overstate what the agency kept. Presenting that as
-- "received" would be a number that is technically sourced and practically
-- misleading, which is the failure mode this whole gap is about. Both figures
-- are exposed so the subtraction is visible rather than assumed.
--
-- ── security_invoker, and why it is not optional ─────────────────────────
--
-- This is the first view in the schema. A Postgres view runs with its
-- **owner's** rights by default, so without `security_invoker = true` it would
-- read every organization's rows and hand them to any caller — RLS on the
-- underlying tables would not apply, because the view, not the caller, is
-- doing the reading.
--
-- That is a tenant-isolation hole that looks like a reporting convenience.
-- It is set below and proved by a live check.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace view crm.client_relationship_facts
with (security_invoker = true) as
select
  ca.organization_id,
  ca.id                                as client_account_id,
  ca.name                              as client_name,

  -- ── RECORDED ──────────────────────────────────────────────────────────
  coalesce(pay.captured_minor, 0)      as payments_received_minor,
  coalesce(ref.refunded_minor, 0)      as payments_refunded_minor,

  -- ── DERIVED: captured minus refunded, reproducible by hand ────────────
  coalesce(pay.captured_minor, 0)
    - coalesce(ref.refunded_minor, 0)  as net_received_minor,

  -- ── RECORDED ──────────────────────────────────────────────────────────
  coalesce(proj.total, 0)              as projects_total,
  coalesce(proj.completed, 0)          as projects_completed,
  coalesce(maint.open_items, 0)        as maintenance_items_open,

  -- The span of the relationship as the record knows it. Both are recorded
  -- moments; neither is an estimate of anything.
  proj.first_project_at,
  proj.last_project_at

from core.client_accounts ca

left join lateral (
  -- Only `captured`. `created`, `authorized` and `failed` are not money that
  -- arrived, and counting them would be the overstatement this view exists to
  -- avoid.
  select sum(p.amount_minor) as captured_minor
    from finance.payments p
    join finance.invoices i on i.id = p.invoice_id
   where i.client_account_id = ca.id
     and p.status = 'captured'
) pay on true

left join lateral (
  -- Only `recorded`. A refund that was requested or refused did not move money.
  select sum(r.amount_minor) as refunded_minor
    from finance.refunds r
    join finance.invoices i on i.id = r.invoice_id
   where i.client_account_id = ca.id
     and r.status = 'recorded'
) ref on true

left join lateral (
  select count(*)                                    as total,
         count(*) filter (where p.status = 'completed') as completed,
         min(p.created_at)                           as first_project_at,
         max(p.created_at)                           as last_project_at
    from projects.projects p
   where p.client_account_id = ca.id
     and p.deleted_at is null
) proj on true

left join lateral (
  select count(*) as open_items
    from projects.maintenance_items m
   where m.client_account_id = ca.id
     and m.status in ('open', 'in_progress')
) maint on true

-- ── internal only, and this line is not decoration ───────────────────────
--
-- `security_invoker` makes the view read as the caller, which stops it
-- crossing tenants. It does **not** make it internal: a client can read their
-- own `core.client_accounts` row, so without this predicate the view handed
-- them an internal analytics summary of themselves — payments totalled,
-- projects counted — that nobody decided to show them.
--
-- Found by the live client-portal check rather than by reading this file,
-- which is the difference between a policy that is written and one that is
-- exercised. A view cannot carry an RLS policy, so the filter lives here.
where (select core.is_internal());

comment on view crm.client_relationship_facts is
  'What the record already says about a client, added up (G-037). NOT a lifetime-value model and deliberately not named one: nothing in AgencyOS defines lifetime value, and calling a sum of past payments by that name would smuggle in a forecast, since the term means EXPECTED value and expecting anything requires retention assumptions nobody has made. Every column is a count, a sum or a date drawn from rows that exist; net_received_minor is the only derived column and is captured minus refunded, reproducible by hand. A VIEW rather than a table because a stored total goes stale the moment a payment is captured, and for the window in between the record disagrees with itself while looking authoritative. security_invoker = true is load-bearing: without it the view would read every organization rows regardless of the caller RLS.';

comment on column crm.client_relationship_facts.payments_received_minor is
  'RECORDED. Sum of finance.payments with status captured, for invoices belonging to this client. Money that actually arrived - created, authorized and failed are excluded because they are not.';

comment on column crm.client_relationship_facts.net_received_minor is
  'DERIVED. payments_received_minor minus payments_refunded_minor. Both inputs are exposed so the subtraction is visible rather than assumed - captured alone overstates what the agency kept, which is a number that is technically sourced and practically misleading.';
