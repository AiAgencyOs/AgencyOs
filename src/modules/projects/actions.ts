'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { configurePaymentPlan, setProjectStatus } from './service';

/** Server Actions for delivery — thin wrappers over service.ts. */

export async function setProjectStatusAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await setProjectStatus({
    projectId,
    status: String(formData.get('status') ?? '') as never,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/projects');
  return { status: 'success', message: `Project moved to ${result.data.status}.` };
}

/**
 * Reads the plan from repeated `name` / `percent` / `dueOn` fields, so the form
 * can carry any number of milestones without the server knowing a fixed shape.
 */
export async function configurePaymentPlanAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const names = formData.getAll('name').map(String);
  const percents = formData.getAll('percent').map(String);
  const dueOns = formData.getAll('dueOn').map(String);

  const items = names
    .map((name, i) => ({
      name: name.trim(),
      percent: Number(percents[i] ?? ''),
      ...(dueOns[i]?.trim() ? { dueOn: dueOns[i] as string } : {}),
    }))
    // Blank rows are how a user removes a milestone from the form.
    .filter((item) => item.name.length > 0 && Number.isFinite(item.percent) && item.percent > 0);

  if (items.length === 0) {
    return { status: 'error', message: 'Add at least one milestone with a percentage.' };
  }

  const result = await configurePaymentPlan({ projectId, items });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: `Payment plan saved (${result.data.milestones} milestones).` };
}
