'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { setOrgProjectDefaults } from './org-project-defaults-service';

export async function setOrgProjectDefaultsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setOrgProjectDefaults({
    watchPhases: formData.getAll('watchPhase').map(String) as never,
    folderText: String(formData.get('folderText') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings/project-defaults');
  return { status: 'success', message: `Saved: ${result.data.phases} phase${result.data.phases === 1 ? '' : 's'} followed by default, ${result.data.folders} standard folder${result.data.folders === 1 ? '' : 's'} for new projects.` };
}
