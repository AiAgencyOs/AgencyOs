'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { resendCenterEmail, sendCenterEmail } from './email-service';

const text = (formData: FormData, name: string) => String(formData.get(name) ?? '').trim();

function revalidate() {
  revalidatePath('/communication');
  revalidatePath('/projects/[projectId]/activity', 'page');
}

/** SCR-057 — send an email or a client update; the provider's answer is recorded either way. */
export async function sendCenterEmailAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await sendCenterEmail({
    kind: text(formData, 'kind') === 'client_update' ? 'client_update' : 'email',
    to: text(formData, 'to'),
    subject: text(formData, 'subject'),
    body: text(formData, 'body'),
    ...(text(formData, 'projectId') ? { projectId: text(formData, 'projectId') } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidate();
  if (result.data.status === 'failed') return { status: 'error', message: `The provider refused it: ${result.data.reason}. It is recorded as failed below; send it again once that is fixed.` };
  return { status: 'success', message: `Sent through ${result.data.transport === 'resend' ? 'Resend' : 'SMTP'} and recorded.` };
}

/** SCR-057 / SCR-060 — "requeue with reason" for a failed email. */
export async function resendCenterEmailAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await resendCenterEmail({ emailId: text(formData, 'emailId'), reason: text(formData, 'reason') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidate();
  if (result.data.status === 'failed') return { status: 'error', message: `Sent again, and refused again: ${result.data.reason}.` };
  return { status: 'success', message: 'Sent again and recorded.' };
}
