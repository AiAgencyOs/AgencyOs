import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * How many audit entries the caller's organization holds — SCR-069's
 * "audit count" KPI. A `head` request with an exact count, so the number is
 * the table's own rather than the length of a capped page; RLS
 * (`audit_log_select`) scopes it to owner / ops_admin of the row's org.
 * Refuses on failure (G-054): "0 audited changes" is a security claim.
 */
export async function countAuditEntries(): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase.schema('audit').from('audit_log').select('id', { count: 'exact', head: true });
  if (error) unreadable('countAuditEntries', error);
  return count ?? 0;
}
