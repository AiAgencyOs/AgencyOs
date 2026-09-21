import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import type { createAdminClient } from '@/lib/db/admin';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';
import { getBillableMilestone } from '@/modules/projects/service';
import { toLadderProgress } from './ladder';

import { billingReadiness, checkGstin, taxRateBpForMode, type BillingReadiness } from './gstin';

import {
  applyPayment,
  generateMilestoneInvoiceSchema,
  invoiceNumberPrefix,
  invoiceTotals,
  issueInvoiceSchema,
  manualPaymentKey,
  milestoneInvoiceability,
  milestoneInvoiceLines,
  nextInvoiceNumber,
  nextUnlockedMilestone,
  parseInvoiceSequence,
  recordManualPaymentSchema,
  recordPaymentSubmissionSchema,
  verifyPaymentSubmissionSchema,
  type RecordPaymentSubmissionInput,
  type VerifyPaymentSubmissionInput,
  voidInvoiceSchema,
  INVOICE_TRANSITIONS,
  type GenerateMilestoneInvoiceInput,
  type InvoiceStatus,
  type IssueInvoiceInput,
  type MilestoneBillingEntry,
  type RecordManualPaymentInput,
  type VoidInvoiceInput,
  recordRefundSchema,
  requestRefundSchema,
  type RecordRefundInput,
  type RequestRefundInput,
  verifyPaymentSchema,
  type VerifyPaymentInput,
  confirmBillingModeSchema,
  recordBillingDetailsSchema,
  type ConfirmBillingModeInput,
  type RecordBillingDetailsInput,
  recordExpenseSchema,
  type RecordExpenseInput,
} from './schema';

/**
 * Writes for the finance module — its only public surface.
 *
 * This module owns the money: turning a delivery milestone into a bill,
 * sending that bill, and recording what came back. It reaches delivery only
 * through projects/service.ts (ARCHITECTURE.md §3.2) and tells the rest of the
 * system what happened by publishing events, never by calling anybody.
 *
 * **No payment provider is contacted from this file.** There is no gateway
 * client to import, no webhook to satisfy, and `recordManualPayment` asserts
 * nothing on a client's behalf — a human enters a reference for money they
 * have seen arrive. When a gateway does land it writes finance.payments under
 * service_role from its own webhook handler, and the only thing that changes
 * here is that `reconcile` gains a second caller.
 *
 * Capabilities are reused rather than invented:
 *   invoice.create — draft an invoice from a milestone
 *   invoice.issue  — send it, record payment against it, void it
 *
 * `invoice.issue` covers payment and voiding because it already resolves to
 * exactly owner + ops_admin, which is also the set the finance RLS policies
 * admit. A new capability mapping to an identical role set would add
 * vocabulary without adding control.
 */

/**
 * How many times to retry when two writers pick the same invoice number.
 *
 * Only the number is retried. Since G-078 the write itself is one statement, so
 * a collision leaves nothing behind to clean up before trying the next one.
 */
const NUMBER_ATTEMPTS = 5;

type InvoiceRef = { invoiceId: string; number: string; created: boolean };

// ── generate ───────────────────────────────────────────────────────────────

/**
 * Creates a DRAFT invoice from a payment milestone.
 *
 * PAYMENT MILESTONE → DRAFT INVOICE. It stops at draft deliberately: drafting
 * is a mechanical consequence of a milestone becoming due, and sending a bill
 * to a client is not. The two are separate calls so that nothing a background
 * job could ever run also emails a client by accident.
 *
 * Idempotent in the way that actually matters. The pre-check below catches the
 * ordinary repeat (a refreshed page, a re-run job); the partial unique index
 * `invoices_milestone_live_key` catches the concurrent one that the pre-check
 * cannot, and `already_invoiced` turns that loss into the same answer the
 * winner got. Calling this ten times in parallel produces one invoice and ten
 * identical results.
 *
 * The write itself is one statement — `finance.create_milestone_invoice`, added
 * for G-078. It used to be four transactions: the invoice, its lines with a
 * hand-rolled compensating DELETE behind them, the audit row, and the outbox
 * row. Three of those could be lost after the invoice had committed, and the
 * audit row is the one that mattered most, because `audit.audit_log` is
 * append-only and a row never written can never be repaired.
 *
 * What stays here is what the database has no business deciding: which lines
 * the invoice has, and what its number is. Both are pure functions with tests
 * against them, and re-deriving either in plpgsql would put the same rule in
 * two places.
 *
 * The milestone's own `amount_minor` and `currency` are copied verbatim. The
 * percentage is not re-multiplied against the project budget here — the split
 * was resolved into exact minor units when the plan was saved, and any plan
 * that totals 100% (30/20/30/20, 5/10/30/20/35, 33.33/33.33/33.34) is already
 * accounted for by that arithmetic. Re-deriving would reintroduce the rounding
 * the plan carefully removed.
 */
