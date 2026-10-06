import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import { serverEnv } from '@/lib/env';
import { openForTenant } from '@/lib/secrets/tenant-vault';

import { readMetaCampaignInsights, type MetaInsightsResult } from './meta-ads-adapter';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Pull Meta's daily figures for the campaigns a person recorded as launched, and record them through the SAME door a person's hand-copied
 * figures use (`crm.record_ad_metrics`: a restated figure supersedes, only an increase is counted as spend, once). Read-only toward Meta.
 *
 * What this does NOT do: it does not decide anything, change a campaign, or pause one. It reads and records. The CRM stays the authority
 * on leads: Meta's lead count is stored as the platform's claim, never as a lead.
 *
 * Only runs for a connection that is ACTIVE and LIVE_VERIFIED by a real check, and only for a campaign with a provider id on record.
 */

/** Currencies whose minor unit is not 1/100: a spend string cannot be turned into minor units by x100, so they are refused, not guessed. */
const NOT_TWO_DECIMALS = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'PYG', 'KWD', 'BHD', 'OMR', 'JOD', 'TND', 'IQD', 'LYD']);

export type MetaSyncSummary = { connections: number; campaigns: number; days: number; recorded: number; unchanged: number; skipped: number; failed: number };

export function spendToMinor(spend: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(spend)) return null;
  const minor = Math.round(Number(spend) * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function syncMetaAdMetrics(
  admin: Admin,
  options: { now?: Date; days?: number; read?: (input: { token: string; providerCampaignId: string; since: string; until: string; signal: AbortSignal }) => Promise<MetaInsightsResult> } = {},
): Promise<MetaSyncSummary> {
  const out: MetaSyncSummary = { connections: 0, campaigns: 0, days: 0, recorded: 0, unchanged: 0, skipped: 0, failed: 0 };
  const read = options.read ?? ((i) => readMetaCampaignInsights(i));
  const now = options.now ?? new Date();
  // A restated figure can arrive days late, so the window re-reads a week; unchanged days cost nothing (they are compared, not re-recorded).
  const until = iso(now);
  const since = iso(new Date(now.getTime() - (options.days ?? 7) * 86_400_000));

  const { data: integrations, error } = await admin.schema('crm').from('acquisition_integrations')
    .select('id, organization_id').eq('provider', 'meta_ads').eq('status', 'active').eq('verification', 'LIVE_VERIFIED').limit(50);
  if (error) { console.error(JSON.stringify({ level: 'error', scope: 'syncMetaAdMetrics', detail: error.message })); return { ...out, failed: 1 }; }

  for (const integ of integrations ?? []) {
    // Campaigns first: with nothing recorded as launched, Meta is never called.
    const { data: apps, error: appsError } = await admin.schema('crm').from('ad_applications')
      .select('provider_campaign_id, version_id, ad_campaign_versions!inner(campaign_id, ad_campaigns!inner(id, platform, currency, status))')
      .eq('organization_id', integ.organization_id).limit(200);
    if (appsError) { out.failed += 1; continue; }
    const campaigns = new Map<string, { campaignId: string; currency: string }>();
    for (const a of (apps ?? []) as unknown as { provider_campaign_id: string; ad_campaign_versions: { campaign_id: string; ad_campaigns: { id: string; platform: string; currency: string; status: string } } }[]) {
      const c = a.ad_campaign_versions?.ad_campaigns;
      if (c?.platform === 'meta_ads' && c.status !== 'draft') campaigns.set(a.provider_campaign_id, { campaignId: c.id, currency: c.currency });
    }
    if (campaigns.size === 0) continue;
    out.connections += 1;

    const token = await openCredential(admin, integ.organization_id, integ.id, 'access_token');
    if (!token) { out.failed += 1; await alertOnce(admin, integ.organization_id, 'the stored Meta token could not be opened. Store it again.'); continue; }

    for (const [providerCampaignId, camp] of campaigns) {
      out.campaigns += 1;
      const result = await read({ token, providerCampaignId, since, until, signal: AbortSignal.timeout(20_000) });
      if (!result.ok) {
        out.failed += 1;
        // A credential or permission problem needs a person; a transient one retries on the next window by itself.
        if (result.errorClass !== 'transient') await alertOnce(admin, integ.organization_id, result.message);
        continue;
      }
      if (result.currency && (result.currency !== camp.currency || NOT_TWO_DECIMALS.has(result.currency))) {
        out.skipped += result.days.length;
        await alertOnce(admin, integ.organization_id, `Meta reports in ${result.currency} but the campaign is in ${camp.currency} (or the currency has no hundredths); its figures were not recorded, because converting would be a guess.`);
        continue;
      }
      for (const day of result.days) {
        out.days += 1;
        const spendMinor = spendToMinor(day.spend);
        if (spendMinor === null) { out.skipped += 1; continue; }
        const { data: last, error: lastError } = await admin.schema('crm').from('ad_metrics')
          .select('spend_minor, impressions, clicks, platform_leads').eq('campaign_id', camp.campaignId).eq('metric_date', day.date).order('reported_at', { ascending: false }).limit(1).maybeSingle();
        if (lastError) { out.failed += 1; continue; }
        if (last && Number(last.spend_minor) === spendMinor && Number(last.impressions) === day.impressions && Number(last.clicks) === day.clicks && Number(last.platform_leads) === day.leads) { out.unchanged += 1; continue; }
        const { data, error: recordError } = await admin.schema('crm').rpc('record_ad_metrics', {
          p_organization_id: integ.organization_id, p_campaign: camp.campaignId, p_date: day.date, p_spend_minor: spendMinor, p_impressions: day.impressions, p_clicks: day.clicks, p_platform_leads: day.leads,
        });
        const outcome = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | null;
        if (recordError || outcome?.outcome !== 'recorded') out.failed += 1; else out.recorded += 1;
      }
    }
  }
  return out;
}

async function openCredential(admin: Admin, organizationId: string, integrationId: string, name: string): Promise<string | null> {
  const secret = serverEnv().VAULT_ENCRYPTION_KEY;
  if (!secret) return null;
  const { data, error } = await admin.schema('crm').from('connector_credentials')
    .select('name, ciphertext, iv, auth_tag').eq('integration_id', integrationId).eq('organization_id', organizationId).eq('name', name).eq('status', 'active').maybeSingle();
  if (error || !data) return null;
  try {
    return openForTenant({ ciphertext: data.ciphertext, iv: data.iv, authTag: data.auth_tag }, { organizationId, integrationId, name }, secret);
  } catch {
    return null; // a credential that will not open is a credential problem, never a crash with a value in it
  }
}

async function alertOnce(admin: Admin, organizationId: string, why: string): Promise<void> {
  await admin.schema('core').rpc('raise_alert', {
    p_organization_id: organizationId, p_source: 'ad_operations', p_severity: 'warning',
    p_summary: `Meta ad figures could not be read: ${why}`.slice(0, 300), p_fingerprint: 'meta-metrics-sync',
  });
}
