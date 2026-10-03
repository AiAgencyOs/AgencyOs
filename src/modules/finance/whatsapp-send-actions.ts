'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { sendInvoiceWhatsApp } from './whatsapp-send-service';

/**
 * "Send on WhatsApp" — SCR-051, owner decision 2026-09-29. The door decides
 * consent, the window and the provider; a refusal is shown as written. A
 * text that went with a PDF that did not is reported as exactly that.
 */
export async function sendInvoiceWhatsAppAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  const invoiceId = text('invoiceId');

  const result = await sendInvoiceWhatsApp({
    invoiceId,
    conversationId: text('conversationId'),
    ...(text('note') ? { note: text('note') } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoiceId}`);
  return {
    status: 'success',
    message: result.data.pdfDelivered
      ? 'Sent to the client on WhatsApp, with the PDF.'
      : `The invoice text reached the client; the PDF did not (${result.data.pdfReason ?? 'unknown reason'}). Recorded as sent with that note.`,
  };
}
