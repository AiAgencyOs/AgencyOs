import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import type { Json } from '@/lib/db/types';

import type { AdPlatform, ChangeKind } from './ad-vocabulary';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The ad engine's worker side (20261020100000). Approval, versioning, the caps and the one-execution rule live in the database;
 * this is the code that goes through them. A provider is only reached after `crm.begin_ad_apply` says `proceed`, and what it is
 * sent is read from the immutable version row - so what runs is what was approved.
 */

export type AdApplyInput = {
  platform: AdPlatform;
  versionId: string;
  contentHash: string;
  changeKind: ChangeKind;
  plan: Json;
  budgetDailyMinor: number;
  budgetTotalMinor: number | null;
  startDate: string | null;
  endDate: string | null;
  currency: string;
  /** The provider's id for the campaign this changes, when it already runs. */
  existingProviderCampaignId: string | null;
  signal: AbortSignal;
};

/** `rejected` = the platform refused and nothing changed. `unknown` = it may have been accepted: reconciled, never repeated blindly. */
export type AdApplyResult =
  | { status: 'applied'; providerCampaignId: string; objects: { objectType: 'campaign' | 'ad_set' | 'ad_group' | 'ad' | 'keyword' | 'creative'; providerId: string }[] }
  | { status: 'rejected'; reason: string }
  | { status: 'unknown'; reason: string };

export type AdProvider = {
  apply(input: AdApplyInput): Promise<AdApplyResult>;
  /** Push a pause, resume or end. `confirmed` only when the platform says it is done. */
  change?(input: { platform: AdPlatform; providerCampaignId: string; action: 'pause' | 'resume' | 'end'; signal: AbortSignal }): Promise<'confirmed' | 'failed'>;
};

const row = <T>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;

export type AdApplyOutcome =
  | { outcome: 'applied'; providerCampaignId: string }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'unknown'; reason: string }
  | { outcome: 'not_proceeding'; reason: string; why: string };

/**
 * Apply ONE approved version, if and only if the governed door lets it proceed. Never throws for a provider problem: an exception
 * from the provider is `unknown` (we cannot know whether the change went out), which parks it for reconciliation.
 */
export async function applyAdVersion(
  admin: Admin,
  input: { organizationId: string; versionId: string; provider: AdProvider; correlationId?: string; timeoutMs?: number },
): Promise<AdApplyOutcome> {
  const { data: begun, error } = await admin.schema('crm').rpc('begin_ad_apply', {
    p_organization_id: input.organizationId, p_version: input.versionId, p_correlation_id: input.correlationId,
  });
  if (error) throw new Error(`begin_ad_apply failed: ${error.message}`);
  const b = row<{ outcome?: string; reason?: string | null; execution_id?: string | null }>(begun);
  if (b?.outcome !== 'proceed' || !b.execution_id) return { outcome: 'not_proceeding', reason: b?.outcome ?? 'no_answer', why: b?.reason ?? '' };
  const executionId = b.execution_id;

  const { data: v } = await admin.schema('crm').from('ad_campaign_versions')
    .select('campaign_id, plan, budget_daily_minor, budget_total_minor, start_date, end_date, content_hash, change_kind').eq('id', input.versionId).eq('organization_id', input.organizationId).maybeSingle();
  const { data: c } = v
    ? await admin.schema('crm').from('ad_campaigns').select('platform, currency, live_version_id').eq('id', v.campaign_id).maybeSingle()
    : { data: null };
  if (!v || !c) {
    await record(admin, input, executionId, 'unknown', '', {}, { error: 'could not read the approved version' });
    return { outcome: 'unknown', reason: 'could not read the approved version' };
  }
  const { data: existing } = await admin.schema('crm').from('ad_applications').select('provider_campaign_id').eq('version_id', c.live_version_id ?? '00000000-0000-0000-0000-000000000000').maybeSingle();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 60_000);
  let result: AdApplyResult;
  try {
    result = await input.provider.apply({
      platform: c.platform as AdPlatform, versionId: input.versionId, contentHash: v.content_hash, changeKind: v.change_kind as ChangeKind, plan: v.plan,
      budgetDailyMinor: v.budget_daily_minor, budgetTotalMinor: v.budget_total_minor, startDate: v.start_date, endDate: v.end_date, currency: c.currency,
      existingProviderCampaignId: existing?.provider_campaign_id ?? null, signal: controller.signal,
    });
  } catch {
    result = { status: 'unknown', reason: 'the provider did not return a result' };
  } finally {
    clearTimeout(timer);
  }

  if (result.status === 'applied') {
    const recorded = await record(admin, input, executionId, 'executed', result.providerCampaignId, { objects: result.objects }, {});
    if (recorded !== 'recorded') return { outcome: 'unknown', reason: `the change is live but could not be recorded (${recorded})` };
    return { outcome: 'applied', providerCampaignId: result.providerCampaignId };
  }
  if (result.status === 'rejected') {
    await record(admin, input, executionId, 'failed', '', {}, { reason: result.reason });
    return { outcome: 'failed', reason: result.reason };
  }
  await record(admin, input, executionId, 'unknown', '', {}, { reason: result.reason });
  return { outcome: 'unknown', reason: result.reason };
}

