'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import {
  addDeliverable,
  configurePaymentPlan,
  setOnboardingItem,
  setProjectStatus,
  submitDeliverable,
} from './service';

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

/**
 * Add the next version of a deliverable — Phase 12.
 *
 * Never an edit: the service allocates a new version in Postgres, because an
 * approval names a version and rewriting one makes the approval refer to
 * something that no longer exists.
 */
export async function addDeliverableAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const artifactUrl = String(formData.get('artifactUrl') ?? '').trim();
  const changelog = String(formData.get('changelog') ?? '').trim();

  const result = await addDeliverable({
    projectId,
    kind: String(formData.get('kind') ?? '') as 'design',
    title: String(formData.get('title') ?? ''),
    ...(artifactUrl ? { artifactUrl } : {}),
    ...(changelog ? { changelog } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: `Version ${result.data.version} added.` };
}

/** Put a version in front of the client, through the approval engine. */
export async function submitDeliverableAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await submitDeliverable({
    deliverableId: String(formData.get('deliverableId') ?? ''),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/approvals');
  return {
    status: 'success',
    message: result.data.alreadyInReview ? 'Already with the client.' : 'Sent for client review.',
  };
}

/**
 * Tick, un-tick or excuse one onboarding checklist item — G-017, ADM-06.
 *
 * It gates nothing, and nothing downstream reads the result. That is the whole
 * decision: "the onboarding checklist blocks nothing. Every item is a
 * reminder."
 */
export async function setOnboardingItemAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const status = String(formData.get('status') ?? '');

  if (status !== 'pending' && status !== 'done' && status !== 'not_applicable') {
    return { status: 'error', message: 'A checklist item is pending, done, or not applicable.' };
  }

  const note = String(formData.get('note') ?? '').trim();

  const result = await setOnboardingItem({
    itemId: String(formData.get('itemId') ?? ''),
    status,
    ...(note ? { note } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}`);
  return {
    status: 'success',
    message: `${result.data.done} of ${result.data.total} done.`,
  };
}
