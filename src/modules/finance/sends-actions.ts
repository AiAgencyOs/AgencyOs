'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { recordInvoiceSend } from './sends-service';

/**
 * "Record that it was sent" — SCR-051. The wording is the point: this writes
 * down a send somebody made on WhatsApp, by email or by hand. It sends
 * nothing.
 */
export async function recordInvoiceSendAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  const invoiceId = text('invoiceId');
  const sentAtRaw = text('sentAt');
  const sentAt = sentAtRaw ? new Date(sentAtRaw) : null;
  if (sentAt && Number.isNaN(sentAt.getTime())) {
    return { status: 'error', message: 'That is not a date.' };
  }

  const result = await recordInvoiceSend({
    invoiceId,
    kind: text('kind') as never,
    channel: text('channel') as never,
    ...(text('note') ? { note: text('note') } : {}),
    ...(text('messageRef') ? { messageRef: text('messageRef') } : {}),
    ...(sentAt ? { sentAt: sentAt.toISOString() } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoiceId}`);
  return {
    status: 'success',
    message: result.data.kind === 'reminder' ? 'Reminder recorded.' : 'Recorded as sent.',
  };
}
