import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readPhaseEightObservability } from '@/modules/projects/phase-eight-observability-queries';
import { readReconciliation, type ReconciliationRow } from '@/modules/projects/phase-eight-gaps2-queries';
import { Badge, BarChart, Card, CardHeader, DataTable, DonutChart, PageHeader, PermissionDenied, humanize, type Column } from '@/ui';

export const metadata: Metadata = { title: 'Customer Success metric reconciliation' };

const columns: Column<ReconciliationRow>[] = [
  { key: 'check', header: 'Check', primary: true, cell: (r) => humanize(r.check) },
  { key: 'observability', header: 'Observability', align: 'right', cell: (r) => r.observability },
  { key: 'overview', header: 'Overview', align: 'right', cell: (r) => r.overview },
  { key: 'result', header: 'Result', cell: (r) => <Badge tone={r.reconciled ? 'success' : 'danger'}>{r.reconciled ? 'Reconciled' : 'Disagree'}</Badge> },
  { key: 'note', header: 'Note', cell: (r) => r.note ?? '' },
];

/**
 * E2E-14: the observability counts and the account overview must agree, and every disagreement is shown, never hidden. The charts draw the same counts
 * the observability page tabulates; the database counted them.
 */
export default async function CustomerSuccessReconciliationPage() {
  const context = await requireInternal('/projects/customer-success/reconciliation');
  if (!can(context, 'project.read')) return <PermissionDenied />;
  const [reconciliation, observability] = await Promise.all([readReconciliation(), readPhaseEightObservability()]);
  const disagree = reconciliation.filter((r) => !r.reconciled).length;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Metric reconciliation"
        description="Each number is counted two ways, from the observability reads and from the overview, and the two are compared."
        actions={<Link href="/projects/customer-success/observability" className="text-[13px] underline">Observability tables</Link>}
      />
      <Card>
        <CardHeader title={disagree === 0 ? 'Everything reconciles' : `${disagree} check${disagree === 1 ? '' : 's'} disagree`} description="A disagreement is a defect in a read, to be found, not a number to pick." />
        <DataTable dense rows={reconciliation} columns={columns} getKey={(r) => r.check} />
      </Card>
      <Card>
        <CardHeader title="Health distribution" description="Live accounts by derived health." />
        <div className="px-4 pb-4 sm:px-5">
          {observability.health_distribution.length > 0 ? <DonutChart data={observability.health_distribution.map((b) => ({ label: humanize(b.bucket), value: b.count }))} totalLabel="Accounts" /> : <p className="text-[13px] text-muted">Nothing to chart.</p>}
        </div>
      </Card>
      <Card>
        <CardHeader title="Support tickets by state" />
        <div className="px-4 pb-4 sm:px-5">
          {observability.tickets_by_state.length > 0 ? <BarChart data={observability.tickets_by_state.map((b) => ({ label: humanize(b.bucket), value: b.count }))} /> : <p className="text-[13px] text-muted">Nothing to chart.</p>}
        </div>
      </Card>
    </div>
  );
}