async function record(admin: Admin, input: { organizationId: string; versionId: string }, executionId: string, status: 'executed' | 'failed' | 'unknown', providerId: string, extra: { objects?: AdApplyResultObjects }, evidence: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.schema('crm').rpc('record_ad_apply', {
    p_organization_id: input.organizationId, p_version: input.versionId, p_execution: executionId, p_status: status, p_provider_campaign_id: providerId,
    p_objects: (extra.objects ?? []).map((o) => ({ object_type: o.objectType, provider_id: o.providerId })) as unknown as Json, p_evidence: evidence as unknown as Json,
  });
  if (error) throw new Error(`record_ad_apply failed: ${error.message}`);
  return row<{ outcome?: string }>(data)?.outcome ?? 'invalid';
}
type AdApplyResultObjects = Extract<AdApplyResult, { status: 'applied' }>['objects'];

export type AdSweep = { approvalsClosed: number; stopsRequested: number; applied: number; failed: number; unknown: number; assisted: number; pushed: number; pushFailed: number };

/**
 * The cron sweep. Moves rejected or lapsed approvals out of review, turns an emergency stop into pending pauses, applies what is
 * approved through whatever provider exists, pushes pending pause/resume/end, and TELLS A PERSON about what cannot be done
 * automatically (no provider: assisted) or is stuck (unknown outcome). Bounded per tick.
 */
