'use server';

import { revalidatePath } from 'next/cache';

import { setKillSwitch } from '@/lib/observability/kill-switches';
import type { FormState } from '@/modules/identity/types';

import { QUALIFICATION_FACTORS, type QualificationFactor } from './qualification-vocabulary';
import type { FactSource } from './email-engine';
import { ACQUISITION_CHANNELS, ICP_LIST_KEYS, buildIcpDefinition, type AcquisitionChannel } from './schema';
import { registerIntegration, saveAcquisitionPolicy, setIntegrationState, storeConnectorSecret, testConnection } from './integrations';
import { mergeContacts, requestAgentTask, setAcquisitionAutopilot, checkDraft, createTrackedLink, recordProspectFact, scoreProspect, recheckLanding, recordAdChangeDone, recordAdFigures, recordAdLaunched, recordLandingUploaded, recordPosted, linkB2bLead, checkB2bProfile, checkB2bProposal, decideB2bOpportunity, importB2bOpportunity, readyB2b, recordB2bOutcome, recordB2bProfileApplied, recordB2bSent, saveB2bProfile, saveB2bProposal, saveB2bRule, saveB2bSettings, submitB2bProfile, submitB2bProposal, checkLandingVersion, retireLandingPage, saveLandingVersion, submitLandingVersion, checkAdVersion, requestAdChange, saveAdPlan, submitAdVersion, activateSocialStrategy, cancelContentVersion, createContentDraft, reviewContentVersion, scheduleContentVersion, submitContentForApproval, blockProspect, liftProspectBlock, saveQualificationModel, cancelSubtask, cancelHandoff, decideDuplicateReview, saveChannelSettings, saveHandoffSettings, saveIcp, saveTargetService, seedAcquisitionDefaults, setChannelPause } from './service';

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

export async function askAgentAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await requestAgentTask({ agent: text(f, 'agent'), task: text(f, 'task') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Queued. The agent drafts; nothing is sent or published, and you approve what it prepares.' };
}

export async function setAutopilotAction(_p: FormState, f: FormData): Promise<FormState> {
  const on = f.get('enabled') === '1';
  const r = await setAcquisitionAutopilot({ enabled: on });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: on ? 'On. From Monday 09:00 each enabled agent drafts for approval.' : 'Off.' };
}

