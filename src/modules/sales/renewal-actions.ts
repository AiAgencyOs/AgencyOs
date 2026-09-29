'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { openRenewal } from './renewal-service';
import type { RenewalKind } from './renewal-schema';

/** SCR-016 — "Start renewal / upsell" on Client 360. The value is typed in rupees. */
export async function openRenewalAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const clientAccountId = String(formData.get('clientAccountId') ?? '');
  const rupees = Number(String(formData.get('value') ?? '').trim() || '0');
  const result = await openRenewal({
    clientAccountId,
    projectId: String(formData.get('projectId') ?? ''),
    kind: String(formData.get('kind') ?? '') as RenewalKind,
    name: String(formData.get('name') ?? ''),
    valueMinor: Number.isFinite(rupees) && rupees >= 0 ? Math.round(rupees * 100) : 0,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/clients/${clientAccountId}`);
  revalidatePath('/sales-funnel');
  if (result.data.leadId) revalidatePath(`/leads/${result.data.leadId}`);
  return {
    status: 'success',
    message: result.data.leadId
      ? `Deal opened in discovery on the original lead. Audited. Open it at /leads/${result.data.leadId}#sales.`
      : 'Deal opened in discovery. Audited. It has no lead of its own; it is on the pipeline board once a lead is attached.',
  };
}
