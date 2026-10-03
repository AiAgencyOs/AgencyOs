'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { draftMilestoneAnnouncement, saveAnnouncementTemplate } from './announcement-templates-service';

const text = (formData: FormData, name: string) => String(formData.get(name) ?? '').trim();

function revalidate() {
  revalidatePath('/settings/communication');
  revalidatePath('/communication');
  revalidatePath('/projects/[projectId]/activity', 'page');
}

/** SCR-059 — save (create or change) an announcement template; unticking "Active" archives it. */
export async function saveAnnouncementTemplateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await saveAnnouncementTemplate({
    ...(text(formData, 'templateId') ? { templateId: text(formData, 'templateId') } : {}),
    name: text(formData, 'name'),
    kind: text(formData, 'kind') as never,
    audience: text(formData, 'audience') as never,
    titleTemplate: text(formData, 'titleTemplate'),
    bodyTemplate: text(formData, 'bodyTemplate'),
    active: formData.get('active') === 'on',
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidate();
  return { status: 'success', message: result.data.created ? 'Template saved.' : 'Template updated.' };
}

/** SCR-059 — a met milestone the tick did not draft for gets its announcement on request. */
export async function draftMilestoneAnnouncementAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await draftMilestoneAnnouncement(text(formData, 'milestoneId'));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidate();
  revalidatePath('/clients/[clientId]', 'page');
  return { status: 'success', message: 'Draft prepared. Publish it from Communication when you are ready — nothing is sent.' };
}
