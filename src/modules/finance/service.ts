import 'server-only';

import { recordAudit } from '@/lib/audit';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import type { createAdminClient } from '@/lib/db/admin';
import { createClient } from '@/lib/db/server';
import { emitEvent } from '@/lib/events';
import { err, ok, type Result } from '@/lib/result';
import { getBillableMilestone, listMilestonesForBilling } from '@/modules/projects/service';

import { listProjectInvoices } from './queries';
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
  voidInvoiceSchema,
  INVOICE_TRANSITIONS,
  MANUAL_PAYMENT_PROVIDER,
  type GenerateMilestoneInvoiceInput,
  type InvoiceStatus,
  type IssueInvoiceInput,
  type MilestoneBillingEntry,
  type RecordManualPaymentInput,
  type VoidInvoiceInput,
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

/** How many times to retry when two writers pick the same invoice number. */
const NUMBER_ATTEMPTS = 5;

/** Postgres unique violation. */
const UNIQUE_VIOLATION = '23505';

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
 * cannot, and the 23505 handler turns that loss into the same answer the
 * winner got. Calling this ten times in parallel produces one invoice and ten
 * identical results.
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

  const lines = milestoneInvoiceLines({
    name: milestone.name,
    amountMinor: milestone.amountMinor,
    paymentPercent: milestone.paymentPercent,
    position: milestone.position,
    projectName: milestone.projectName,
  });
  const totals = invoiceTotals(lines);

  const year = new Date().getUTCFullYear();
  const highest = await highestInvoiceSequence(supabase, year);

  let invoiceId: string | null = null;
  let number = '';

  for (let attempt = 0; attempt < NUMBER_ATTEMPTS; attempt += 1) {
    number = nextInvoiceNumber(year, highest, attempt);

    const { data, error } = await supabase
      .schema('finance')
      .from('invoices')
      .insert({
        organization_id: milestone.organizationId,
        client_account_id: milestone.clientAccountId,
        project_id: milestone.projectId,
        milestone_id: milestone.milestoneId,
        number,
        status: 'draft',
        currency: milestone.currency,
        subtotal_minor: totals.subtotalMinor,
        tax_minor: totals.taxMinor,
        total_minor: totals.totalMinor,
        due_at: dueAt(milestone.dueOn, parsed.data.dueInDays),
        notes: parsed.data.notes ?? null,
      })
      .select('id')
      .single();

    if (!error && data) {
      invoiceId = data.id;
      break;
    }

    if (error?.code !== UNIQUE_VIOLATION) {
      console.error(
        JSON.stringify({
          level: 'error',
          scope: 'generateInvoiceFromMilestone',
          detail: error?.message,
        }),
      );
      return err('INTERNAL', 'Could not create the invoice.');
    }

    // Either another request just invoiced this milestone, or it took the
    // number we wanted. The first is the answer; the second is a retry.
    const raced = await findLiveInvoiceForMilestone(supabase, milestone.milestoneId);
    if (raced) return ok({ invoiceId: raced.id, number: raced.number, created: false });
  }

  if (!invoiceId) {
    return err('CONFLICT', 'Could not allocate an invoice number. Please try again.');
  }

  // Bound to a const so the closures below see a string rather than the
  // still-nullable `let` the retry loop needs.
  const createdInvoiceId = invoiceId;

  const { error: itemsError } = await supabase
    .schema('finance')
    .from('invoice_items')
    .insert(
      lines.map((line) => ({
        organization_id: milestone.organizationId,
        invoice_id: createdInvoiceId,
        position: line.position,
        description: line.description,
        quantity: line.quantity,
        unit_price_minor: line.unitPriceMinor,
        amount_minor: line.amountMinor,
        tax_rate_bp: line.taxRateBp,
      })),
    );

  if (itemsError) {
    // An invoice with a total and no lines is worse than no invoice: it would
    // occupy the milestone's one live slot and read as a real bill. Roll it
    // back rather than leave that behind.
    await supabase.schema('finance').from('invoices').delete().eq('id', createdInvoiceId);

    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'generateInvoiceFromMilestone',
        detail: itemsError.message,
      }),
    );
    return err('INTERNAL', 'Could not add the invoice lines.');
  }

  await recordAudit({
    organizationId: milestone.organizationId,
    action: 'invoice.created',
    subjectType: 'invoice',
    subjectId: createdInvoiceId,
    after: {
      number,
      milestoneId: milestone.milestoneId,
      projectId: milestone.projectId,
      clientAccountId: milestone.clientAccountId,
      totalMinor: totals.totalMinor,
      currency: milestone.currency,
    },
  });

  await emitEvent({
    organizationId: milestone.organizationId,
    type: 'invoice.created',
    subjectType: 'invoice',
    subjectId: createdInvoiceId,
    payload: {
      number,
      milestoneId: milestone.milestoneId,
      projectId: milestone.projectId,
      totalMinor: totals.totalMinor,
      currency: milestone.currency,
    },
  });

  return ok({ invoiceId: createdInvoiceId, number, created: true });
}

