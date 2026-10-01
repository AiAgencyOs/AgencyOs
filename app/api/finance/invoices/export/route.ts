import { NextResponse } from 'next/server';

import { csvHeaders, toCsv } from '@/lib/admin/csv';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { logReportExport } from '@/modules/finance/export-log';
import { invoiceKindLabel, isInvoiceKind } from '@/modules/finance/invoice-kind';
import { listInvoicesFiltered } from '@/modules/finance/overview-queries';
import { owedOn, verifiedOn } from '@/modules/finance/verified-basis';

/**
 * The invoice registry, as a file — SCR-050 (the overview's report) and
 * SCR-051 (the registry's export). The same reader and the same filters the
 * pages apply, so the CSV can never say something the screen does not:
 * period (`days` or `from`/`to`), `client`, `project`, plus the registry's
 * own `status`, `kind` and `q`, and `ids` for a bulk selection. Gated on
 * `invoice.read` like the pages; RLS bounds the rows regardless.
 *
 * Amounts are written in major units (minor ÷ 100) because that is what a
 * spreadsheet reader expects to sum. `verified` is what a person confirmed;
 * `recorded` is what was written down; `outstanding` is total less verified —
 * the one basis every finance total uses.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UNPAID = new Set(['issued', 'partially_paid', 'overdue']);

export async function GET(request: Request) {
  const context = await requireInternal('/finance');
  if (!can(context, 'invoice.read')) {
    return NextResponse.json({ error: 'You do not have permission to read invoices.' }, { status: 403 });
  }

  const url = new URL(request.url);
  const daysParam = url.searchParams.get('days');
  const days = daysParam && /^\d+$/.test(daysParam) ? Number(daysParam) : undefined;
  const clientId = url.searchParams.get('client') ?? undefined;
  const projectId = url.searchParams.get('project') ?? undefined;
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  const status = url.searchParams.get('status') ?? undefined;
  const kind = url.searchParams.get('kind') ?? undefined;
  const needle = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const ids = new Set((url.searchParams.get('ids') ?? '').split(',').filter((id) => /^[0-9a-f-]{36}$/i.test(id)));

  const all = await listInvoicesFiltered({ days, clientId, projectId, from, to });
  const invoices = all.filter(
    (i) =>
      (ids.size === 0 || ids.has(i.id)) &&
      (!status || (status === 'unpaid' ? UNPAID.has(i.status) : i.status === status)) &&
      (!kind || (isInvoiceKind(kind) && i.kind === kind)) &&
      (!needle || i.number.toLowerCase().includes(needle)),
  );

  const body = toCsv(
    ['number', 'type', 'status', 'currency', 'total', 'recorded', 'verified', 'outstanding', 'tax', 'issued_at', 'due_at', 'project_id', 'milestone_id', 'client_account_id'],
    invoices.map((i) => [
      i.number,
      invoiceKindLabel(i.kind),
      i.status,
      i.currency,
      (i.total_minor / 100).toFixed(2),
      (i.paid_minor / 100).toFixed(2),
      (verifiedOn(i) / 100).toFixed(2),
      (owedOn(i) / 100).toFixed(2),
      (i.tax_minor / 100).toFixed(2),
      i.issued_at,
      i.due_at,
      i.project_id,
      i.milestone_id,
      i.client_account_id,
    ]),
  );

  const label = ids.size > 0 ? `${ids.size} selected` : from || to ? `${from ?? 'start'} to ${to ?? 'today'}` : days ? `last ${days} days` : 'All time';
  await logReportExport('invoices_csv', label, invoices.length);

  return new NextResponse(body, { status: 200, headers: csvHeaders('invoices.csv') });
}
