'use server';

import { revalidatePath } from 'next/cache';

import { acknowledgeAlert } from '@/lib/observability/alerts';
import type { FormState } from '@/modules/identity/types';

/** SCR-067 — acknowledge one alert with a reason. Refusals are surfaced as written; see acknowledgeAlert. */
export async function acknowledgeAlertAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await acknowledgeAlert(String(formData.get('alertId') ?? ''), String(formData.get('reason') ?? ''));
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/operations');
  revalidatePath('/', 'layout');
  return { status: 'success', message: 'Acknowledged. It leaves the banner; the reason is in the audit log.' };
}
