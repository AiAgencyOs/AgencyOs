import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

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

  const [{ data: clients }, summaries] = await Promise.all([
    clientIds.length > 0
      ? supabase.schema('core').from('client_accounts').select('id, name').in('id', clientIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    Promise.all(
      rows.map((r) =>
        supabase.schema('projects').rpc('completion_summary', { p_project_id: r.id }).single(),
      ),
    ),
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
    };
  });
}

function startOfCurrentMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export type RevenueByCurrency = { currency: string; paidMinor: number };

/** Sum of `paid_minor` for invoices paid since the start of the current calendar month (UTC), by currency. */
export async function getRevenueThisMonth(): Promise<RevenueByCurrency[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('finance')
    .from('invoices')
    .select('paid_minor, currency')
    .eq('status', 'paid')
    .gte('paid_at', startOfCurrentMonthIso());

  if (error) unreadable('getRevenueThisMonth', error);

  const byCurrency = new Map<string, number>();
  for (const row of data ?? []) {
    byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + row.paid_minor);
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
 * How many projects sit in each delivery status — the right-hand half of
 * the Command Center's pipeline strip. One `status` column over every
 * project the caller may read, counted here; the strip prints exactly these.
 */
export async function getProjectCountsByStatus(): Promise<ProjectCountsByStatus> {
  const supabase = await createClient();

  const { data, error } = await supabase.schema('projects').from('projects').select('status');

  if (error) unreadable('getProjectCountsByStatus', error);

  const counts: ProjectCountsByStatus = {};
  for (const row of data ?? []) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return counts;
}
