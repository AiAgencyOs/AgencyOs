'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { breakDownPlan } from './plan-breakdown-service';

/** SCR-040 — one click from plan deliverables to modules, features and tasks. */
export async function breakDownPlanAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await breakDownPlan({ projectId, planId: String(formData.get('planId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}/plan`);
  revalidatePath(`/projects/${projectId}/development`);

  const { created, skipped, refusals } = result.data;
  const made = `${created.modules} module${created.modules === 1 ? '' : 's'}, ${created.features} feature${created.features === 1 ? '' : 's'}, ${created.tasks} task${created.tasks === 1 ? '' : 's'} created`;
  const skippedNote = skipped.length > 0 ? ` · ${skipped.length} already had a module (${skipped.join(', ')})` : '';
  // A refusal is shown verbatim, per deliverable, rather than folded into a
  // count: which ones have no module is the whole answer.
  const refusalNote = refusals.length > 0 ? ` · refused: ${refusals.join('; ')}` : '';

  return {
    status: refusals.length > 0 && created.modules === 0 ? 'error' : 'success',
    message: `${made}${skippedNote}${refusalNote}.`,
  };
}
