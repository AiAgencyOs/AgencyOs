-- ═══════════════════════════════════════════════════════════════════════════
-- Issuing an invoice is serialised on the invoice being issued.
--
-- Audit finding D4, and the third instance of one defect. issueInvoice read the
-- invoice, decided from that copy whether it could be issued, counted its line
-- items in a separate round trip, and then wrote status = 'issued' with the
-- invoice id as its only predicate. Four statements, three gaps, nothing held
-- still in any of them.
--
-- What lands in those gaps:
--
--     issue reads 'draft'
--     void commits, under its own lock
--     issue writes status = 'issued'
--       → a withdrawn invoice is live again, visible to the client through
--         invoices_select, with D2's own 'Voided: …' line still in its notes,
--         and holding the milestone's live-invoice slot so the corrected
--         replacement cannot be raised
--
--     issue reads 'draft'
--     someone else issues it; the client pays it in full; reconcile writes
--       status = 'paid', paid_at, paid_minor = total
--     issue writes status = 'issued'
--       → a settled invoice presents itself as outstanding, while carrying a
--         paid_at and a full ledger. INVOICE_TRANSITIONS makes 'paid' terminal
--         precisely to stop this, and nothing enforced it.
--
-- That second one has no way back through the application: void refuses an
-- invoice with money against it (D2), a fresh receipt is refused as an
-- overpayment against a ledger that is already full (D1), and nothing but
-- reconcileInvoiceTotals ever writes 'paid'.
--
-- The asymmetry is the whole argument. The reverse orderings are all safe,
-- because void and payment re-decide under a lock and see the issue that
-- landed. Only the unlocked writer loses, and it loses silently.
--
-- The rule is not new: INVOICE_TRANSITIONS has always said which statuses may
-- become 'issued', and ARCHITECTURE.md §5.4 has always said where a rule that
-- two writers can race has to live. This makes the existing rule true under
-- concurrency and changes nothing else.
--
-- Two things move inside the lock besides the decision:
--
--   The line-item check. It was a second round trip whose `error` was never
--   read, so a transient failure came back as `count = undefined`, folded to
--   zero, and told the operator "This invoice has no line items" about an
--   invoice that has them — a read failure presented as a domain fact, which
--   is what D3 was about. Here it is a `for share` probe: it locks every line
--   it reads, so no concurrent write can empty the invoice between the check
--   and the issue. `for share` rather than `for key share` because
--   invoice_items_write is `for all`, so a concurrent UPDATE moving a line to
--   another invoice takes FOR NO KEY UPDATE — which FOR KEY SHARE does not
--   conflict with. And `perform` rather than `select … limit 1`, because a
--   LIMIT under a row lock can lose its one chosen tuple to a concurrent
--   delete and report an empty table that is not empty.
--
--   The moment of issue. `clock_timestamp()`, not `now()`: now() is fixed when
--   the transaction begins, which under contention is before the lock is
--   granted, and issued_at is meant to record when the invoice was issued.
--
-- SECURITY INVOKER, deliberately and explicitly. This runs for a signed-in
-- owner or ops_admin and every table it touches already has the right policy.
-- Note which one admits the item probe: a locking SELECT applies the UPDATE
-- USING clause as well as the SELECT one and needs the UPDATE privilege, so it
-- is invoice_items_write that answers tenancy there, not invoice_items_select
-- — and invoice_items_write names the same two roles `invoice.issue` resolves
-- to. invoices_write covers locking and updating the invoice itself. Running
-- this as definer would mean re-deciding tenancy here, which the policies
-- already answer. No new privilege is created by this function.
--
-- No schema change: no table, column, index or constraint is added, altered or
-- dropped.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function finance.issue_invoice(
  p_invoice_id uuid,
  p_due_at     timestamptz default null
)
returns table (
  -- 'issued' | 'not_found' | 'already_issued' | 'not_issuable' | 'no_amount'
  -- | 'no_items'. The caller turns these into the same Result answers it
  -- always returned; the wording lives in the application, as it does for
  -- finance.record_manual_payment and finance.void_invoice.
  outcome        text,
  -- The status read *under the lock*. The caller audits it as the "before"
  -- state and quotes it back in a refusal, so neither can be made wrong by a
  -- write that landed after the caller's own read.
  invoice_status text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_status text;
  v_total  bigint;
begin
  -- ── 1. take the lock, and read the invoice through it ────────────────────
  select i.status, i.total_minor
    into v_status, v_total
    from finance.invoices i
   where i.id = p_invoice_id
     for update;

  if not found then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- ── 2. the same refusals the application already made ────────────────────
  --
  -- Restated here because a check that ran before the lock is a check that
  -- could have been true when it ran and false by the time it mattered.
  --
  -- Issuing an invoice that is already issued is the answer, not an error, and
  -- it is answered here rather than from the caller's earlier read: an invoice
  -- that was voided a moment ago must not be reported as successfully issued.
  if v_status = 'issued' then
    return query select 'already_issued'::text, v_status;
    return;
  end if;

  -- The statuses whose INVOICE_TRANSITIONS include 'issued' (finance/schema.ts).
  -- 'pending_approval' has no writer in the application yet; it is listed
  -- because the state machine admits it, not because it is reachable today.
  if v_status not in ('draft', 'pending_approval') then
    return query select 'not_issuable'::text, v_status;
    return;
  end if;

  if v_total <= 0 then
    return query select 'no_amount'::text, v_status;
    return;
  end if;

  -- ── 3. the line items, locked as they are read ───────────────────────────
  --
  -- A bill with a total and no lines is not a bill. Locking the rows is what
  -- makes the answer still true at the write below.
  perform 1
     from finance.invoice_items it
    where it.invoice_id = p_invoice_id
      for share;

  if not found then
    return query select 'no_items'::text, v_status;
    return;
  end if;

  -- ── 4. the write ─────────────────────────────────────────────────────────
  --
  -- coalesce leaves an existing due date alone when the caller supplied none,
  -- which is what the optional `dueOn` has always meant.
  update finance.invoices
     set status    = 'issued',
         issued_at = clock_timestamp(),
         due_at    = coalesce(p_due_at, due_at)
   where id = p_invoice_id;

  return query select 'issued'::text, v_status;
end;
$$;

comment on function finance.issue_invoice(uuid, timestamptz) is
  'Issues one invoice, serialised on that invoice. Locks the invoice row before deciding, and locks its line items while it counts them, so neither a void nor a payment landing mid-issue can be written over. Refuses rather than issues; writes nothing on refusal.';

-- Signed-in staff only, and only through the policies that already govern
-- these tables. anon has no business here.
revoke all on function finance.issue_invoice(uuid, timestamptz)
  from public, anon;
grant execute on function finance.issue_invoice(uuid, timestamptz)
  to authenticated, service_role;
