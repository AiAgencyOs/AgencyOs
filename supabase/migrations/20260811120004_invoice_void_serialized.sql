-- ═══════════════════════════════════════════════════════════════════════════
-- Voiding an invoice is serialised on the invoice being voided.
--
-- Audit finding D2. voidInvoice read the invoice, refused if `paid_minor` was
-- above zero, and then issued an UPDATE whose only predicate was the invoice's
-- id. Two statements with a gap, and nothing in the gap held still: a payment
-- committing between them was never seen by the check and was not excluded by
-- the write.
--
-- Two orderings, both wrong, and both reachable today:
--
--     void reads paid_minor = 0
--     payment lands and commits
--     void writes status = 'void'
--       → a voided invoice holding money nobody can see
--
--     void reads paid_minor = 0
--     payment lands, and reconcileInvoiceTotals writes status = 'paid'
--     void writes status = 'void' over it
--       → the milestone's live-invoice slot is freed by
--         invoices_milestone_live_key, so the same milestone can be billed a
--         second time for money the client has already paid
--
-- D1's lock makes the second one *worse* rather than better. An UPDATE that
-- arrives while finance.record_manual_payment holds the row waits for it, and
-- READ COMMITTED then re-evaluates a WHERE clause that says only `id = :id` —
-- so it still matches, and the void lands having queued behind the very
-- payment it failed to notice. A lock only protects a writer that re-checks
-- its precondition after acquiring it. voidInvoice never acquired one.
--
-- The rule is not new and is not restated here as new. finance/service.ts has
-- always said it: "An invoice with money against it cannot be voided. That is
-- a refund, which moves real money and needs the mechanism this codebase does
-- not have yet." ARCHITECTURE.md §5.4 says where a rule like that has to live
-- — "the database is the only reliable arbiter under concurrency". This makes
-- the refusal true when two writers race, and changes nothing else.
--
-- The lock is on the invoice row, taken before the ledger is read, and the
-- write happens inside the same statement. That ordering is the mechanism, and
-- it is the same one in finance.record_manual_payment, in the seq lock in
-- crm.ingest_whatsapp_message, and in the version lock in
-- crm.insert_requirement_version.
--
-- The ledger is summed rather than trusted. `invoices.paid_minor` is a cached
-- sum of finance.payments, and a cache that failed to update is exactly the
-- state D3 can leave behind — an invoice showing zero while captured rows say
-- otherwise. A guard on the cache would void that invoice. A guard on the rows
-- refuses it.
--
-- SECURITY INVOKER, deliberately, and written out rather than left to the
-- default. This runs for a signed-in owner or ops_admin and every table it
-- touches already has the right policy — invoices_write lets those two roles
-- lock and update the row, payments_select lets them read the ledger. Running
-- it as definer would mean re-deciding tenancy here, which the policies
-- already answer. No new privilege is created by this function.
--
-- No schema change: no table, column, index or constraint is added, altered or
-- dropped. finance.invoices and finance.payments are exactly as they were.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function finance.void_invoice(
  p_invoice_id uuid,
  p_note       text
)
returns table (
  -- 'voided' | 'not_found' | 'already_void' | 'not_voidable' | 'has_payments'.
  -- The caller turns these into the same Result answers it always returned;
  -- the wording lives in the application, as it does for
  -- finance.record_manual_payment.
  outcome        text,
  -- The status read *under the lock*. The caller audits it as the "before"
  -- state, so a concurrent write cannot make that record wrong, and quotes it
  -- back in the refusal so the operator is told what the invoice actually is.
  invoice_status text,
  -- The captured sum, read under the same lock. Zero on the path that voids —
  -- which is the whole point.
  captured_minor bigint
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_status   text;
  v_notes    text;
  v_captured bigint;
begin
  -- ── 1. take the lock, and read the invoice through it ────────────────────
  --
  -- Everything below is decided from this row, including the notes the void
  -- appends to. Reading them here rather than trusting the caller's earlier
  -- copy is what stops a concurrent note from being silently dropped.
  select i.status, i.notes
    into v_status, v_notes
    from finance.invoices i
   where i.id = p_invoice_id
     for update;

  if not found then
    return query select 'not_found'::text, null::text, null::bigint;
    return;
  end if;

  -- ── 2. the same refusals the application already made ────────────────────
  --
  -- Restated here because a check that ran before the lock is a check that
  -- could have been true when it ran and false by the time it mattered.
  --
  -- Voiding an invoice that is already void is the answer, not an error: the
  -- caller asked for a state the invoice is already in.
  if v_status = 'void' then
    return query select 'already_void'::text, v_status, null::bigint;
    return;
  end if;

  -- The statuses whose INVOICE_TRANSITIONS include 'void' (finance/schema.ts).
  -- Only 'paid' is missing from this list, and deliberately: money that came
  -- back is a refund, not a status flip.
  if v_status not in ('draft', 'pending_approval', 'issued', 'partially_paid', 'overdue') then
    return query select 'not_voidable'::text, v_status, null::bigint;
    return;
  end if;

  -- ── 3. the ledger, read inside the lock ──────────────────────────────────
  --
  -- The payment rows are the ledger; invoices.paid_minor is a cached sum of
  -- them. Summing here rather than trusting the cache means a stale or
  -- un-reconciled paid_minor cannot let a void through.
  select coalesce(sum(p.amount_minor), 0)
    into v_captured
    from finance.payments p
   where p.invoice_id = p_invoice_id
     and p.status = 'captured';

  if v_captured > 0 then
    return query select 'has_payments'::text, v_status, v_captured;
    return;
  end if;

  -- ── 4. the write ─────────────────────────────────────────────────────────
  --
  -- Same transaction, same lock. The reason is appended to the notes read
  -- above; concat_ws drops a null or empty existing note rather than leaving a
  -- leading blank line.
  update finance.invoices
     set status = 'void',
         notes  = concat_ws(chr(10), nullif(v_notes, ''), p_note)
   where id = p_invoice_id;

  return query select 'voided'::text, v_status, 0::bigint;
end;
$$;

comment on function finance.void_invoice(uuid, text) is
  'Withdraws one invoice, serialised on that invoice. Locks the invoice row before summing captured payments, so a payment landing mid-void cannot be voided over. Refuses rather than voids when money is present; writes nothing on refusal.';

-- Signed-in staff only, and only through the policies that already govern
-- these tables. anon has no business here.
revoke all on function finance.void_invoice(uuid, text)
  from public, anon;
grant execute on function finance.void_invoice(uuid, text)
  to authenticated, service_role;
