'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { commentOnDesignReview } from './design-review-comments-service';

export async function commentOnDesignReviewAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const subjectType = String(formData.get('subjectType') ?? '');
  const result = await commentOnDesignReview({
    projectId,
    subjectType: subjectType === 'deliverable' ? 'deliverable' : 'theme_option',
    subjectId: String(formData.get('subjectId') ?? ''),
    body: String(formData.get('body') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/design`);
  revalidatePath(`/projects/${projectId}/design/themes`);
  revalidatePath(`/projects/${projectId}/design/final`);
  return { status: 'success', message: 'Comment added.' };
}
