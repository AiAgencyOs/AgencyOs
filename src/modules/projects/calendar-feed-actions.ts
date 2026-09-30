'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { createCalendarFeed, revokeCalendarFeed } from './calendar-feed-service';

/** SCR-022 — subscribe to / revoke a project's ICS feed. */
export async function createCalendarFeedAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await createCalendarFeed({ projectId });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/calendar`);
  return { status: 'success', message: 'Feed ready. Copy the URL into your calendar app as a subscription.' };
}

export async function revokeCalendarFeedAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await revokeCalendarFeed({ feedId: String(formData.get('feedId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/calendar`);
  return { status: 'success', message: 'Feed revoked. Calendars subscribed to it will stop updating.' };
}
