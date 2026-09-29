'use server';

import { revalidatePath } from 'next/cache';

import { addClientNote } from '@/lib/admin/clients';
import type { FormState } from '@/modules/identity/types';

export async function addClientNoteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const clientAccountId = String(formData.get('clientAccountId') ?? '');
  const result = await addClientNote({
    clientAccountId,
    body: String(formData.get('body') ?? ''),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/clients/${clientAccountId}`);
  return { status: 'success', message: 'Note added.' };
}
