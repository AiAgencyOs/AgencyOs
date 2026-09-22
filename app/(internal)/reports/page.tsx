import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getSalesFunnel } from '@/lib/admin/sales-funnel';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listInvoices } from '@/modules/finance/queries';
import { listOpenDefects } from '@/modules/qa/queries';
import { listProjects } from '@/modules/projects/queries';
import { Card, CardHeader, PageHeader } from '@/ui';

import { SimpleBarChart } from './simple-bar-chart';

export const metadata: Metadata = { title: 'Reports' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(
    minor / 100,
  );
}

const PROJECT_STATUS_LABEL: Record<string, string> = {
  planning: 'Planning',
  active: 'Active',
  on_hold: 'On hold',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const SEVERITY_COLOR: Record<string, string> = {
  blocker: 'var(--danger)',
  major: 'var(--warning)',
  minor: 'var(--muted)',
  trivial: 'var(--muted)',
};

/**
 * Reports & Analytics — the PDF's Reports module, built entirely from
 * readers that already exist: getSalesFunnel (sales-funnel.ts), listProjects,
 * listInvoices, listOpenDefects. Nothing here computes a number the rest of
 * the app doesn't already show elsewhere — a report that could disagree with
 * the screen it summarizes would be worse than no report.
 *
 * Deliberately scoped to what current schema supports: no expense/margin
 * section, because finance.expenses does not exist yet (SCR-055 needs new
 * schema, not just a new chart).
 */
export default async function ReportsPage() {
  const context = await requireInternal('/reports');
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const [funnel, projects, invoices, defects] = await Promise.all([
    getSalesFunnel(),
    listProjects(500),
    listInvoices(500),
    listOpenDefects(),
  ]);

  const funnelData = funnel.steps.map((s) => ({ label: s.label, value: s.count }));

  const projectsByStatus = new Map<string, number>();
  for (const p of projects) {
    projectsByStatus.set(p.status, (projectsByStatus.get(p.status) ?? 0) + 1);
  }
  const projectData = [...projectsByStatus.entries()].map(([status, count]) => ({
    label: PROJECT_STATUS_LABEL[status] ?? status,
    value: count,
  }));

  // Invoiced vs paid by currency, since a mixed-currency deployment cannot be
  // summed into one meaningful number — the same rule Finance Overview follows.
  const byCurrency = new Map<string, { invoiced: number; paid: number }>();
  for (const inv of invoices) {
    if (inv.status === 'draft' || inv.status === 'void') continue;
    const row = byCurrency.get(inv.currency) ?? { invoiced: 0, paid: 0 };
    row.invoiced += inv.total_minor;
    row.paid += inv.paid_minor;
    byCurrency.set(inv.currency, row);
  }

  const severityOrder = ['blocker', 'major', 'minor', 'trivial'];
  const severityCounts = new Map<string, number>();
  for (const d of defects) severityCounts.set(d.severity, (severityCounts.get(d.severity) ?? 0) + 1);
  const defectData = severityOrder
    .filter((s) => (severityCounts.get(s) ?? 0) > 0)
    .map((s) => ({ label: s, value: severityCounts.get(s) ?? 0 }));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Reports"
        description="Cross-module rollups, computed from the same readers the rest of the Admin Panel uses — never a number that could disagree with its own detail screen."
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Sales pipeline" description={`${funnel.counts.leads} leads in the last 90 days`} />
          <div className="px-2 pb-4 sm:px-3">
            {funnelData.length > 0 ? <SimpleBarChart data={funnelData} /> : <p className="px-3 text-[13px] text-muted">No leads in this window.</p>}
          </div>
        </Card>

        <Card>
          <CardHeader title="Projects by status" description={`${projects.length} project${projects.length === 1 ? '' : 's'}`} />
          <div className="px-2 pb-4 sm:px-3">
            {projectData.length > 0 ? <SimpleBarChart data={projectData} /> : <p className="px-3 text-[13px] text-muted">No projects yet.</p>}
          </div>
        </Card>

        <Card>
          <CardHeader title="Open defects by severity" description={defects.length === 0 ? 'None open' : `${defects.length} open`} />
          <div className="px-2 pb-4 sm:px-3">
            {defectData.length > 0 ? (
              <SimpleBarChart data={defectData} colors={defectData.map((d) => SEVERITY_COLOR[d.label] ?? 'var(--muted)')} />
            ) : (
              <p className="px-3 text-[13px] text-muted">No open defects.</p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Invoiced vs. received" />
          <div className="flex flex-col gap-4 px-2 pb-4 sm:px-3">
            {byCurrency.size > 0 ? (
              [...byCurrency.entries()].map(([currency, totals]) => (
                <div key={currency}>
                  <p className="px-3 text-xs font-medium text-muted">{currency}</p>
                  <SimpleBarChart
                    height={160}
                    data={[
                      { label: 'Invoiced', value: totals.invoiced },
                      { label: 'Received', value: totals.paid },
                    ]}
                    colors={['var(--brand)', 'var(--success)']}
                    valueFormatter={(v) => money(v, currency)}
                  />
                  <p className="px-3 text-xs text-muted">
                    {money(totals.invoiced, currency)} invoiced · {money(totals.paid, currency)} received
                  </p>
                </div>
              ))
            ) : (
              <p className="px-3 text-[13px] text-muted">No invoices yet.</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
