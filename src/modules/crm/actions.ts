'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import {
  linkInternalRecipient,
  addLeadNote,
  appendMessage,
  sendClientMessage,
  decideRequirementVersion,
  linkWhatsAppGroup,
  requestExtraction,
  resumeAgentReplies,
  setLeadFollowUp,
  setLeadQualification,
  setLeadStatus,
  startConversation,
  sendRequirementForConfirmation,
} from './service';

/**
 * Server Actions for requirement collection — thin wrappers: validate → call
 * the service → shape a FormState (ARCHITECTURE.md §3.2).
 *
 * Authentication and capability checks live in the service, so they hold no
 * matter who calls it. Reusing identity's FormState keeps one form-result
 * shape across the app rather than inventing a second.
 */

export async function startConversationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await startConversation({
    leadId: String(formData.get('leadId') ?? ''),
    channel: 'manual',
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/leads/${String(formData.get('leadId') ?? '')}`);
  return { status: 'success', message: 'Conversation started.' };
}

/**
 * Send a message to the client — gap G-014.
 *
 * The idempotency key is generated here rather than in the form, so a page
 * that renders twice, a double click and a retried submission all produce a
 * different key only when they are genuinely different sends. A key from the
 * client would be attacker-controlled and could suppress a message somebody
 * meant to send.
 *
 * Nothing here composes the message: the body is what a human typed. An
 * AI-drafted follow-up is G-012 and goes through an approval first.
 */
export async function sendClientMessageAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const conversationId = String(formData.get('conversationId') ?? '');
  const leadId = String(formData.get('leadId') ?? '');

  const result = await sendClientMessage({
    conversationId,
    body: String(formData.get('body') ?? ''),
    idempotencyKey: `out-${crypto.randomUUID()}`,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/leads/${leadId}`);
  return { status: 'success', message: 'Sent to the client.' };
}

export async function appendMessageAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const authorType = String(formData.get('authorType') ?? 'client');

  const result = await appendMessage({
    conversationId: String(formData.get('conversationId') ?? ''),
    authorType: authorType === 'user' ? 'user' : 'client',
    body: String(formData.get('body') ?? ''),
  });

  if (!result.ok) {
    return {
      status: 'error',
      message: result.error.message,
      ...(result.error.details ? { fieldErrors: result.error.details } : {}),
    };
  }

  revalidatePath(`/leads/${String(formData.get('leadId') ?? '')}`);
  return { status: 'success', message: 'Message added.' };
}

export async function requestExtractionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await requestExtraction({
    conversationId: String(formData.get('conversationId') ?? ''),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/leads/${String(formData.get('leadId') ?? '')}`);
  return {
    status: 'success',
    message: result.data.enqueued
      ? 'Extraction queued. Run the job runner to process it.'
      : 'An extraction is already queued for this transcript.',
  };
}

/**
 * The approval gate, reachable from the lead's requirement list.
 *
 * The decision itself — who may make it, whether this version is still open,
 * which organization it belongs to — is entirely the service's, so a caller
 * that reached this action without those rights gets the same refusal any
 * other caller would.
 */
export async function decideRequirementVersionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const decision = String(formData.get('decision') ?? '');
  if (decision !== 'accepted' && decision !== 'rejected') {
    return { status: 'error', message: 'Unknown decision.' };
  }

  const result = await decideRequirementVersion(
    String(formData.get('versionId') ?? ''),
    decision,
  );

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/leads/${String(formData.get('leadId') ?? '')}`);
  return {
    status: 'success',
    message: decision === 'accepted' ? 'Requirements approved.' : 'Requirements rejected.',
  };
}

/**
 * Doc §12's client confirmation step — G-200.
 *
 * A person presses it, and the summary goes to the client through the same
 * consent chokepoint as every other outbound message. Nothing here reads the
 * reply: the client answers in the thread, in their own words, and the person
 * accepting the version reads those words rather than a label.
 */
