import 'server-only';

import { createClient } from '@/lib/db/server';

import type { InvoiceListItem } from './types';

/**
 * Reads for the finance module. Pure, RLS-scoped, safe in Server Components
 * (ARCHITECTURE.md §3.2). See the note in crm/queries.ts on why there is no
 * organization_id predicate here.
 *
 * The client account name is deliberately not embedded: client_accounts lives
 * in `core`, and PostgREST will not resolve a foreign key across schemas
 * (PGRST200). Joining it needs either a finance-side view or a second query,
 * and the list does not currently need the name enough to justify either.
 */

const LIST_SELECT =
  'id, number, status, currency, total_minor, paid_minor, due_at, issued_at';

export async function listInvoices(limit = 100): Promise<InvoiceListItem[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('finance')
    .from('invoices')
    .select(LIST_SELECT)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'listInvoices', detail: error.message }));
    return [];
  }

  return data ?? [];
}
