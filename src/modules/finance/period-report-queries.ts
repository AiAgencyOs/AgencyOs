import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Reads over `finance.period_reports` — the dated snapshots "Generate period
 * report" stores (Q-D2). Refuses on failure (G-054): a history that could not
 * be read must not render as "nothing has been generated".
 */
export type PeriodReportRow = {
  id: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  invoiceCount: number;
  snapshot: unknown;
  generatedByName: string | null;
  generatedAt: string;
};

export async function listPeriodReports(limit = 100): Promise<PeriodReportRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('finance')
    .from('period_reports')
    .select('id, period_start, period_end, period_label, invoice_count, snapshot, generated_by, generated_at')
    .order('generated_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listPeriodReports', error);

  const rows = data ?? [];
  const userIds = [...new Set(rows.map((r) => r.generated_by).filter((id): id is string => id !== null))];
  const nameById = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users, error: usersError } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', userIds);
    if (usersError) unreadable('listPeriodReports.users', usersError);
    for (const u of users ?? []) nameById.set(u.id, u.full_name || u.email);
  }
  return rows.map((r) => ({
    id: r.id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    periodLabel: r.period_label,
    invoiceCount: r.invoice_count,
    snapshot: r.snapshot,
    generatedByName: r.generated_by ? (nameById.get(r.generated_by) ?? null) : null,
    generatedAt: r.generated_at,
  }));
}
