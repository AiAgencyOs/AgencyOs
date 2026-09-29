'use server';

import { revalidatePath } from 'next/cache';

import { recordManualOverride } from '@/lib/admin/overrides';
import type { FormState } from '@/modules/identity/types';

/** SCR-068 — record an exception with a reason where no domain door exists. Refusals are surfaced as written. */
export async function recordManualOverrideAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await recordManualOverride({
    subjectType: String(formData.get('subjectType') ?? ''),
    subjectId: String(formData.get('subjectId') ?? '').trim() || undefined,
    kind: String(formData.get('kind') ?? ''),
    reason: String(formData.get('reason') ?? ''),
    expiresAt: String(formData.get('expiresAt') ?? '').trim() || undefined,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/governance/overrides');
  return { status: 'success', message: `Exception ${result.data.id.slice(0, 8)} recorded with its reason. Audited.` };
}
