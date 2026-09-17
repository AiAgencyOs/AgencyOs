'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { parseMinorUnits } from './schema';
import {
  generateInvoiceFromMilestone,
  issueFreeMaintenanceInvoice,
  issueInvoice,
  recordManualPayment,
  verifyPayment,
  recordRefund,
  requestRefund,
  voidInvoice,
} from './service';

/** Server Actions for milestone billing — thin wrappers over service.ts. */

function revalidateInvoice(invoiceId: string, projectId?: string) {
  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoiceId}`);
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

  if (!result.data.changed) {
    return { status: 'success', message: 'Already confirmed by somebody else.' };
  }
  return {
    status: 'success',
    message: result.data.fullyPaid
      ? 'Confirmed. The invoice is fully paid and the next milestone is open.'
      : 'Confirmed. The invoice is not fully covered yet.',
  };
}
