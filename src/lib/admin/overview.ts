import 'server-only';

import { wouldRun } from './agent-eval';
import { aiStatus } from './agent-status';
import { configStatus } from './config-status';
import { reactivationSummary, type ReactivationSummary } from './reactivation-summary';
import { createClient } from '@/lib/db/server';
import type { BacklogRow } from '@/lib/observability/backlog';
import { listFailedDeliveries, readBacklog, readCronAgeSeconds } from '@/lib/observability/queries';

import type { Avail } from './overview-eval';

/**
 * The Overview command center's data, composed from the real reads the rest of
 * the Admin already uses — nothing invented, nothing hard-coded.
 *
 * Each database-backed signal is wrapped so a FAILED read becomes
 * `{ ok: false }` (rendered DATA UNAVAILABLE), never a zero. That is the whole
 * discipline of this page: a monitor that shows 0 because it could not read is
 * worse than one that admits it does not know. `configStatus()` is env-based and
 * always available; `readCronAgeSeconds()` already returns null (unknown) on
 * failure and keeps that meaning.
 */

export type OverviewData = {
  environment: { nodeEnv: string; looksLocal: boolean; productionProblems: number };
  cronAgeSeconds: number | null;
  backlog: Avail<BacklogRow>;
  ai: Avail<{ providerConfigured: boolean; agentsEnabled: number; agentsRunnable: number; agentsTotal: number }>;
  reactivation: Avail<ReactivationSummary>;
  approvals: Avail<{ pending: number; overdue: number }>;
  failedDeliveries: Avail<number>;
  whatsapp: { tokenConfigured: boolean; numberConfigured: Avail<boolean> };
};

/** Resolve a promise into Avail, turning any read failure into DATA UNAVAILABLE. */
async function avail<T>(p: Promise<T>): Promise<Avail<T>> {
  try {
    return { ok: true, value: await p };
  } catch {
    return { ok: false };
  }
}

async function whatsappNumberConfigured(): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').from('organizations').select('settings').limit(1);
  if (error) throw error; // -> Avail false, not a false "no"
  const settings = (data?.[0]?.settings ?? {}) as Record<string, unknown>;
  return typeof settings.whatsapp_phone_number_id === 'string' && settings.whatsapp_phone_number_id.trim().length > 0;
}

/**
 * Pending approvals, read directly under RLS (lib does not cross into modules —
 * ARCHITECTURE.md §3.2). A pending request is overdue once its SLA deadline has
 * passed, the same rule the approvals page applies.
 */
async function pendingApprovals(): Promise<{ pending: number; overdue: number }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('approvals')
    .from('approval_requests')
    .select('sla_due_at')
    .eq('state', 'pending');
  if (error) throw error;
  const now = Date.now();
  const rows = data ?? [];
  return { pending: rows.length, overdue: rows.filter((r) => new Date(r.sla_due_at as string).getTime() <= now).length };
}

export async function getOverview(): Promise<OverviewData> {
  const config = configStatus();

  const [backlog, cronAgeSeconds, ai, reactivation, approvals, failedDeliveries, numberConfigured] = await Promise.all([
    avail(readBacklog()),
    readCronAgeSeconds(), // already null-on-failure by design
    avail(
      aiStatus().then((s) => ({
        providerConfigured: s.providerConfigured,
        agentsEnabled: s.agents.filter((a) => a.enabled).length,
        agentsRunnable: s.agents.filter((a) => wouldRun(a, s.providerConfigured)).length,
        agentsTotal: s.agents.length,
      })),
    ),
    avail(reactivationSummary()),
    avail(pendingApprovals()),
    avail(listFailedDeliveries().then((rows) => rows.length)),
    avail(whatsappNumberConfigured()),
  ]);

  const tokenConfigured = config.items.find((i) => i.key === 'WHATSAPP_ACCESS_TOKEN')?.present ?? false;

  return {
    environment: { nodeEnv: config.nodeEnv, looksLocal: config.looksLocal, productionProblems: config.productionProblems.length },
    cronAgeSeconds,
    backlog,
    ai,
    reactivation,
    approvals,
    failedDeliveries,
    whatsapp: { tokenConfigured, numberConfigured },
  };
}
