'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { setSuiteSchedule } from './schedule-service';

/** SCR-048 — "Schedule suite", from the project's QA page and the QA dashboard. */
export async function setSuiteScheduleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  const projectId = text('projectId');
  const result = await setSuiteSchedule({
    projectId,
    deliverableId: text('deliverableId'),
    suite: text('suite') as never,
    cron: text('cron'),
    active: text('active') !== 'false',
    remove: text('remove') === 'true',
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/qa`);
  revalidatePath('/qa');
  return {
    status: 'success',
    message: result.data.removed ? 'Schedule removed.' : result.data.nextRunAt ? `Scheduled. The tick opens the next run at ${result.data.nextRunAt}.` : 'Schedule saved, paused.',
  };
}
