'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { sendClientMessage } from './service';

/**
 * SCR-017 — send a permitted message from Client 360 › Communication.
 *
 * The same door the Lead 360 composer uses (`sendClientMessage`): the row is
 * written first, `crm.send_outbound_message` refuses without consent, and
 * `planOutbound` refuses outside the 24-hour window unless an approved
 * template carries it. Only the picker is new. The idempotency key is minted
 * here, never taken from the form.
 */
export async function sendClientMessageFromClientAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const conversationId = String(formData.get('conversationId') ?? '');
  const leadId = String(formData.get('leadId') ?? '');
  const clientId = String(formData.get('clientId') ?? '');

  const result = await sendClientMessage({
    conversationId,
    body: String(formData.get('body') ?? ''),
    idempotencyKey: `out-${crypto.randomUUID()}`,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  if (leadId) revalidatePath(`/leads/${leadId}`);
  if (clientId) revalidatePath(`/clients/${clientId}`);
  return { status: 'success', message: 'Sent to the client.' };
}