export async function generateInvoiceFromMilestone(
  input: GenerateMilestoneInvoiceInput,
): Promise<Result<InvoiceRef>> {
  const parsed = generateMilestoneInvoiceSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Invalid invoice request.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'invoice.create')) {
    return err('FORBIDDEN', 'You do not have permission to raise invoices.');
  }

  const milestoneResult = await getBillableMilestone(parsed.data.milestoneId);
  if (!milestoneResult.ok) return milestoneResult;
  const milestone = milestoneResult.data;

  const billable = milestoneInvoiceability({
    status: milestone.status,
    amountMinor: milestone.amountMinor,
    paymentPercent: milestone.paymentPercent,
  });
  if (!billable.ok) return err('CONFLICT', billable.reason);

  const supabase = await createClient();

  // Ordinary idempotency: this milestone has already been billed.
  const existing = await findLiveInvoiceForMilestone(supabase, milestone.milestoneId);
  if (existing) {
    return ok({ invoiceId: existing.id, number: existing.number, created: false });
  }

  // ── Finance §16, the first two rows — G-259 ──────────────────────────────
  //
  //   "Missing billing mode → Block invoice; PM requests GST/Non-GST
  //    confirmation."
  //   "Incomplete GST data → Block GST invoice; request only missing fields."
  //
  // Checked BEFORE the invoice is built rather than after, because an invoice
  // that exists is a number issued and a gap in the sequence if it is undone.
  //
  // This is the gate G-255 recorded a mode for and nothing read. Until now
  // every invoice this system issued carried `tax_rate_bp = 0` while every
  // quotation it sent promised GST would be added.
  const readiness = await readBillingReadiness(milestone.projectId, supabase);
  if (!readiness.ok) return readiness;

  if (readiness.data.mode === null) {
    return err(
      'CONFLICT',
      'Confirm whether this project is billed with GST or without it before raising an invoice.',
    );
  }
  if (!readiness.data.complete) {
    // §16: "request ONLY missing fields." The list is carried so the PM asks
    // for those and not for everything again.
    const missing = readiness.data.missing.join(', ');
    const invalid = readiness.data.invalid.map((i) => `${i.field} (${i.reason})`).join(', ');
    return err(
      'CONFLICT',
      `The billing details are not complete yet${missing ? ` — missing: ${missing}` : ''}${invalid ? ` — invalid: ${invalid}` : ''}.`,
    );
  }

  const taxRateBp = taxRateBpForMode(readiness.data.mode);
  if (taxRateBp === null) {
    // Unreachable while `mode` is non-null, and returned rather than coerced:
    // a `?? 0` here would turn an impossible state into a Non-GST invoice.
    return err('INTERNAL', 'The billing mode could not be resolved into a tax rate.');
  }

  const lines = milestoneInvoiceLines(
    {
      name: milestone.name,
      amountMinor: milestone.amountMinor,
      paymentPercent: milestone.paymentPercent,
      position: milestone.position,
      projectName: milestone.projectName,
    },
    taxRateBp,
  );
  const totals = invoiceTotals(lines);

  const year = new Date().getUTCFullYear();
  const highest = await highestInvoiceSequence(supabase, year);

  const payload = lines.map((line) => ({
    position: line.position,
    description: line.description,
    quantity: line.quantity,
    unit_price_minor: line.unitPriceMinor,
    amount_minor: line.amountMinor,
    tax_rate_bp: line.taxRateBp,
  }));

  const due = dueAt(milestone.dueOn, parsed.data.dueInDays);

  // The loop is only about the *number* now. Everything the winner writes —
  // invoice, lines, audit, event — commits or does not, together.
  for (let attempt = 0; attempt < NUMBER_ATTEMPTS; attempt += 1) {
    const number = nextInvoiceNumber(year, highest, attempt);

    const { data, error } = await supabase.schema('finance').rpc('create_milestone_invoice', {
      // G-260, Finance §5: which profile version decided this invoice's tax.
      // A reference, because the version it points at is frozen.
      p_billing_profile_id: readiness.data.profileId ?? undefined,
      p_organization_id: milestone.organizationId,
      p_client_account_id: milestone.clientAccountId,
      p_project_id: milestone.projectId,
      p_milestone_id: milestone.milestoneId,
      p_number: number,
      p_currency: milestone.currency,
      p_subtotal_minor: totals.subtotalMinor,
      p_tax_minor: totals.taxMinor,
      p_total_minor: totals.totalMinor,
      p_lines: payload,
      ...(due ? { p_due_at: due } : {}),
      ...(parsed.data.notes ? { p_notes: parsed.data.notes } : {}),
    });

    if (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          scope: 'generateInvoiceFromMilestone',
          detail: error.message,
        }),
      );
      return err('INTERNAL', 'Could not create the invoice.');
    }

    const row = Array.isArray(data) ? data[0] : data;

    // A read that returned nothing is a failed read, not an empty answer —
    // D3's shape, and the reason `readNetReceived` exists in the form it does.
    if (!row) {
      console.error(
        JSON.stringify({
          level: 'error',
          scope: 'generateInvoiceFromMilestone',
          detail: 'create_milestone_invoice returned no row',
        }),
      );
      return err('INTERNAL', 'Could not create the invoice.');
    }

    switch (row.outcome) {
      case 'created':
        return ok({ invoiceId: row.invoice_id as string, number: row.number as string, created: true });

      // Another request invoiced this milestone between the pre-check above and
      // this write. Its invoice is the answer, exactly as the pre-check's would
      // have been.
      case 'already_invoiced':
        return ok({ invoiceId: row.invoice_id as string, number: row.number as string, created: false });

      // Somebody took the number; nothing was written. Try the next one.
      case 'number_taken':
        continue;

      // Refused before anything was written. Unreachable from here —
      // milestoneInvoiceLines never returns an empty list for a billable
      // milestone — but answered rather than assumed away, because the caller
      // that eventually does hit it should be told, not left with a bill that
      // has no lines.
      case 'no_lines':
        return err('CONFLICT', 'That milestone produced no invoice lines.');

      default:
        console.error(
          JSON.stringify({
            level: 'error',
            scope: 'generateInvoiceFromMilestone',
            detail: `unrecognised outcome "${String(row.outcome)}"`,
          }),
        );
        return err('INTERNAL', 'Could not create the invoice.');
    }
  }

  return err('CONFLICT', 'Could not allocate an invoice number. Please try again.');
}

// ── issue ──────────────────────────────────────────────────────────────────

/** The row `finance.issue_invoice` returns. */
type IssueInvoiceRow = {
  outcome:
    | 'issued'
    | 'not_found'
    | 'already_issued'
    | 'not_issuable'
    | 'no_amount'
    | 'no_items'
    | 'deliverable_not_approved';
  /** The status read under the invoice lock. */
  invoice_status: string | null;
};

/**
 * Issues a draft — INVOICE SENT TO CLIENT.
 *
 * Sending needs no messaging integration: `invoices_select` already shows a
 * client every non-draft invoice on their own account, so leaving draft *is*
 * delivery to the portal. When WhatsApp or email is added it subscribes to the
 * `invoice.issued` event emitted here and this function does not change.
 */
export async function issueInvoice(
  input: IssueInvoiceInput,
): Promise<Result<{ status: InvoiceStatus; number: string }>> {
  const parsed = issueInvoiceSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid issue request.');

  const context = await requireInternal();
  if (!can(context.role, 'invoice.issue')) {
    return err('FORBIDDEN', 'You do not have permission to issue invoices.');
  }

  const supabase = await createClient();
  const loaded = await loadInvoice(supabase, parsed.data.invoiceId);
  if (!loaded.ok) return loaded;
  const invoice = loaded.data;

  const from = invoice.status as InvoiceStatus;
  // `issued` is exempted rather than answered here. It is not a transition to
  // itself, so it would fail the gate below — but whether this invoice really
  // is already issued, or was voided a moment ago, is a question only the
  // locked read can answer. Every other refusal here fails closed, so an
  // out-of-date copy can only make them stricter than the truth.
  if (from !== 'issued' && !INVOICE_TRANSITIONS[from]?.includes('issued')) {
    return err('CONFLICT', `An invoice cannot move from ${from} to issued.`);
  }
  if (invoice.total_minor <= 0) {
    return err('CONFLICT', 'This invoice has no amount and cannot be issued.');
  }

  // The line items are no longer counted here. That was a second unlocked
  // round trip whose `error` was never read, so a failed read came back as
  // "this invoice has no line items" — a read failure presented as a domain
  // fact, which is what D3 was about. finance.issue_invoice checks them under
  // a lock instead (audit D4).
  const { data: sent, error } = await supabase.schema('finance').rpc('issue_invoice', {
    p_invoice_id: invoice.id,
    ...(parsed.data.dueOn ? { p_due_at: `${parsed.data.dueOn}T00:00:00.000Z` } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'issueInvoice', detail: error.message }));
    return err('INTERNAL', 'Could not issue the invoice.');
  }

  const settled = (Array.isArray(sent) ? sent[0] : sent) as IssueInvoiceRow | undefined;
  if (!settled) return err('INTERNAL', 'Could not issue the invoice.');

  // Same answers as before, decided under the lock rather than before it.
  // Nothing below runs unless the invoice was actually issued: an
  // `invoice.issued` audit row is immutable and its event unretractable, and
  // §2 of the migration is about exactly the case where they described a
  // transition that did not happen.
  if (settled.outcome !== 'issued') {
    if (settled.outcome === 'already_issued') return ok({ status: 'issued', number: invoice.number });
    if (settled.outcome === 'not_found') return err('NOT_FOUND', 'Invoice not found.');
    if (settled.outcome === 'not_issuable') {
      return err('CONFLICT', `An invoice cannot move from ${settled.invoice_status} to issued.`);
    }
    if (settled.outcome === 'no_amount') {
      return err('CONFLICT', 'This invoice has no amount and cannot be issued.');
    }
    if (settled.outcome === 'no_items') {
      return err('CONFLICT', 'This invoice has no line items and cannot be issued.');
    }
    // G-100, ADM-13: client approval makes the invoice raisable, not sent. The
    // draft already exists; what waits is the act that reaches the client.
    if (settled.outcome === 'deliverable_not_approved') {
      return err(
        'CONFLICT',
        'The client has not approved the deliverable this milestone bills for, so this invoice cannot be sent yet.',
      );
    }
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'issueInvoice',
        detail: `unrecognised outcome "${settled.outcome}"`,
      }),
    );
    return err('INTERNAL', 'Could not issue the invoice.');
  }

  // The audit row is written by finance.issue_invoice, in the transaction that
  // set the status (gap G-079), and `invoice.issued` is published from the same
  // place (audit D17). The `before` status it records is the one read under the
  // lock — the value this used to reach back out here for.

  return ok({ status: 'issued', number: invoice.number });
}