export async function sendRequirementForConfirmationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await sendRequirementForConfirmation(String(formData.get('versionId') ?? ''));
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/leads/${String(formData.get('leadId') ?? '')}`);
  return {
    status: 'success',
    message: 'Sent. The client has the summary — their reply arrives on the thread below.',
  };
}

// ── Lead pipeline ─────────────────────────────────────────────────────────

function revalidateLead(formData: FormData) {
  revalidatePath(`/leads/${String(formData.get('leadId') ?? '')}`);
}

export async function setLeadStatusAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await setLeadStatus({
    leadId: String(formData.get('leadId') ?? ''),
    status: String(formData.get('status') ?? '') as never,
    reason: String(formData.get('reason') ?? '') || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return { status: 'success', message: `Lead moved to ${result.data.status}.` };
}

export async function addLeadNoteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await addLeadNote({
    leadId: String(formData.get('leadId') ?? ''),
    body: String(formData.get('body') ?? ''),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return { status: 'success', message: 'Note added.' };
}

export async function setLeadQualificationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const budget = String(formData.get('budgetMinor') ?? '').trim();
  const decisionMaker = String(formData.get('isDecisionMaker') ?? '');

  const result = await setLeadQualification({
    leadId: String(formData.get('leadId') ?? ''),
    qualification: {
      ...(budget ? { budgetMinor: Number(budget) } : {}),
      ...(String(formData.get('timelineNote') ?? '').trim()
        ? { timelineNote: String(formData.get('timelineNote')) }
        : {}),
      ...(decisionMaker === 'yes' || decisionMaker === 'no'
        ? { isDecisionMaker: decisionMaker === 'yes' }
        : {}),
      ...(String(formData.get('notes') ?? '').trim()
        ? { notes: String(formData.get('notes')) }
        : {}),
    },
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return { status: 'success', message: 'Qualification saved.' };
}

export async function setLeadFollowUpAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = String(formData.get('nextFollowUpAt') ?? '').trim();

  const result = await setLeadFollowUp({
    leadId: String(formData.get('leadId') ?? ''),
    // A date input gives YYYY-MM-DD; the column is timestamptz.
    nextFollowUpAt: raw ? new Date(`${raw}T09:00:00Z`).toISOString() : null,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return { status: 'success', message: raw ? 'Follow-up scheduled.' : 'Follow-up cleared.' };
}

/**
 * Put the sales agent back on a conversation it handed to a person.
 *
 * The pause is the agent's and the resume is a person's — that asymmetry is
 * the whole design, and `crm.resume_agent_replies` refuses a caller with no
 * identity so it holds for a raw PostgREST call too.
 */
export async function resumeAgentRepliesAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const conversationId = String(formData.get('conversationId') ?? '');
  const result = await resumeAgentReplies(conversationId);

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/leads/${String(formData.get('leadId') ?? '')}`);
  return {
    status: 'success',
    message: result.data.resumed
      ? 'The agent will answer this conversation again.'
      : 'This conversation was not waiting for anybody.',
  };
}

/**
 * Link the internal group — G-109, and the reason a handover reached nobody.
 *
 * `crm.link_whatsapp_group` and its service have existed since G-015. Nothing
 * ever called them for `internal_group`, so no deployment had one — and the
 * announcer built for exactly this answered `no_group` and marked the job
 * succeeded, which is right: not having set one up is an ordinary state, not
 * an error.
 *
 * The consequence was not ordinary. The first real handover on production
 * carried a good reason — *"scope fully gathered … needs colleague to provide
 * proper estimate"* — the lead went to the top of `/leads` under **Asked for a
 * person**, the thread grew a banner… and **no phone buzzed**. The push was
 * built and silent, because there was nowhere to push to.
 *
 * The id is Meta's group id, which comes from the group's own metadata rather
 * than from anybody's memory — the schema says so and the unique index decides
 * which tenant owns it.
 */
/**
 * Point announcements at a person's own WhatsApp — ADM-95, G-159.
 *
 * The fallback Meta forced: this WABA has no Groups eligibility (#131215),
 * so a person is the channel. Relinking genuinely relinks.
 */
export async function linkInternalRecipientAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await linkInternalRecipient({
    phone: String(formData.get('phone') ?? ''),
    ...(String(formData.get('title') ?? '').trim()
      ? { title: String(formData.get('title')).trim() }
      : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/settings');
  return {
    status: 'success',
    message: result.data.relinked
      ? 'Number updated. Approvals and handovers will reach it, quotation PDFs included.'
      : 'Linked. Approvals and handovers will reach this number, quotation PDFs included.',
  };
}

export async function linkInternalGroupAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await linkWhatsAppGroup({
    kind: 'internal_group',
    externalRef: String(formData.get('externalRef') ?? ''),
    ...(String(formData.get('title') ?? '').trim()
      ? { title: String(formData.get('title')).trim() }
      : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/settings');
  return {
    status: 'success',
    message: result.data.linked
      ? 'Linked. Approvals and handovers will be announced there.'
      : 'That group was already linked.',
  };
}
