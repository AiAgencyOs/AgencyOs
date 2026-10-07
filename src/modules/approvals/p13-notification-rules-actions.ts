'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { setNotificationRule } from '@/lib/p13/notification-rules';

export async function setNotificationRuleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const interval = Number(formData.get('minIntervalSeconds') ?? 0);
  const result = await setNotificationRule({
    eventClass: String(formData.get('eventClass') ?? ''),
    channel: String(formData.get('channel') ?? ''),
    enabled: formData.get('enabled') === 'on',
    minIntervalSeconds: Number.isFinite(interval) ? Math.trunc(interval) : -1,
    quietStart: String(formData.get('quietStart') ?? '') || null,
    quietEnd: String(formData.get('quietEnd') ?? '') || null,
    timezone: String(formData.get('timezone') ?? '') || 'Asia/Kolkata',
    criticalBypassesQuiet: formData.get('criticalBypassesQuiet') === 'on',
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings/notification-rules');
  return { status: 'success', message: 'Saved and audited.' };
}