// ── payment ────────────────────────────────────────────────────────────────

export type PaymentResult = {
  status: InvoiceStatus;
  paidMinor: number;
  fullyPaid: boolean;
  /**
   * The milestone this payment has cleared the way for, when it cleared one.
   *
   * PAYMENT RECEIVED → NEXT PROJECT STAGE UNLOCKED, as a value the caller can
   * act on rather than a side effect. Nothing is mutated on the milestone:
   * what "unlocked" should *do* is a delivery decision, and delivery has not
   * made it yet. The `invoice.paid` event carries the same id for whatever
   * subscribes later.
   */
  unlockedMilestoneId: string | null;
};

/** The row `finance.record_manual_payment` returns. */
type ManualPaymentRow = {
  outcome:
    | 'recorded'
    | 'not_found'
    | 'not_payable'
    | 'non_positive'
    | 'overpayment'
    | 'duplicate';
  payment_id: string | null;
  /** Captured sum before this payment, read under the invoice lock. */
  captured_before_minor: number | null;
  invoice_status: string | null;
  /** What the invoice holds after this payment, written under the same lock. */
  paid_after_minor: number | null;
  status_after: string | null;
  /**
   * The milestone the `invoice.paid` event named, derived and published inside
   * the paying transaction (audit D17). Reported rather than recomputed: a
   * second answer taken out here would be a second answer, from after the lock
   * was released, and could disagree with the one the event carries.
   */
  unlocked_milestone_id: string | null;
};

/**
 * Records a payment somebody has actually received.
 *
 * This is the manual mechanism, and it is honest about being one. It asserts
 * nothing on the client's behalf and contacts no provider: a human who has
 * seen money land enters the amount and the bank reference, and that reference
 * is stored as the payment's identity so the same receipt cannot be recorded
 * twice.
 *
 * Payment is strictly separate from invoice creation and from issuing.
 * `paid_minor` moves only through this function, and only in response to a
 * recorded receipt — there is no code path anywhere that marks an invoice paid
 * without a payment row backing it.
 */
export async function recordManualPayment(
  input: RecordManualPaymentInput,
): Promise<Result<PaymentResult>> {
  const parsed = recordManualPaymentSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid payment.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'invoice.issue')) {
    return err('FORBIDDEN', 'You do not have permission to record payments.');
  }

  const supabase = await createClient();
  const loaded = await loadInvoice(supabase, parsed.data.invoiceId);
  if (!loaded.ok) return loaded;
  const invoice = loaded.data;

  // Refused rather than carried on with, and the ordering is why: this read
  // happens *before* the RPC commits anything.
  //
  // It is a real trade, not a free one. The RPC is authoritative under its own
  // lock, so pressing on past an unreadable advisory read would usually still
  // reach the right answer — the two reads are separate round trips and the
  // first failing does not mean the second will. What it risks is the one
  // outcome with no way back: if the recompute below also fails, the payment
  // has committed and the cache cannot be repaired from inside the
  // application. Refusing while nothing has moved costs a retry; pressing on
  // costs a manual UPDATE.
  const paidSoFar = await capturedTotal(supabase, invoice.id);
  if (!paidSoFar.ok) return paidSoFar;

  const outcome = applyPayment({
    status: invoice.status as InvoiceStatus,
    totalMinor: invoice.total_minor,
    paidSoFarMinor: paidSoFar.data,
    amountMinor: parsed.data.amountMinor,
  });

  if (!outcome.ok) {
    if (outcome.reason === 'not_payable') {
      return err(
        'CONFLICT',
        `An invoice that is ${invoice.status} cannot take a payment. Issue it first.`,
      );
    }
    if (outcome.reason === 'overpayment') {
      return err(
        'VALIDATION',
        'That is more than the invoice still owes. Record the amount actually received, or raise a separate invoice.',
      );
    }
    return err('VALIDATION', 'A payment must be a positive amount.');
  }

  const capturedAt = parsed.data.receivedAt ?? new Date().toISOString();

  // The check above ran before anything was locked, so it answers for the
  // caller that is alone. finance.record_manual_payment answers for the one
  // that is not: it locks the invoice, re-reads the ledger through that lock,
  // and inserts only if the payment still fits. The refusals it can return are
  // the same ones applyPayment makes — restated in SQL because a check that
  // ran before the lock could have been true when it ran and false by the time
  // it mattered (audit D1).
  const { data: recorded, error: paymentError } = await supabase
    .schema('finance')
    .rpc('record_manual_payment', {
      p_invoice_id: invoice.id,
      p_provider_payment_id: manualPaymentKey(invoice.id, parsed.data.reference),
      p_amount_minor: parsed.data.amountMinor,
      p_captured_at: capturedAt,
      // The audit row records how the money arrived, and the function now
      // writes that row itself (G-079), so the method has to reach it.
      p_method: parsed.data.method,
    });

  if (paymentError) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'recordManualPayment', detail: paymentError.message }),
    );
    return err('INTERNAL', 'Could not record the payment.');
  }

  const settled = (Array.isArray(recorded) ? recorded[0] : recorded) as ManualPaymentRow | undefined;
  if (!settled) return err('INTERNAL', 'Could not record the payment.');

  // Same answers as before, decided under the lock rather than before it.
  if (settled.outcome !== 'recorded') {
    if (settled.outcome === 'duplicate') {
      return err(
        'CONFLICT',
        `A payment with reference ${parsed.data.reference} is already recorded against this invoice.`,
      );
    }
    if (settled.outcome === 'not_found') return err('NOT_FOUND', 'Invoice not found.');
    if (settled.outcome === 'not_payable') {
      return err(
        'CONFLICT',
        `An invoice that is ${settled.invoice_status} cannot take a payment. Issue it first.`,
      );
    }
    if (settled.outcome === 'overpayment') {
      return err(
        'VALIDATION',
        'That is more than the invoice still owes. Record the amount actually received, or raise a separate invoice.',
      );
    }
    if (settled.outcome === 'non_positive') {
      return err('VALIDATION', 'A payment must be a positive amount.');
    }
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'recordManualPayment',
        detail: `unrecognised outcome "${settled.outcome}"`,
      }),
    );
    return err('INTERNAL', 'Could not record the payment.');
  }

  // The invoice total is not read back, and not written here at all. It was
  // updated inside the same statement that inserted the payment, under the
  // same lock — so these are what the database holds, not a second opinion
  // formed after the lock was released (gap G-008).
  if (settled.paid_after_minor === null || settled.status_after === null) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'recordManualPayment',
        detail: 'a recorded payment returned no reconciled total',
      }),
    );
    return err('INTERNAL', 'Could not record the payment.');
  }

  // `null` here is a legitimate answer — no further priced milestone, or a
  // payment that did not cover the invoice. `undefined` is not an answer at
  // all: it means the column is absent, so the deployed function predates the
  // caller and did not publish `invoice.paid` either. Reporting success then
  // would return `unlockedMilestoneId: undefined` under a type that promises
  // `string | null`, for a payment whose event nobody sent.
  if (settled.unlocked_milestone_id === undefined) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'recordManualPayment',
        detail: 'record_manual_payment returned no unlocked_milestone_id — migration 20260812120004 has not run',
      }),
    );
    return err('INTERNAL', 'Could not record the payment.');
  }

  const paidMinor = settled.paid_after_minor;
  const status = settled.status_after as InvoiceStatus;
  const fullyPaid = status === 'paid';

  // The audit row is written by finance.record_manual_payment, in the same
  // statement as the money (gap G-079). Its `before` is the captured sum read
  // under the lock — the number this used to take from the returned row, one
  // request later, by which time a concurrent receipt could have moved it.
  //
  // `method` is the one field the function cannot derive, which is why it now
  // takes `p_method`: it is caller intent, not a fact about the invoice.

  // `payment.recorded` and `invoice.paid` are published by the function above,
  // in the transaction that wrote the payment (audit D17). Nothing is emitted
  // here, and that is the fix: emitting from out here meant a separate
  // connection and a separate transaction, so a failed insert left the money
  // recorded and the event gone — for `invoice.paid`, a client who has paid in
  // full and a milestone that never opens, with nothing queued to retry.
  //
  // The milestone the payment unlocked comes back from the same statement for
  // the same reason. Deriving it out here would mean reading the plan after
  // the lock was released, so the answer could differ from the one the event
  // already carries.
  const unlockedMilestoneId = settled.unlocked_milestone_id;

  return ok({
    status: status,
    paidMinor: paidMinor,
    fullyPaid: fullyPaid,
    unlockedMilestoneId,
  });
}

