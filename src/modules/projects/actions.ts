'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { recordKickoff } from './planning';

import {
  addDeliverable,
  configurePaymentPlan,
  confirmGroupCreated,
  mapGroup,
  reviseGroupSetup,
  setOnboardingItem,
  setProjectStatus,
  submitDeliverable,
  verifyGroup,
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

  // Master §5.4's four states, plus pending — G-261. `done` is gone, migrated
  // to `verified`. Narrowed through a type predicate rather than a cast, so a
  // sixth state added to the door has to be added here too before it compiles.
  const ONBOARDING_STATUSES = ['pending', 'waiting_client', 'received', 'verified', 'not_applicable'] as const;
  type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];
  const isOnboardingStatus = (value: string): value is OnboardingStatus =>
    (ONBOARDING_STATUSES as readonly string[]).includes(value);

  if (!isOnboardingStatus(status)) {
    return {
      status: 'error',
      message: 'A checklist item is pending, waiting on the client, received, verified, or not applicable.',
    };
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

/**
 * The WhatsApp group manual action — Master §5.5, §6; G-253, G-254.
 *
 * Every one of these records something a person did in another app. None of
 * them creates a group, and none of them can: Meta refused this WABA the
 * Groups API (ADM-95, #131215). The doors beneath them refuse the service role
 * for the same reason — an unattended process cannot witness what happened on
 * somebody's phone.
 */

export async function reviseGroupSetupAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const suggestedName = String(formData.get('suggestedName') ?? '').trim();

  // Repeated fields, like the payment plan's: the form can carry any number of
  // members without the server knowing a fixed shape.
  const names = formData.getAll('memberName').map((v) => String(v).trim());
  const phones = formData.getAll('memberPhone').map((v) => String(v).trim());
  const roles = formData.getAll('memberRole').map((v) => String(v).trim());
  const kinds = formData.getAll('memberKind').map((v) => String(v).trim());

  const members = names
    .map((name, i) => ({
      name,
      phone: phones[i] ?? '',
      role: roles[i] || null,
      kind: (kinds[i] === 'client' ? 'client' : 'internal') as 'internal' | 'client',
    }))
    // A row the Admin emptied is a row they removed — not a member with no
    // name, which the schema would refuse and which would read as a mistake.
    .filter((m) => m.name.length > 0 || m.phone.length > 0);

  const result = await reviseGroupSetup({
    setupId: String(formData.get('setupId') ?? ''),
    ...(suggestedName ? { suggestedName } : {}),
    ...(members.length > 0 ? { members } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: 'Group setup updated.' };
}

export async function confirmGroupCreatedAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const note = String(formData.get('note') ?? '').trim();

  const result = await confirmGroupCreated({
    setupId: String(formData.get('setupId') ?? ''),
    ...(note ? { note } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/operations');
  return { status: 'success', message: 'Recorded that you created the group.' };
}

export async function mapGroupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await mapGroup({
    setupId: String(formData.get('setupId') ?? ''),
    conversationId: String(formData.get('conversationId') ?? ''),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/operations');
  return { status: 'success', message: 'Group mapped.' };
}

export async function verifyGroupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await verifyGroup({ setupId: String(formData.get('setupId') ?? '') });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/operations');
  return { status: 'success', message: 'Group verified.' };
}

/**
 * Record that the kickoff went out, and close Phase 2 — Master §5.11; G-263.
 *
 * It records; it does not send. There is no channel on this deployment
 * (BLK-003, BLK-007), so the evidence reference is a message a person sent
 * themselves — and the door requires it, because a kickoff with no evidence
 * would be this system claiming a client was told something nobody can show
 * them being told.
 */
export async function recordKickoffAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await recordKickoff({
    projectId,
    evidenceRef: String(formData.get('evidenceRef') ?? ''),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/projects');
  return { status: 'success', message: 'Kickoff recorded. Phase 2 is complete and the project is active.' };
}
