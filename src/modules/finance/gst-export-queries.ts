import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * GST export history — SCR-056. Every GSTR-1 / GSTR-3B file the routes
 * produced (`finance.gst_exports`, written by app/api/finance/gst/gstr-export.ts
 * beside the gst.exported audit row), newest first, with who pulled it and
 * how many invoices the file omitted. The same roles that read invoices.
 */
export type GstExportRow = {
  id: string;
  kind: 'gstr1' | 'gstr3b';
  periodLabel: string;
  returnPeriod: string;
  counts: Record<string, number>;
  omitted: string[];
  exportedByName: string | null;
  createdAt: string;
};

export async function listGstExports(limit = 50): Promise<GstExportRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('finance')
    .from('gst_exports')
    .select('id, kind, period_label, return_period, counts, omitted, exported_by, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listGstExports', error);

  const rows = data ?? [];
  const userIds = [...new Set(rows.map((r) => r.exported_by).filter((id): id is string => id !== null))];
  const nameById = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users, error: usersError } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', userIds);
    if (usersError) unreadable('listGstExports.users', usersError);
    for (const u of users ?? []) nameById.set(u.id, u.full_name || u.email);
  }

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind === 'gstr3b' ? 'gstr3b' : 'gstr1',
    periodLabel: r.period_label,
    returnPeriod: r.return_period,
    counts: (r.counts ?? {}) as Record<string, number>,
    omitted: Array.isArray(r.omitted) ? (r.omitted as string[]) : [],
    exportedByName: r.exported_by ? (nameById.get(r.exported_by) ?? null) : null,
    createdAt: r.created_at,
  }));
}
