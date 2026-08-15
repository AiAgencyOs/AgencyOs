-- ═══════════════════════════════════════════════════════════════════════════
-- Confirming a payment is idempotent under the lock — the double-verify race.
--
-- `finance.verify_payment` (20260813120015) is where an invoice becomes `paid`
-- and where `invoice.paid` — the event that opens the next milestone (G-007) —
-- is published. It decides under the invoice row lock, and that lock is what
-- makes two confirmations of the same invoice serialize. But the lock was doing
-- less than it looked:
--
--   1. the payment's `verified_at` was read at the TOP of the function, BEFORE
--      the invoice lock was taken (step 1), and the "already verified? then
--      answer, do not re-do" guard tested that PRE-LOCK snapshot;
--   2. the write set `verified_at = now()` UNCONDITIONALLY (no `where
--      verified_at is null`);
--   3. the new confirmed total was a DELTA — `v_before + v_amount` — which is
--      only right if this payment was not already in `v_before`.
--
-- Two confirmations of the SAME captured payment, dispatched close enough that
-- both run step 1 before either commits (a double-click, a retry, two admins on
-- one bank statement), then serialize on the invoice lock. The second carries a
-- stale `verified_at = null`, so it passes the guard; `v_before` is now re-read
-- as the CURRENT confirmed total, which already includes the payment the first
-- caller just verified; and `v_before + v_amount` adds that same payment's money
-- a SECOND time. Depending on `paid_minor`, the invoice either flips to `paid`
-- on money that was never confirmed — opening the next milestone against it,
-- exactly the invariant G-007 exists to protect — or overshoots the
-- `verified_minor <= paid_minor` check and RAISES, turning the "verifying twice
-- is answered, not an error" contract into an INTERNAL error for the operator.
--
-- The lock was never the bug; the check-then-act across it was. The write is
-- now the guard: `verified_at` is set only WHERE it is still null, and a zero
-- row-count IS the "already confirmed" answer — race-safe, because the invoice
-- lock serialises the two writers and the second one sees the first's committed
-- row. And the confirmed total is a full re-sum over the verified rows, which
-- counts each payment exactly once, rather than a delta that can add one twice.
-- This mirrors the sibling writers: `record_refund` already guards with a
-- conditional `... where status = 'requested'`, and `record_manual_payment`
-- with a unique key. `verify_payment` was the one money mutator flipping an
-- existing row through an unguarded delta.
--
-- Behaviour is otherwise identical: same signature, same outcomes, same audit
-- and event. `create or replace`, no schema change.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function finance.verify_payment(
  p_payment_id  uuid,
  p_verified_by uuid
)
returns table (
  -- 'verified' | 'not_found' | 'already_verified' | 'not_captured'
  outcome               text,
  invoice_id            uuid,
  -- Confirmed money after this verification, computed under the lock.
  verified_after_minor  bigint,
  status_after          text,
  -- The milestone this verification opened, derived and published inside this
  -- transaction. Null unless the invoice became covered.
  unlocked_milestone_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_invoice   uuid;
  v_org       uuid;
  v_status    text;
  v_total     bigint;
  v_currency  char(3);
  v_number    text;
  v_client    uuid;
  v_project   uuid;
  v_milestone uuid;
  v_pay_status text;
  v_verified  timestamptz;
  v_amount    bigint;
  v_before    bigint;
  v_after     bigint;
  v_new       text;
  v_unlocked  uuid;
  v_rows      int;
begin
  -- ── 1. the payment, and the invoice it belongs to ───────────────────────
  select p.invoice_id, p.status, p.verified_at, p.amount_minor
    into v_invoice, v_pay_status, v_verified, v_amount
    from finance.payments p
   where p.id = p_payment_id;

  if not found then
    return query select 'not_found'::text, null::uuid, null::bigint, null::text, null::uuid;
    return;
  end if;

  -- ── 2. the lock, and the invoice read through it ────────────────────────
  select i.organization_id, i.status, i.total_minor, i.currency,
         i.number, i.client_account_id, i.project_id, i.milestone_id
    into v_org, v_status, v_total, v_currency, v_number, v_client, v_project, v_milestone
    from finance.invoices i
   where i.id = v_invoice
     for update;

  if not found then
    return query select 'not_found'::text, null::uuid, null::bigint, null::text, null::uuid;
    return;
  end if;

  -- ── 3. the refusals, restated under the lock ────────────────────────────
  --
  -- Confirming a payment twice is the answer, not an error — two people
  -- reading the same bank statement should not fight. This is the fast path
  -- for a payment already verified when we first read it; the race-safe guard
  -- is the conditional write in step 4, because THIS read was taken before the
  -- lock and a concurrent confirmation could have landed since.
  if v_verified is not null then
    return query select 'already_verified'::text, v_invoice,
                        finance.net_verified_minor(v_invoice), v_status, null::uuid;
    return;
  end if;

  -- Money that failed or was never captured is not money to confirm.
  if v_pay_status <> 'captured' then
    return query select 'not_captured'::text, v_invoice,
                        finance.net_verified_minor(v_invoice), v_status, null::uuid;
    return;
  end if;

  -- ── 4. the confirmation, idempotent under the lock ──────────────────────
  --
  -- The write is the guard. `verified_at` is set only WHERE it is still null,
  -- so a payment a concurrent caller confirmed between step 1's pre-lock read
  -- and this line updates zero rows — and that zero IS the already-verified
  -- answer, written once, with no second history entry and no second unlock.
  v_before := finance.net_verified_minor(v_invoice);

  update finance.payments
     set verified_at = now(),
         verified_by = p_verified_by,
         updated_at  = now()
   where id = p_payment_id
     and verified_at is null;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return query select 'already_verified'::text, v_invoice,
                        finance.net_verified_minor(v_invoice), v_status, null::uuid;
    return;
  end if;

  -- A full re-sum over the verified rows, NOT `v_before + v_amount`. The delta
  -- double-counts a payment a concurrent confirmation already folded into
  -- net_verified_minor; the sum counts each verified payment exactly once.
  -- Floored at zero, and not as a convenience: the refund ceiling is checked
  -- against *received* money (net_received_minor), so refunding more than has
  -- been confirmed is legitimate and makes net_verified_minor negative. A
  -- negative cache would trip invoices_verified_not_over_paid mid-write; zero
  -- is the honest floor, and the refund ledger keeps the arithmetic.
  v_after := greatest(finance.net_verified_minor(v_invoice), 0);

  v_new := case
             when v_after >= v_total then 'paid'
             else v_status
           end;

  update finance.invoices
     set verified_minor = v_after,
         status         = v_new,
         paid_at        = case when v_new = 'paid' then coalesce(paid_at, now()) else paid_at end
   where id = v_invoice;

  -- ── 5. the history, in the same transaction (G-079) ─────────────────────
  perform core.record_audit(
    v_org, 'payment.verified', 'invoice', v_invoice,
    jsonb_build_object('verifiedMinor', v_before, 'status', v_status),
    jsonb_build_object(
      'verifiedMinor', v_after,
      'status',        v_new,
      'amountMinor',   v_amount,
      'paymentId',     p_payment_id,
      'verifiedBy',    p_verified_by
    )
  );

  -- ── 6. and the event that opens the next milestone (D17) ────────────────
  --
  -- Below the write, because next_unlocked_milestone answers "the first priced
  -- milestone with no paid invoice" — which is the milestone being paid for
  -- right now until the UPDATE above is visible.
  if v_new = 'paid' then
    if v_project is not null then
      v_unlocked := finance.next_unlocked_milestone(v_project, v_org);
    end if;

    perform core.emit_event(
      v_org, 'invoice.paid', 'invoice', v_invoice,
      jsonb_build_object(
        'number',              v_number,
        'clientAccountId',     v_client,
        'projectId',           v_project,
        'milestoneId',         v_milestone,
        'unlockedMilestoneId', v_unlocked,
        'paidMinor',           v_after,
        'currency',            v_currency
      )
    );
  end if;

  return query select 'verified'::text, v_invoice, v_after, v_new, v_unlocked;
end;
$$;

comment on function finance.verify_payment(uuid, uuid) is
  'Confirms that recorded money actually arrived (ADM-04, G-007). This is where an invoice becomes paid and where invoice.paid - the event that opens the next milestone - is published, so delivery advances on somebody having checked a bank statement rather than on a client saying they paid. Decides under the invoice row lock. Verifying twice is answered, not raised, and writes no second history: the confirming write is conditional on verified_at still being null, so a concurrent double-confirmation of the same payment cannot double-count it, and the confirmed total is a full re-sum rather than a delta. SECURITY INVOKER: finance RLS still decides who may touch the invoice.';

revoke all on function finance.verify_payment(uuid, uuid) from public, anon;
grant execute on function finance.verify_payment(uuid, uuid) to authenticated, service_role;
