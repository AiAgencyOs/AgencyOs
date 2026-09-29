import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-018 — the projects list with its client and owner, filterable by
 * either. `listProjects` in queries.ts stays as it is for the callers that
 * want the bare rows; this reads two more columns the table has always
 * carried (`client_account_id`, `delivery_lead_id`) and resolves the names
 * so the list can show "for whom" and "who owns it" without a lookup.
 *
 * Filters are applied in the query, not after it, so the limit bounds the
 * filtered result rather than the unfiltered one.
 */

export type FilteredProject = {
  id: string;
  name: string;
  code: string | null;
  status: string;
  currency: string;
  budgetMinor: number | null;
  createdAt: string;
  clientAccountId: string;
  clientName: string;
  deliveryLeadId: string | null;
  deliveryLeadName: string | null;
};

export type ProjectFilterOption = { id: string; name: string };

export type ProjectFilters = { clientId?: string; ownerId?: string };

export async function listProjectsFiltered(
  filters: ProjectFilters,
  limit = 200,
): Promise<{ projects: FilteredProject[]; clients: ProjectFilterOption[]; owners: ProjectFilterOption[] }> {
  const supabase = await createClient();

  let query = supabase
    .schema('projects')
    .from('projects')
    .select('id, name, code, status, currency, budget_minor, created_at, client_account_id, delivery_lead_id')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (filters.clientId) query = query.eq('client_account_id', filters.clientId);
  if (filters.ownerId) query = query.eq('delivery_lead_id', filters.ownerId);

  const [{ data: rows, error }, { data: accounts, error: accountsError }, { data: members, error: membersError }] =
    await Promise.all([
      query,
      supabase.schema('core').from('client_accounts').select('id, name').order('name', { ascending: true }),
      supabase.schema('core').from('memberships').select('user_id, role, users:user_id(full_name, email)'),
    ]);
  if (error) unreadable('listProjectsFiltered.projects', error);
  if (accountsError) unreadable('listProjectsFiltered.accounts', accountsError);
  if (membersError) unreadable('listProjectsFiltered.memberships', membersError);

  const clientNameById = new Map((accounts ?? []).map((a) => [a.id, a.name]));

  const ownerNameById = new Map<string, string>();
  for (const m of (members ?? []) as Record<string, unknown>[]) {
    const userId = m.user_id as string;
    if (ownerNameById.has(userId)) continue;
    const user = (m.users ?? {}) as { full_name?: string | null; email?: string | null };
    ownerNameById.set(userId, user.full_name ?? user.email ?? 'someone without a name on file');
  }

  const projects: FilteredProject[] = (rows ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    code: p.code,
    status: p.status,
    currency: p.currency,
    budgetMinor: p.budget_minor,
    createdAt: p.created_at,
    clientAccountId: p.client_account_id,
    clientName: clientNameById.get(p.client_account_id) ?? 'Unknown client',
    deliveryLeadId: p.delivery_lead_id,
    deliveryLeadName: p.delivery_lead_id ? (ownerNameById.get(p.delivery_lead_id) ?? 'Unknown member') : null,
  }));

  // Owner options: only people who actually own a project, so the select is
  // not the whole roster for a filter that would match nothing.
  const ownerIds = new Set<string>();
  for (const p of rows ?? []) if (p.delivery_lead_id) ownerIds.add(p.delivery_lead_id);
  if (filters.ownerId) ownerIds.add(filters.ownerId);
  const owners = [...ownerIds]
    .map((id) => ({ id, name: ownerNameById.get(id) ?? 'Unknown member' }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    projects,
    clients: (accounts ?? []).map((a) => ({ id: a.id, name: a.name })),
    owners,
  };
}
