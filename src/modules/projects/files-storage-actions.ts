'use server';

import { revalidatePath } from 'next/cache';

import { clientEnv } from '@/lib/env';
import type { FormState } from '@/modules/identity/types';

import {
  createFileShareLink,
  restoreProjectFile,
  revokeFileShareLink,
  trashProjectFile,
  uploadProjectFile,
} from './files-storage-service';

/**
 * Stored project files — thin `FormState` wrappers over
 * files-storage-service.ts. Every form carries `projectId` so the Files
 * tab and the overview's "Recent files" are both revalidated.
 */
function revalidateFiles(projectId: string) {
  revalidatePath(`/projects/${projectId}/files`);
  revalidatePath(`/projects/${projectId}`);
}

export async function uploadProjectFileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const parentFileId = String(formData.get('parentFileId') ?? '').trim();
  const file = formData.get('file');

  const result = await uploadProjectFile(
    {
      projectId,
      category: String(formData.get('category') ?? 'documents') as never,
      title: String(formData.get('title') ?? ''),
      description: String(formData.get('description') ?? ''),
      ...(parentFileId ? { parentFileId } : {}),
    },
    file instanceof File ? file : null,
  );
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateFiles(projectId);
  return { status: 'success', message: result.data.version > 1 ? `Version ${result.data.version} uploaded.` : 'File uploaded.' };
}

export async function trashProjectFileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await trashProjectFile({ fileId: String(formData.get('fileId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateFiles(projectId);
  return { status: 'success', message: result.data.trashed > 1 ? `Moved to the trash with its ${result.data.trashed - 1} version${result.data.trashed === 2 ? '' : 's'}.` : 'Moved to the trash.' };
}

export async function restoreProjectFileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await restoreProjectFile({ fileId: String(formData.get('fileId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateFiles(projectId);
  return { status: 'success', message: 'Restored.' };
}

export async function createFileShareLinkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await createFileShareLink({
    fileId: String(formData.get('fileId') ?? ''),
    expiresInDays: String(formData.get('expiresInDays') ?? '7'),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateFiles(projectId);
  // The link itself rides in the message so the form can offer "copy"
  // without a second read; the row under the file shows it too.
  return { status: 'success', message: `${clientEnv.NEXT_PUBLIC_APP_URL}/api/files/share/${result.data.token}` };
}

export async function revokeFileShareLinkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await revokeFileShareLink({ shareId: String(formData.get('shareId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateFiles(projectId);
  return { status: 'success', message: 'Link revoked.' };
}
