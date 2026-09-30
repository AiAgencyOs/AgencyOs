'use server';

import { revalidatePath } from 'next/cache';

import { addClientTag, setClientOwner } from '@/lib/admin/client-ownership';
import type { FormState } from '@/modules/identity/types';

const MAX_BULK = 100;

/**
 * SCR-014's list-level "Assign relationship owner" and "Add tags": the
 * single-client doors (`setClientOwner`, `addClientTag` → `setClientTags`)
 * applied once per ticked client. Each door re-checks `project.write` and lets
 * RLS decide again, so the batch can never do what one row could not. The
 * outcome is said as counts plus the first refusal, never as a bare "done".
 */
export async function bulkClientAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ids = [...new Set(formData.getAll('id').map(String).filter(Boolean))].slice(0, MAX_BULK);
  const kind = String(formData.get('kind') ?? '');
  if (ids.length === 0) return { status: 'error', message: 'Tick at least one client.' };

  let done = 0;
  let firstError: string | null = null;
  if (kind === 'owner') {
    const ownerId = String(formData.get('ownerId') ?? '').trim();
    for (const clientAccountId of ids) {
      const r = await setClientOwner({ clientAccountId, ownerId: ownerId === '' ? null : ownerId });
      if (r.ok) done += 1;
      else firstError ??= r.error.message;
    }
  } else if (kind === 'tag') {
    const tag = String(formData.get('tag') ?? '');
    for (const clientAccountId of ids) {
      const r = await addClientTag({ clientAccountId, tag });
      if (r.ok) done += 1;
      else firstError ??= r.error.message;
    }
  } else {
    return { status: 'error', message: 'Choose an action.' };
  }

  revalidatePath('/clients');
  if (done === 0) return { status: 'error', message: firstError ?? 'Nothing was changed.' };
  const what = kind === 'owner' ? 'Owner set on' : 'Tag added to';
  return { status: firstError ? 'error' : 'success', message: `${what} ${done} of ${ids.length} client${ids.length === 1 ? '' : 's'}.${firstError ? ` Refused: ${firstError}` : ''}` };
}