// ── void ───────────────────────────────────────────────────────────────────

/** The row `finance.void_invoice` returns. */
type VoidInvoiceRow = {
  outcome: 'voided' | 'not_found' | 'already_void' | 'not_voidable' | 'has_payments';
  /** The status read under the invoice lock. */
  invoice_status: string | null;
  /** The captured sum, read under the same lock. */
  captured_minor: number | null;
};

/**
 * Withdraws an invoice that should not have been raised.
 *
 * Voiding is the only correction available, and that is intentional: an
 * invoice a client has seen is a document, and editing one in place leaves two
 * parties holding different versions of the same number. Voiding frees the
 * milestone — `invoices_milestone_live_key` excludes void rows — so a correct
 * invoice can be generated in its place with a new number.
 *
 * An invoice with money against it cannot be voided. That is a refund, which
 * moves real money and needs the mechanism this codebase does not have yet.
 */
export async function voidInvoice(
  input: VoidInvoiceInput,
): Promise<Result<{ status: InvoiceStatus }>> {
  const parsed = voidInvoiceSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'A voided invoice needs a reason.');

  const context = await requireInternal();
  if (!can(context.role, 'invoice.issue')) {
    return err('FORBIDDEN', 'You do not have permission to void invoices.');
  }

  const supabase = await createClient();
  const loaded = await loadInvoice(supabase, parsed.data.invoiceId);
  if (!loaded.ok) return loaded;
  const invoice = loaded.data;

  const from = invoice.status as InvoiceStatus;
  // `void` is exempted rather than answered here (audit D7, the twin of the
  // return D4 removed from issueInvoice). It is not a transition to itself, so
  // it would fail the gate below — but whether this invoice really is already
  // void, or was issued a moment ago by somebody else, is a question only the
  // locked read can answer. Every other refusal here fails closed, so an
  // out-of-date copy can only make them stricter than the truth.
  if (from !== 'void' && !INVOICE_TRANSITIONS[from]?.includes('void')) {
    return err('CONFLICT', `An invoice that is ${from} cannot be voided.`);
  }
  if (invoice.paid_minor > 0) {
    return err(
      'CONFLICT',
      'This invoice has payments recorded against it. Refund them before voiding.',
    );
  }

  const note = `Voided: ${parsed.data.reason}`;

  // The checks above ran before anything was locked, so they answer for the
  // caller that is alone. finance.void_invoice answers for the one that is
  // not: it locks the invoice, sums the ledger through that lock, and writes
  // only if no money arrived in the meantime. The refusals it can return are
  // the same ones made above — restated in SQL because a check that ran before
  // the lock could have been true when it ran and false by the time the write
  // landed (audit D2).
  const { data: withdrawn, error } = await supabase.schema('finance').rpc('void_invoice', {
    p_invoice_id: invoice.id,
    p_note: note,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'voidInvoice', detail: error.message }));
    return err('INTERNAL', 'Could not void the invoice.');
  }

  const settled = (Array.isArray(withdrawn) ? withdrawn[0] : withdrawn) as
    | VoidInvoiceRow
    | undefined;
  if (!settled) return err('INTERNAL', 'Could not void the invoice.');

  // Same answers as before, decided under the lock rather than before it.
  // Nothing below this point runs unless the invoice was actually withdrawn:
  // an `invoice.voided` audit row is immutable and the event it pairs with is
  // unretractable, so neither may describe a void that did not happen.
  if (settled.outcome !== 'voided') {
    if (settled.outcome === 'already_void') return ok({ status: 'void' });
    if (settled.outcome === 'not_found') return err('NOT_FOUND', 'Invoice not found.');
    if (settled.outcome === 'not_voidable') {
      return err('CONFLICT', `An invoice that is ${settled.invoice_status} cannot be voided.`);
    }
    if (settled.outcome === 'has_payments') {
      return err(
        'CONFLICT',
        'This invoice has payments recorded against it. Refund them before voiding.',
      );
    }
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'voidInvoice',
        detail: `unrecognised outcome "${settled.outcome}"`,
      }),
    );
    return err('INTERNAL', 'Could not void the invoice.');
  }

  // The audit row is written by finance.void_invoice, in the transaction that
  // wrote the status and the note (gap G-079), and `invoice.voided` is
  // published from the same place (audit D17). The reason it records is the
  // note the function was handed, so the two cannot disagree.

  return ok({ status: 'void' });
}

// ── internals ──────────────────────────────────────────────────────────────

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

/**
 * The service-role client, as a type only. Importing the *factory* here would
 * put an RLS-bypassing client one import away from every Server Action; the
 * type alone lets a sanctioned caller (the job runner) hand one in.
 */
type AdminClient = ReturnType<typeof createAdminClient>;

const INVOICE_COLUMNS =
  'id, organization_id, client_account_id, project_id, milestone_id, number, status, currency, total_minor, paid_minor, notes';

/**
 * The invoice a write is about to act on.
 *
 * A read that failed is not an invoice that does not exist (audit D6). It used
 * to return null for both, and all three writes in this file turned that null
 * into `NOT_FOUND` — so a database that did not answer was reported to the
 * operator as a missing invoice, which is a fact about the world rather than
 * about the request. The same distinction D3 restored for the ledger.
 *
 * `NOT_FOUND` now means the row is genuinely absent, or RLS does not admit it
 * to this caller — which are the same answer on purpose, because telling a
 * caller that a row they may not see nonetheless exists is a leak.
 */
async function loadInvoice(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<Result<NonNullable<Awaited<ReturnType<typeof selectInvoice>>['data']>>> {
  const { data, error } = await selectInvoice(supabase, invoiceId);

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'loadInvoice', detail: error.message }));
    return err('INTERNAL', 'The invoice could not be read. Please try again.');
  }
  if (!data) return err('NOT_FOUND', 'Invoice not found.');
  return ok(data);
}

function selectInvoice(supabase: SupabaseClient, invoiceId: string) {
  return supabase
    .schema('finance')
    .from('invoices')
    .select(INVOICE_COLUMNS)
    .eq('id', invoiceId)
    .maybeSingle();
}

/** The milestone's current bill, if it has one that has not been withdrawn. */
async function findLiveInvoiceForMilestone(supabase: SupabaseClient, milestoneId: string) {
  const { data } = await supabase
    .schema('finance')
    .from('invoices')
    .select('id, number, status')
    .eq('milestone_id', milestoneId)
    .neq('status', 'void')
    .limit(1)
    .maybeSingle();

  return data;
}

/**
 * The highest sequence used this year, within the caller's organization.
 *
 * RLS supplies the organization scope, which is why there is no explicit
 * predicate — the same reasoning as every other read in this codebase. Zero
 * padding is what makes the descending text sort agree with numeric order.
 */
