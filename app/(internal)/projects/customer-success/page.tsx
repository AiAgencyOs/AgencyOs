import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readCustomerSuccessOverview, type OverviewRow } from '@/modules/projects/phase-eight-queries';
import { Badge, DataTable, EmptyState, IconProjects, PageHeader, PermissionDenied, humanize, type Column, type Tone } from '@/ui';

export const metadata: Metadata = { title: 'Customer Success' };

const HEALTH_TONE: Record<string, Tone> = { healthy: 'success', stable: 'info', watch: 'warning', at_risk: 'danger', critical: 'danger' };

const columns: Column<OverviewRow>[] = [
  { key: 'project', header: 'Project', primary: true, cell: (r) => r.projectName },
  { key: 'client', header: 'Client', cell: (r) => r.clientName },
  { key: 'health', header: 'Health (derived)', badge: true, cell: (r) => (r.healthStatus ? <Badge tone={HEALTH_TONE[r.healthStatus] ?? 'neutral'}>{humanize(r.healthStatus)}</Badge> : '—') },
  { key: 'tickets', header: 'Open tickets', align: 'right', cell: (r) => r.openTickets },
  { key: 'breaches', header: 'Past an SLA target', align: 'right', cell: (r) => r.slaBreached },
  { key: 'recovery', header: 'Recovery plans', align: 'right', cell: (r) => r.openRecoveryPlans },
  { key: 'checkins', header: 'Check-ins due', align: 'right', cell: (r) => r.dueCheckIns },
  { key: 'renewals', header: 'Renewals in flight', align: 'right', cell: (r) => r.renewalsInFlight },
  { key: 'opportunities', header: 'Opportunities', align: 'right', cell: (r) => r.openOpportunities },
  { key: 'state', header: 'Workspace', cell: (r) => humanize(r.workspaceState) },
];

/**
 * Customer Success across every live Phase 8 project, worst health first. Health is DERIVED on every read by the database from tickets, SLA stamps,
 * invoices, defects and plans; nothing here stores or computes it. Read-only: each row opens the project, where the doors are.
 */
export default async function CustomerSuccessPage() {
  const context = await requireInternal('/projects/customer-success');
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const rows = await readCustomerSuccessOverview();
  const needing = rows.filter((r) => r.healthStatus === 'at_risk' || r.healthStatus === 'critical').length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Customer Success"
        actions={
          <span className="flex flex-wrap gap-3 text-[13px]">
            <Link href="/projects/customer-success/observability" className="underline">Counts and ages</Link>
            <Link href="/projects/customer-success/next-actions" className="underline">Next actions</Link>
            <Link href="/projects/customer-success/reconciliation" className="underline">Reconciliation</Link>
            <Link href="/projects/customer-success/records" className="underline">Records</Link>
            <Link href="/projects/customer-success/next-actions/queue" className="underline">Action queue</Link>
            <Link href="/projects/customer-success/governance" className="underline">Governance</Link>
            <Link href="/projects/customer-success/knowledge" className="underline">Knowledge</Link>
            <Link href="/projects/customer-success/p789-governance" className="underline">Retention and alerts</Link>
            <Link href="/projects/customer-success/p789-charts" className="underline">Charts</Link>
            <Link href="/projects/p789-operations" className="underline">Phase 7 operations</Link>
          </span>
        }
        description={
          rows.length === 0
            ? 'No project has started Phase 8 yet.'
            : `${rows.length} live account${rows.length === 1 ? '' : 's'}${needing > 0 ? `, ${needing} needing recovery before any commercial outreach` : ''}.`
        }
      />
      {rows.length > 0 ? (
        <DataTable rows={rows} columns={columns} getKey={(r) => r.projectId} href={(r) => `/projects/${r.projectId}`} />
      ) : (
        <EmptyState
          icon={<IconProjects size={22} />}
          title="No live accounts"
          description="A completed project appears here once Phase 8 is started from its ready intake and a person has defined the warranty window."
        />
      )}
    </div>
  );
}
