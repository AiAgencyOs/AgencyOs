'use server';

import { revalidatePath } from 'next/cache';

import { commitImportRecord } from '@/lib/import/commit';
import type { FormState } from '@/modules/identity/types';

/**
 * Server Action for committing one staged import record. Thin: the capability
 * check, every safety rule and the audit live in `@/lib/import/commit` and the
 * database beneath it. Every refusal — a name-only row above all — is surfaced
 * as written.
 */
export async function commitRecordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const recordId = String(formData.get('recordId') ?? '');
  const batchId = String(formData.get('batchId') ?? '');
  const result = await commitImportRecord(recordId);
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/import/${batchId}`);
  return { status: 'success', message: 'Committed to a contact + lead. No consent was set; nothing was sent.' };
}
