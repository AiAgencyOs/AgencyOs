'use server';

import { revalidatePath } from 'next/cache';

import { setKillSwitch } from '@/lib/observability/kill-switches';
import type { FormState } from '@/modules/identity/types';

import { ACQUISITION_CHANNELS, ICP_LIST_KEYS, buildIcpDefinition, type AcquisitionChannel } from './schema';
import { cancelHandoff, decideDuplicateReview, saveChannelSettings, saveHandoffSettings, saveIcp, saveTargetService, seedAcquisitionDefaults, setChannelPause } from './service';

const text = (f: FormData, n: string) => String(f.get(n) ?? '').trim();
const BASE = '/lead-generation';
const refresh = () => revalidatePath(BASE, 'layout');

/** An empty box means "no value", which is not zero: a blank budget is not a budget of nothing. */
function wholeOrNull(raw: string): number | null | 'bad' {
  if (raw === '') return null;
  if (!/^\d+$/.test(raw)) return 'bad';
  return Number(raw);
}

export async function seedDefaultsAction(): Promise<FormState> {
  const r = await seedAcquisitionDefaults();
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: r.data.seeded ? 'Set up with the three default services. Change them under Settings.' : 'Already set up.' };
}

export async function saveServiceAction(_p: FormState, f: FormData): Promise<FormState> {
  const priority = Number(text(f, 'priority') || '100');
  if (!Number.isInteger(priority)) return { status: 'error', message: 'Priority must be a whole number from 1 to 1000.' };
  const r = await saveTargetService({
    id: text(f, 'id') || null,
    name: text(f, 'name'),
    description: text(f, 'description'),
    priority,
    active: f.get('active') === 'on',
  });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Saved.' };
}

export async function saveIcpAction(_p: FormState, f: FormData): Promise<FormState> {
  const lists: Partial<Record<(typeof ICP_LIST_KEYS)[number], string>> = {};
  for (const key of ICP_LIST_KEYS) lists[key] = String(f.get(key) ?? '');
  const definition = buildIcpDefinition({ ...lists, minScore: text(f, 'minScore') });
  if (Object.keys(definition).length === 0) return { status: 'error', message: 'Fill in at least one part of the profile.' };
  const r = await saveIcp({ definition, note: text(f, 'note') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: `Saved as version ${r.data.version}. Earlier versions are kept.` };
}

export async function saveChannelSettingsAction(_p: FormState, f: FormData): Promise<FormState> {
  const channel = text(f, 'channel');
  const target = wholeOrNull(text(f, 'monthlyQualifiedTarget'));
  const budget = wholeOrNull(text(f, 'monthlyBudget'));
  const daily = wholeOrNull(text(f, 'dailyLimit'));
  if (target === 'bad' || budget === 'bad' || daily === 'bad') return { status: 'error', message: 'Targets, budgets and limits must be whole numbers.' };
  const r = await saveChannelSettings({
    channel,
    enabled: f.get('enabled') === 'on',
    monthlyQualifiedTarget: target,
    monthlyBudgetMinor: budget === null ? null : budget * 100,
    dailyLimit: daily,
  });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Saved.' };
}

export async function setChannelPauseAction(_p: FormState, f: FormData): Promise<FormState> {
  const channel = text(f, 'channel');
  if (!(ACQUISITION_CHANNELS as readonly string[]).includes(channel)) return { status: 'error', message: 'That is not one of the five channels.' };
  const r = await setChannelPause({ channel: channel as AcquisitionChannel, paused: f.get('paused') === '1', reason: text(f, 'reason') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: f.get('paused') === '1' ? 'Paused. No new action will be taken on this channel.' : 'Resumed.' };
}

export async function setGlobalPauseAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await setKillSwitch({ switch: 'acquisition_paused', active: f.get('active') === '1', reason: text(f, 'reason') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  revalidatePath('/operations');
  return { status: 'success', message: f.get('active') === '1' ? 'All lead generation is paused.' : 'Lead generation resumed.' };
}

const DECISIONS = ['confirmed_same', 'kept_separate', 'dismissed'] as const;

export async function decideDuplicateReviewAction(_p: FormState, f: FormData): Promise<FormState> {
  const decision = text(f, 'decision');
  if (!(DECISIONS as readonly string[]).includes(decision)) return { status: 'error', message: 'Choose one of the three decisions.' };
  const r = await decideDuplicateReview({ reviewId: text(f, 'reviewId'), decision: decision as (typeof DECISIONS)[number], note: text(f, 'note') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Recorded.' };
}

export async function saveHandoffSettingsAction(_p: FormState, f: FormData): Promise<FormState> {
  const days = Number(text(f, 'linkTtlDays') || '14');
  if (!Number.isInteger(days)) return { status: 'error', message: 'The lifetime must be a whole number of days.' };
  const r = await saveHandoffSettings({ businessNumber: text(f, 'businessNumber'), linkTtlDays: days });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Saved.' };
}

export async function cancelHandoffAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await cancelHandoff({ handoffId: text(f, 'handoffId'), reason: text(f, 'reason') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Cancelled. The link no longer works.' };
}