// ── issue ──────────────────────────────────────────────────────────────────

/** The row `finance.issue_invoice` returns. */
type IssueInvoiceRow = {
  outcome: 'issued' | 'not_found' | 'already_issued' | 'not_issuable' | 'no_amount' | 'no_items';
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
  const invoice = await loadInvoice(supabase, parsed.data.invoiceId);
  if (!invoice) return err('NOT_FOUND', 'Invoice not found.');

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
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'issueInvoice',
        detail: `unrecognised outcome "${settled.outcome}"`,
      }),
    );
    return err('INTERNAL', 'Could not issue the invoice.');
  }

  await recordAudit({
    organizationId: invoice.organization_id,
    action: 'invoice.issued',
    subjectType: 'invoice',
    subjectId: invoice.id,
    // From the locked read, not the one taken before it.
    before: { status: settled.invoice_status ?? from },
    after: { status: 'issued' },
  });

  await emitEvent({
    organizationId: invoice.organization_id,
    type: 'invoice.issued',
    subjectType: 'invoice',
    subjectId: invoice.id,
    payload: {
      number: invoice.number,
      clientAccountId: invoice.client_account_id,
      projectId: invoice.project_id,
      milestoneId: invoice.milestone_id,
      totalMinor: invoice.total_minor,
      currency: invoice.currency,
    },
  });

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
  const invoice = await loadInvoice(supabase, parsed.data.invoiceId);
  if (!invoice) return err('NOT_FOUND', 'Invoice not found.');

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

  // Reconciled from the payments themselves rather than incremented, so a
  // retry after a failed update lands on the same number instead of adding to
  // it. The payment rows are the ledger; paid_minor is a cached sum of them.
  const reconciled = await reconcileInvoiceTotals(supabase, {
    invoiceId: invoice.id,
    totalMinor: invoice.total_minor,
    currentStatus: invoice.status as InvoiceStatus,
  });
  if (!reconciled.ok) return reconciled;

  await recordAudit({
    organizationId: invoice.organization_id,
    action: 'payment.recorded',
    subjectType: 'invoice',
    subjectId: invoice.id,
    // From the locked read, not the one taken before it: under a concurrent
    // receipt the earlier number is already out of date by the time this lands.
    // `coalesce(sum(...), 0)` in the function means the 'recorded' outcome
    // always carries a number, so there is nothing to fall back to.
    before: { paidMinor: settled.captured_before_minor, status: invoice.status },
    after: {
      paidMinor: reconciled.data.paidMinor,
      status: reconciled.data.status,
      amountMinor: parsed.data.amountMinor,
      method: parsed.data.method,
      reference: parsed.data.reference,
      provider: MANUAL_PAYMENT_PROVIDER,
    },
  });

  const unlockedMilestoneId = reconciled.data.fullyPaid
    ? await resolveUnlockedMilestone(invoice.project_id)
    : null;

  await emitEvent({
    organizationId: invoice.organization_id,
    type: 'payment.recorded',
    subjectType: 'invoice',
    subjectId: invoice.id,
    payload: {
      provider: MANUAL_PAYMENT_PROVIDER,
      amountMinor: parsed.data.amountMinor,
      currency: invoice.currency,
      paidMinor: reconciled.data.paidMinor,
      totalMinor: invoice.total_minor,
    },
  });

  if (reconciled.data.fullyPaid) {
    // The signal the delivery side will subscribe to. Everything a handler
    // needs to advance the project is in the payload, so it never has to guess
    // which milestone a payment belonged to.
    await emitEvent({
      organizationId: invoice.organization_id,
      type: 'invoice.paid',
      subjectType: 'invoice',
      subjectId: invoice.id,
      payload: {
        number: invoice.number,
        clientAccountId: invoice.client_account_id,
        projectId: invoice.project_id,
        milestoneId: invoice.milestone_id,
        unlockedMilestoneId,
        paidMinor: reconciled.data.paidMinor,
        currency: invoice.currency,
      },
    });
  }

  return ok({
    status: reconciled.data.status,
    paidMinor: reconciled.data.paidMinor,
    fullyPaid: reconciled.data.fullyPaid,
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
  const invoice = await loadInvoice(supabase, parsed.data.invoiceId);
  if (!invoice) return err('NOT_FOUND', 'Invoice not found.');

  const from = invoice.status as InvoiceStatus;
  if (from === 'void') return ok({ status: from });
  if (!INVOICE_TRANSITIONS[from]?.includes('void')) {
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

  await recordAudit({
    organizationId: invoice.organization_id,
    action: 'invoice.voided',
    subjectType: 'invoice',
    subjectId: invoice.id,
    // From the locked read, not the one taken before it: under a concurrent
    // write the earlier status is already out of date by the time this lands.
    before: { status: settled.invoice_status ?? from },
    after: { status: 'void', reason: parsed.data.reason },
  });

  await emitEvent({
    organizationId: invoice.organization_id,
    type: 'invoice.voided',
    subjectType: 'invoice',
    subjectId: invoice.id,
    payload: { number: invoice.number, milestoneId: invoice.milestone_id, reason: parsed.data.reason },
  });

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

async function loadInvoice(supabase: SupabaseClient, invoiceId: string) {
  const { data, error } = await supabase
    .schema('finance')
    .from('invoices')
    .select(INVOICE_COLUMNS)
    .eq('id', invoiceId)
    .maybeSingle();

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'loadInvoice', detail: error.message }));
    return null;
  }
  return data;
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