export async function mergeContactsAction(_p: FormState, f: FormData): Promise<FormState> {
  const [winner = '', loser = ''] = text(f, 'keep').split(':');
  const r = await mergeContacts({ winner, loser, reason: text(f, 'reason') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Merged. The other record is kept as history.' };
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

export async function registerIntegrationAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await registerIntegration({ provider: text(f, 'provider'), environment: text(f, 'environment') || 'production', label: text(f, 'label') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Added. Store its credential next, then test it.' };
}

export async function storeSecretAction(_p: FormState, f: FormData): Promise<FormState> {
  // The value is read from the form once, handed to the encryptor and never echoed back or put in a message.
  const r = await storeConnectorSecret({ integrationId: text(f, 'integrationId'), name: text(f, 'name'), value: String(f.get('value') ?? ''), expiresOn: text(f, 'expiresOn') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: r.data.rotated ? 'Replaced. The old credential is kept as revoked history.' : 'Stored securely. It cannot be viewed again.' };
}

export async function setIntegrationStateAction(_p: FormState, f: FormData): Promise<FormState> {
  const to = text(f, 'to');
  if (to !== 'DISABLED' && to !== 'CONFIGURED' && to !== 'REVOKED') return { status: 'error', message: 'Unknown change.' };
  const r = await setIntegrationState({ integrationId: text(f, 'integrationId'), to, reason: text(f, 'reason') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Done.' };
}

export async function testConnectionAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await testConnection(text(f, 'integrationId'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  const t = r.data;
  if (t.kind === 'passed') return { status: 'success', message: `Connected to ${t.accountRef}.` };
  return { status: 'error', message: t.message };
}

export async function savePolicyAction(_p: FormState, f: FormData): Promise<FormState> {
  const num = (n: string) => {
    const raw = text(f, n);
    if (raw === '') return null;
    return /^\d+$/.test(raw) ? Number(raw) * 100 : Number.NaN;
  };
  const approvalAbove = num('approvalAbove');
  const escalateAbove = num('escalateAbove');
  if (Number.isNaN(approvalAbove) || Number.isNaN(escalateAbove)) return { status: 'error', message: 'Thresholds are whole rupee amounts, or blank.' };
  const r = await saveAcquisitionPolicy({ action: text(f, 'action'), mode: text(f, 'mode'), approvalAboveMinor: approvalAbove, escalateAboveMinor: escalateAbove });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Saved.' };
}

export async function cancelSubtaskAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await cancelSubtask({ subtaskId: text(f, 'subtaskId'), reason: text(f, 'reason') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Cancelled. Control is back with the conversation owner.' };
}

export async function saveQualificationModelAction(_p: FormState, f: FormData): Promise<FormState> {
  const weights: Record<string, number> = {};
  for (const factor of QUALIFICATION_FACTORS) {
    const raw = text(f, factor);
    if (raw === '') continue;
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > 100) return { status: 'error', message: 'Weights are whole numbers from 0 to 100.' };
    weights[factor] = Number(raw);
  }
  if (Object.keys(weights).length === 0) return { status: 'error', message: 'Give at least one factor a weight.' };
  const r = await saveQualificationModel({ weights, note: text(f, 'note') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: `Saved as version ${r.data.version}. Earlier decisions keep the version they were made under.` };
}

export async function blockProspectAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await blockProspect({ kind: text(f, 'kind'), value: text(f, 'value'), reason: text(f, 'reason') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Blocked. Nobody matching it will be qualified or emailed.' };
}

export async function liftBlockAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await liftProspectBlock({ blockId: text(f, 'blockId'), reason: text(f, 'reason') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Lifted. The record of the block is kept.' };
}

export async function createDraftAction(_p: FormState, f: FormData): Promise<FormState> {
  const hashtags = text(f, 'hashtags').split(/[\s,]+/).map((h) => h.trim()).filter(Boolean).map((h) => (h.startsWith('#') ? h : `#${h}`)).slice(0, 30);
  const r = await createContentDraft({
    platform: text(f, 'platform'), objective: text(f, 'objective'), format: text(f, 'format'), title: text(f, 'title'), service: text(f, 'service'),
    body: String(f.get('body') ?? '').trim(), cta: text(f, 'cta'), hashtags,
  });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Saved as a draft. Run the automated review next.' };
}

export async function reviewVersionAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await reviewContentVersion(text(f, 'versionId'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return r.data.passed ? { status: 'success', message: 'Passed the automated review. This is not approval - submit it for an admin.' } : { status: 'error', message: `Failed the review: ${r.data.blocking.join(', ').replaceAll('_', ' ')}. Write the next version.` };
}

export async function submitVersionAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await submitContentForApproval(text(f, 'versionId'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  revalidatePath('/approvals');
  return { status: 'success', message: 'Sent to the Approval Center. It is approved only as exactly these words.' };
}

export async function scheduleVersionAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await scheduleContentVersion({ versionId: text(f, 'versionId'), when: text(f, 'when') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Scheduled.' };
}

export async function cancelVersionAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await cancelContentVersion({ versionId: text(f, 'versionId'), reason: text(f, 'reason') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Cancelled.' };
}

export async function activateStrategyAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await activateSocialStrategy(text(f, 'strategyId'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Activated. The previous strategy for that platform and horizon is superseded.' };
}

/** Money is typed in whole rupees; the database holds paise. An empty box is "none", never zero. */
function majorToMinor(raw: string): number | null | 'bad' {
  if (raw === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return 'bad';
  return Math.round(Number(raw) * 100);
}
const lines = (raw: string) => raw.split('\n').map((l) => l.trim()).filter(Boolean);
const commas = (raw: string) => raw.split(',').map((l) => l.trim()).filter(Boolean);

export async function saveAdPlanAction(_p: FormState, f: FormData): Promise<FormState> {
  const platform = text(f, 'platform');
  const daily = majorToMinor(text(f, 'daily'));
  const total = majorToMinor(text(f, 'total'));
  if (daily === 'bad' || daily === null || daily <= 0) return { status: 'error', message: 'Enter the daily budget as an amount above zero.' };
  if (total === 'bad') return { status: 'error', message: 'Enter the total budget as an amount, or leave it empty.' };
  let plan: Record<string, unknown>;
  if (platform === 'meta_ads') {
    plan = {
      destination: { type: 'whatsapp' },
      adsets: [{ name: 'Main', audience: { locations: commas(text(f, 'locations')), age_min: Number(text(f, 'ageMin') || 0), age_max: Number(text(f, 'ageMax') || 65) }, placements: commas(text(f, 'placements') || 'feed') }],
      creatives: [{ headline: text(f, 'headline'), primary_text: text(f, 'primaryText'), cta: 'WHATSAPP_MESSAGE' }],
    };
  } else if (platform === 'google_ads') {
    plan = {
      destination: { type: 'landing_page', landing_page_version_id: text(f, 'landingPageVersionId') },
      ad_groups: [{ name: 'Main', keywords: lines(String(f.get('keywords') ?? '')).map((l) => { const [t, m] = l.split('|').map((x) => x.trim()); return { text: t ?? '', match: m || 'phrase' }; }) }],
      negative_keywords: lines(String(f.get('negatives') ?? '')),
      ads: [{ headlines: lines(String(f.get('headlines') ?? '')), descriptions: lines(String(f.get('descriptions') ?? '')) }],
    };
  } else {
    return { status: 'error', message: 'Choose Meta or Google.' };
  }
  const r = await saveAdPlan({
    platform, campaignId: text(f, 'campaignId') || null, name: text(f, 'name'), service: text(f, 'service'), plan,
    dailyMinor: daily, totalMinor: total, startDate: text(f, 'startDate') || null, endDate: text(f, 'endDate') || null,
  });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Saved as a draft version. Run the checks next. Nothing has been sent to the platform.' };
}

export async function checkAdVersionAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await checkAdVersion(text(f, 'versionId'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return r.data.passed ? { status: 'success', message: 'Passed the checks. This is not approval - submit it for an admin.' } : { status: 'error', message: 'Failed the checks. See the list on the version, then write the next one.' };
}

export async function submitAdVersionAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await submitAdVersion(text(f, 'versionId'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  revalidatePath('/approvals');
  return { status: 'success', message: 'Sent to the Approval Center. It is approved only as exactly this plan and budget.' };
}

export async function requestAdChangeAction(_p: FormState, f: FormData): Promise<FormState> {
  const action = text(f, 'action');
  if (action !== 'pause' && action !== 'resume' && action !== 'end') return { status: 'error', message: 'Unknown change.' };
  const r = await requestAdChange({ campaignId: text(f, 'campaignId'), action, reason: text(f, 'reason') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Requested. It shows as pending until the platform confirms it.' };
}

const pairs = (raw: string) => lines(raw).map((l) => { const i = l.indexOf('|'); return i < 0 ? [l.trim(), ''] as const : [l.slice(0, i).trim(), l.slice(i + 1).trim()] as const; });

export async function saveLandingAction(_p: FormState, f: FormData): Promise<FormState> {
  const content: Record<string, unknown> = {
    headline: text(f, 'headline'), subheadline: text(f, 'subheadline'),
    benefits: pairs(String(f.get('benefits') ?? '')).map(([title, t]) => ({ title, text: t })),
    proof: pairs(String(f.get('proof') ?? '')).map(([id, caption]) => ({ portfolio_item_id: id, caption })),
    faq: pairs(String(f.get('faq') ?? '')).map(([q, ans]) => ({ q, a: ans })),
    cta_text: text(f, 'ctaText'), privacy_url: text(f, 'privacyUrl'), contact_email: text(f, 'contactEmail'),
  };
  const r = await saveLandingVersion({ pageId: text(f, 'pageId') || null, name: text(f, 'name'), slug: text(f, 'slug'), service: text(f, 'service'), content, publicUrl: text(f, 'publicUrl') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Saved as a draft version. Run the checks next. Nothing has been sent to a host.' };
}

export async function checkLandingAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await checkLandingVersion(text(f, 'versionId'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return r.data.passed ? { status: 'success', message: 'Passed the checks. This is not approval - submit it for an admin.' } : { status: 'error', message: 'Failed the checks. See the list on the version, then write the next one.' };
}

export async function submitLandingAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await submitLandingVersion(text(f, 'versionId'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  revalidatePath('/approvals');
  return { status: 'success', message: 'Sent to the Approval Center. It is approved only as exactly this page, address and number.' };
}

export async function retireLandingAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await retireLandingPage({ pageId: text(f, 'pageId'), reason: text(f, 'reason') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: 'Retired.' };
}

const b2bDone = (message: string): FormState => { refresh(); return { status: 'success', message }; };
const intOrNull = (raw: string): number | null | 'bad' => (raw === '' ? null : /^\d+$/.test(raw) ? Number(raw) : 'bad');

export async function readyB2bAction(): Promise<FormState> {
  const r = await readyB2b();
  return r.ok ? b2bDone('B2B is set up. Every marketplace starts as: no contact off the platform, a person does everything.') : { status: 'error', message: r.error.message };
}

export async function saveB2bRuleAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await saveB2bRule({ platform: text(f, 'platform'), offplatform: text(f, 'offplatform'), mode: text(f, 'mode'), note: text(f, 'note') });
  return r.ok ? b2bDone('Saved.') : { status: 'error', message: r.error.message };
}

export async function saveB2bSettingsAction(_p: FormState, f: FormData): Promise<FormState> {
  const min = majorToMinor(text(f, 'minBudget'));
  const cap = intOrNull(text(f, 'connectsCap'));
  const threshold = intOrNull(text(f, 'threshold'));
  if (min === 'bad') return { status: 'error', message: 'Enter the minimum budget as an amount, or leave it empty.' };
  if (cap === 'bad') return { status: 'error', message: 'Enter the connects budget as a whole number, or leave it empty.' };
  if (threshold === 'bad' || threshold === null || threshold > 100) return { status: 'error', message: 'The score threshold is a whole number from 0 to 100.' };
  const r = await saveB2bSettings({ minBudgetMinor: min, excludedTerms: commas(text(f, 'excluded')), scoreThreshold: threshold, monthlyConnectsCap: cap });
  return r.ok ? b2bDone('Saved. It applies to the next job scored and the next proposal sent.') : { status: 'error', message: r.error.message };
}

export async function importOpportunityAction(_p: FormState, f: FormData): Promise<FormState> {
  const min = majorToMinor(text(f, 'budgetMin'));
  const max = majorToMinor(text(f, 'budgetMax'));
  if (min === 'bad' || max === 'bad') return { status: 'error', message: 'Enter budgets as amounts, or leave them empty.' };
  const r = await importB2bOpportunity({
    platform: text(f, 'platform'), externalRef: text(f, 'externalRef'), url: text(f, 'url'), title: text(f, 'title'), description: String(f.get('description') ?? '').trim(),
    budgetMinMinor: min, budgetMaxMinor: max, currency: text(f, 'currency') || 'USD', country: text(f, 'country'),
  });
  if (!r.ok) return { status: 'error', message: r.error.message };
  return b2bDone(r.data.status === 'excluded' ? 'Recorded, and excluded by one of your terms.' : `Recorded. Fit score ${r.data.score}: ${r.data.status === 'scored' ? 'worth a look' : 'below your threshold'}.`);
}

export async function decideOpportunityAction(_p: FormState, f: FormData): Promise<FormState> {
  const decision = text(f, 'decision');
  if (decision !== 'shortlist' && decision !== 'skip') return { status: 'error', message: 'Unknown decision.' };
  const r = await decideB2bOpportunity({ opportunityId: text(f, 'opportunityId'), decision, reason: text(f, 'reason') });
  return r.ok ? b2bDone(decision === 'shortlist' ? 'Shortlisted. You can write a proposal now.' : 'Skipped.') : { status: 'error', message: r.error.message };
}

export async function saveProposalAction(_p: FormState, f: FormData): Promise<FormState> {
  const price = majorToMinor(text(f, 'price'));
  const timeline = intOrNull(text(f, 'timeline'));
  const connects = intOrNull(text(f, 'connects')) ?? 0;
  if (price === 'bad' || price === null || price <= 0) return { status: 'error', message: 'Enter the price as an amount above zero - a person sets it.' };
  if (timeline === 'bad' || connects === 'bad') return { status: 'error', message: 'Enter the timeline and connects as whole numbers.' };
  const r = await saveB2bProposal({ opportunityId: text(f, 'opportunityId'), body: String(f.get('body') ?? '').trim(), priceMinor: price, timelineDays: timeline, connects, portfolioIds: commas(text(f, 'portfolio')) });
  return r.ok ? b2bDone('Saved as a draft version. Run the checks next.') : { status: 'error', message: r.error.message };
}

export async function checkProposalAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await checkB2bProposal(text(f, 'versionId'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return r.data.passed ? { status: 'success', message: 'Passed the checks. This is not approval - submit it for an admin.' } : { status: 'error', message: 'Failed the checks. See the list on the version, then write the next one.' };
}

export async function submitProposalAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await submitB2bProposal(text(f, 'versionId'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  revalidatePath('/approvals');
  return b2bDone('Sent to the Approval Center. It is approved only as exactly these words and this price.');
}

export async function recordSentAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await recordB2bSent({ versionId: text(f, 'versionId'), externalRef: text(f, 'externalRef') });
  return r.ok ? b2bDone('Recorded as sent. It will not be recorded again.') : { status: 'error', message: r.error.message };
}

export async function recordOutcomeAction(_p: FormState, f: FormData): Promise<FormState> {
  const outcome = text(f, 'outcome');
  if (outcome !== 'won' && outcome !== 'lost') return { status: 'error', message: 'Choose won or lost.' };
  const value = majorToMinor(text(f, 'value'));
  if (value === 'bad') return { status: 'error', message: 'Enter the value as an amount.' };
  const r = await recordB2bOutcome({ opportunityId: text(f, 'opportunityId'), outcome, valueMinor: value, note: text(f, 'note') });
  return r.ok ? b2bDone('Recorded.') : { status: 'error', message: r.error.message };
}

export async function saveProfileAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await saveB2bProfile({ platform: text(f, 'platform'), content: { headline: text(f, 'headline'), summary: String(f.get('summary') ?? '').trim() } });
  return r.ok ? b2bDone('Saved as a draft version. Run the checks next.') : { status: 'error', message: r.error.message };
}

export async function checkProfileAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await checkB2bProfile(text(f, 'versionId'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return r.data.passed ? { status: 'success', message: 'Passed the checks. This is not approval - submit it for an admin.' } : { status: 'error', message: 'Failed the checks. See the list on the version.' };
}

export async function submitProfileAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await submitB2bProfile(text(f, 'versionId'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  revalidatePath('/approvals');
  return b2bDone('Sent to the Approval Center.');
}

export async function recordProfileAppliedAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await recordB2bProfileApplied({ versionId: text(f, 'versionId'), evidenceUrl: text(f, 'evidenceUrl') });
  return r.ok ? b2bDone('Recorded as applied, with your evidence.') : { status: 'error', message: r.error.message };
}

export async function linkLeadAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await linkB2bLead({ opportunityId: text(f, 'opportunityId'), leadId: text(f, 'leadId') });
  return r.ok ? b2bDone('Linked. The marketplace is now a touchpoint on that lead.') : { status: 'error', message: r.error.message };
}

// ── the by-hand path ───────────────────────────────────────────────────────

export async function recordLaunchAction(_p: FormState, f: FormData): Promise<FormState> {
  const objects: { objectType: string; providerId: string }[] = [];
  for (const [field, objectType] of [['adSetIds', 'ad_set'], ['adGroupIds', 'ad_group'], ['adIds', 'ad']] as const) {
    for (const id of commas(text(f, field))) objects.push({ objectType, providerId: id });
  }
  const r = await recordAdLaunched({ versionId: text(f, 'versionId'), providerCampaignId: text(f, 'providerCampaignId'), objects });
  return r.ok ? b2bDone('Recorded as launched, once. Leads that arrive with those ids are now credited to this campaign.') : { status: 'error', message: r.error.message };
}

export async function adChangeDoneAction(_p: FormState, f: FormData): Promise<FormState> {
  const confirmed = text(f, 'confirmed') === 'yes';
  const r = await recordAdChangeDone({ campaignId: text(f, 'campaignId'), confirmed, detail: text(f, 'detail') });
  return r.ok ? b2bDone(confirmed ? 'Confirmed. The campaign now shows what the platform shows.' : 'Recorded: the platform did not do it. It stays pending.') : { status: 'error', message: r.error.message };
}

export async function adFiguresAction(_p: FormState, f: FormData): Promise<FormState> {
  const spend = majorToMinor(text(f, 'spend'));
  const n = (name: string) => { const v = intOrNull(text(f, name)); return v === 'bad' ? null : v ?? 0; };
  const impressions = n('impressions'); const clicks = n('clicks'); const leads = n('platformLeads');
  if (spend === 'bad' || spend === null) return { status: 'error', message: 'Enter the day\'s spend as an amount.' };
  if (impressions === null || clicks === null || leads === null) return { status: 'error', message: 'Impressions, clicks and leads are whole numbers.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(f, 'date'))) return { status: 'error', message: 'Choose the day these figures are for.' };
  const r = await recordAdFigures({ campaignId: text(f, 'campaignId'), date: text(f, 'date'), spendMinor: spend, impressions, clicks, platformLeads: leads });
  return r.ok ? b2bDone(r.data.countedMinor > 0 ? `Recorded. ₹${(r.data.countedMinor / 100).toLocaleString('en-IN')} was added to this month's spend.` : 'Recorded. Nothing new was added to the spend (the same or a lower figure than already reported).') : { status: 'error', message: r.error.message };
}

export async function recordPostedAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await recordPosted({ versionId: text(f, 'versionId'), externalRef: text(f, 'externalRef'), url: text(f, 'url') });
  return r.ok ? b2bDone('Recorded as posted, once.') : { status: 'error', message: r.error.message };
}

export async function recordLandingUploadedAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await recordLandingUploaded(text(f, 'versionId'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return r.data.verification === 'verified'
    ? { status: 'success', message: 'Recorded as uploaded, and the public address carries exactly the approved page: verified.' }
    : { status: 'success', message: 'Recorded as uploaded. The public address does not carry the approved page yet (or cannot be reached), so it is NOT verified. Check the upload, then press Re-check.' };
}

export async function recheckLandingAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await recheckLanding(text(f, 'versionId'));
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return r.data.verification === 'verified' ? { status: 'success', message: 'Checked: the public address carries exactly the approved page.' } : { status: 'error', message: 'Checked: the public address does not carry the approved page. Ads cannot launch to it.' };
}

// ── the Email engine's decisions, run by a person ──────────────────────────

export async function scoreProspectAction(_p: FormState, f: FormData): Promise<FormState> {
  const factors: Partial<Record<QualificationFactor, number>> = {};
  for (const factor of QUALIFICATION_FACTORS) {
    const raw = text(f, `f_${factor}`);
    if (raw === '') continue;
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > 100) return { status: 'error', message: 'Each score is a whole number from 0 to 100, or empty for "not known".' };
    factors[factor] = Number(raw);
  }
  const r = await scoreProspect({ prospectId: text(f, 'prospectId'), factors, reasoning: String(f.get('reasoning') ?? '').trim() });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  const why = [...r.data.disqualifiers.map((d) => d.replaceAll('_', ' ')), ...(r.data.missing.length > 0 ? [`still needed: ${r.data.missing.join(', ').replaceAll('_', ' ')}`] : [])].join(' · ');
  return { status: 'success', message: `Recorded: ${r.data.decision.replaceAll('_', ' ')}, score ${r.data.score}.${why ? ` ${why}.` : ''}` };
}

export async function recordFactAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await recordProspectFact({ prospectId: text(f, 'prospectId'), fact: String(f.get('fact') ?? '').trim(), sourceKind: text(f, 'sourceKind') as FactSource, sourceUrl: text(f, 'sourceUrl') });
  return r.ok ? { status: 'success', message: `Recorded. Its id is ${r.data.factId} - a message may cite it as a claim.` } : { status: 'error', message: r.error.message };
}

export async function checkDraftAction(_p: FormState, f: FormData): Promise<FormState> {
  const claims = lines(String(f.get('claims') ?? '')).map((l) => { const i = l.lastIndexOf('|'); return i < 0 ? { text: l.trim(), factId: '' } : { text: l.slice(0, i).trim(), factId: l.slice(i + 1).trim() }; });
  const r = await checkDraft({ prospectId: text(f, 'prospectId'), subject: text(f, 'subject'), body: String(f.get('body') ?? '').trim(), claims });
  if (!r.ok) return { status: 'error', message: r.error.message };
  return r.data.valid ? { status: 'success', message: 'Passed: every claim cites a recorded fact about this person, and nothing in it is pressure. A passed draft is still yours to approve.' } : { status: 'error', message: `Failed: ${r.data.problems.map((x) => x.replaceAll('_', ' ')).join(' · ')}. It will not be used until it is corrected.` };
}

export async function createTrackedLinkAction(_p: FormState, f: FormData): Promise<FormState> {
  const r = await createTrackedLink({ leadId: text(f, 'leadId'), sourceChannel: text(f, 'sourceChannel'), sourcePlatform: text(f, 'sourcePlatform'), nextAction: text(f, 'nextAction') });
  if (!r.ok) return { status: 'error', message: r.error.message };
  refresh();
  return { status: 'success', message: `${r.data.reused ? 'That lead already has a live link: ' : 'Created. Send this to them - it works once and is not shown again: '}${r.data.link} (expires ${new Date(r.data.expiresAt).toLocaleDateString('en-IN')})` };
}
