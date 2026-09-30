'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { createAnnouncement, setAnnouncementStatus } from './announcements-service';

const PAGES = ['/settings/communication', '/communication'];

/** Settings › Communication — draft an announcement. Records; sends nothing. */
export async function createAnnouncementAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await createAnnouncement({
    title: String(formData.get('title') ?? ''),
    body: String(formData.get('body') ?? ''),
    audience: String(formData.get('audience') ?? '') as 'internal' | 'clients',
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  for (const p of PAGES) revalidatePath(p);
  return { status: 'success', message: 'Draft saved.' };
}

/** Publish or archive — the only two moves. */
export async function setAnnouncementStatusAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setAnnouncementStatus({
    announcementId: String(formData.get('announcementId') ?? ''),
    status: String(formData.get('status') ?? '') as 'published' | 'archived',
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  for (const p of PAGES) revalidatePath(p);
  return { status: 'success', message: result.data.status === 'published' ? 'Published — recorded, not sent.' : 'Archived.' };
}