/** Recomputes an invoice's paid state from its payments and stores it. */
async function reconcileInvoiceTotals(
  supabase: SupabaseClient,
  invoice: { invoiceId: string; totalMinor: number; currentStatus: InvoiceStatus },
): Promise<Result<{ paidMinor: number; status: InvoiceStatus; fullyPaid: boolean }>> {
  const captured = await capturedTotal(supabase, invoice.invoiceId);
  // Nothing is written on an unreadable ledger. The payment this reconcile
  // follows is already committed and the rows are intact; a cache left stale
  // is recoverable, a cache overwritten with a fabricated zero is not.
  if (!captured.ok) {
    return err(
      'INTERNAL',
      'The payment was recorded but the invoice total could not be updated. Re-open the invoice to retry.',
    );
  }

  const paidMinor = captured.data;
  const fullyPaid = paidMinor >= invoice.totalMinor;

  // Nothing captured leaves the status alone: an overdue invoice with no
  // payments is still overdue, and reconciliation must not quietly un-flag it.
  const status: InvoiceStatus = fullyPaid
    ? 'paid'
    : paidMinor > 0
      ? 'partially_paid'
      : invoice.currentStatus;

  const { error } = await supabase
    .schema('finance')
    .from('invoices')
    .update({
      paid_minor: paidMinor,
      status,
      // The table refuses status = 'paid' without paid_at, which is the schema
      // making the same point: "paid" is a moment, not just a flag.
      ...(fullyPaid ? { paid_at: new Date().toISOString() } : {}),
    })
    .eq('id', invoice.invoiceId);

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'reconcileInvoiceTotals', detail: error.message }),
    );
    return err(
      'INTERNAL',
      'The payment was recorded but the invoice total could not be updated. Re-open the invoice to retry.',
    );
  }

  return ok({ paidMinor, status, fullyPaid });
}

/**
 * The next milestone whose payment gate has just opened.
 *
 * Derived from the plan and its invoices every time, never stored. See
 * `nextUnlockedMilestone` for why the rule lives in schema.ts and why it is
 * advisory rather than enforced.
 */
async function resolveUnlockedMilestone(projectId: string | null): Promise<string | null> {
  if (!projectId) return null;

  const [milestones, invoices] = await Promise.all([
    listMilestonesForBilling(projectId),
    listProjectInvoices(projectId),
  ]);

  return nextUnlockedMilestone(
    billingEntries(
      milestones.map((m) => ({
        id: m.id,
        position: m.position,
        payment_percent: m.payment_percent,
      })),
      invoices.map((i) => ({ milestone_id: i.milestone_id, status: i.status })),
    ),
  )?.milestoneId ?? null;
}

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
): Promise<string | null> {
  const [{ data: milestones }, { data: invoices }] = await Promise.all([
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

  return nextUnlockedMilestone(billingEntries(milestones ?? [], invoices ?? []))?.milestoneId ?? null;
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
