'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { createProjectFolder, fileIntoFolder } from './project-folder-service';

/** New Folder, and filing a file into a folder — Server Actions over the migration-20261005100400 doors. */

const str = (formData: FormData, key: string) => String(formData.get(key) ?? '');

export async function createProjectFolderAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const result = await createProjectFolder({ projectId, category: str(formData, 'category') as never, path: str(formData, 'path') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/files`);
  return { status: 'success', message: `Folder “${result.data.path}” created.` };
}

export async function fileIntoFolderAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const result = await fileIntoFolder({ projectId, fileId: str(formData, 'fileId'), path: str(formData, 'path') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/files`);
  return { status: 'success', message: result.data.path ? `Filed under “${result.data.path}”.` : 'Moved to the category root.' };
}
