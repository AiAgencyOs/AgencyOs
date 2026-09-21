'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import {
  addProposalItem,
  conversionMessage,
  convertToProject,
  createOpportunity,
  draftPlanSet,
  draftProposal,
  recordPlanSetChoice,
  recordPlanSetResponse,
  recordProposalResponse,
  requestPaymentException,
  sendPlanSet,
  sendProposal,
  setOpportunityStage,
  setOpportunityTerms,
  setProposalPricing,
  submitPlanSet,
  submitProposal,
} from './service';

/** Server Actions for the sales pipeline — thin wrappers over service.ts. */

function revalidateLead(formData: FormData) {
  revalidatePath(`/leads/${String(formData.get('leadId') ?? '')}`);
}

export async function createOpportunityAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const value = String(formData.get('valueMinor') ?? '').trim();

  const result = await createOpportunity({
    leadId: String(formData.get('leadId') ?? ''),
    name: String(formData.get('name') ?? ''),
    valueMinor: value ? Number(value) : 0,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return { status: 'success', message: 'Deal opened.' };
}

export async function setOpportunityStageAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await setOpportunityStage({
    opportunityId: String(formData.get('opportunityId') ?? ''),
    stage: String(formData.get('stage') ?? '') as never,
    lostReason: String(formData.get('lostReason') ?? '') || undefined,
    lostCategory: (String(formData.get('lostCategory') ?? '') || undefined) as never,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return { status: 'success', message: `Deal moved to ${result.data.stage}.` };
}

export async function requestPaymentExceptionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await requestPaymentException({
    opportunityId: String(formData.get('opportunityId') ?? ''),
    reason: String(formData.get('reason') ?? ''),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);

  const messages: Record<string, string> = {
    requested: 'No-advance exception requested — waiting on the owner.',
    already_pending: 'A no-advance exception is already pending on this quotation.',
  };
  return {
    status: 'success',
    message: messages[result.data.outcome] ?? `Exception request: ${result.data.outcome}.`,
  };
}

export async function convertToProjectAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await convertToProject({
    opportunityId: String(formData.get('opportunityId') ?? ''),
    projectName: String(formData.get('projectName') ?? ''),
    clientAccountName: String(formData.get('clientAccountName') ?? '') || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateLead(formData);
  revalidatePath('/projects');
  return {
    status: result.data.handoffRecorded ? 'success' : 'error',
    message: conversionMessage(result.data),
  };
}

// ── quotations (G-011, ADM-07) ─────────────────────────────────────────────

/** Money arrives from a form as rupees; the database counts paise. */
function toMinor(value: FormDataEntryValue | null): number | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.round(parsed * 100);
}

export async function draftProposalAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await draftProposal({
    opportunityId: String(formData.get('opportunityId') ?? ''),
    title: String(formData.get('title') ?? ''),
    body: String(formData.get('body') ?? '') || undefined,
    validUntil: String(formData.get('validUntil') ?? '') || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return {
    status: 'success',
    message: result.data.supersededId
      ? `Quotation v${result.data.version} drafted. The previous version is now superseded.`
      : `Quotation v${result.data.version} drafted.`,
  };
}

export async function addProposalItemAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const quantity = Number(String(formData.get('quantity') ?? '1').trim() || '1');
  const unitPriceMinor = toMinor(formData.get('unitPrice'));

  const result = await addProposalItem({
    proposalId: String(formData.get('proposalId') ?? ''),
    description: String(formData.get('description') ?? ''),
    quantity,
    unitPriceMinor: unitPriceMinor ?? 0,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return { status: 'success', message: 'Line added.' };
}

export async function setProposalPricingAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const discountMinor = toMinor(formData.get('discount'));
  const taxMinor = toMinor(formData.get('tax'));

  const result = await setProposalPricing({
    proposalId: String(formData.get('proposalId') ?? ''),
    ...(discountMinor === undefined ? {} : { discountMinor }),
    ...(taxMinor === undefined ? {} : { taxMinor }),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return { status: 'success', message: 'Pricing updated.' };
}

export async function submitProposalAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await submitProposal({
    proposalId: String(formData.get('proposalId') ?? ''),
    summary: String(formData.get('summary') ?? '') || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  revalidatePath('/approvals');
  return {
    status: 'success',
    message: result.data.alreadyPending
      ? 'This quotation is already waiting on the owner.'
      : 'Sent to the owner for approval.',
  };
}

export async function sendProposalAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await sendProposal({
    proposalId: String(formData.get('proposalId') ?? ''),
    conversationId: String(formData.get('conversationId') ?? '') || undefined,
    messageRef: String(formData.get('messageRef') ?? '') || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  // A missing PDF is said, not swallowed: the quotation is sent either way,
  // but "sent" alone would claim a document the client does not have.
  return {
    status: 'success',
    message: result.data.alreadySent
      ? 'This quotation was already sent.'
      : result.data.pdfDelivered
        ? 'Quotation sent, PDF attached.'
        : `Quotation sent. The PDF was not attached: ${result.data.pdfNote ?? 'unknown reason'}.`,
  };
}

export async function recordProposalResponseAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await recordProposalResponse({
    proposalId: String(formData.get('proposalId') ?? ''),
    response: String(formData.get('response') ?? '') as never,
    note: String(formData.get('note') ?? '') || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return {
    status: 'success',
    message: result.data.status === 'accepted' ? 'Recorded as accepted.' : 'Recorded as rejected.',
  };
}

/**
 * Correct an open deal's value, name or expected close date — G-092, ADM-43;
 * given a caller by G-306.
 *
 * The service function has existed since G-092 with its audit trail and its
 * `lead.write` check, and nothing ever called it — so a deal's value was
 * written once at insert and could not be corrected in the product. That
 * number is what the accepted quotation is measured against (G-017), and a
 * deal re-won at a different figure converted into a project budgeted at the
 * old one.
 *
 * Blank fields are omitted rather than sent as zero or as an empty name: the
 * schema refuses a call that changes nothing, and "clear the value" is not an
 * operation ADM-43 offered.
 */
export async function setOpportunityTermsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  const rupees = text('value');

  const result = await setOpportunityTerms({
    opportunityId: text('opportunityId'),
    ...(rupees === '' ? {} : { valueMinor: Math.round(Number(rupees) * 100) }),
    ...(text('name') === '' ? {} : { name: text('name') }),
    ...(text('expectedCloseOn') === '' ? {} : { expectedCloseOn: text('expectedCloseOn') }),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return {
    status: 'success',
    // `changed: false` is a success with nothing to do — the same values were
    // submitted — and reporting a correction that did not happen would put a
    // line in somebody's head that is not in the audit log.
    message: result.data.changed ? 'Deal terms corrected.' : 'Nothing changed.',
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The plan-set offer — G-166, ADM-97; G-305.
 *
 * Seven service functions, three schemas and eight doors were built for the
 * 2-3 plan ladder Part H asks for, and **nothing called any of them**: the
 * only references outside `service.ts` were its own log scope strings. So the
 * offer existed for somebody with database access and for nobody else.
 *
 * These wrappers are deliberately the same shape as the single-quotation ones
 * above. A plan-set moves through the same four states in the same order —
 * draft, with the owner, sent, answered — and a second vocabulary for it would
 * be two things to learn for one process.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The plans arrive as parallel form fields (`title1`, `label1`, …) rather than
 * as JSON, because an HTML form posts strings and the alternative is a hidden
 * field holding a serialised array that no `<noscript>` and no browser autofill
 * can produce. Empty rungs are dropped here; the 2-3 count is refused by the
 * schema and again by the database CHECK.
 */
function plansFrom(formData: FormData) {
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  return [1, 2, 3]
    .map((slot) => ({
      title: text(`title${slot}`),
      label: text(`label${slot}`),
      body: text(`body${slot}`) || undefined,
      validUntil: text(`validUntil${slot}`) || undefined,
    }))
    .filter((plan) => plan.title !== '' && plan.label !== '');
}

export async function draftPlanSetAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await draftPlanSet({
    opportunityId: String(formData.get('opportunityId') ?? ''),
    plans: plansFrom(formData),
    recommendedSlot: Number(String(formData.get('recommendedSlot') ?? '')),
    requirementVersionId: String(formData.get('requirementVersionId') ?? '') || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return {
    status: 'success',
    // Named as what it is: the members are draft quotations, and each still
    // needs its lines and its price before the set can go to the owner.
    message: `Offer drafted with ${result.data.proposalIds.length} plans. Price each one, then send it for approval.`,
  };
}

export async function submitPlanSetAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await submitPlanSet({
    planSetId: String(formData.get('planSetId') ?? ''),
    summary: String(formData.get('summary') ?? '') || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  revalidatePath('/approvals');
  return {
    status: 'success',
    // ADM-97: one approval, at the recommended plan's price, because that is
    // the amount the money-floor policy resolves an approver from.
    message: result.data.alreadyPending
      ? 'This offer is already waiting on the owner.'
      : 'Sent to the owner for approval, at the recommended plan’s price.',
  };
}

export async function sendPlanSetAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await sendPlanSet({
    planSetId: String(formData.get('planSetId') ?? ''),
    conversationId: String(formData.get('conversationId') ?? '') || undefined,
    messageRef: String(formData.get('messageRef') ?? '') || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return {
    status: 'success',
    message: result.data.alreadySent ? 'This offer was already sent.' : 'Offer sent.',
  };
}

export async function recordPlanSetChoiceAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await recordPlanSetChoice({
    planSetId: String(formData.get('planSetId') ?? ''),
    chosenProposalId: String(formData.get('chosenProposalId') ?? ''),
    note: String(formData.get('note') ?? '') || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return {
    status: 'success',
    // One winner, exactly as a single accepted quote — the siblings are
    // superseded by the door and `plan_set.accepted` carries the chosen id.
    message: 'Recorded. That plan is accepted and the others are superseded.',
  };
}

export async function recordPlanSetResponseAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await recordPlanSetResponse({
    planSetId: String(formData.get('planSetId') ?? ''),
    // The literal is the schema's, not the form's: declining is the ONLY
    // answer this door takes, because accepting means naming which plan and
    // that is `recordPlanSetChoice`. Reading it from the form would invite a
    // caller to post 'accepted' and get a refusal about a union.
    response: 'rejected',
    note: String(formData.get('note') ?? '') || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return { status: 'success', message: 'Recorded as declined. Every plan in the offer is rejected.' };
}
