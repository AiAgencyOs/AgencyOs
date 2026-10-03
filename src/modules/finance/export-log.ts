import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The export history — PDF SCR-056: "Export history" and "Export CSV/PDF".
 * The GSTR files were logged in `finance.gst_exports`; the CSV and PDF
 * downloads logged nothing. Every finance download now writes one row here,
 * through `finance.log_report_export` (who, when, which period, how many
 * rows), and the tax screen lists both tables together.
 *
 * Logging is best effort for the DOWNLOAD (a failure to log must not withhold
 * a file somebody is entitled to) but is never silent: it writes a structured
 * error line, and the door itself audits every row it accepts.
 */

export type LoggedExportKind = 'tax_register_csv' | 'tax_report_pdf' | 'invoices_csv' | 'payments_csv' | 'expenses_csv';

export const EXPORT_KIND_LABEL: Record<string, string> = {
  tax_register_csv: 'Tax register (CSV)',
  tax_report_pdf: 'Tax report (PDF)',
  invoices_csv: 'Invoices (CSV)',
  payments_csv: 'Payments (CSV)',
  expenses_csv: 'Expenses (CSV)',
  gstr1: 'GSTR-1',
  gstr3b: 'GSTR-3B',
};

export async function logReportExport(kind: LoggedExportKind, periodLabel: string, rowCount: number): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('finance')
    .rpc('log_report_export', { p_kind: kind, p_period_label: periodLabel, p_row_count: rowCount });
  const outcome = Array.isArray(data) ? data[0]?.outcome : undefined;
  if (error || outcome !== 'logged') {
    console.error(JSON.stringify({ level: 'error', scope: 'logReportExport', kind, detail: error?.message ?? `outcome ${String(outcome)}` }));
  }
}

export type ReportExportRow = {
  id: string;
  kind: string;
  periodLabel: string;
  rowCount: number;
  exportedByName: string | null;
  createdAt: string;
};

export async function listReportExports(limit = 50): Promise<ReportExportRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('finance')
    .from('report_exports')
    .select('id, kind, period_label, row_count, exported_by, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listReportExports', error);

  const rows = data ?? [];
  const userIds = [...new Set(rows.map((r) => r.exported_by).filter((id): id is string => id !== null))];
  const nameById = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users, error: usersError } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', userIds);
    if (usersError) unreadable('listReportExports.users', usersError);
    for (const u of users ?? []) nameById.set(u.id, u.full_name || u.email);
  }
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    periodLabel: r.period_label,
    rowCount: r.row_count,
    exportedByName: r.exported_by ? (nameById.get(r.exported_by) ?? null) : null,
    createdAt: r.created_at,
  }));
}
