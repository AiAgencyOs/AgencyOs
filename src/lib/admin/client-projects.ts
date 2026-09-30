import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Projects by status, per client — SCR-014's completed/pending counts and
 * SCR-016's per-status breakdown. A count of rows in `projects.projects`
 * grouped by the status column; `completed` is the status word itself,
 * `pending` is every live project that is not yet completed.
 */
export type ClientProjectStatusCounts = { byStatus: Record<string, number>; completed: number; pending: number; total: number };

export async function listClientProjectStatusCounts(clientAccountIds: readonly string[]): Promise<Map<string, ClientProjectStatusCounts>> {
  const out = new Map<string, ClientProjectStatusCounts>();
  if (clientAccountIds.length === 0) return out;
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('projects')
    .select('client_account_id, status')
    .in('client_account_id', [...clientAccountIds])
    .is('deleted_at', null);
  if (error) unreadable('listClientProjectStatusCounts', error);
  for (const row of data ?? []) {
    const entry = out.get(row.client_account_id) ?? { byStatus: {}, completed: 0, pending: 0, total: 0 };
    entry.byStatus[row.status] = (entry.byStatus[row.status] ?? 0) + 1;
    entry.total += 1;
    if (row.status === 'completed') entry.completed += 1;
    else if (row.status !== 'cancelled' && row.status !== 'archived') entry.pending += 1;
    out.set(row.client_account_id, entry);
  }
  return out;
}
