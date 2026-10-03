import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-018 — the two facets the projects list filters on: which client a
 * project is for (`client_account_id`) and who owns it
 * (`delivery_lead_id`). `listProjectsForTable` prints the client's name
 * but not its id, and nothing about the owner; this reads both ids per
 * project plus the option lists, and the page narrows the table rows it
 * already has by id. One bounded read of each of three tables.
 */
export type ProjectFilterOption = { id: string; name: string };

export type ProjectFilterFacets = {
  /** Per project id: the client and delivery lead it belongs to. */
  byProject: Map<string, { clientAccountId: string | null; deliveryLeadId: string | null }>;
  clients: ProjectFilterOption[];
  /** Only people who actually own a project — a select of the whole roster would mostly match nothing. */
  owners: ProjectFilterOption[];
};

export async function readProjectFilterFacets(limit = 500): Promise<ProjectFilterFacets> {
  const supabase = await createClient();

  const [{ data: rows, error }, { data: accounts, error: accountsError }, { data: members, error: membersError }] =
    await Promise.all([
      supabase
        .schema('projects')
        .from('projects')
        .select('id, client_account_id, delivery_lead_id')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(limit),
      supabase.schema('core').from('client_accounts').select('id, name').order('name', { ascending: true }),
      supabase.schema('core').from('memberships').select('user_id, users:user_id(full_name, email)'),
    ]);
  if (error) unreadable('readProjectFilterFacets.projects', error);
  if (accountsError) unreadable('readProjectFilterFacets.accounts', accountsError);
  if (membersError) unreadable('readProjectFilterFacets.memberships', membersError);

  const ownerNameById = new Map<string, string>();
  for (const m of (members ?? []) as Record<string, unknown>[]) {
    const userId = m.user_id as string;
    if (ownerNameById.has(userId)) continue;
    const user = (m.users ?? {}) as { full_name?: string | null; email?: string | null };
    ownerNameById.set(userId, user.full_name ?? user.email ?? 'someone without a name on file');
  }

  const byProject = new Map<string, { clientAccountId: string | null; deliveryLeadId: string | null }>();
  const ownerIds = new Set<string>();
  const clientIds = new Set<string>();
  for (const p of rows ?? []) {
    byProject.set(p.id, { clientAccountId: p.client_account_id, deliveryLeadId: p.delivery_lead_id });
    if (p.delivery_lead_id) ownerIds.add(p.delivery_lead_id);
    if (p.client_account_id) clientIds.add(p.client_account_id);
  }

  return {
    byProject,
    clients: (accounts ?? []).filter((a) => clientIds.has(a.id)).map((a) => ({ id: a.id, name: a.name })),
    owners: [...ownerIds]
      .map((id) => ({ id, name: ownerNameById.get(id) ?? 'Unknown member' }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