async function highestInvoiceSequence(supabase: SupabaseClient, year: number): Promise<number> {
  const { data } = await supabase
    .schema('finance')
    .from('invoices')
    .select('number')
    .like('number', `${invoiceNumberPrefix(year)}%`)
    .order('number', { ascending: false })
    .limit(1)
    .maybeSingle();

  return parseInvoiceSequence(data?.number, year);
}

/**
 * Sum of captured payments — the ledger behind `paid_minor`.
 *
 * A failure to read is a failure, not a zero (audit D3). It used to return 0,
 * and the caller below wrote that 0 straight over `paid_minor`: one transient
 * error erased an invoice's record of every receipt against it, left the
 * status stale, and withheld `invoice.paid` so the milestone it gates never
 * opened. Nothing in the database refuses that write —
 * `invoices_paid_not_over_total` bounds the cache from above only — and
 * nothing in the application could repair it afterwards, because re-recording
 * the same reference is a `duplicate` and any other amount is an
 * `overpayment` against a ledger that is still, correctly, full.
 *
 * The distinction this restores is the one directive §33 asks for: "the ledger
 * says zero" and "the ledger did not answer" are different facts and must
 * produce different outcomes.
 */
async function capturedTotal(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<Result<number>> {
  const { data, error } = await supabase
    .schema('finance')
    .from('payments')
    .select('amount_minor')
    .eq('invoice_id', invoiceId)
    .eq('status', 'captured');

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'capturedTotal', detail: error.message }));
    return err(
      'INTERNAL',
      'The payments recorded against this invoice could not be read. Please try again.',
    );
  }
  return ok((data ?? []).reduce((sum, row) => sum + row.amount_minor, 0));
}

/**
 * `resolveUnlockedMilestone` used to sit here, and is gone with D17.
 *
 * It answered "which milestone did this payment unlock" from a request taken
 * after the paying transaction had committed and its lock had been released.
 * That was the only way to fill the `invoice.paid` payload while the event was
 * emitted from out here — and it was two reads that could fail, could see a
 * plan that had since moved, and could disagree with the money that had just
 * been written.
 *
 * `finance.record_manual_payment` now answers it under the same lock that
 * wrote the payment, and returns it in the same row. The rule itself has not
 * moved: `nextUnlockedMilestone` in schema.ts is still where it is defined,
 * `nextUnlockedMilestoneForProject` below is still the reader the unlock
 * handler uses to check the event's claim, and the SQL statement of it in
 * migration 20260812120004 is advisory and differentially tested against this
 * one.
 */

/**
 * The same answer, for a caller running under the service role.
 *
 * The job runner has no session, so the RLS-scoped path above cannot serve it;
 * organization scoping is therefore applied by hand on every query, as
 * ARCHITECTURE.md §7.3 requires of service-role code.
 *
 * Exported because the milestone-unlock handler in the projects module must
 * check the event's claim against the live plan, and this is the one rule that
 * says what "next" means. A second implementation over there would be a second
 * definition of when a client has paid far enough to proceed — the sort of
 * duplication that stays consistent right up until it matters.
 */
export async function nextUnlockedMilestoneForProject(
  admin: AdminClient,
  scope: { organizationId: string; projectId: string },
): Promise<Result<string | null>> {
  const [milestones, invoices] = await Promise.all([
    admin
      .schema('projects')
      .from('milestones')
      .select('id, position, payment_percent')
      .eq('project_id', scope.projectId)
      .eq('organization_id', scope.organizationId),
    admin
      .schema('finance')
      .from('invoices')
      .select('milestone_id, status')
      .eq('project_id', scope.projectId)
      .eq('organization_id', scope.organizationId),
  ]);

  // A plan that could not be read is not a plan with nothing left in it
  // (audit D5). Both reads used to be destructured for `data` alone and folded
  // to `?? []`, and an empty plan is exactly what makes invoicePaidVerdict
  // refuse — with `permanent: true`, so the runner parked the unlock as dead
  // on its first attempt and never tried again. A blip on either query
  // stranded a milestone the client had already paid for.
  const failure = milestones.error ?? invoices.error;
  if (failure) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'nextUnlockedMilestoneForProject',
        projectId: scope.projectId,
        detail: failure.message,
      }),
    );
    return err('INTERNAL', 'The payment plan could not be read.');
  }

  return ok(
    nextUnlockedMilestone(
      billingEntries(milestones.data ?? [], invoices.data ?? []),
    )?.milestoneId ?? null,
  );
}

/**
 * Pairs each milestone with its live invoice status.
 *
 * Void invoices are dropped rather than represented, because a withdrawn bill
 * is not a bill — the same rule `invoices_milestone_live_key` enforces in the
 * database and the project page reproduces on screen.
 */
function billingEntries(
  milestones: readonly { id: string; position: number; payment_percent: number | null }[],
  invoices: readonly { milestone_id: string | null; status: string }[],
): MilestoneBillingEntry[] {
  const live = new Map(
    invoices
      .filter((invoice) => invoice.status !== 'void' && invoice.milestone_id !== null)
      .map((invoice) => [invoice.milestone_id as string, invoice.status as InvoiceStatus]),
  );

  return milestones.map((milestone) => ({
    milestoneId: milestone.id,
    position: milestone.position,
    paymentPercent: milestone.payment_percent === null ? null : Number(milestone.payment_percent),
    invoiceStatus: live.get(milestone.id) ?? null,
  }));
}

/**
 * When the invoice falls due.
 *
 * The milestone's own date wins, because that is what was agreed with the
 * client. `dueInDays` is a fallback for milestones that carry no date, and
 * when neither is present the invoice has no due date rather than an invented
 * one — a made-up deadline is worse than none.
 */
function dueAt(milestoneDueOn: string | null, dueInDays?: number): string | null {
  if (milestoneDueOn) return `${milestoneDueOn}T00:00:00.000Z`;
  if (dueInDays === undefined) return null;
  return new Date(Date.now() + dueInDays * 86_400_000).toISOString();
}

// ═══════════════════════════════════════════════════════════════════════════
// Refunds — gap G-005
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ask for a refund.
 *
 * `refund.issue` is owner-only and has been since the capability matrix was
 * written; this is its first caller. Nothing leaves the business here — the
 * request raises an approval, and `recordRefund` is what happens after
 * somebody says yes.
 *
 * The ceiling, the approval and the audit are all `finance.request_refund`'s.
 * Checking any of them here would be a read taken before a write somebody
 * else may land first, which is the defect this module was rebuilt around.
 */
export async function requestRefund(
  input: RequestRefundInput,
): Promise<Result<{ refundId: string; requestId: string }>> {
  const parsed = requestRefundSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'That refund could not be validated.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'refund.issue')) {
    return err('FORBIDDEN', 'Only an owner may ask for a refund.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('finance').rpc('request_refund', {
    p_invoice_id: parsed.data.invoiceId,
    p_amount_minor: parsed.data.amountMinor,
    p_reason: parsed.data.reason,
    ...(context.userId ? { p_requested_by: context.userId } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'requestRefund', detail: error.message }));
    return err('INTERNAL', 'Could not request the refund.');
  }

  const settled = (Array.isArray(data) ? data[0] : data) as
    | { outcome: string; refund_id: string | null; request_id: string | null; net_received: number | null }
    | undefined;

  if (!settled) return err('INTERNAL', 'Could not request the refund.');

  switch (settled.outcome) {
    case 'requested':
      if (!settled.refund_id || !settled.request_id) {
        return err('INTERNAL', 'Could not request the refund.');
      }
      return ok({ refundId: settled.refund_id, requestId: settled.request_id });

    case 'not_found':
      return err('NOT_FOUND', 'Invoice not found.');

    case 'non_positive':
      return err('VALIDATION', 'A refund needs an amount above zero.');

    // Refused, never clamped: the caller asked for more than the business is
    // holding, and is told the figure rather than quietly given less.
    case 'exceeds_received':
      return err(
        'CONFLICT',
        `That is more than this invoice has received. Available to refund: ${settled.net_received ?? 0} minor units.`,
      );

    case 'no_policy':
      return err(
        'CONFLICT',
        'No approval policy covers refunds, so nobody is named to approve this. An owner sets one first.',
      );

    default:
      return err('INTERNAL', 'Could not request the refund.');
  }
}

