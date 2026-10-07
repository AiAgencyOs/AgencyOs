'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';
import { applyConfiguredTax, cancelQuotation, recordEvidencedAcceptance, resolveClarification } from '@/modules/sales/p1o-quotation-service';

const CHANNELS = ['whatsapp', 'email', 'call', 'meeting', 'portal', 'other'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

/** Record the client's acceptance of ONE exact version, with who, where and the evidence. Several open versions and no stated version records a clarification instead. */
export async function recordAcceptanceAction(_prev: FormState, f: FormData): Promise<FormState> {
  const channel = text(f, 'channel');
  const proposalId = text(f, 'proposalId');
  const contactId = text(f, 'contactId');
  if (!UUID.test(proposalId) || !UUID.test(contactId)) return { status: 'error', message: 'Choose the quotation and the client contact who accepted.' };
  if (!(CHANNELS as readonly string[]).includes(channel)) return { status: 'error', message: 'Say where the acceptance came from.' };
  const stated = text(f, 'statedVersion');
  const result = await recordEvidencedAcceptance({
    proposalId,
    contactId,
    channel: channel as (typeof CHANNELS)[number],
    evidenceRef: text(f, 'evidenceRef'),
    statedVersion: /^\d{1,3}$/.test(stated) ? Number(stated) : null,
    messageRef: text(f, 'messageRef') || null,
    note: text(f, 'note') || null,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/quotations/negotiation');
  return result.data.kind === 'recorded'
    ? { status: 'success', message: 'Accepted. The terms as they stood are saved with the evidence.' }
    : { status: 'success', message: 'Several versions are open and the client did not say which. Nothing was accepted: ask them which version, then record it with that version.' };
}

export async function cancelQuotationAction(_prev: FormState, f: FormData): Promise<FormState> {
  const result = await cancelQuotation(text(f, 'proposalId'), text(f, 'reason'));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/quotations/negotiation');
  return { status: 'success', message: result.data };
}

export async function resolveClarificationAction(_prev: FormState, f: FormData): Promise<FormState> {
  const result = await resolveClarification(text(f, 'clarificationId'), text(f, 'note'));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/quotations/negotiation');
  return { status: 'success', message: result.data };
}

export async function applyTaxAction(_prev: FormState, f: FormData): Promise<FormState> {
  const result = await applyConfiguredTax(text(f, 'proposalId'));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/quotations/negotiation');
  if (result.data.state === 'applied') return { status: 'success', message: 'Tax applied from the configuration; the total now includes it.' };
  if (result.data.state === 'not_draft') return { status: 'error', message: 'Only a draft can have its tax recomputed.' };
  return { status: 'error', message: 'The tax treatment is uncertain (no configuration, or GST without a GSTIN). It was flagged for an administrator in Quotation policy; it cannot go for approval until that is resolved.' };
}
