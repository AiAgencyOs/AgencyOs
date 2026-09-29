import type { Metadata } from 'next';

import { getSalesFunnel } from '@/lib/admin/sales-funnel';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listInvoices } from '@/modules/finance/queries';
import { listProjectsForTable } from '@/modules/projects/queries';
import { listOpenDefects } from '@/modules/qa/queries';
import {
  BarChart,
  Card,
  CardHeader,
  DonutChart,
  humanize,
  IconAlert,
  IconCheck,
  IconInvoices,
  IconProjects,
  IconUsers,
  PageHeader,
  PermissionDenied,
  ProgressBar,
  Stat,
  StatGrid,
  ViewAll,
} from '@/ui';

export const metadata: Metadata = { title: 'Reports' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
}

const SEVERITY_COLOR: Record<string, string> = {
  blocker: 'var(--danger)',
  major: 'var(--warning)',
  minor: 'var(--info)',
  trivial: 'var(--faint)',
};

/**
 * Reports & Analytics — the PDF's Reports module, laid out as the
 * reference's project reports (figures, a completion trend, distribution and
 * health), built entirely from readers that already exist: getSalesFunnel,
 * listProjectsForTable, listInvoices, listOpenDefects. Nothing here computes
 * a number the rest of the app doesn't already show elsewhere — a report
 * that could disagree with the screen it summarizes would be worse than no
 * report. Project completion is milestones met over milestones planned,
 * the same figure the projects list prints; there is no stored trend
 * series, so no trend line is drawn.
 */
