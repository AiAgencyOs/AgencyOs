import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';
import { isInQa, pipelineCounts } from './qa-stage';
import { readQaStageFacts } from './qa-stage-queries';

/**
 * Reads for the Dashboard's "Recent leads", "Active projects", "Revenue this
 * month" and "Messages sent" tiles — none of these existed as a listable
 * shape before (confirmed: `listLeads`/`listProjects` are missing phone,
 * assignee, client name and due date; there is no revenue-by-month or
 * outbound-message-count reader anywhere). Kept beside `overview.ts` rather
 * than folded into it because these are lists, not the single-value/Avail
 * reads that file's contract is built around.
 */

export type RecentLead = {
  id: string;
  title: string;
  contactPhone: string | null;
  source: string;
  status: string;
  assignedEmail: string | null;
  lastActivityAt: string;
};

export async function getRecentLeads(limit = 5): Promise<RecentLead[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, title, status, source, assigned_to, updated_at, contact_id')
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) unreadable('getRecentLeads', error);

  const rows = data ?? [];
  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((id): id is string => id !== null))];
  const userIds = [...new Set(rows.map((r) => r.assigned_to).filter((id): id is string => id !== null))];

  const [{ data: contacts }, { data: users }] = await Promise.all([
    contactIds.length > 0
      ? supabase.schema('crm').from('contacts').select('id, phone').in('id', contactIds)
      : Promise.resolve({ data: [] as { id: string; phone: string | null }[] }),
    userIds.length > 0
      ? supabase.schema('core').from('users').select('id, email').in('id', userIds)
      : Promise.resolve({ data: [] as { id: string; email: string }[] }),
  ]);

  const phoneById = new Map((contacts ?? []).map((c) => [c.id, c.phone]));
  const emailById = new Map((users ?? []).map((u) => [u.id, u.email]));

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    contactPhone: r.contact_id ? (phoneById.get(r.contact_id) ?? null) : null,
    source: r.source,
    status: r.status,
    assignedEmail: r.assigned_to ? (emailById.get(r.assigned_to) ?? null) : null,
    lastActivityAt: r.updated_at,
  }));
}

/** All leads ever created for this organization, deleted ones excluded. */
export async function getTotalLeadsCount(): Promise<number> {
  const supabase = await createClient();

  const { count, error } = await supabase
    .schema('crm')
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .is('deleted_at', null);

  if (error) unreadable('getTotalLeadsCount', error);

  return count ?? 0;
}

/** Not yet finished and not abandoned — planning through on_hold. */
const ACTIVE_PROJECT_STATUSES = ['planning', 'onboarding', 'active', 'on_hold'];

export type ActiveProjectSummary = {
  id: string;
  name: string;
  clientName: string | null;
  status: string;
  milestonesMet: number;
  milestonesTotal: number;
  endsOn: string | null;
  /** Derived (decision 9): an open test run and no release. */
  inQa: boolean;
};

/**
 * Milestone completion is read per project (`completion_summary`, the same
 * RPC the project detail page uses) rather than invented as a stored
 * percentage — `projects.projects` has no progress column anywhere in the
 * schema. Bounded to `limit` projects, so this is at most a handful of extra
 * round trips for a dashboard tile, not an N+1 over the whole table.
 */
export async function getActiveProjectsSummary(limit = 5): Promise<ActiveProjectSummary[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name, client_account_id, status, ends_on')
    .is('deleted_at', null)
    .in('status', ACTIVE_PROJECT_STATUSES)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) unreadable('getActiveProjectsSummary', error);

  const rows = data ?? [];
  const clientIds = [...new Set(rows.map((r) => r.client_account_id).filter((id): id is string => id !== null))];

  const [{ data: clients }, summaries, qa] = await Promise.all([
    clientIds.length > 0
      ? supabase.schema('core').from('client_accounts').select('id, name').in('id', clientIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    Promise.all(
      rows.map((r) =>
        supabase.schema('projects').rpc('completion_summary', { p_project_id: r.id }).single(),
      ),
    ),
    readQaStageFacts(),
  ]);

  const nameById = new Map((clients ?? []).map((c) => [c.id, c.name]));

  return rows.map((r, i) => {
    const summary = summaries[i]?.data as { milestones_total?: number; milestones_met?: number } | null;
    return {
      id: r.id,
      name: r.name,
      clientName: r.client_account_id ? (nameById.get(r.client_account_id) ?? null) : null,
      status: r.status,
      milestonesMet: summary?.milestones_met ?? 0,
      milestonesTotal: summary?.milestones_total ?? 0,
      endsOn: r.ends_on,
      inQa: isInQa({ status: r.status, openTestRuns: qa.get(r.id)?.openTestRuns ?? 0, hasRelease: qa.get(r.id)?.hasRelease ?? false }),
    };
  });
}

function startOfCurrentMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export type RevenueByCurrency = { currency: string; paidMinor: number };

/**
 * Money received since the start of the current calendar month (UTC), by currency, on the ONE verified basis
 * (src/modules/finance/verified-basis.ts): payments a person verified, dated by the day they verified them —
 * not `paid_minor`, which counts what somebody recorded, and not the date an invoice flipped to paid.
 */
export async function getRevenueThisMonth(): Promise<RevenueByCurrency[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('finance')
    .from('payments')
    .select('amount_minor, currency')
    .eq('status', 'captured')
    .not('verified_at', 'is', null)
    .gte('verified_at', startOfCurrentMonthIso());

  if (error) unreadable('getRevenueThisMonth', error);

  const byCurrency = new Map<string, number>();
  for (const row of data ?? []) {
    byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + row.amount_minor);
  }

  return [...byCurrency.entries()].map(([currency, paidMinor]) => ({ currency, paidMinor }));
}

/** Outbound WhatsApp messages sent since the start of the current calendar month (UTC). */
export async function getMessagesSentThisMonth(): Promise<number> {
  const supabase = await createClient();

  const { count, error } = await supabase
    .schema('crm')
    .from('conversation_messages')
    .select('id', { count: 'exact', head: true })
    .eq('metadata->>direction', 'outbound')
    .gte('occurred_at', startOfCurrentMonthIso());

  if (error) unreadable('getMessagesSentThisMonth', error);

  return count ?? 0;
}

export type ProjectCountsByStatus = Record<string, number>;

/**
 * How many projects sit in each delivery stage — the right-hand half of the
 * Command Center's pipeline strip. Stored statuses, except that a project
 * with an open test run and no release is counted under `inQa` instead of
 * its status (decision 9; the rule is `pipelineCounts`).
 */
export async function getProjectCountsByStatus(): Promise<ProjectCountsByStatus> {
  const supabase = await createClient();

  const [{ data, error }, qa] = await Promise.all([
    supabase.schema('projects').from('projects').select('id, status, archived_at'),
    readQaStageFacts(),
  ]);

  if (error) unreadable('getProjectCountsByStatus', error);

  return pipelineCounts(
    (data ?? []).map((row) => ({
      status: row.status,
      archivedAt: row.archived_at,
      openTestRuns: qa.get(row.id)?.openTestRuns ?? 0,
      hasRelease: qa.get(row.id)?.hasRelease ?? false,
    })),
  );
}
