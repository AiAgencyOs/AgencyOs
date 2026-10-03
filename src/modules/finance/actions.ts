'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { FormState } from '@/modules/identity/types';

import { parseMinorUnits, PAYMENT_ACCOUNT_FIELDS, PAYMENT_ACCOUNT_KINDS, type PaymentAccountKind } from './schema';
import {
  composeInvoice,
  confirmBillingMode,
  generateInvoiceFromMilestone,
  issueFreeMaintenanceInvoice,
  issueInvoice,
  recordBillingDetails,
  recordManualPayment,
  recordPaymentSubmission,
  verifyPayment,
  verifyPaymentSubmission,
  recordRefund,
  requestPaymentEvidence,
  requestRefund,
  voidInvoice,
  recordExpense,
  createPaymentAccount,
  setPaymentAccountStatus,
  updateExpense,
} from './service';

/** Server Actions for milestone billing — thin wrappers over service.ts. */

function revalidateInvoice(invoiceId: string, projectId?: string) {
  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/invoices/verify');
  if (projectId) revalidatePath(`/projects/${projectId}`);
}

/**
 * Generates the draft invoice for a milestone.
 *
 * A second submission is not an error and is not reported as one: the service
 * returns the invoice that already exists, and the message says so. Telling a
 * user their double-click "failed" when it in fact did exactly the right thing
 * is how people end up creating a duplicate on purpose.
 */
export async function generateMilestoneInvoiceAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const dueInDays = String(formData.get('dueInDays') ?? '').trim();

  const result = await generateInvoiceFromMilestone({
    milestoneId: String(formData.get('milestoneId') ?? ''),
    ...(dueInDays ? { dueInDays: Number(dueInDays) } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateInvoice(result.data.invoiceId, projectId);
  return {
    status: 'success',
    message: result.data.created
      ? `Draft ${result.data.number} created.`
      : `This milestone is already invoiced as ${result.data.number}.`,
  };
}

export async function issueInvoiceAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const invoiceId = String(formData.get('invoiceId') ?? '');
  const dueOn = String(formData.get('dueOn') ?? '').trim();

  const result = await issueInvoice({
    invoiceId,
    ...(dueOn ? { dueOn } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateInvoice(invoiceId, String(formData.get('projectId') ?? '') || undefined);
  return {
    status: 'success',
    message: `${result.data.number} issued. It is now visible to the client in their portal.`,
  };
}

/**
 * Records a payment that has already been received.
 *
 * The wording of every message here matters: nothing in this flow collects
 * money, and the UI must not imply that it did.
 */
export async function recordManualPaymentAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const invoiceId = String(formData.get('invoiceId') ?? '');

  // The form takes major units because that is what a bank statement shows.
  // The conversion is exact and happens here, once, before anything else in
  // the system sees the number.
  const amountMinor = parseMinorUnits(String(formData.get('amountMajor') ?? ''));
  if (amountMinor === null) {
    return { status: 'error', message: 'Enter the amount received, e.g. 45000 or 45000.50.' };
  }

  const result = await recordManualPayment({
    invoiceId,
    amountMinor,
    method: String(formData.get('method') ?? '') as never,
    reference: String(formData.get('reference') ?? ''),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateInvoice(invoiceId, String(formData.get('projectId') ?? '') || undefined);

  return {
    status: 'success',
    message: result.data.fullyPaid
      ? result.data.unlockedMilestoneId
        ? 'Payment recorded. Invoice paid in full — the next milestone is now clear to bill.'
        : 'Payment recorded. Invoice paid in full.'
      : 'Payment recorded. The invoice is partially paid.',
  };
}

export async function voidInvoiceAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const invoiceId = String(formData.get('invoiceId') ?? '');

  const result = await voidInvoice({
    invoiceId,
    reason: String(formData.get('reason') ?? ''),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateInvoice(invoiceId, String(formData.get('projectId') ?? '') || undefined);
  return {
    status: 'success',
    message: 'Invoice voided. The milestone can be invoiced again.',
  };
}

/**
 * Ask for a refund — gap G-005.
 *
 * The amount arrives in major units because that is what a person types, and
 * is converted once, here, by the same parser every other money field uses.
 * Nothing leaves the business on this action: it raises the approval that
 * must be answered first.
 */
export async function requestRefundAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const invoiceId = String(formData.get('invoiceId') ?? '');
  // Major units in, minor units out — the same parser every other money field
  // on this screen uses, so a refund and a payment cannot disagree about what
  // "1,500.50" means. It answers null rather than throwing.
  const amountMinor = parseMinorUnits(String(formData.get('amountMajor') ?? ''));

  if (amountMinor === null) {
    return {
      status: 'error',
      message: 'That is not an amount.',
      fieldErrors: { amountMajor: ['Something like 1500 or 1500.50'] },
    };
  }

  const result = await requestRefund({
    invoiceId,
    amountMinor,
    reason: String(formData.get('reason') ?? ''),
  });

  if (!result.ok) {
    return {
      status: 'error',
      message: result.error.message,
      ...(result.error.details ? { fieldErrors: result.error.details } : {}),
    };
  }

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/approvals');

  return {
    status: 'success',
    message: 'Requested. It needs an owner’s approval before any money moves.',
  };
}

/** Record that an approved refund actually left the account. */
export async function recordRefundAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const invoiceId = String(formData.get('invoiceId') ?? '');

  const result = await recordRefund({
    refundId: String(formData.get('refundId') ?? ''),
    providerRefundId: String(formData.get('providerRefundId') ?? ''),
  });

  if (!result.ok) {
    return {
      status: 'error',
      message: result.error.message,
      ...(result.error.details ? { fieldErrors: result.error.details } : {}),
    };
  }

  revalidatePath(`/invoices/${invoiceId}`);

  return { status: 'success', message: 'Recorded.' };
}

/**
 * Finance §9 — the ₹0 invoice for maintenance that was included.
 *
 * A second submission is not an error, for the same reason drafting a
 * milestone invoice twice is not: the service returns the document that
 * already exists and the message says so.
 */
export async function issueFreeMaintenanceInvoiceAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await issueFreeMaintenanceInvoice(String(formData.get('planId') ?? ''));

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateInvoice(result.data.invoiceId, projectId);
  return {
    status: 'success',
    message: result.data.issued
      ? `Raised ${result.data.number} at ₹0. Nothing is owed and no verification is needed — send it to the client yourself.`
      : `${result.data.number} was already raised for this plan.`,
  };
}

/**
 * Confirms that recorded money actually arrived — ADM-04, G-007; G-270.
 *
 * `verifyPayment` was written in August, tested, and **never given a caller**.
 * So since G-007 made `status = 'paid'` follow confirmed money, no invoice in
 * AgencyOS could ever become paid: money could be recorded and nothing in the
 * product could confirm it. Everything downstream waits on this — ADM-13's
 * advance condition, the milestone unlock, the Phase 7 gate.
 *
 * A second click is not an error. Two people reading the same bank statement
 * should not fight, and the service already answers the second one with the
 * same picture and `changed: false`.
 */
export async function verifyPaymentAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const invoiceId = String(formData.get('invoiceId') ?? '');

  const result = await verifyPayment({ paymentId: String(formData.get('paymentId') ?? '') });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateInvoice(invoiceId, String(formData.get('projectId') ?? '') || undefined);

  const receiptNote = result.data.receiptNumber ? ` Receipt ${result.data.receiptNumber}.` : '';

  if (!result.data.changed) {
    return { status: 'success', message: `Already confirmed by somebody else.${receiptNote}` };
  }
  return {
    status: 'success',
    message: `${
      result.data.fullyPaid
        ? 'Confirmed. The invoice is fully paid and the next milestone is open.'
        : 'Confirmed. The invoice is not fully covered yet.'
    }${receiptNote}`,
  };
}

/**
 * Billing mode and billing details — Finance §4.1–§4.3, Master §5.6; G-275.
 *
 * G-255 built both doors and G-259 made `generateInvoiceFromMilestone` refuse
 * until a mode is confirmed. **Neither door had a caller**, so the refusal
 * named an action the product did not offer: every invoice would have been
 * blocked with a message telling somebody to do something they could not do.
 */
export async function confirmBillingModeAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await confirmBillingMode({
    projectId,
    mode: String(formData.get('mode') ?? '') as never,
    source: String(formData.get('source') ?? 'client_confirmation') as never,
    note: String(formData.get('note') ?? '').trim() || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}`);
  if (!result.data.changed) {
    // §4.3 calls a repeated confirmation not a legitimate change, so it does
    // not get a new version and is not reported as one.
    return { status: 'success', message: 'Already recorded — nothing changed.' };
  }
  return {
    status: 'success',
    message:
      result.data.mode === 'gst'
        ? `Recorded as GST billing (v${result.data.version}). 18% is added to every invoice from now on.`
        : `Recorded as Non-GST billing (v${result.data.version}). No tax is added.`,
  };
}

export async function recordBillingDetailsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const field = (key: string) => String(formData.get(key) ?? '').trim() || undefined;

  const result = await recordBillingDetails({
    projectId,
    legalName: field('legalName'),
    billingAddress: field('billingAddress'),
    billingState: field('billingState'),
    gstin: field('gstin'),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}`);
  return {
    status: 'success',
    message: result.data.changed
      ? `Saved as v${result.data.version}.`
      : 'Already recorded — nothing changed.',
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The claim layer — Doc 15 §11 and §12; G-272.
 *
 * The table, the guard, the door and §4.7's three decisions were built and
 * **nothing in the application touched any of it**, on either side. The verify
 * half was deliberately not built alone: a queue that nothing can put a claim
 * into is an always-empty list, which is the same defect wearing a page.
 *
 * A claim is what somebody SAID. It moves no money — `recordManualPayment`
 * writes the ledger — and confirming one is not paying it.
 * ──────────────────────────────────────────────────────────────────────────── */

export async function recordPaymentSubmissionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  const amount = parseMinorUnits(text('amount'));
  if (amount === null) return { status: 'error', message: 'That is not an amount.' };

  const result = await recordPaymentSubmission({
    invoiceId: text('invoiceId'),
    amountMinor: amount,
    method: text('method') as never,
    ...(text('reference') === '' ? {} : { reference: text('reference') }),
    ...(text('payerName') === '' ? {} : { payerName: text('payerName') }),
    ...(text('paidAt') === '' ? {} : { paidAt: new Date(text('paidAt')).toISOString() }),
    ...(text('proofUrl') === '' ? {} : { proofUrl: text('proofUrl') }),
  }, formData.get('proofFile') as File | null);

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateInvoice(text('invoiceId'), text('projectId') || undefined);
  return {
    status: 'success',
    // Said plainly, because the difference is the whole point of the layer:
    // recording what a client claimed is not recording that they paid.
    message: 'Claim recorded. Nothing has moved until somebody verifies it.',
  };
}

export async function verifyPaymentSubmissionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();

  const result = await verifyPaymentSubmission({
    submissionId: text('submissionId'),
    decision: text('decision') as never,
    ...(text('evidence') === '' ? {} : { evidence: text('evidence') }),
    ...(text('reason') === '' ? {} : { reason: text('reason') }),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateInvoice(text('invoiceId'), text('projectId') || undefined);

  const message =
    result.data.status === 'verified'
      ? // Verifying is not paying: the ledger row is still a separate act, and
        // saying "recorded" here would claim money that has not moved.
        'Verified. Record the payment itself to move the invoice.'
      : result.data.status === 'mismatch'
        ? 'Recorded as a mismatch. It stays in the queue until it is resolved.'
        : 'Rejected.';
  return { status: 'success', message };
}

export async function recordExpenseAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  const amount = parseMinorUnits(text('amount'));
  if (amount === null) return { status: 'error', message: 'That is not an amount.' };

  const projectId = text('projectId');
  const vendor = text('vendor');

  const result = await recordExpense({
    category: text('category') as never,
    description: text('description'),
    amountMinor: amount,
    incurredOn: text('incurredOn'),
    ...(projectId ? { projectId } : {}),
    ...(vendor ? { vendor } : {}),
    ...(text('receiptUrl') ? { receiptUrl: text('receiptUrl') } : {}),
  }, formData.get('receiptFile') as File | null);

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/finance/expenses');
  return { status: 'success', message: 'Expense recorded.' };
}

/** SCR-057 — a receiving account the agency offers on its invoices (Doc 15 §9). */
export async function createPaymentAccountAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  const kindRaw = text('kind');
  if (!(PAYMENT_ACCOUNT_KINDS as readonly string[]).includes(kindRaw)) {
    return { status: 'error', message: 'Pick what kind of account this is.' };
  }
  const kind = kindRaw as PaymentAccountKind;

  const instructions: Record<string, string> = {};
  for (const field of PAYMENT_ACCOUNT_FIELDS[kind]) instructions[field.key] = text(`field_${field.key}`);

  const effectiveFrom = text('effectiveFrom');
  const result = await createPaymentAccount({
    kind,
    label: text('label'),
    instructions,
    ...(effectiveFrom ? { effectiveFrom } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/settings/finance');
  revalidatePath('/invoices');
  return { status: 'success', message: `"${result.data.label}" added — new invoices can name it.` };
}

export async function setPaymentAccountStatusAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const status = String(formData.get('status') ?? '') === 'inactive' ? 'inactive' : 'active';
  const result = await setPaymentAccountStatus({ accountId: String(formData.get('accountId') ?? ''), status });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/settings/finance');
  return {
    status: 'success',
    message: result.data.status === 'inactive' ? 'Account deactivated — it stays on the invoices that already name it.' : 'Account active again.',
  };
}

export async function updateExpenseAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  const amount = parseMinorUnits(text('amount'));
  if (amount === null) return { status: 'error', message: 'That is not an amount.' };

  const projectId = text('projectId');
  const vendor = text('vendor');

  const result = await updateExpense({
    expenseId: text('expenseId'),
    category: text('category') as never,
    description: text('description'),
    amountMinor: amount,
    incurredOn: text('incurredOn'),
    ...(projectId ? { projectId } : {}),
    ...(vendor ? { vendor } : {}),
    ...(text('receiptUrl') ? { receiptUrl: text('receiptUrl') } : {}),
  }, formData.get('receiptFile') as File | null);

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/finance/expenses');
  revalidatePath('/finance/tax');
  return { status: 'success', message: 'Expense updated.' };
}

/**
 * The composer's submit: a draft invoice from typed lines. The form posts the
 * lines as JSON text (`lines`) — text, never amounts: the service recomputes
 * every figure. On success it lands on the new invoice, where review and issue
 * are separate, audited steps.
 */
export async function composeInvoiceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let lines: unknown;
  try {
    lines = JSON.parse(String(formData.get('lines') ?? '[]'));
  } catch {
    return { status: 'error', message: 'The lines could not be read. Reload the page and try again.' };
  }
  const dueOn = String(formData.get('dueOn') ?? '').trim();
  const notes = String(formData.get('notes') ?? '').trim();

  const result = await composeInvoice({
    projectId: String(formData.get('projectId') ?? ''),
    lines: lines as { description: string; quantity: string; unitPrice: string }[],
    ...(dueOn ? { dueOn } : {}),
    ...(notes ? { notes } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/invoices');
  revalidatePath('/finance');
  redirect(`/invoices/${result.data.invoiceId}`);
}

/**
 * The verification queue's three buttons — PDF SCR-054: PAYMENT VERIFIED,
 * REJECT, NEED MORE EVIDENCE, plus a mismatch flag. One form, one note field
 * (what you checked / why / what is missing), four intents, each routed to its
 * own door — the same `verify_payment_submission` decision the project panel
 * uses, and `request_payment_evidence` for the fourth. Nothing here moves
 * money: a verified claim records that somebody checked it.
 */
export async function decideClaimAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  const intent = text('intent');
  const note = text('note');
  const submissionId = text('submissionId');

  if (intent === 'evidence') {
    const result = await requestPaymentEvidence({ submissionId, note });
    if (!result.ok) return { status: 'error', message: result.error.message };
    revalidateInvoice(text('invoiceId'), text('projectId') || undefined);
    return { status: 'success', message: 'Sent back for more evidence. It stays in the queue until somebody answers it.' };
  }

  const decision = intent === 'verify' ? 'confirm' : intent === 'mismatch' ? 'mismatch' : intent === 'reject' ? 'reject' : null;
  if (decision === null) return { status: 'error', message: 'Choose what to do with the claim.' };

  const result = await verifyPaymentSubmission({
    submissionId,
    decision,
    ...(decision === 'confirm' ? { evidence: note } : { reason: note }),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateInvoice(text('invoiceId'), text('projectId') || undefined);
  return {
    status: 'success',
    message:
      result.data.status === 'verified'
        ? 'Verified. Record the payment itself to move the invoice.'
        : result.data.status === 'mismatch'
          ? 'Recorded as a mismatch. It stays in the queue until it is resolved.'
          : 'Rejected.',
  };
}