export async function runAdOperations(admin: Admin, providers: Partial<Record<AdPlatform, AdProvider>>): Promise<AdSweep> {
  const sweep: AdSweep = { approvalsClosed: 0, stopsRequested: 0, applied: 0, failed: 0, unknown: 0, assisted: 0, pushed: 0, pushFailed: 0 };
  try {
    const closed = await admin.schema('crm').rpc('sync_ad_approvals', { p_limit: 200 });
    sweep.approvalsClosed = typeof closed.data === 'number' ? closed.data : 0;
    const stops = await admin.schema('crm').rpc('enforce_ad_stops', { p_limit: 100 });
    sweep.stopsRequested = typeof stops.data === 'number' ? stops.data : 0;

    // Approved and waiting: an admin decided, nothing has applied it yet.
    const { data: waiting } = await admin.schema('crm').from('ad_campaign_versions')
      .select('id, organization_id, campaign_id, approval_request_id').in('state', ['ADMIN_REVIEW', 'LAUNCHING']).not('approval_request_id', 'is', null).order('state_changed_at').limit(25);
    for (const w of waiting ?? []) {
      const { data: req } = await admin.schema('approvals').from('approval_requests').select('state').eq('id', w.approval_request_id ?? '').maybeSingle();
      if (req?.state !== 'approved') continue;
      const { data: camp } = await admin.schema('crm').from('ad_campaigns').select('platform, name').eq('id', w.campaign_id).maybeSingle();
      const provider = camp ? providers[camp.platform as AdPlatform] : undefined;
      if (!provider || !camp) {
        sweep.assisted += 1;
        await admin.schema('core').rpc('raise_alert', {
          p_organization_id: w.organization_id, p_source: 'ad_operations', p_severity: 'warning',
          p_summary: `The approved ${camp?.platform ?? 'ad'} change for "${camp?.name ?? 'a campaign'}" cannot be applied automatically yet (no connector is built): apply it by hand on the platform exactly as approved, then record it.`,
          p_fingerprint: `ads-assisted:${w.id}`,
        });
        continue;
      }
      const r = await applyAdVersion(admin, { organizationId: w.organization_id, versionId: w.id, provider });
      if (r.outcome === 'applied') sweep.applied += 1;
      else if (r.outcome === 'failed') sweep.failed += 1;
      else if (r.outcome === 'unknown') sweep.unknown += 1;
      else if (r.reason === 'needs_reconciliation') {
        await admin.schema('core').rpc('raise_alert', {
          p_organization_id: w.organization_id, p_source: 'ad_operations', p_severity: 'critical',
          p_summary: `An ad change may have gone live but its result is unknown. Check the platform before doing anything: AgencyOS will not apply it again.`,
          p_fingerprint: `ads-reconcile:${w.id}`,
        });
      }
    }

    // Pending pause / resume / end: an intent until the platform confirms it.
    const { data: pending } = await admin.schema('crm').rpc('pending_ad_changes', { p_limit: 50 });
    for (const p of pending ?? []) {
      if (!p.organization_id || !p.campaign_id || !p.platform || !p.action) continue;
      const provider = providers[p.platform as AdPlatform];
      if (!provider?.change) {
        await admin.schema('core').rpc('raise_alert', {
          p_organization_id: p.organization_id, p_source: 'ad_operations', p_severity: 'critical',
          p_summary: `A ${p.action} was requested for a ${p.platform} campaign and AgencyOS cannot push it: do it by hand on the platform now, then confirm it here.`,
          p_fingerprint: `ads-push:${p.campaign_id}:${p.action}`,
        });
        continue;
      }
      const { data: app } = await admin.schema('crm').from('ad_campaigns').select('live_version_id').eq('id', p.campaign_id).maybeSingle();
      const { data: applied } = await admin.schema('crm').from('ad_applications').select('provider_campaign_id').eq('version_id', app?.live_version_id ?? '00000000-0000-0000-0000-000000000000').maybeSingle();
      if (!applied) continue;
      let res: 'confirmed' | 'failed' = 'failed';
      try {
        res = await provider.change({ platform: p.platform as AdPlatform, providerCampaignId: applied.provider_campaign_id, action: p.action as 'pause' | 'resume' | 'end', signal: AbortSignal.timeout(30_000) });
      } catch { res = 'failed'; }
      await admin.schema('crm').rpc('confirm_ad_change', { p_organization_id: p.organization_id, p_campaign: p.campaign_id, p_confirmed: res === 'confirmed', p_detail: res === 'confirmed' ? undefined : 'the platform did not confirm' });
      if (res === 'confirmed') sweep.pushed += 1; else sweep.pushFailed += 1;
    }

    // Health is read for every running campaign; it only ever records, never acts.
    const { data: running } = await admin.schema('crm').from('ad_campaigns').select('id, organization_id').in('status', ['live', 'paused']).limit(100);
    for (const c of running ?? []) await admin.schema('crm').rpc('assess_campaign_health', { p_organization_id: c.organization_id, p_campaign: c.id });
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'runAdOperations', detail: e instanceof Error ? e.message : 'unknown' }));
  }
  return sweep;
}
