'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import {
  addProposalItem,
  convertToProject,
  createOpportunity,
  draftProposal,
  recordProposalResponse,
  sendProposal,
  setOpportunityStage,
  setProposalPricing,
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
    status: 'success',
    message: result.data.created
      ? 'Client and project created.'
      : 'This deal was already converted; showing the existing project.',
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
