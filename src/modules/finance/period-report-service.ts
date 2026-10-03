import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { generatePeriodReportSchema, type GeneratePeriodReportInput } from './period-report-schema';

/**
 * "Generate period report" — SCR-056, owner decision Q-D2.
 *
 * `invoice.read` (owner, ops_admin, finance — the roles that read the export
 * history this lands in); the database door `finance.generate_period_report`
 * asks `core.is_admin() or core.is_finance()` again, computes the figures
 * itself from the invoices and expenses of the caller's own tenant, and audits
 * `finance.period_report_generated` in the same transaction.
 */
export async function generatePeriodReport(input: GeneratePeriodReportInput): Promise<Result<{ reportId: string; invoiceCount: number }>> {
  const parsed = generatePeriodReportSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid period.');

  const context = await requireInternal();
  if (!can(context, 'invoice.read')) return err('FORBIDDEN', 'You do not have permission to generate a period report.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc('generate_period_report', {
    p_period_start: parsed.data.periodStart,
    p_period_end: parsed.data.periodEnd,
    ...(parsed.data.label ? { p_label: parsed.data.label } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'generatePeriodReport', detail: error.message }));
    return err('INTERNAL', 'Could not generate the report.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; id?: string | null; invoice_count?: number } | undefined;
  switch (row?.outcome) {
    case 'generated':
      return row.id ? ok({ reportId: row.id, invoiceCount: row.invoice_count ?? 0 }) : err('INTERNAL', 'Could not generate the report.');
    case 'not_a_period':
      return err('VALIDATION', 'The period must end after it starts.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or finance may generate a period report.');
    case 'no_actor':
      return err('UNAUTHORIZED', 'No signed-in person to record this against.');
    default:
      console.error(JSON.stringify({ level: 'error', scope: 'generatePeriodReport', detail: `unrecognised outcome "${row?.outcome ?? 'none'}"` }));
      return err('INTERNAL', 'Could not generate the report.');
  }
}