/**
 * Record that the money left.
 *
 * The approval check lives in `finance.record_refund` and is deliberately not
 * repeated here: the database refuses without an approved request behind it,
 * and a second check in TypeScript would be a copy that could drift from the
 * one that actually runs.
 */
export async function recordRefund(input: RecordRefundInput): Promise<Result<{ netReceived: number }>> {
  const parsed = recordRefundSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'That refund could not be validated.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'refund.issue')) {
    return err('FORBIDDEN', 'Only an owner may record a refund.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('finance').rpc('record_refund', {
    p_refund_id: parsed.data.refundId,
    p_provider_refund_id: parsed.data.providerRefundId,
    ...(context.userId ? { p_recorded_by: context.userId } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordRefund', detail: error.message }));
    return err('INTERNAL', 'Could not record the refund.');
  }

  const settled = (Array.isArray(data) ? data[0] : data) as
    | { outcome: string; refund_id: string | null; net_received: number | null }
    | undefined;

  if (!settled) return err('INTERNAL', 'Could not record the refund.');

  switch (settled.outcome) {
    case 'recorded':
      return ok({ netReceived: settled.net_received ?? 0 });

    // Reported as success for the same reason a duplicate payment is: the
    // refund this caller wanted recorded is recorded, and telling them it
    // failed is how somebody transfers the money a second time.
    case 'already_recorded':
    case 'duplicate':
      return ok({ netReceived: settled.net_received ?? 0 });

    case 'not_found':
      return err('NOT_FOUND', 'Refund not found.');

    case 'not_approved':
      return err('FORBIDDEN', 'This refund has not been approved yet.');

    case 'exceeds_received':
      return err(
        'CONFLICT',
        'Another refund has been recorded since this was approved, and there is no longer enough to cover it.',
      );

    default:
      return err('INTERNAL', 'Could not record the refund.');
  }
}

// ── verification ───────────────────────────────────────────────────────────

/** The row `finance.verify_payment` returns. */
type VerifyPaymentRow = {
  outcome: 'verified' | 'not_found' | 'already_verified' | 'not_captured';
  invoice_id: string | null;
  verified_after_minor: number | null;
  status_after: string | null;
  unlocked_milestone_id: string | null;
};

export type VerificationResult = {
  invoiceId: string;
  status: InvoiceStatus;
  verifiedMinor: number;
  fullyPaid: boolean;
  /** The milestone this confirmation opened, when it opened one. */
  unlockedMilestoneId: string | null;
  /** False when the payment was already confirmed by somebody else. */
  changed: boolean;
};

/**
 * Confirms that recorded money actually arrived — ADM-04, G-007.
 *
 * MONEY CLAIMED → MONEY BELIEVED. Until this runs, a payment is a claim
 * somebody wrote down: a client said they paid, a staff member recorded it,
 * and the invoice shows it as received. This is where the owner or an ops
 * admin says they have seen it on the bank statement.
 *
 * **It is also where the next milestone opens.** `invoice.paid` used to be
 * published by `record_manual_payment`, which meant delivery advanced on a
 * client's word. It is published here now.
 *
 * `invoice.issue` rather than a new capability: it already resolves to exactly
 * owner + ops_admin, which is who ADM-04 names, and finance's rule is that a
 * capability mapping to an identical role set adds vocabulary without adding
 * control.
 *
 * Nothing is decided here. `finance.verify_payment` reads the payment and its
 * invoice under the invoice's row lock and answers from what it saw, because a
 * status this file checked first is one another request could change before the
 * write landed — the shape D1, D2, D4 and D20 all were.
 */
export async function verifyPayment(input: VerifyPaymentInput): Promise<Result<VerificationResult>> {
  const parsed = verifyPaymentSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Invalid verification request.');
  }

  const context = await requireInternal();
  if (!can(context.role, 'invoice.issue')) {
    return err('FORBIDDEN', 'You do not have permission to confirm payments.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('finance').rpc('verify_payment', {
    p_payment_id: parsed.data.paymentId,
    p_verified_by: context.userId,
  });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'verifyPayment', detail: error.message }),
    );
    return err('INTERNAL', 'Could not confirm that payment.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as VerifyPaymentRow | undefined;

  // A read that returned nothing is a failed read, not an empty answer — G-054.
  if (!row) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'verifyPayment', detail: 'no row returned' }),
    );
    return err('INTERNAL', 'Could not confirm that payment.');
  }

  switch (row.outcome) {
    // Two people reading the same bank statement should not fight, so the
    // second gets the same picture as the first and says so with
    // `changed: false`. Handled together deliberately: the difference is one
    // flag, and splitting them would duplicate the whole answer to vary it.
    case 'verified':
    case 'already_verified': {
      return ok({
        invoiceId: row.invoice_id as string,
        status: (row.status_after ?? 'issued') as InvoiceStatus,
        verifiedMinor: row.verified_after_minor ?? 0,
        fullyPaid: row.status_after === 'paid',
        unlockedMilestoneId: row.unlocked_milestone_id,
        changed: row.outcome === 'verified',
      });
    }

    case 'not_found':
      return err('NOT_FOUND', 'That payment is not in this organization.');

    // Money that failed, or was never captured, is not money to confirm.
    case 'not_captured':
      return err('CONFLICT', 'That payment has not been captured, so there is nothing to confirm.');

    default:
      console.error(
        JSON.stringify({
          level: 'error',
          scope: 'verifyPayment',
          detail: `unrecognised outcome "${String(row.outcome)}"`,
        }),
      );
      return err('INTERNAL', 'Could not confirm that payment.');
  }
}

/**
 * Billing mode and the profile it requires — Finance §4.1–§4.3, §16.
 *
 * Every quotation this system sends says *"All amounts are exclusive of GST;
 * 18% GST extra"*, and every invoice it has issued has added none — because
 * `tax_rate_bp` defaults to 0 and nothing ever recorded which it should be.
 * That is what a default does to a decision nobody made, and §4.1's answer is
 * that the mode is **confirmed** rather than read out of old messages.
 */

/** Finance §4.1 — a person records which way this project is billed. */
/* ────────────────────────────────────────────────────────────────────────────
 * The claim layer — Doc 15 §11 and §12; G-272.
 *
 * The table, the guard, the door and §4.7's three decisions were all built —
 * and **nothing in the application touched any of it**, on either side. So a
 * client saying *"paid, UTR 402318"* had nowhere to go, and the verification
 * queue G-271 finished would have shown an always-empty list.
 *
 * That is why this is one unit rather than two: building only the verify half
 * would have been the same defect wearing a page.
 *
 * ── what a claim is NOT ───────────────────────────────────────────────
 *
 * It is not money. `finance.payments` is the ledger and `recordManualPayment`
 * writes it; a claim moves no invoice, unlocks no milestone and appears in no
 * total. §12's verification is what turns one into the other, and it is a
 * PERSON's act — the table has no `verified_by_agent` column, and that absence
 * is the control.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Record what somebody said they paid — §11.
 *
 * The capability is `invoice.issue`, which is owner and ops_admin: the same
 * pair `payment_submissions_insert` admits in RLS, and the same one that
 * records a manual payment. **Doc 15 §11 names a client and Sales as well**,
 * and neither can reach this today — the row policy would refuse them. That
 * is a narrowing of the document, stated rather than smuggled: widening it is
 * an RLS change and a decision about who may make a claim on a client's
 * behalf, not a capability string.
 */
