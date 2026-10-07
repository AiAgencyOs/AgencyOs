import { NextResponse } from 'next/server';

import { recordAudit } from '@/lib/audit';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { gstIdentityIssues, gstr1, gstr3b, returnPeriodFor } from '@/modules/finance/gstr';
import { listGstrInvoices, readGstIdentity } from '@/modules/finance/gstr-queries';
import { resolveTaxPeriod } from '@/modules/finance/tax-report';
import { filingCheck, gstSetupFrom } from '@/modules/finance/gst-settings';
import { readOrganizationSettingsRow } from '@/modules/finance/numbering';
import { routeError } from '@/lib/route-errors';

/**
 * The one path both GSTR downloads take — bucket E5. Same reader and the
 * same period arithmetic as the GST & tax page (`resolveTaxPeriod`), so the
 * file matches what the person was looking at; `invoice.read` is the page's
 * own gate. Refuses with words when the identity is incomplete or the
 * period is not a month or quarter, and audits `gst.exported` with the
 * period and the counts, including how many invoices the file OMITTED.
 */
export async function exportGstr(kind: 'gstr1' | 'gstr3b', request: Request): Promise<Response> {
  const context = await requireInternal('/finance/tax');
  if (!can(context, 'invoice.read')) {
    return routeError('FORBIDDEN', 'You do not have permission to read invoices.');
  }
  if (!context.organizationId) {
    return routeError('FORBIDDEN', 'No organization in your session.');
  }

  const url = new URL(request.url);
  const period = resolveTaxPeriod(url.searchParams.get('period') ?? undefined, new Date());
  const fp = returnPeriodFor(period);
  if (!fp) {
    return routeError('VALIDATION', `A ${kind === 'gstr1' ? 'GSTR-1' : 'GSTR-3B'} is for one month or one quarter. "${period.label}" is neither — pick a month or a quarter on the GST & tax page.`, { status: 400 });
  }

  // Owner decision 9 (2026-10-01): the agency's saved GST setup (unset = regular, monthly, calendar month) decides which windows are returns it files.
  const setup = gstSetupFrom(await readOrganizationSettingsRow(await createClient()));
  const filing = filingCheck(setup, period, kind === 'gstr1' ? 'GSTR-1' : 'GSTR-3B');
  if (!filing.ok) return routeError('CONFLICT', filing.message);

  const [identity, rows] = await Promise.all([readGstIdentity(), listGstrInvoices()]);
  const issues = gstIdentityIssues(identity);
  if (issues.length > 0) {
    return routeError('CONFLICT', `The agency's GST identity is incomplete: ${issues.map((i) => i.reason).join(' ')} Set it under Settings › Finance.`);
  }

  const result = kind === 'gstr1' ? gstr1(rows, identity, period) : gstr3b(rows, identity, period);

  await recordAudit({
    organizationId: context.organizationId,
    action: 'gst.exported',
    subjectType: 'organization',
    subjectId: context.organizationId,
    after: { kind, period: period.label, return_period: fp, counts: result.counts, omitted: result.unresolved.map((u) => u.number) },
  });

  // SCR-056: the export history the GST & tax page lists (finance.gst_exports,
  // bucket F). A row the database refuses is logged and does not stop the
  // download: the audit row above already records the export.
  const supabase = await createClient();
  const { error: historyError } = await supabase.schema('finance').from('gst_exports').insert({
    organization_id: context.organizationId,
    kind,
    period_label: period.label,
    return_period: fp,
    counts: result.counts,
    omitted: result.unresolved.map((u) => u.number),
    exported_by: context.userId,
  });
  if (historyError) {
    console.error(JSON.stringify({ level: 'error', scope: 'exportGstr.history', detail: historyError.message }));
  }

  return new NextResponse(JSON.stringify(result.json, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${kind}-${fp}.json"`,
      'cache-control': 'no-store',
    },
  });
}
