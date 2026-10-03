'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { createAnnouncement, setAnnouncementStatus } from './announcements-service';

const PAGES = ['/settings/communication', '/communication'];

/** An announcement names a project or client, so their timelines change too. */
function revalidateTimelines() {
  revalidatePath('/projects/[projectId]/activity', 'page');
  revalidatePath('/clients/[clientId]', 'page');
}

/** Settings › Communication — draft an announcement. Records; sends nothing. */
export async function createAnnouncementAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await createAnnouncement({
    title: String(formData.get('title') ?? ''),
    body: String(formData.get('body') ?? ''),
    audience: String(formData.get('audience') ?? '') as 'internal' | 'clients',
    ...(String(formData.get('projectId') ?? '') ? { projectId: String(formData.get('projectId')) } : {}),
    ...(String(formData.get('clientAccountId') ?? '') ? { clientAccountId: String(formData.get('clientAccountId')) } : {}),
    ...(String(formData.get('templateId') ?? '') ? { templateId: String(formData.get('templateId')) } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  for (const p of PAGES) revalidatePath(p);
  revalidateTimelines();
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
  revalidateTimelines();
  return { status: 'success', message: result.data.status === 'published' ? 'Published — recorded, not sent.' : 'Archived.' };
}
