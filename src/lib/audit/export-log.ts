import 'server-only';

import { createClient } from '@/lib/db/server';

/**
 * Owner decision 11 (round 2, 2026-10-01): the audit log is kept forever, the
 * owner and the ops admin may export it, and every export is itself logged.
 *
 * The export route calls this BEFORE it sends a byte and sends nothing when it
 * returns false: a file that left the building without its own audit entry is
 * the one thing this decision forbids. The door (`audit.log_audit_export`)
 * re-checks owner / ops admin in the database and appends `audit.exported`
 * (who, the filters, how many rows).
 */

export type AuditExportFilters = {
  q?: string;
  action?: string;
  subject?: string;
  actor?: string;
  from?: string;
  to?: string;
  /** True when more matched than the 10,000-row ceiling a single export carries. */
  capped?: boolean;
};

/** Only the filters that were set, so the audit entry says what was asked for and nothing else. */
export function auditExportFilters(params: URLSearchParams, capped: boolean): AuditExportFilters {
  const out: AuditExportFilters = {};
  for (const key of ['q', 'action', 'subject', 'actor', 'from', 'to'] as const) {
    const value = params.get(key);
    if (value) out[key] = value.slice(0, 200);
  }
  if (capped) out.capped = true;
  return out;
}

export async function logAuditExport(filters: AuditExportFilters, rowCount: number): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('audit').rpc('log_audit_export', { p_filters: filters, p_row_count: rowCount });
  const outcome = Array.isArray(data) ? data[0]?.outcome : undefined;
  if (error || outcome !== 'logged') {
    console.error(JSON.stringify({ level: 'error', scope: 'logAuditExport', detail: error?.message ?? `outcome ${String(outcome)}` }));
    return false;
  }
  return true;
}
