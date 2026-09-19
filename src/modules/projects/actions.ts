'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import {
  assignDesignReviewer,
  lockPhaseThreeDirection,
  openDesignRevision,
  recordClientDesignDecision,
  recordDesignShare,
  submitAdminDesignDecision,
  submitInternalDesignReview,
} from './design';

import {
  activateProjectPlan,
  addPlanDeliverable,
  addPlanDependency,
  addPlanMilestone,
  addPlanNote,
  draftProjectPlan,
  raiseClarification,
  recordClarificationAnswer,
  recordKickoff,
  resolveClarification,
} from './planning';

import {
  addDeliverable,
  addTeamDefault,
  configurePaymentPlan,
  confirmGroupCreated,
  mapGroup,
  reviseGroupSetup,
  removeTeamDefault,
  setOnboardingItem,
  setTeamDefaultActive,
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

/**
 * The internal team roster — Master §6, P2-05; G-267.
 *
 * `/settings`, not a project page: the roster is the agency's own, and the
 * same list is copied onto every group card. Revalidating a single project
 * would leave the panel that renders it showing yesterday's team.
 */

export async function addTeamDefaultAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await addTeamDefault({
    displayName: String(formData.get('displayName') ?? ''),
    phone: String(formData.get('phone') ?? ''),
    role: String(formData.get('role') ?? '').trim() || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/settings');
  return {
    status: 'success',
    message: result.data.added
      ? 'Added to the default team.'
      : 'That number is already on the roster.',
  };
}

export async function setTeamDefaultActiveAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await setTeamDefaultActive({
    memberId: String(formData.get('memberId') ?? ''),
    active: formData.get('active') === 'true',
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/settings');
  return {
    status: 'success',
    // Groups that already exist keep the member they were created with: a
    // card copies the roster, it does not reference it (G-253).
    message: 'Saved. Groups created from now on use the new roster.',
  };
}

export async function removeTeamDefaultAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await removeTeamDefault(String(formData.get('memberId') ?? ''));

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/settings');
  return { status: 'success', message: 'Removed from the default team.' };
}

/**
 * The operational plan — Project Planning §7; G-274.
 *
 * G-256, G-257, G-262 and G-265 built every door a plan needs and **nothing
 * ever called one of them**: a project plan could not be created in the
 * product at all. These are the thin wrappers that make the blueprint
 * reachable, and each one revalidates the plan page, because every register on
 * it is read in the same pass.
 */

const planPath = (projectId: string) => {
  revalidatePath(`/projects/${projectId}/plan`);
  revalidatePath(`/projects/${projectId}`);
};

const optional = (formData: FormData, key: string): string | undefined =>
  String(formData.get(key) ?? '').trim() || undefined;

export async function draftProjectPlanAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await draftProjectPlan({
    projectId,
    objective: optional(formData, 'objective'),
    changeReason: optional(formData, 'changeReason'),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  planPath(projectId);
  return {
    status: 'success',
    message: result.data.alreadyDrafting
      ? `Version ${result.data.version} is already open as a draft.`
      : `Draft v${result.data.version} opened.`,
  };
}

export async function addPlanDeliverableAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await addPlanDeliverable({
    planId: String(formData.get('planId') ?? ''),
    name: String(formData.get('name') ?? ''),
    applicablePhase: String(formData.get('applicablePhase') ?? ''),
    readinessCriteria: String(formData.get('readinessCriteria') ?? ''),
    evidenceRequired: String(formData.get('evidenceRequired') ?? ''),
    // Chosen from the approved scope of this plan's own version, never typed.
    scopeItemId: optional(formData, 'scopeItemId'),
    ownerRole: optional(formData, 'ownerRole'),
    ambiguityNote: optional(formData, 'ambiguityNote'),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  planPath(projectId);
  return { status: 'success', message: 'Deliverable added.' };
}

export async function addPlanMilestoneAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await addPlanMilestone({
    planId: String(formData.get('planId') ?? ''),
    name: String(formData.get('name') ?? ''),
    kind: String(formData.get('kind') ?? '') as never,
    phase: String(formData.get('phase') ?? ''),
    gateCriteria: String(formData.get('gateCriteria') ?? ''),
    windowStart: optional(formData, 'windowStart'),
    windowEnd: optional(formData, 'windowEnd'),
    timingBasis: optional(formData, 'timingBasis'),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  planPath(projectId);
  return { status: 'success', message: 'Milestone added.' };
}

export async function addPlanDependencyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await addPlanDependency({
    planId: String(formData.get('planId') ?? ''),
    kind: String(formData.get('kind') ?? ''),
    description: String(formData.get('description') ?? ''),
    neededByPhase: String(formData.get('neededByPhase') ?? ''),
    ownerRole: String(formData.get('ownerRole') ?? ''),
    windowStart: optional(formData, 'windowStart'),
    windowEnd: optional(formData, 'windowEnd'),
    timingBasis: optional(formData, 'timingBasis'),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  planPath(projectId);
  return { status: 'success', message: 'Dependency recorded.' };
}

export async function addPlanNoteAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await addPlanNote({
    planId: String(formData.get('planId') ?? ''),
    kind: String(formData.get('kind') ?? '') as 'risk' | 'assumption',
    statement: String(formData.get('statement') ?? ''),
    ownerRole: optional(formData, 'ownerRole'),
    escalationPath: optional(formData, 'escalationPath'),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  planPath(projectId);
  return { status: 'success', message: 'Recorded on the register.' };
}

export async function raiseClarificationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await raiseClarification({
    planId: String(formData.get('planId') ?? ''),
    question: String(formData.get('question') ?? ''),
    impact: String(formData.get('impact') ?? ''),
    scopeItemId: optional(formData, 'scopeItemId'),
    deliverableId: optional(formData, 'deliverableId'),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  planPath(projectId);
  return {
    status: 'success',
    // §10: the plan cannot activate until this is settled, which is the point
    // of writing the question down rather than guessing an answer.
    message: 'Question raised. The plan cannot be activated until it is settled.',
  };
}

export async function answerClarificationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await recordClarificationAnswer({
    clarificationId: String(formData.get('clarificationId') ?? ''),
    answer: String(formData.get('answer') ?? ''),
    answeredVia: String(formData.get('answeredVia') ?? ''),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  planPath(projectId);
  return { status: 'success', message: 'Answer recorded.' };
}

export async function resolveClarificationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await resolveClarification(String(formData.get('clarificationId') ?? ''));

  if (!result.ok) return { status: 'error', message: result.error.message };

  planPath(projectId);
  return { status: 'success', message: 'Settled.' };
}

export async function activateProjectPlanAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await activateProjectPlan(String(formData.get('planId') ?? ''));

  // G-265's findings come back as the refusal message. A bare "invalid" is a
  // refusal somebody has to go and investigate.
  if (!result.ok) return { status: 'error', message: result.error.message };

  planPath(projectId);
  return { status: 'success', message: `Plan v${result.data.version} is active.` };
}

/**
 * Phase 3's gates — Master §16, §10; G-287.
 *
 * Every one of these revalidates `/projects/<id>/design`, because that page is
 * where the outcome shows: a gate that recorded a decision and left the trail
 * reading as it did a moment ago would look like it had not worked.
 */

export async function submitInternalDesignReviewAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = String(formData.get('result') ?? '');

  const outcome = await submitInternalDesignReview({
    themeOptionId: String(formData.get('themeOptionId') ?? ''),
    // Narrowed here rather than cast: the door refuses anything else as
    // `bad_result`, and this keeps the two in step.
    result: result === 'passed' ? 'passed' : 'changes_required',
    comments: String(formData.get('comments') ?? '').trim() || undefined,
  });

  if (!outcome.ok) return { status: 'error', message: outcome.error.message };

  revalidatePath(`/projects/${projectId}/design`);
  return {
    status: 'success',
    message:
      result === 'passed'
        ? 'Passed. The option is now waiting on Admin.'
        : 'Sent back to the designer with your comments.',
  };
}

export async function submitAdminDesignDecisionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const decision = String(formData.get('decision') ?? '');

  const outcome = await submitAdminDesignDecision({
    themeOptionId: String(formData.get('themeOptionId') ?? ''),
    decision: decision === 'confirm' ? 'confirm' : 'edit',
    reason: String(formData.get('reason') ?? '').trim() || undefined,
  });

  if (!outcome.ok) return { status: 'error', message: outcome.error.message };

  revalidatePath(`/projects/${projectId}/design`);
  return {
    status: 'success',
    message:
      decision === 'confirm'
        ? 'Approved. The option may now be shared with the client.'
        : 'Sent back for an edit — internal review runs again before it returns to you.',
  };
}

export async function assignDesignReviewerAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const outcome = await assignDesignReviewer({
    projectId,
    userId: String(formData.get('userId') ?? ''),
  });

  if (!outcome.ok) return { status: 'error', message: outcome.error.message };

  revalidatePath(`/projects/${projectId}/design`);
  return {
    status: 'success',
    message: outcome.data.changed
      ? 'Appointed. The internal design gate belongs to them now.'
      : 'They already held the internal design gate.',
  };
}

/**
 * The client loop — Master §7.6; PM §4.4, §4.6, §9; G-288.
 *
 * Each of these RECORDS something a person did or received. None of them
 * sends anything, and the messages say so: this deployment has no channel
 * (BLK-003, BLK-007).
 */

export async function recordDesignShareAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  // Checkboxes: every option the PM ticked. `getAll` rather than `get`,
  // because one option is the common case and not the only one.
  const themeOptionIds = formData.getAll('themeOptionIds').map(String).filter(Boolean);

  const outcome = await recordDesignShare({
    projectId,
    themeOptionIds,
    channel: String(formData.get('channel') ?? ''),
    evidenceRef: String(formData.get('evidenceRef') ?? ''),
  });

  if (!outcome.ok) return { status: 'error', message: outcome.error.message };

  revalidatePath(`/projects/${projectId}/design`);
  return {
    status: 'success',
    message: `Recorded. ${themeOptionIds.length} option${themeOptionIds.length === 1 ? '' : 's'} now shows as sent to the client.`,
  };
}

export async function recordClientDesignDecisionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const decision = String(formData.get('decision') ?? '');

  const outcome = await recordClientDesignDecision({
    shareId: String(formData.get('shareId') ?? ''),
    decision,
    clientWords: String(formData.get('clientWords') ?? ''),
    themeOptionId: String(formData.get('themeOptionId') ?? '') || undefined,
    colorOptionId: String(formData.get('colorOptionId') ?? '') || undefined,
    referenceUrl: String(formData.get('referenceUrl') ?? '').trim() || undefined,
    referenceNote: String(formData.get('referenceNote') ?? '').trim() || undefined,
    evidenceRef: String(formData.get('evidenceRef') ?? '').trim() || undefined,
  });

  if (!outcome.ok) return { status: 'error', message: outcome.error.message };

  revalidatePath(`/projects/${projectId}/design`);
  return {
    status: 'success',
    message:
      decision === 'possible_scope_change'
        ? 'Recorded, and the phase has stopped. This goes to the scope process, not to a design round.'
        : 'Recorded, in the client’s own words.',
  };
}

export async function openDesignRevisionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const outcome = await openDesignRevision({
    fromThemeOptionId: String(formData.get('themeOptionId') ?? ''),
    origin: String(formData.get('origin') ?? 'client_revision'),
    requestedChanges: String(formData.get('requestedChanges') ?? ''),
    clientDecisionId: String(formData.get('clientDecisionId') ?? '') || undefined,
  });

  if (!outcome.ok) return { status: 'error', message: outcome.error.message };

  revalidatePath(`/projects/${projectId}/design`);

  // An escalation is not a failure and must not read as one: the phase
  // stopped on purpose, and telling somebody to try again would be telling
  // them to do the thing the limit exists to prevent.
  if (outcome.data.escalated) {
    return {
      status: 'success',
      message:
        'The client revision limit has been reached, so the phase has stopped. Nothing more is designed until somebody decides on continuation, scope or commercial handling.',
    };
  }

  return {
    status: 'success',
    message: outcome.data.alreadyOpen
      ? 'That request already opened a round — this did not spend another one.'
      : 'Opened. It goes back to the designer, then internal review, then Admin, before the client sees it again.',
  };
}

/**
 * The completion gate — Master §7.11, §7.12; G-289.
 *
 * It passes the phase and nothing else, because the door takes nothing else.
 */

export async function lockPhaseThreeDirectionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const outcome = await lockPhaseThreeDirection({
    phaseThreeId: String(formData.get('phaseThreeId') ?? ''),
  });

  if (!outcome.ok) return { status: 'error', message: outcome.error.message };

  revalidatePath(`/projects/${projectId}/design`);
  revalidatePath(`/projects/${projectId}`);

  // Both are successes, and they say different things. Phase 3 completed
  // either way; whether Phase 4 may start did not.
  return {
    status: 'success',
    message: outcome.data.phaseFourReady
      ? 'Locked. Phase 3 is complete and Phase 4 has everything it needs.'
      : 'Locked, and Phase 3 is complete — but the handoff is not Phase 4 ready: the canonical Figma artifact is missing. Phase 4 stays blocked until it exists.',
  };
}
