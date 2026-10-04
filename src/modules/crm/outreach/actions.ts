'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import {
  approveCampaign,
  approveTemplate,
  convertProspect,
  createCampaign,
  createTemplate,
  importProspects,
  markReplied,
  saveOutreachSettings,
  setCampaignState,
  suppress,
} from './service';

const text = (f: FormData, n: string) => String(f.get(n) ?? '').trim();
const BASE = '/communication/email-outreach';
const refresh = () => revalidatePath(BASE);

export async function saveOutreachSettingsAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await saveOutreachSettings({
    senderName: text(f, 'senderName'),
    postalAddress: text(f, 'postalAddress'),
    replyTo: text(f, 'replyTo'),
    dailyCap: Number(text(f, 'dailyCap')) || 20,
    bouncePausePercent: Number(text(f, 'bouncePausePercent')) || 5,
    coldBasisEnabled: f.has('coldBasisPresent') ? f.get('coldBasisEnabled') === 'on' : undefined,
  });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Saved.' };
}

export async function importProspectsAction(_p: FormState, f: FormData): Promise<FormState> {
  const basis = text(f, 'lawfulBasis');
  const r = await importProspects({
    csv: String(f.get('csv') ?? ''),
    provenance: text(f, 'provenance'),
    lawfulBasis: (['consent', 'existing_relationship', 'b2b_legitimate_interest'].includes(basis) ? basis : 'b2b_legitimate_interest') as 'consent',
  });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  const d = r.data;
  return {
    status: 'success',
    message: `${d.inserted} added, ${d.duplicates} already known, ${d.suppressed} suppressed (skipped), ${d.invalid} refused.${d.problems.length ? ` First problems: ${d.problems.slice(0, 3).join('; ')}` : ''}`,
  };
}

export async function createTemplateAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await createTemplate({ name: text(f, 'name'), language: text(f, 'language') || 'en', subject: text(f, 'subject'), body: String(f.get('body') ?? '') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Saved as a draft. A second person must approve it before any campaign can use it.' };
}

export async function approveTemplateAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await approveTemplate(text(f, 'templateId'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Approved.' };
}

export async function createCampaignAction(_p: FormState, f: FormData): Promise<FormState> {
  const steps = [1, 2, 3]
    .map((n) => ({ templateId: text(f, `template${n}`), delayDays: Number(text(f, `delay${n}`)) || 0 }))
    .filter((s) => s.templateId);
  const split = (v: string) => v.split(',').map((t) => t.trim()).filter(Boolean);
  const r = await createCampaign({ name: text(f, 'name'), tags: split(text(f, 'tags')), languages: split(text(f, 'languages')), limit: Number(text(f, 'limit')) || null, steps });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Created as a draft. A second person approves it; approving freezes who it goes to.' };
}

export async function approveCampaignAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await approveCampaign(text(f, 'campaignId'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  revalidatePath(`${BASE}/${text(f, 'campaignId')}`);
  return { status: 'success', message: `Approved - ${r.data.recipients} people are now frozen into the campaign.` };
}

export async function setCampaignStateAction(_p: FormState, f: FormData): Promise<FormState> {
  const to = text(f, 'to') as 'running' | 'paused' | 'cancelled';
  const r = await setCampaignState(text(f, 'campaignId'), to, text(f, 'note') || undefined);
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  revalidatePath(`${BASE}/${text(f, 'campaignId')}`);
  return { status: 'success', message: `Campaign ${to}.` };
}

export async function suppressAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await suppress(text(f, 'email'), text(f, 'reason') || 'manual', text(f, 'note'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Suppressed for good. No campaign can email this address.' };
}

export async function markRepliedAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await markReplied(text(f, 'prospectId'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Marked as replied - any next step to them is cancelled.' };
}

export async function convertProspectAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await convertProspect(text(f, 'prospectId'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Converted to a lead. No marketing consent was granted by doing so.' };
}
