'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { commitImportRecord } from '@/lib/import/commit';
import { stageUploadedExport } from '@/lib/import/upload';
import type { FormState } from '@/modules/identity/types';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // a _chat.txt is small; 10MB is generous

/**
 * Upload a WhatsApp export from the browser and STAGE it — the Admin entry to
 * the same pipeline the CLI loader uses. The capability check, tenant derivation
 * and every safety rule live in `@/lib/import/upload`; this only unwraps the
 * file. On success it navigates to the staged batch's preview, where the owner
 * reviews and commits. Nothing is imported or sent here.
 */
export async function uploadImportAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { status: 'error', message: 'Choose a WhatsApp export (the extracted _chat.txt) to upload.' };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { status: 'error', message: 'That file is too large (max 10MB). Upload the _chat.txt only, not the media.' };
  }
  const text = await file.text();
  const result = await stageUploadedExport(text, file.name);
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/import');
  redirect(`/import/${result.data.batchId}`);
}

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

/**
 * A whole batch into the reactivation cohort, one bounded pass — G-219.
 *
 * The single-record button below is right for one lead and wrong for twelve
 * hundred: a campaign against a batch is ONE decision, and making an operator
 * take it twelve hundred times is how the eleven-hundredth gets taken without
 * being read.
 *
 * Every refusal is reported by name — who lacks consent, who is already a
 * client — because an operator who asked to enrol a hundred and enrolled
 * forty needs to know which forty and why.
 */
export async function enrolBatchAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { enrolReactivationBatch } = await import('@/lib/admin/reactivation-cohort');
  const batchId = String(formData.get('batch_id') ?? '').trim();

  const result = await enrolReactivationBatch(batchId);
  if (!result.ok) return { status: 'error', message: result.error.message };

  const { enrolled, alreadyIn, noConsent, notContactable, remaining } = result.data;
  const refused = [
    noConsent > 0 ? `${noConsent} never wrote to you, so there is no consent to infer` : null,
    notContactable > 0 ? `${notContactable} are already a client or a live deal` : null,
    alreadyIn > 0 ? `${alreadyIn} were already enrolled` : null,
  ].filter(Boolean);

  revalidatePath(`/import/${batchId}`);
  return {
    status: 'success',
    message:
      `Enrolled ${enrolled}.` +
      (refused.length > 0 ? ` Not enrolled: ${refused.join('; ')}.` : '') +
      (remaining > 0 ? ` ${remaining} still to go — run it again.` : '') +
      ' Nothing has been sent: the 24-hour window, an approved template and your outreach limits all still apply.',
  };
}

export async function withdrawBatchAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { withdrawReactivationBatch } = await import('@/lib/admin/reactivation-cohort');
  const batchId = String(formData.get('batch_id') ?? '').trim();

  const result = await withdrawReactivationBatch(batchId);
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/import/${batchId}`);
  return {
    status: 'success',
    message: `Took ${result.data.withdrawn} back out of the reactivation cohort.`,
  };
}
