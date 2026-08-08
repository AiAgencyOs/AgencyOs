import 'server-only';

import { createClient } from '@/lib/db/server';

import type { LeadListItem } from './types';

/**
 * Reads for the crm module. Pure, RLS-scoped, safe in Server Components
 * (ARCHITECTURE.md §3.2).
 *
 * These use the per-request client, which carries the user's JWT, so the
 * database applies the same tenant isolation to our own server code that it
 * applies to anyone else. There is deliberately no organization_id filter
 * below: adding one would imply the isolation lives here, and the day someone
 * forgets it the query would still be safe only by accident. RLS is the
 * boundary; this file is just a projection.
 */

const LIST_SELECT = 'id, title, status, score, source, created_at, contacts(full_name, company)';

export async function listLeads(limit = 100): Promise<LeadListItem[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('leads')
    .select(LIST_SELECT)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'listLeads', detail: error.message }));
    return [];
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    score: row.score,
    source: row.source,
    created_at: row.created_at,
    contact: row.contacts
      ? { fullName: row.contacts.full_name, company: row.contacts.company }
      : null,
  }));
}
