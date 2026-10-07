'use server';

import { revalidatePath } from 'next/cache';

import { handleMeetingFlag } from '@/modules/crm/p1o-scheduling-service';
import type { FormState } from '@/modules/identity/types';

/** Mark a scheduling flag handled, with a note. The meeting itself is not touched: moving or cancelling it uses the meeting's own controls. */
export async function handleMeetingFlagAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await handleMeetingFlag(String(formData.get('flagId') ?? ''), String(formData.get('note') ?? '').trim());
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/meetings/attention');
  return { status: 'success', message: result.data };
}
