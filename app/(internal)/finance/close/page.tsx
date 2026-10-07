import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listFinanceExceptions, listPeriodCloses, listProjectCloses, listWaivers, previewPeriod } from '@/modules/finance/phase-nine-queries';
import { closeModeLabel, formatMinor, resultLabel, resultTone } from '@/modules/finance/phase-nine-view';
import { Badge, buttonClass, Callout, Card, CardHeader, EmptyState, humanize, inputClass, labelClass, PageHeader, PermissionDenied } from '@/ui';

import { PhaseNineForm } from './phase-nine-forms';
import { PhaseNineBPanels } from './phase-nine-b-panels';

export const metadata: Metadata = { title: 'Financial close' };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The Phase 9 finance control centre: every project's financial-close state, the open exception queue, waivers waiting for an Admin, and the period
 * close (a frozen report). Dashboard rows open the underlying record; nothing here is a vanity number. The figures are the database's.
 */
export default async function FinanceCloseIndexPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const context = await requireInternal('/finance/close');
  if (!can(context, 'invoice.read')) return <PermissionDenied />;
  const q = await searchParams;
  const from = q.from && DATE.test(q.from) ? q.from : '';
  const to = q.to && DATE.test(q.to) ? q.to : '';

  const [projects, exceptions, waivers, periods, preview] = await Promise.all([
    listProjectCloses(),
    listFinanceExceptions({ limit: 200, state: 'open' }),
    listWaivers(),
    listPeriodCloses(),
    from && to && to > from ? previewPeriod(from, to) : Promise.resolve(null),
  ]);
  const open = exceptions.filter((e) => e.state === 'open');
  const pendingWaivers = waivers.filter((w) => w.status === 'requested');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Financial close" description="Project financial close, exceptions, waivers and the period close. Verified money only." actions={<Link href="/finance" className={buttonClass('secondary', 'sm')}>Finance</Link>} />

      <Callout tone="info">
        Closing the finances is not completing the project. Nothing here verifies a payment, edits an invoice or an amount, records a refund or messages a client.
      </Callout>

      <PhaseNineBPanels />

      <Card className="flex flex-col gap-2 p-4">
        <CardHeader title="Projects" description="Open one to see its position, blockers and actions." />
        {projects.length === 0 ? <EmptyState title="No projects" description="There is nothing to close yet." /> : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {projects.map((p) => (
              <li key={p.projectId} className="flex flex-wrap items-center gap-2">
                <Link href={`/finance/close/${p.projectId}`} className="font-medium text-foreground underline">{p.name}</Link>
                {p.code ? <span className="text-muted">{p.code}</span> : null}
                {p.closedMode ? <Badge tone="success">{closeModeLabel(p.closedMode)}</Badge> : <Badge tone={resultTone(p.lastResult)}>{resultLabel(p.lastResult)}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="flex flex-col gap-2 p-4">
        <CardHeader title={`Open exceptions (${open.length})`} description="Blocking ones stop a close and a period from closing without an acknowledgement." />
        {open.length === 0 ? <p className="text-[13px] text-muted">No exception is open.</p> : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {open.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2">
                <Badge tone={e.blocking ? 'danger' : 'warning'}>{humanize(e.kind)}</Badge>
                {e.invoiceNumber ? <span className="text-muted">{e.invoiceNumber}</span> : null}
                <span className="text-foreground">{e.reason}</span>
                {e.projectId ? <Link href={`/finance/close/${e.projectId}`} className="text-muted underline">open</Link> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="flex flex-col gap-2 p-4">
        <CardHeader title={`Waivers waiting (${pendingWaivers.length})`} description="Decided by an Admin who did not request them." />
        {pendingWaivers.length === 0 ? <p className="text-[13px] text-muted">No waiver is waiting.</p> : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {pendingWaivers.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-2">
                <span className="text-foreground">{w.invoiceNumber ?? 'Invoice'}: {formatMinor(w.amountMinor)}</span>
                <span className="text-muted">{w.reason}</span>
                {w.projectId ? <Link href={`/finance/close/${w.projectId}`} className="text-muted underline">decide</Link> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <CardHeader title="Close a period" description="Preview the report, then freeze it. Standing exceptions are listed with their reasons and must be formally acknowledged." />
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1"><span className={labelClass}>From</span><input type="date" name="from" defaultValue={from} className={inputClass} /></label>
          <label className="flex flex-col gap-1"><span className={labelClass}>To (exclusive)</span><input type="date" name="to" defaultValue={to} className={inputClass} /></label>
          <button type="submit" className={buttonClass('secondary', 'sm')}>Preview</button>
        </form>
        {from && to && !preview ? <p className="text-[13px] text-muted">That period is not valid, or your role does not read it.</p> : null}
        {preview ? (
          <div className="flex flex-col gap-3 text-[13px]">
            <p className="text-muted">{preview.basis}</p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 md:grid-cols-4">
              {([['Invoiced', preview.invoicedMinor], ['Verified collected', preview.collectedMinor], ['Refunded', preview.refundedMinor], ['Waived (not cash)', preview.waivedMinor], ['Expenses', preview.expensedMinor],
                ['Unverified (not revenue)', preview.unverifiedMinor], ['Revenue', preview.revenueMinor], ['Net profit', preview.netMinor]] as [string, number][]).map(([label, v]) => (
                <div key={label}><dt className="text-muted">{label}</dt><dd className="font-medium text-foreground">{formatMinor(v)}</dd></div>
              ))}
            </dl>
            {preview.projects.length ? (
              <ul className="flex flex-col gap-1">
                {preview.projects.map((p) => (
                  <li key={p.projectId} className="text-foreground">{p.projectName}: invoiced {formatMinor(p.invoicedMinor)}, collected {formatMinor(p.collectedMinor)}, refunded {formatMinor(p.refundedMinor)}, expenses {formatMinor(p.expensedMinor)}, margin {formatMinor(p.marginMinor)}</li>
                ))}
              </ul>
            ) : null}
            <div>
              <p className="font-medium text-foreground">Exceptions standing ({preview.exceptions.length})</p>
              {preview.exceptions.length === 0 ? <p className="text-muted">None.</p> : (
                <ul className="flex flex-col gap-1">
                  {preview.exceptions.map((e, i) => (<li key={`${e.source}-${i}`}><Badge tone={e.blocking ? 'danger' : 'warning'}>{humanize(e.kind)}</Badge> <span className="text-foreground">{e.reason}</span></li>))}
                </ul>
              )}
            </div>
            <PhaseNineForm door="close_period" tone="primary" hidden={{ periodStart: from, periodEnd: to }} fields={[
              { kind: 'text', name: 'label', label: 'Label, e.g. September 2026', required: true },
              { kind: 'textarea', name: 'acknowledgement', label: preview.exceptions.length ? 'Acknowledgement of the exceptions above (required)' : 'Acknowledgement (not needed: no exception stands)', required: preview.exceptions.length > 0 },
            ]} submit="Freeze this period" intro="Once closed the report is never edited, and expenses dated inside it can no longer change." />
          </div>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-2 p-4">
        <CardHeader title="Closed periods" />
        {periods.length === 0 ? <p className="text-[13px] text-muted">No period has been closed.</p> : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {periods.map((p) => (
              <li key={p.id} className="text-foreground">
                {p.label} ({p.periodStart} to {p.periodEnd}): collected {formatMinor(p.collectedMinor)}, refunded {formatMinor(p.refundedMinor)}, waived {formatMinor(p.waivedMinor)}, expenses {formatMinor(p.expensedMinor)}, net {formatMinor(p.netMinor)}
                {p.exceptionCount ? <span className="text-muted"> - {p.exceptionCount} exception{p.exceptionCount === 1 ? '' : 's'} acknowledged: {p.acknowledgement}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
