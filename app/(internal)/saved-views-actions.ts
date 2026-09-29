'use server';

import { revalidatePath } from 'next/cache';

import { deleteSavedView, saveView } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import type { FormState } from '@/modules/identity/types';

/**
 * Shared Server Actions for the "saved views" bar, one instance per list
 * screen (see `src/ui/primitives/saved-views.tsx`). Not colocated with any
 * single route's own `actions.ts` because the feature itself is not
 * page-specific — `page` comes from the calling form, matching the pattern
 * `command-palette.tsx` already sets at this same level for cross-page UI.
 */

export async function saveViewAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const page = String(formData.get('page') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const query = String(formData.get('query') ?? '');

  if (!page || !name) {
    return { status: 'error', message: 'Name the view before saving it.' };
  }

  const context = await requireInternal();
  if (!context.organizationId) {
    return { status: 'error', message: 'No organization on this session.' };
  }

  await saveView(page, name, query, context.organizationId, context.userId);
  revalidatePath(page);

  return { status: 'success', message: `Saved "${name}".` };
}

export async function deleteSavedViewAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get('id') ?? '');
  const page = String(formData.get('page') ?? '');

  if (!id) {
    return { status: 'error', message: 'Missing view id.' };
  }

  await requireInternal();
  await deleteSavedView(id);
  if (page) revalidatePath(page);

  return { status: 'success', message: 'Removed.' };
}