export default async function ReportsPage() {
  const context = await requireInternal('/reports');
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const [funnel, projects, invoices, defects] = await Promise.all([
    getSalesFunnel(),
    listProjectsForTable(500),
    can(context.role, 'invoice.read') ? listInvoices(500) : Promise.resolve([]),
    listOpenDefects(),
  ]);

  const funnelData = funnel.steps.map((s) => ({ label: s.label, value: s.count }));

  const projectsByStatus = new Map<string, number>();
  for (const p of projects) projectsByStatus.set(p.status, (projectsByStatus.get(p.status) ?? 0) + 1);
  const projectData = [...projectsByStatus.entries()].map(([status, count]) => ({ label: humanize(status), value: count }));

  const planned = projects.filter((p) => p.milestonesTotal > 0);
  const completion = planned.length > 0 ? Math.round((planned.reduce((n, p) => n + p.milestonesMet / p.milestonesTotal, 0) / planned.length) * 100) : null;
  const active = projects.filter((p) => p.status === 'active');
  const todayKey = new Date().toISOString().slice(0, 10);
  const late = projects.filter((p) => p.status !== 'completed' && p.status !== 'cancelled' && p.endsOn !== null && p.endsOn < todayKey);
  const healthy = active.filter((p) => !late.includes(p) && !defects.some((d) => d.projectId === p.id && d.severity === 'blocker'));

  const byCurrency = new Map<string, { invoiced: number; paid: number }>();
  for (const inv of invoices) {
    if (inv.status === 'draft' || inv.status === 'void' || inv.status === 'pending_approval') continue;
    const row = byCurrency.get(inv.currency) ?? { invoiced: 0, paid: 0 };
    row.invoiced += inv.total_minor;
    row.paid += inv.paid_minor;
    byCurrency.set(inv.currency, row);
  }

  const severityOrder = ['blocker', 'major', 'minor', 'trivial'];
  const severityCounts = new Map<string, number>();
  for (const d of defects) severityCounts.set(d.severity, (severityCounts.get(d.severity) ?? 0) + 1);
  const defectData = severityOrder.filter((s) => (severityCounts.get(s) ?? 0) > 0).map((s) => ({ label: humanize(s), value: severityCounts.get(s) ?? 0, key: s }));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Reports"
        description="Cross-module rollups, computed from the same readers the rest of the Admin Panel uses — never a number that could disagree with its own detail screen."
      />

      <StatGrid cols={5}>
        <Stat label="Leads (90 days)" value={String(funnel.counts.leads)} caption={`${funnel.counts.won} won · ${funnel.counts.lost} lost`} tone="brand" icon={<IconUsers size={16} />} href="/sales-funnel" />
        <Stat label="Projects" value={String(projects.length)} caption={`${active.length} active`} tone="info" icon={<IconProjects size={16} />} href="/projects" />
        <Stat label="Avg completion" value={completion === null ? '—' : `${completion}%`} caption={planned.length === 0 ? 'No project has a plan yet' : `Across ${planned.length} planned project${planned.length === 1 ? '' : 's'}`} tone="success" icon={<IconCheck size={16} />} />
        <Stat label="Running late" value={String(late.length)} caption="Past their due date" tone={late.length > 0 ? 'danger' : 'success'} icon={<IconAlert size={16} />} />
        <Stat label="Open defects" value={String(defects.length)} caption={`${severityCounts.get('blocker') ?? 0} blocker${(severityCounts.get('blocker') ?? 0) === 1 ? '' : 's'}`} tone={defects.length > 0 ? 'warning' : 'success'} icon={<IconAlert size={16} />} href="/qa" />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Sales pipeline" description={`${funnel.counts.leads} leads in the last 90 days, by the stage they reached.`} actions={<ViewAll href="/sales-funnel" />} />
          <div className="px-2 pb-4 sm:px-3">
            {funnelData.length > 0 && funnel.counts.leads > 0 ? <BarChart data={funnelData} /> : <p className="px-3 py-6 text-[13px] text-muted">No leads in this window.</p>}
          </div>
        </Card>

        <Card>
          <CardHeader title="Project distribution" description="By status." actions={<ViewAll href="/projects" />} />
          <div className="p-4 sm:p-5">
            {projectData.length > 0 ? <DonutChart data={projectData} totalLabel="Projects" height={150} /> : <p className="text-[13px] text-muted">No projects yet.</p>}
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader title="Project health" description="Active projects — on time and free of open blockers." />
          <div className="flex flex-col gap-3 p-4 sm:p-5">
            {active.length === 0 ? (
              <p className="text-[13px] text-muted">No active projects.</p>
            ) : (
              <>
                <ProgressBar value={(healthy.length / active.length) * 100} label="Healthy share of active projects" tone={healthy.length === active.length ? 'success' : 'warning'} />
                <p className="text-[13px] text-muted">
                  {healthy.length} of {active.length} healthy · {late.length} late · {active.length - healthy.length - late.filter((p) => p.status === 'active').length} with a blocker
                </p>
              </>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Open defects by severity" description={defects.length === 0 ? 'None open' : `${defects.length} open`} actions={<ViewAll href="/qa" />} />
          <div className="px-2 pb-4 sm:px-3">
            {defectData.length > 0 ? (
              <BarChart height={160} data={defectData.map(({ label, value }) => ({ label, value }))} colors={defectData.map((d) => SEVERITY_COLOR[d.key] ?? 'var(--muted)')} />
            ) : (
              <p className="px-3 py-6 text-[13px] text-muted">No open defects.</p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Invoiced vs. received" actions={<ViewAll href="/finance" />} />
          <div className="flex flex-col gap-4 px-2 pb-4 sm:px-3">
            {byCurrency.size > 0 ? (
              [...byCurrency.entries()].map(([currency, totals]) => (
                <div key={currency}>
                  <BarChart
                    height={140}
                    data={[
                      { label: 'Invoiced', value: totals.invoiced / 100 },
                      { label: 'Received', value: totals.paid / 100 },
                    ]}
                    colors={['var(--brand)', 'var(--success)']}
                    currency={currency}
                  />
                  <p className="px-3 text-xs text-muted">
                    <IconInvoices size={12} className="mr-1 inline align-[-2px]" />
                    {money(totals.invoiced, currency)} invoiced · {money(totals.paid, currency)} received
                  </p>
                </div>
              ))
            ) : (
              <p className="px-3 py-6 text-[13px] text-muted">{can(context.role, 'invoice.read') ? 'No invoices yet.' : 'Your role cannot read invoices.'}</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
