'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { parseGithubReference } from './repository-link-schema';
import { linkRepository, unlinkRepository } from './repository-link-service';

/**
 * The Repository tab's link/unlink controls — Decision: reversed by the owner
 * on 2026-09-29. The form takes one field for the repository (`owner/repo`
 * or the GitHub URL) and one for the branch; the service and the database
 * decide the rest.
 */

export async function linkRepositoryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const reference = parseGithubReference(String(formData.get('repository') ?? ''));
  if (!reference) {
    return { status: 'error', message: 'Enter the repository as owner/name or paste its GitHub link.' };
  }

  const result = await linkRepository({
    projectId,
    owner: reference.owner,
    repo: reference.repo,
    defaultBranch: String(formData.get('defaultBranch') ?? '').trim() || 'main',
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}/repository`);
  revalidatePath('/integrations');
  return { status: 'success', message: `Linked ${reference.owner}/${reference.repo}.` };
}

export async function unlinkRepositoryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await unlinkRepository({ projectId });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}/repository`);
  revalidatePath('/integrations');
  return { status: 'success', message: 'Repository unlinked.' };
}
