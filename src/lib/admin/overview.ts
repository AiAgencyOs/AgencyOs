import 'server-only';

import { agencyClock } from './agency-clock';
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
  paymentsPendingVerification: Avail<number>;
  projectsOnHold: Avail<number>;
  whatsapp: { tokenConfigured: boolean; numberConfigured: Avail<boolean> };
  /** What's on the calendar for today, in the agency's own zone. */
  today: Avail<TodayMeeting[]>;
  /** The prioritised queue SCR-001 calls for: what's overdue, soonest first. */
  needsAttention: Avail<AttentionItem[]>;
};

export type TodayMeeting = { id: string; title: string; at: string | null };

export type AttentionItem = {
  kind: 'approval' | 'failed_delivery';
  id: string;
  title: string;
  detail: string;
  at: string;
  href: string;
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

/**
 * Claimed but not yet confirmed by an Admin — the financial gate itself.
 * Counts the same two statuses the /invoices/verify queue lists ('mismatch'
 * stays in the queue too — Doc 15 §6 calls it "requires resolution", not
 * settled), so the tile and the screen it links to never disagree.
 */
async function paymentsPendingVerification(): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .schema('finance')
    .from('payment_submissions')
    .select('id', { count: 'exact', head: true })
    .in('status', ['pending_verification', 'mismatch']);
  if (error) throw error;
  return count ?? 0;
}

/** `on_hold` is the only status the schema admits for a stalled project — see projects.projects. */
async function projectsOnHold(): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .schema('projects')
    .from('projects')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'on_hold')
    .is('deleted_at', null);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Meetings landing today, agreed time first and requested-only time otherwise
 * — the same rule `listMeetings` (crm module) applies, duplicated here rather
 * than imported: `lib/` may not depend on `modules/*` (ARCHITECTURE.md §3.2).
 */
async function meetingsToday(from: Date, to: Date): Promise<TodayMeeting[]> {
  const supabase = await createClient();
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const { data, error } = await supabase
    .schema('crm')
    .from('meetings')
    .select('id, purpose, confirmed_start_at, requested_start_at, leads(title)')
    .or(
      `and(confirmed_start_at.gte."${fromIso}",confirmed_start_at.lt."${toIso}"),` +
        `and(confirmed_start_at.is.null,requested_start_at.gte."${fromIso}",requested_start_at.lt."${toIso}")`,
    )
    .order('confirmed_start_at', { ascending: true, nullsFirst: false })
    .order('requested_start_at', { ascending: true, nullsFirst: false })
    .limit(10);
  if (error) throw error;
  return (data ?? []).map((m) => ({
    id: m.id as string,
    title: (m.leads as { title: string } | null)?.title ?? (m.purpose as string | null) ?? 'Meeting',
    at: (m.confirmed_start_at ?? m.requested_start_at) as string | null,
  }));
}

/** Pending approvals already past their SLA deadline — the queue's most urgent rows. */
async function overdueApprovalItems(limit = 5): Promise<AttentionItem[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('approvals')
    .from('approval_requests')
    .select('id, subject_type, summary, sla_due_at')
    .eq('state', 'pending')
    .lte('sla_due_at', new Date().toISOString())
    .order('sla_due_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    kind: 'approval' as const,
    id: r.id as string,
    title: (r.summary as string | null) ?? (r.subject_type as string),
    detail: `${r.subject_type as string} · overdue for a decision`,
    at: r.sla_due_at as string,
    href: '/approvals',
  }));
}

/** The most recent delivery failures — the other half of "needs attention". */
async function failedDeliveryItems(limit = 5): Promise<AttentionItem[]> {
  const rows = await listFailedDeliveries(limit);
  return rows.map((m, i) => ({
    kind: 'failed_delivery' as const,
    id: `${m.occurredAt}-${i}`,
    title: 'Message delivery failed',
    detail: m.body.length > 80 ? `${m.body.slice(0, 80)}…` : m.body,
    at: m.occurredAt,
    href: '/operations',
  }));
}

/** The two queues merged and sorted oldest-first — oldest waiting is likeliest to escalate. */
async function needsAttentionItems(): Promise<AttentionItem[]> {
  const [approvalItems, deliveryItems] = await Promise.all([overdueApprovalItems(), failedDeliveryItems()]);
  return [...approvalItems, ...deliveryItems]
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .slice(0, 8);
}

export async function getOverview(): Promise<OverviewData> {
  const config = configStatus();
  const clock = await agencyClock();
  const todayWindow = clock.today();

  const [
    backlog,
    cronAgeSeconds,
    ai,
    reactivation,
    approvals,
    failedDeliveries,
    numberConfigured,
    paymentsPendingVerificationResult,
    projectsOnHoldResult,
    today,
    needsAttention,
  ] = await Promise.all([
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
    avail(paymentsPendingVerification()),
    avail(projectsOnHold()),
    avail(meetingsToday(todayWindow.from, todayWindow.to)),
    avail(needsAttentionItems()),
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
    paymentsPendingVerification: paymentsPendingVerificationResult,
    projectsOnHold: projectsOnHoldResult,
    whatsapp: { tokenConfigured, numberConfigured },
    today,
    needsAttention,
  };
}
