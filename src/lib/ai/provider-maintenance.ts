import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import { discoverModels } from './provider-discovery';
import { endpointAndSecret, recordProbe } from './provider-endpoint';
import { resetProviderRegistry } from './router';
import { raiseAlert } from './run-gates';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The background half of the Provider Manager: on the cron tick, probe the providers that are due and refresh their model lists.
 *
 *   • only enabled, un-archived providers are touched - what the Admin turned off is left alone,
 *   • at most a few per tick, oldest check first, so a slow vendor cannot hold the tick,
 *   • a provider with no usable key is marked "not checked" with that reason (so it does not starve the others) - never "failed",
 *   • a probe is the same call as the Admin's Test (same endpoint, same key choice, same record),
 *   • models it finds arrive DISABLED, and ones the vendor stops listing are marked, never deleted,
 *   • a provider that turns bad (rejected key, exhausted quota, unreachable) raises ONE alert per provider and kind; a recovery
 *     clears nothing by itself - a person acknowledges the alert.
 *
 * Best effort and never fatal: a failure here is logged and the tick carries on.
 */

const HEALTH_MINUTES = 15;
const SYNC_MINUTES = 360;
const PER_TICK = 3;

export type MaintenanceSummary = { probed: string[]; synced: string[]; skipped: string[]; alerts: string[] };

const BAD = new Set(['auth_error', 'quota_exhausted', 'unavailable']);

export async function runProviderMaintenance(admin: Admin): Promise<MaintenanceSummary> {
  const summary: MaintenanceSummary = { probed: [], synced: [], skipped: [], alerts: [] };
  try {
    const due = await admin.schema('ai').rpc('due_provider_maintenance', { p_health_minutes: HEALTH_MINUTES, p_sync_minutes: SYNC_MINUTES, p_limit: PER_TICK });
    if (due.error) throw new Error(due.error.message);

    for (const row of due.data ?? []) {
      const providerId = row.provider_id ?? '';
      if (!providerId) continue;
      const target = await endpointAndSecret(providerId, null);
      if (!target.ok) {
        // Nothing to probe with. Recorded so the provider is not "due" again for a while, and so the screen says why it was not checked.
        await admin.schema('ai').rpc('record_provider_health', { p_provider_id: providerId, p_state: 'unknown', p_detail: 'Not checked: no usable key to probe with.', p_latency_ms: null as unknown as number, p_counted: false });
        await admin.schema('ai').rpc('record_model_sync', { p_provider_id: providerId, p_ok: false, p_detail: 'No usable key to list models with.' });
        summary.skipped.push(providerId);
        continue;
      }

      const outcome = await discoverModels(target.data.endpoint, target.data.secret);
      await recordProbe(admin, providerId, target.data.keyId, outcome);
      summary.probed.push(providerId);

      if (row.need_sync) {
        await admin.schema('ai').rpc('record_model_sync', { p_provider_id: providerId, p_ok: outcome.ok, p_detail: outcome.detail });
        if (outcome.ok && outcome.models.length > 0) {
          const recorded = await admin.schema('ai').rpc('record_discovered_models_system', { p_provider_id: providerId, p_models: outcome.models as unknown as never });
          if (!recorded.error) summary.synced.push(providerId);
        }
      }

      if (BAD.has(outcome.state) && !BAD.has(row.health_state ?? 'unknown')) {
        const orgs = await admin.schema('core').from('organizations').select('id');
        for (const org of orgs.data ?? []) {
          await raiseAlert(admin, {
            organizationId: org.id,
            source: 'ai_provider',
            severity: outcome.state === 'unavailable' ? 'warning' : 'critical',
            summary: `AI provider ${providerId} is ${outcome.state.replace('_', ' ')}: ${outcome.detail.slice(0, 160)}`,
            fingerprint: `ai-provider:${providerId}:${outcome.state}`,
          });
        }
        summary.alerts.push(providerId);
      }
    }
    if (summary.probed.length > 0) resetProviderRegistry();
  } catch (cause) {
    console.error(JSON.stringify({ level: 'error', scope: 'runProviderMaintenance', detail: cause instanceof Error ? cause.message : String(cause) }));
  }
  return summary;
}
