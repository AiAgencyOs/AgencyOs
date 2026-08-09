'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { parseMinorUnits } from './schema';
import {
  generateInvoiceFromMilestone,
  issueInvoice,
  recordManualPayment,
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
