'use server';

import { revalidatePath } from 'next/cache';

import { issueCreditNote, linkReplacementInvoice, requestCreditNote } from '@/modules/finance/p1o-credit-notes';
import type { FormState } from '@/modules/identity/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

/** Rupees typed by a person to minor units, exactly (no float arithmetic on money). Returns null for anything that is not a plain amount. */
function minor(v: string): number | null {
  const m = v.match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

export async function requestCreditNoteAction(_prev: FormState, f: FormData): Promise<FormState> {
  const invoiceId = text(f, 'invoiceId');
  const amount = minor(text(f, 'amount'));
  const tax = minor(text(f, 'tax') || '0');
  if (!UUID.test(invoiceId)) return { status: 'error', message: 'Choose the invoice.' };
  if (amount === null || amount <= 0 || tax === null) return { status: 'error', message: 'Enter the amounts in rupees, like 1500 or 1500.50.' };
  const result = await requestCreditNote({ invoiceId, amountMinor: amount, taxMinor: tax, reason: text(f, 'reason') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/invoices/credit-notes');
  return { status: 'success', message: 'Requested. The owner approves it; then it can be issued.' };
}

export async function issueCreditNoteAction(_prev: FormState, f: FormData): Promise<FormState> {
  const result = await issueCreditNote(text(f, 'creditNoteId'));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/invoices/credit-notes');
  return { status: 'success', message: `Issued as ${result.data.number}.` };
}

export async function linkReplacementAction(_prev: FormState, f: FormData): Promise<FormState> {
  const result = await linkReplacementInvoice(text(f, 'creditNoteId'), text(f, 'invoiceId'));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/invoices/credit-notes');
  return { status: 'success', message: result.data };
}
