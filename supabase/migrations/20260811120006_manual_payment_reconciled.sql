-- ═══════════════════════════════════════════════════════════════════════════
-- A payment and the total it changes are written together.
--
-- Gap G-008, and the last unserialised writer of finance.invoices.status.
--
-- D1 made the payment itself safe: finance.record_manual_payment locks the
-- invoice, sums the ledger through that lock, and refuses rather than clamps.
-- But the cache the ledger backs was still updated afterwards, from
-- TypeScript, in a separate request — reconcileInvoiceTotals read the ledger
-- again, derived paid_minor and status, and wrote them with the invoice id as
-- its only predicate. The lock was released by then.
--
-- What that leaves open, with D1 in place:
--
--     two receipts on one invoice, both legal
--     both RPCs serialise correctly and both payments land
--     reconcile A reads the ledger before B's payment commits
--     reconcile B writes the full total
--     reconcile A writes its lower total over it
--       → paid_minor below the ledger, status 'partially_paid' on an invoice
--         that is fully paid, and `invoice.paid` already emitted
--
-- And worse than the stale number: when that second statement failed at all,
-- the payment had already committed and there was no way back through the
-- application. Re-recording the same reference is a duplicate; recording
-- anything else is an overpayment against a ledger that is correctly full.
-- The runbook has carried that as a known unrecoverable state since D3.
--
-- Both disappear if the cache is written where the ledger is: inside the same
-- statement, under the same lock, in the same transaction as the insert. Then
-- paid_minor cannot disagree with the rows it summarises, because nothing can
-- observe them apart.
--
-- The derivation is unchanged and is not re-decided here. finance/schema.ts
-- has always said what the statuses mean — fully covered is 'paid', partly
-- covered is 'partially_paid', and nothing captured leaves the status alone
-- so that an overdue invoice with no payments is still overdue. This restates
-- that in SQL because the write has moved, not because the rule has.
--
-- paid_at is set only on the transition into 'paid', and never cleared: the
-- table's own invoices_paid_at_set constraint makes the same point, that
-- "paid" is a moment rather than a flag.
--
-- SECURITY INVOKER, unchanged, and no new privilege: invoices_write already
-- admits the UPDATE for the two roles that reach this, and it is the same
-- policy that admits the lock D1 takes.
--
-- No schema change: no table, column, index or constraint is added, altered
-- or dropped.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists finance.record_manual_payment(uuid, text, bigint, timestamptz);

create or replace function finance.record_manual_payment(
  p_invoice_id          uuid,
  p_provider_payment_id text,
  p_amount_minor        bigint,
  p_captured_at         timestamptz
)
returns table (
  -- 'recorded' | 'not_found' | 'not_payable' | 'non_positive' | 'overpayment'
  -- | 'duplicate'. Unchanged from D1; the caller's wording is unchanged too.
  outcome               text,
  payment_id            uuid,
  -- The captured sum *before* this payment, read under the lock.
  captured_before_minor bigint,
  -- The invoice's status before this payment, read under the same lock.
  invoice_status        text,
  -- What the invoice now holds, written in this same statement. The caller
  -- reports these rather than reading them back, because a second read could
  -- only be taken after the lock was released — which is the defect.
  paid_after_minor      bigint,
  status_after          text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org       uuid;
  v_status    text;
  v_total     bigint;
  v_currency  char(3);
  v_captured  bigint;
  v_payment   uuid;
  v_after     bigint;
  v_new       text;
begin
  -- ── 1. take the lock, and read the invoice through it ────────────────────
  select i.organization_id, i.status, i.total_minor, i.currency
    into v_org, v_status, v_total, v_currency
    from finance.invoices i
   where i.id = p_invoice_id
     for update;

  if not found then
    return query select 'not_found'::text, null::uuid, null::bigint, null::text,
                        null::bigint, null::text;
    return;
  end if;

  -- ── 2. the same refusals the application already made ────────────────────
  --
  -- The statuses are finance/schema.ts PAYABLE_INVOICE_STATUSES.
  if v_status not in ('issued', 'partially_paid', 'overdue') then
    return query select 'not_payable'::text, null::uuid, null::bigint, v_status,
                        null::bigint, null::text;
    return;
  end if;

  if p_amount_minor is null or p_amount_minor <= 0 then
    return query select 'non_positive'::text, null::uuid, null::bigint, v_status,
                        null::bigint, null::text;
    return;
  end if;

  -- ── 3. the ledger, read inside the lock ──────────────────────────────────
  select coalesce(sum(p.amount_minor), 0)
    into v_captured
    from finance.payments p
   where p.invoice_id = p_invoice_id
     and p.status = 'captured';

  if v_captured + p_amount_minor > v_total then
    return query select 'overpayment'::text, null::uuid, v_captured, v_status,
                        null::bigint, null::text;
    return;
  end if;

  -- ── 4. the write ─────────────────────────────────────────────────────────
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
      return query select 'duplicate'::text, null::uuid, v_captured, v_status,
                          null::bigint, null::text;
      return;
  end;

  -- ── 5. and the total it changes, in the same breath ──────────────────────
  --
  -- Derived from the sum that was read under this lock plus the amount just
  -- inserted, rather than by re-reading: the row is locked, so nothing can
  -- have changed it, and re-reading would only invite the question of what to
  -- do if the second read disagreed with the first.
  v_after := v_captured + p_amount_minor;

  v_new := case
             when v_after >= v_total then 'paid'
             when v_after > 0        then 'partially_paid'
             else v_status
           end;

  update finance.invoices
     set paid_minor = v_after,
         status     = v_new,
         paid_at    = case when v_new = 'paid' then coalesce(paid_at, p_captured_at)
                           else paid_at end
   where id = p_invoice_id;

  return query select 'recorded'::text, v_payment, v_captured, v_status, v_after, v_new;
end;
$$;

comment on function finance.record_manual_payment(uuid, text, bigint, timestamptz) is
  'Records one manual payment against an invoice and updates the invoice total in the same statement, serialised on that invoice. Locks the invoice before summing captured payments, so two concurrent receipts cannot both pass the overpayment check and cannot leave paid_minor disagreeing with the ledger. Refuses rather than clamps; writes nothing on refusal.';

revoke all on function finance.record_manual_payment(uuid, text, bigint, timestamptz)
  from public, anon;
grant execute on function finance.record_manual_payment(uuid, text, bigint, timestamptz)
  to authenticated, service_role;
