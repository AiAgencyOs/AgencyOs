'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { scheduleAnnouncement } from './announcement-schedule-service';

/** SCR-059 — schedule (or unschedule) a draft, from the Communication dashboard and Settings › Communication. */
export async function scheduleAnnouncementAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await scheduleAnnouncement({
    announcementId: String(formData.get('announcementId') ?? '').trim(),
    scheduledFor: String(formData.get('scheduledFor') ?? '').trim(),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/communication');
  revalidatePath('/settings/communication');
  return { status: 'success', message: result.data.scheduled ? 'Scheduled. The tick publishes it at that moment — a record, not a send.' : 'Schedule cleared; it stays a draft.' };
}
