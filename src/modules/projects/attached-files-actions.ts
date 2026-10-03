'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { ATTACHED_SUBJECT_KINDS, type AttachedSubjectKind } from './attached-files-schema';
import { attachStoredFile } from './attached-files-service';

/**
 * "Attach a file" on a build, a test run or a bug (Q-C1, Q-C6): a thin
 * `FormState` wrapper over the service, which holds the capability check, the
 * project-file rules and the database door.
 */
export async function attachFileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const kind = String(formData.get('subjectKind') ?? '');
  const file = formData.get('file');
  const result = await attachStoredFile(
    {
      subjectKind: ((ATTACHED_SUBJECT_KINDS as readonly string[]).includes(kind) ? kind : '') as AttachedSubjectKind,
      subjectId: String(formData.get('subjectId') ?? ''),
    },
    file instanceof File ? file : null,
  );
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/builds`);
  revalidatePath(`/projects/${projectId}/prototype`);
  revalidatePath(`/projects/${projectId}/qa`);
  revalidatePath(`/projects/${projectId}/qa/runs/${String(formData.get('subjectId') ?? '')}`);
  return { status: 'success', message: `${result.data.fileName} attached.` };
}
