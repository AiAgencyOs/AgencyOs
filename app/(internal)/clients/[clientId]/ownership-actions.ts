'use server';

import { revalidatePath } from 'next/cache';

import { setClientOwner, setClientTags } from '@/lib/admin/client-ownership';
import type { FormState } from '@/modules/identity/types';

/** SCR-014 — tags, typed comma-separated. */
export async function setClientTagsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const clientAccountId = String(formData.get('clientAccountId') ?? '');
  const tags = String(formData.get('tags') ?? '')
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
  const result = await setClientTags({ clientAccountId, tags });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/clients/${clientAccountId}`);
  revalidatePath('/clients');
  return { status: 'success', message: result.data.tags.length === 0 ? 'Tags cleared.' : `${result.data.tags.length} tag${result.data.tags.length === 1 ? '' : 's'} saved.` };
}

/** SCR-014 — the relationship owner; an empty choice clears it. */
export async function setClientOwnerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const clientAccountId = String(formData.get('clientAccountId') ?? '');
  const ownerId = String(formData.get('ownerId') ?? '').trim();
  const result = await setClientOwner({ clientAccountId, ownerId: ownerId === '' ? null : ownerId });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/clients/${clientAccountId}`);
  revalidatePath('/clients');
  return { status: 'success', message: result.data.ownerId ? 'Owner set.' : 'Owner cleared.' };
}