export async function recordPaymentSubmission(
  input: RecordPaymentSubmissionInput,
): Promise<Result<{ submissionId: string }>> {
  const parsed = recordPaymentSubmissionSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid claim.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'invoice.issue')) {
    return err('FORBIDDEN', 'You do not have permission to record a payment claim.');
  }
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('finance')
    .from('payment_submissions')
    .insert({
      organization_id: context.organizationId,
      invoice_id: parsed.data.invoiceId,
      amount_minor: parsed.data.amountMinor,
      method: parsed.data.method,
      reference: parsed.data.reference ?? null,
      payer_name: parsed.data.payerName ?? null,
      paid_at: parsed.data.paidAt ?? null,
      proof_url: parsed.data.proofUrl ?? null,
      account_id: parsed.data.accountId ?? null,
      submitted_by: context.userId,
    })
    .select('id')
    .single();

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'recordPaymentSubmission', detail: error.message }),
    );
    // §12's "duplicate references are flagged" is a partial unique index, and a
    // repeat of a reference that already exists is the caller telling us
    // something rather than a server fault.
    if (error.code === '23505') {
      return err('CONFLICT', 'That reference has already been claimed against an invoice.');
    }
    return err('INTERNAL', 'Could not record the claim.');
  }

  return ok({ submissionId: data.id });
}

type VerifySubmissionRow = {
  outcome:
    | 'verified'
    | 'rejected'
    | 'mismatch'
    | 'not_found'
    | 'settled'
    | 'no_evidence'
    | 'no_verifier'
    | 'no_reason'
    | 'no_note'
    | 'unknown_decision';
  status: string | null;
};

/**
 * Answer a claim — §12, and §4.7's three decisions.
 *
 * **Verifying is not paying.** A confirmed claim records that somebody checked
 * it; the ledger row is still `recordManualPayment`, and the door leaves
 * `payment_id` null until one exists. Saying otherwise here would make a
 * verification move money, which is the one thing ADM-04 separated.
 */
export async function verifyPaymentSubmission(
  input: VerifyPaymentSubmissionInput,
): Promise<Result<{ status: string }>> {
  const parsed = verifyPaymentSubmissionSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid verification.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'invoice.issue')) {
    return err('FORBIDDEN', 'You do not have permission to verify a payment claim.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('finance').rpc('verify_payment_submission', {
    p_submission_id: parsed.data.submissionId,
    // The door records who checked it and the guard refuses any other name:
    // "you may only say that YOU checked it".
    p_verified_by: context.userId,
    // The generated types say these are non-null because the SQL defaults are
    // not nulls; the door itself treats an empty string as absent and answers
    // `no_evidence` / `no_reason`, which is what the schema above prevents
    // reaching it.
    p_evidence: parsed.data.evidence ?? '',
    p_decision: parsed.data.decision,
    p_reason: parsed.data.reason ?? '',
  });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'verifyPaymentSubmission', detail: error.message }),
    );
    return err('INTERNAL', 'Could not record the verification.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as VerifySubmissionRow | undefined;
  if (!row) return err('INTERNAL', 'Could not record the verification.');

  switch (row.outcome) {
    case 'verified':
    case 'rejected':
    case 'mismatch':
      return ok({ status: row.status ?? row.outcome });

    case 'not_found':
      return err('NOT_FOUND', 'That claim is not in this organization.');

    // Every refusal the door can produce, surfaced as written rather than
    // flattened: whether a claim was already answered, or needs evidence, or
    // needs a reason, are three different things for the person looking at it.
    case 'settled':
      return err('CONFLICT', 'That claim has already been answered.');
    case 'no_evidence':
      return err('VALIDATION', 'Say what you checked — a confirmation records the evidence.');
    case 'no_reason':
      return err('VALIDATION', 'Say why it was rejected.');
    case 'no_note':
      return err('VALIDATION', 'Say what does not match.');
    case 'no_verifier':
      return err('FORBIDDEN', 'A verification names the person who did it.');

    default:
      return err('INTERNAL', 'Could not record the verification.');
  }
}

export async function confirmBillingMode(
  input: ConfirmBillingModeInput,
): Promise<Result<{ profileId: string; version: number; mode: 'gst' | 'non_gst'; changed: boolean }>> {
  const parsed = confirmBillingModeSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid billing mode.');

  const context = await requireInternal();
  if (!can(context.role, 'invoice.create')) {
    return err('FORBIDDEN', 'You do not have permission to set a billing mode.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc('confirm_billing_mode', {
    p_project_id: parsed.data.projectId,
    p_mode: parsed.data.mode,
    p_source: parsed.data.source,
    p_note: parsed.data.note,
  });
  if (error) return err('INTERNAL', 'Could not record the billing mode.');

  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome?: string; profile_id?: string | null; version?: number | null }
    | undefined;
  const outcome = row?.outcome ?? 'no answer';

  switch (outcome) {
    case 'confirmed':
    case 'superseded':
    case 'unchanged':
      return ok({
        profileId: row!.profile_id!,
        version: row!.version ?? 1,
        mode: parsed.data.mode,
        // `unchanged` is the repeated click §4.3 calls not a legitimate change.
        changed: outcome !== 'unchanged',
      });
    case 'unknown_project':
      return err('NOT_FOUND', 'Project not found.');
    case 'invalid_mode':
    case 'invalid_source':
      return err('VALIDATION', 'That is not a billing mode this system records.');
    default:
      return err('FORBIDDEN', 'You do not have permission to set this project’s billing mode.');
  }
}

/** Finance §4.2 — the fields a GST invoice cannot be issued without. */
export async function recordBillingDetails(
  input: RecordBillingDetailsInput,
): Promise<Result<{ profileId: string; version: number; changed: boolean }>> {
  const parsed = recordBillingDetailsSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid billing details.');

  // The checksum, before the write rather than after it — a mistyped GSTIN is
  // worth catching while the person who typed it is still looking at it.
  if (parsed.data.gstin !== undefined) {
    const verdict = checkGstin(parsed.data.gstin);
    if (!verdict.valid) return err('VALIDATION', `That GSTIN cannot be right: ${verdict.reason}.`);
  }

  const context = await requireInternal();
  if (!can(context.role, 'invoice.create')) {
    return err('FORBIDDEN', 'You do not have permission to record billing details.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc('record_billing_details', {
    p_project_id: parsed.data.projectId,
    p_legal_name: parsed.data.legalName,
    p_billing_address: parsed.data.billingAddress,
    p_billing_state: parsed.data.billingState,
    p_gstin: parsed.data.gstin,
  });
  if (error) return err('INTERNAL', 'Could not record the billing details.');

  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome?: string; profile_id?: string | null; version?: number | null }
    | undefined;

  switch (row?.outcome ?? 'no answer') {
    case 'recorded':
      return ok({ profileId: row!.profile_id!, version: row!.version ?? 1, changed: true });
    case 'unchanged':
      return ok({ profileId: row!.profile_id!, version: row!.version ?? 1, changed: false });
    case 'no_mode':
      // §16's first row, by name: block, and say what to ask for.
      return err('CONFLICT', 'Confirm whether this project is billed with GST or without it before recording details.');
    case 'gstin_on_non_gst':
      return err('CONFLICT', 'This project is billed without GST, so a GSTIN is not stored against it.');
    case 'unknown_project':
      return err('NOT_FOUND', 'Project not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to record this project’s billing details.');
  }
}

/**
 * Whether Finance may issue against this project — §4.2, §16.
 *
 * Returns the gap rather than a bare no, because §16 asks for *"only missing
 * fields"*, and the PM is the one who will do the asking.
 */
