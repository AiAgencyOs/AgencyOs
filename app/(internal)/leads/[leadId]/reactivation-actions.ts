'use server';

import { revalidatePath } from 'next/cache';

import { enrollLeadInReactivation, removeLeadFromReactivation } from '@/lib/admin/reactivation-cohort';
import type { FormState } from '@/modules/identity/types';

/**
 * Server Actions for the lead-page reactivation cohort control. Thin, like the
 * Settings actions: the capability check, the consent rule and the audit all
 * live in `@/lib/admin/reactivation-cohort` and the database beneath it. Every
 * refusal — a missing consent row above all — is surfaced as written.
 */

export async function enrollLeadAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const leadId = String(formData.get('leadId') ?? '');
  const result = await enrollLeadInReactivation(leadId);
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/leads/${leadId}`);
  return { status: 'success', message: 'Lead enrolled in the reactivation cohort.' };
}

export async function removeLeadAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const leadId = String(formData.get('leadId') ?? '');
  const result = await removeLeadFromReactivation(leadId);
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/leads/${leadId}`);
  return { status: 'success', message: 'Lead removed from the reactivation cohort.' };
}
