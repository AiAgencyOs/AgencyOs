import 'server-only';

import { createClient } from '@/lib/db/server';
import { looseSchema } from '@/lib/p13/loose-client';

/**
 * P1-CRM-057: a CRM export is logged BEFORE the file is produced, through `crm.p13_log_crm_export` (who, which filters, how many rows). Unlike the
 * finance download log (best effort), a CRM export holds personal data of leads and contacts, so the route REFUSES to send the file when the log
 * cannot be written: no export exists without its audit event.
 */
export type CrmExportLogResult = { ok: true } | { ok: false; reason: string };

export async function logCrmExport(kind: 'pipeline_csv', filters: Record<string, string>, rowCount: number): Promise<CrmExportLogResult> {
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'crm').rpc('p13_log_crm_export', { p_kind: kind, p_filters: filters, p_row_count: rowCount });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'logCrmExport', kind, detail: error.message }));
    return { ok: false, reason: 'The export could not be recorded, so it was not produced.' };
  }
  if (data !== 'logged') return { ok: false, reason: `The export was refused (${String(data)}).` };
  return { ok: true };
}
