'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { sendInvoiceByEmail } from './email-send-service';

/** SCR-051 — the invoice page's "Send by email" form. */
export async function sendInvoiceEmailAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  const result = await sendInvoiceByEmail({
    invoiceId: text('invoiceId'),
    to: text('to'),
    kind: text('kind') === 'reminder' ? 'reminder' : 'sent',
    ...(text('note') ? { note: text('note') } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/invoices/${text('invoiceId')}`);
  revalidatePath('/invoices');
  return {
    status: 'success',
    message: `Sent through ${result.data.transport === 'resend' ? 'Resend' : 'SMTP'}${result.data.messageRef ? ` (ref ${result.data.messageRef})` : ''} and recorded.`,
  };
}
