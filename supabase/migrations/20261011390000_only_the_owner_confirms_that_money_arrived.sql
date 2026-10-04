-- Only the owner confirms that money arrived.
--
-- Owner decision 2026-10-04 (separation of duties): the ops admin issues invoices,
-- records what a client says they paid and prepares the evidence; confirming the
-- payment - the act that opens the finance gate and so the project - is the
-- owner's. Enforced where it cannot be bypassed: `finance.verify_payment` and
-- `finance.verify_payment_submission` are carried forward from their live bodies
-- with one guard each, refusing a signed-in caller who is not the owner. The
-- runner (no signed-in user) is unchanged. The application gates its buttons on
-- the new `payment.verify` capability, which only the owner holds.

CREATE OR REPLACE FUNCTION finance.verify_payment(p_payment_id uuid, p_verified_by uuid)
 RETURNS TABLE(outcome text, invoice_id uuid, verified_after_minor bigint, status_after text, unlocked_milestone_id uuid, receipt_id uuid, receipt_number text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  v_receipt_id     uuid;
  v_receipt_number text;
  v_attempt        int;
begin
  -- Declare the sanctioned-write capability finance.payments_update_is_
  -- sanctioned() and finance.invoices_write_is_sanctioned() check
  -- (20260815290000/300000). Transaction-scoped; a direct Data-API write
  -- cannot set it. MISSING FROM THIS MIGRATION'S FIRST DRAFT — caught by
  -- verifying against a real scratch Postgres before this ever reached
  -- production: the true live verify_payment (20260815290000, not
  -- 20260815180000 — a later migration silently carried it forward with an
  -- UPPERCASE `CREATE OR REPLACE` that an earlier lowercase-only grep missed)
  -- already had this line, and dropping it would have broken every
  -- authenticated (non-service-role) payment verification in production.
  -- [Owner decision 2026-10-04] Confirming that money arrived is the OWNER's alone:
  -- the person who issues an invoice and records what the client said they paid
  -- must not also be the one who opens the finance gate. A signed-in caller who
  -- is not the owner is refused here, in the database, whatever a screen offers;
  -- the runner (no signed-in user) is unchanged.
  if (select auth.uid()) is not null and not coalesce((select core.is_owner()), false) then
    return query select 'forbidden'::text, null::uuid, null::bigint, null::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  perform set_config('finance.sanctioned_write', 'on', true);

  -- ── 1. the payment, and the invoice it belongs to ───────────────────────
  select p.invoice_id, p.status, p.verified_at, p.amount_minor
    into v_invoice, v_pay_status, v_verified, v_amount
    from finance.payments p
   where p.id = p_payment_id;

  if not found then
    return query select 'not_found'::text, null::uuid, null::bigint, null::text, null::uuid, null::uuid, null::text;
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
    return query select 'not_found'::text, null::uuid, null::bigint, null::text, null::uuid, null::uuid, null::text;
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
    select r.id, r.number into v_receipt_id, v_receipt_number
      from finance.receipts r where r.payment_id = p_payment_id;
    return query select 'already_verified'::text, v_invoice,
                        finance.net_verified_minor(v_invoice), v_status, null::uuid,
                        v_receipt_id, v_receipt_number;
    return;
  end if;

  -- Money that failed or was never captured is not money to confirm.
  if v_pay_status <> 'captured' then
    return query select 'not_captured'::text, v_invoice,
                        finance.net_verified_minor(v_invoice), v_status, null::uuid,
                        null::uuid, null::text;
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
    select r.id, r.number into v_receipt_id, v_receipt_number
      from finance.receipts r where r.payment_id = p_payment_id;
    return query select 'already_verified'::text, v_invoice,
                        finance.net_verified_minor(v_invoice), v_status, null::uuid,
                        v_receipt_id, v_receipt_number;
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

  -- [Finance Agent spec §14 addition] The receipt, under the same lock,
  -- retrying on a reference collision the same way approvals.request_approval
  -- already retries its own reference — this table's own unique constraint is
  -- the actual guarantee, this loop is just not failing the whole
  -- verification over a one-in-a-billion collision.
  for v_attempt in 1..5 loop
    v_receipt_number := finance.new_receipt_reference();
    begin
      insert into finance.receipts (organization_id, invoice_id, payment_id, number, amount_minor, currency)
      values (v_org, v_invoice, p_payment_id, v_receipt_number, v_amount, v_currency)
      returning id into v_receipt_id;
      exit;
    exception
      when unique_violation then
        v_receipt_id := null;
        continue;
    end;
  end loop;

  -- ── 5. the history, in the same transaction (G-079) ─────────────────────
  perform core.record_audit(
    v_org, 'payment.verified', 'invoice', v_invoice,
    jsonb_build_object('verifiedMinor', v_before, 'status', v_status),
    jsonb_build_object(
      'verifiedMinor', v_after,
      'status',        v_new,
      'amountMinor',   v_amount,
      'paymentId',     p_payment_id,
      'verifiedBy',    p_verified_by,
      'receiptId',     v_receipt_id,
      'receiptNumber', v_receipt_number
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

  return query select 'verified'::text, v_invoice, v_after, v_new, v_unlocked, v_receipt_id, v_receipt_number;
end;
$function$;

CREATE OR REPLACE FUNCTION finance.verify_payment_submission(p_submission_id uuid, p_verified_by uuid, p_evidence text, p_approve boolean DEFAULT true, p_reason text DEFAULT NULL::text, p_decision text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, status text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_row finance.payment_submissions;
  v_decision text := coalesce(
    nullif(btrim(coalesce(p_decision, '')), ''),
    case when p_approve then 'confirm' else 'reject' end
  );
begin
  if v_decision not in ('confirm', 'reject', 'mismatch') then
    return query select 'unknown_decision'::text, null::text;
    return;
  end if;

  -- [Owner decision 2026-10-04] Checking a claim against the bank is the owner's alone.
  if (select auth.uid()) is not null and not coalesce((select core.is_owner()), false) then
    return query select 'forbidden'::text, null::text;
    return;
  end if;

  select s.* into v_row
    from finance.payment_submissions s
   where s.id = p_submission_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- Mismatch and evidence_requested are not settled: "requires resolution".
  if v_row.status not in ('pending_verification', 'mismatch', 'evidence_requested') then
    return query select 'settled'::text, v_row.status;
    return;
  end if;

  if p_verified_by is null then
    return query select 'no_verifier'::text, v_row.status;
    return;
  end if;

  if v_decision = 'confirm' then
    if p_evidence is null or length(trim(p_evidence)) = 0 then
      return query select 'no_evidence'::text, v_row.status;
      return;
    end if;

    update finance.payment_submissions
       set status = 'verified',
           verified_by = p_verified_by,
           verified_at = now(),
           verification_evidence = p_evidence,
           updated_at = now()
     where id = p_submission_id;

    return query select 'verified'::text, 'verified'::text;
    return;
  end if;

  if v_decision = 'mismatch' then
    if p_reason is null or length(trim(p_reason)) = 0 then
      return query select 'no_note'::text, v_row.status;
      return;
    end if;

    update finance.payment_submissions
       set status = 'mismatch',
           mismatch_note = p_reason,
           updated_at = now()
     where id = p_submission_id;

    return query select 'mismatch'::text, 'mismatch'::text;
    return;
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    return query select 'no_reason'::text, v_row.status;
    return;
  end if;

  update finance.payment_submissions
     set status = 'rejected',
         verified_by = p_verified_by,
         verified_at = now(),
         rejected_reason = p_reason,
         updated_at = now()
   where id = p_submission_id;

  return query select 'rejected'::text, 'rejected'::text;
end;
$function$;