export async function readBillingReadiness(
  projectId: string,
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<
  Result<BillingReadiness & { mode: 'gst' | 'non_gst' | null; version: number | null; profileId: string | null }>
> {
  const { data, error } = await supabase
    .schema('finance')
    .from('billing_profiles')
    .select('id, version, mode, legal_name, billing_address, billing_state, gstin')
    .eq('project_id', projectId)
    .eq('status', 'active')
    .maybeSingle();

  // A read that failed is not a project with no billing mode (G-054). The
  // difference matters here more than most: one blocks an invoice and asks a
  // client a question they already answered.
  if (error) return err('INTERNAL', 'Could not read the billing profile.');

  const readiness = billingReadiness({
    mode: (data?.mode as 'gst' | 'non_gst' | undefined) ?? null,
    legal_name: data?.legal_name,
    billing_address: data?.billing_address,
    billing_state: data?.billing_state,
    gstin: data?.gstin,
  });

  return ok({
    ...readiness,
    mode: (data?.mode as 'gst' | 'non_gst' | null) ?? null,
    version: data?.version ?? null,
    // G-260: the row an invoice raised now will point at, so the profile that
    // decided its tax can be read back years later.
    profileId: data?.id ?? null,
  });
}

/**
 * Where a project is on Finance §12's ladder, and whether Phase 7 may open.
 *
 * G-251 wrote `phaseSevenGate` as a pure function and **nothing ever computed
 * the number it takes** — its only caller was its own test. This is the number,
 * and the gate finally has a caller.
 *
 * The percentage comes from `finance.project_payment_progress`, which counts a
 * milestone only when its live invoice is **net verified** — captured and
 * verified payments less refunds. Two consequences worth stating, both proven
 * against a real database:
 *
 *   * a payment captured but not yet verified by an Admin counts for nothing
 *     (Finance §6, proof never auto-verifies);
 *   * **a refund closes the gate again** — 30% back to 0% — rather than
 *     leaving it at a high-water mark.
 *
 * The gate rule itself is not restated here. `phaseSevenGate` owns it, and a
 * second copy of "100% or it stays shut" is a second thing to keep honest.
 */
export async function readPaymentProgress(
  projectId: string,
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<
  Result<{
    verifiedPercent: number | null;
    planTotalPercent: number | null;
    measurable: boolean;
    milestones: number;
    verifiedMilestones: number;
    gate: { open: boolean; shortfallPercent: number };
  }>
> {
  const { data, error } = await supabase
    .schema('finance')
    .rpc('project_payment_progress', { p_project_id: projectId });

  // A read that failed is not a project at 0%. The difference decides whether
  // the last phase of somebody's project opens.
  if (error) return err('INTERNAL', 'Could not read the payment progress.');

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        verified_percent?: number | null;
        plan_total_percent?: number | null;
        measurable?: boolean;
        milestones?: number;
        verified_milestones?: number;
      }
    | undefined;
  if (!row) return err('NOT_FOUND', 'Project not found.');

  // Shaped by `toLadderProgress`, which the page's read also goes through.
  // The gate and the unmeasurable rule live there, once, so the two doors
  // onto this row cannot drift apart.
  return ok(toLadderProgress(row));
}

/**
 * Finance §9 — the ₹0 invoice for maintenance that was included, not sold.
 *
 * *"No Admin payment verification is required because payable amount is ₹0."*
 * That sentence reads like an exemption from ADM-04, and it is not one. G-007
 * made `status = 'paid'` follow `verified_minor >= total_minor`; at a total of
 * zero that is already true, of nothing. **Nothing is being skipped, because
 * nobody claimed any money arrived.**
 *
 * The door takes no amount — there is no argument here or in the SQL that
 * could make the invoice non-zero — so this cannot become a way of marking a
 * real bill paid without an Admin.
 *
 * The number comes from the same sequence every other invoice uses. A separate
 * numbering series for free invoices would be a second sequence to keep
 * gap-free, and §9 asks for an invoice, not a different kind of document.
 */
export async function issueFreeMaintenanceInvoice(
  planId: string,
): Promise<Result<{ invoiceId: string; number: string; issued: boolean }>> {
  const context = await requireInternal();
  if (!can(context.role, 'invoice.create')) {
    return err('FORBIDDEN', 'You do not have permission to raise invoices.');
  }

  const supabase = await createClient();
  const year = new Date().getUTCFullYear();
  const highest = await highestInvoiceSequence(supabase, year);

  for (let attempt = 0; attempt < NUMBER_ATTEMPTS; attempt += 1) {
    const number = nextInvoiceNumber(year, highest, attempt);

    const { data, error } = await supabase
      .schema('finance')
      .rpc('issue_free_maintenance_invoice', { p_plan_id: planId, p_number: number });

    if (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          scope: 'issueFreeMaintenanceInvoice',
          detail: error.message,
        }),
      );
      return err('INTERNAL', 'Could not raise the free-maintenance invoice.');
    }

    const row = (Array.isArray(data) ? data[0] : data) as
      | { outcome?: string; invoice_id?: string | null; number?: string | null }
      | undefined;

    switch (row?.outcome ?? 'no answer') {
      case 'issued':
        return ok({ invoiceId: row!.invoice_id!, number: row!.number!, issued: true });
      case 'already_issued':
        // Not an error: clicking twice is not a mistake, and the second click
        // must not raise a second zero-rupee document.
        return ok({ invoiceId: row!.invoice_id!, number: row!.number!, issued: false });
      case 'number_taken':
        // The only retryable answer, and the same loop create_milestone_invoice
        // runs for the same reason.
        continue;
      case 'not_free':
        return err(
          'CONFLICT',
          'This maintenance plan is not recorded as included with the project, so it is billed the ordinary way.',
        );
      case 'payment_incomplete':
        // §8: Phase 7 starts only at 100% verified, so Phase 7 cannot have
        // completed. A refund puts a project back here (G-264).
        return err(
          'CONFLICT',
          'The project is not fully paid and verified yet, so Phase 7 cannot have completed.',
        );
      case 'unknown_plan':
        return err('NOT_FOUND', 'Maintenance plan not found.');
      default:
        return err('INTERNAL', 'Could not raise the free-maintenance invoice.');
    }
  }

  return err('CONFLICT', 'Could not allocate an invoice number. Try again.');
}

/**
 * Records an internal cost — SCR-055, finance.expenses (20260921150000).
 *
 * `invoice.issue` (owner, ops_admin) rather than a new capability: exactly
 * the two roles `finance.expenses_write`'s RLS policy admits via
 * `core.is_admin()`, and the same pair that may issue an invoice — this is
 * the other half of the same "who may write a financial fact" question.
 * Deliberately not `invoice.read`, which the finance role also holds: G-314
 * built that role to READ money, and this is a write.
 */
export async function recordExpense(input: RecordExpenseInput): Promise<Result<{ expenseId: string }>> {
  const parsed = recordExpenseSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid expense.');
  }

  const context = await requireInternal();
  if (!can(context.role, 'invoice.issue')) {
    return err('FORBIDDEN', 'You do not have permission to record an expense.');
  }
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('finance')
    .from('expenses')
    .insert({
      organization_id: context.organizationId,
      project_id: parsed.data.projectId ?? null,
      category: parsed.data.category,
      vendor: parsed.data.vendor ?? null,
      description: parsed.data.description,
      amount_minor: parsed.data.amountMinor,
      currency: parsed.data.currency ?? 'INR',
      incurred_on: parsed.data.incurredOn,
      recorded_by: context.userId,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordExpense', detail: error?.message }));
    return err('INTERNAL', 'Could not record the expense.');
  }

  return ok({ expenseId: data.id });
}
