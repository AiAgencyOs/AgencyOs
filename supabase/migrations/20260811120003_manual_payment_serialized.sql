-- ═══════════════════════════════════════════════════════════════════════════
-- Manual payments are serialised on the invoice they pay.
--
-- Audit finding D1. recordManualPayment refused an overpayment by reading the
-- captured total, adding the new amount and comparing against the invoice
-- total — a check and an insert in two statements, with finance.payments
-- carrying no constraint tying the sum of its rows to the invoice. Two
-- operators recording a receipt at the same moment both read the same total,
-- both passed the check, and both inserts landed.
--
-- What made that worse than a permissive write: finance.invoices *does* carry
-- the ceiling (invoices_paid_not_over_total), so the reconcile that follows
-- tried to store a sum the constraint forbids and failed — and failed again on
-- every retry, because the sum never changes. The invoice was left holding
-- money it could not show: paid_minor stale, status never 'paid', and
-- `invoice.paid` never emitted, so the milestone it gates never unlocked.
--
-- The rule is unchanged and is not restated here as a new one. ARCHITECTURE.md
-- §5.4 already says where it belongs: money-moving operations are "enforced by
-- unique constraints … rather than application checks — the database is the
-- only reliable arbiter under concurrency". crm/schema.ts is equally clear on
-- what the answer is: "Overpayment is refused rather than clamped. Money
-- arriving that nobody expected is a conversation with the client, not a
-- rounding decision." This makes that refusal true when two callers race, and
-- changes nothing else.
--
-- The lock is on the invoice row, taken before the sum is read. That ordering
-- is the whole mechanism: the second caller waits, and the sum it then reads
-- already includes the first caller's committed payment, so it refuses. A
-- single INSERT … SELECT with the sum in its WHERE would not do this — both
-- statements would evaluate the subquery against a snapshot taken before
-- either committed. Same shape as the seq lock in crm.ingest_whatsapp_message
-- and the version lock in crm.allocate_requirement_version.
--
-- SECURITY INVOKER, deliberately. This runs for a signed-in owner or ops_admin
-- and every table it touches already has the right policy —
-- payments_manual_insert admits provider 'manual' for those two roles,
-- payments_select lets them read the ledger, invoices_write lets them lock the
-- row. Running it as definer would mean re-deciding tenancy here, which the
-- policies already answer. No new privilege is created by this function.
--
-- No schema change: no table, column, index or constraint is added, altered or
-- dropped. finance.payments and finance.invoices are exactly as they were.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function finance.record_manual_payment(
  p_invoice_id          uuid,
  p_provider_payment_id text,
  p_amount_minor        bigint,
  p_captured_at         timestamptz
)
returns table (
  -- 'recorded' | 'not_found' | 'not_payable' | 'non_positive' | 'overpayment'
  -- | 'duplicate'. The caller turns these into the same Result errors it
  -- always returned; the wording lives in the application, as it does for
  -- crm.ingest_whatsapp_message.
  outcome               text,
  payment_id            uuid,
  -- The captured sum *before* this payment, read under the lock. The caller
  -- audits it as the "before" state, so a concurrent receipt cannot make that
  -- record wrong.
  captured_before_minor bigint,
  invoice_status        text
)
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_org      uuid;
  v_status   text;
  v_total    bigint;
  v_currency char(3);
  v_captured bigint;
  v_payment  uuid;
begin
  -- ── 1. take the lock, and read the invoice through it ────────────────────
  --
  -- Everything below is decided from this row. Reading it FOR UPDATE is what
  -- makes two concurrent receipts against one invoice queue rather than
  -- interleave.
  select i.organization_id, i.status, i.total_minor, i.currency
    into v_org, v_status, v_total, v_currency
    from finance.invoices i
   where i.id = p_invoice_id
     for update;

  if not found then
    return query select 'not_found'::text, null::uuid, null::bigint, null::text;
    return;
  end if;

  -- ── 2. the same refusals the application already made ────────────────────
  --
  -- Restated here because a check that ran before the lock is a check that
  -- could have been true when it ran and false by the time it mattered. The
  -- statuses are finance/schema.ts PAYABLE_INVOICE_STATUSES.
  if v_status not in ('issued', 'partially_paid', 'overdue') then
    return query select 'not_payable'::text, null::uuid, null::bigint, v_status;
    return;
  end if;

  if p_amount_minor is null or p_amount_minor <= 0 then
    return query select 'non_positive'::text, null::uuid, null::bigint, v_status;
    return;
  end if;

  -- ── 3. the ledger, read inside the lock ──────────────────────────────────
  --
  -- The payment rows are the ledger; invoices.paid_minor is a cached sum of
  -- them. Summing here rather than trusting the cache means a stale or
  -- un-reconciled paid_minor cannot let a payment through.
  select coalesce(sum(p.amount_minor), 0)
    into v_captured
    from finance.payments p
   where p.invoice_id = p_invoice_id
     and p.status = 'captured';

  if v_captured + p_amount_minor > v_total then
    return query select 'overpayment'::text, null::uuid, v_captured, v_status;
    return;
  end if;

  -- ── 4. the write ─────────────────────────────────────────────────────────
  --
  -- organization_id and currency come from the locked invoice rather than from
  -- the caller: the same reason app/api/jobs/run takes organization_id from
  -- the job and never from input.
  begin
    insert into finance.payments (
      organization_id, invoice_id, provider, provider_payment_id,
      amount_minor, currency, status, captured_at
    )
    values (
      v_org, p_invoice_id, 'manual', p_provider_payment_id,
      p_amount_minor, v_currency, 'captured', p_captured_at
    )
    returning id into v_payment;
  exception
    when unique_violation then
      -- The same bank reference against the same invoice, already recorded.
      -- unique (provider, provider_payment_id) is the guard; this reports it
      -- as an outcome rather than an error so the caller keeps its wording.
      return query select 'duplicate'::text, null::uuid, v_captured, v_status;
      return;
  end;

  return query select 'recorded'::text, v_payment, v_captured, v_status;
end;
$$;

comment on function finance.record_manual_payment(uuid, text, bigint, timestamptz) is
  'Records one manual payment against an invoice, serialised on that invoice. Locks the invoice row before summing captured payments, so two concurrent receipts cannot both pass the overpayment check. Refuses rather than clamps; writes nothing on refusal.';

-- Signed-in staff only, and only through the policies that already govern
-- these tables. anon has no business here.
revoke all on function finance.record_manual_payment(uuid, text, bigint, timestamptz)
  from public, anon;
grant execute on function finance.record_manual_payment(uuid, text, bigint, timestamptz)
  to authenticated, service_role;
