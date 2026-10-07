import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readPhaseEightObservability, type ObservabilityBucket } from '@/modules/projects/phase-eight-observability-queries';
import { readAlerts } from '@/modules/projects/p789-round2-queries';
import { BarChart, Card, CardHeader, DonutChart, PageHeader, PermissionDenied, humanize } from '@/ui';

export const metadata: Metadata = { title: 'Customer Success charts' };

const series = (buckets: ObservabilityBucket[]) => buckets.map((b) => ({ label: humanize(b.bucket), value: b.count }));

/**
 * The Customer Success dashboard as charts. The database groups and counts (the same reads the observability page tabulates); a chart only draws those counts.
 * A chart with nothing to draw says so instead of drawing an empty frame. Nothing on this page has been rendered in a browser by the builder.
 */
export default async function P789ChartsPage() {
  const context = await requireInternal('/projects/customer-success/p789-charts');
  if (!can(context, 'project.read')) return <PermissionDenied />;
  const [o, alerts] = await Promise.all([readPhaseEightObservability(), readAlerts()]);
  const live = alerts.filter((a) => a.state !== 'cleared');
  const panels: { title: string; node: React.ReactNode }[] = [
    { title: 'Health distribution', node: o.health_distribution.length ? <DonutChart data={series(o.health_distribution)} totalLabel="Accounts" /> : null },
    { title: 'Tickets by state', node: o.tickets_by_state.length ? <BarChart data={series(o.tickets_by_state)} /> : null },
    { title: 'Tickets by resolution SLA', node: o.tickets_by_sla.length ? <DonutChart data={series(o.tickets_by_sla)} totalLabel="Tickets" /> : null },
    { title: 'Recovery plans', node: o.recovery_plans.length ? <BarChart data={series(o.recovery_plans)} /> : null },
    { title: 'Renewals due', node: o.renewals_due.length ? <BarChart data={series(o.renewals_due)} /> : null },
    { title: 'Opportunities by stage', node: o.opportunities_by_stage.length ? <BarChart data={series(o.opportunities_by_stage)} /> : null },
    { title: 'Live alerts by figure', node: live.length ? <BarChart data={live.map((a) => ({ label: humanize(a.metric), value: a.observed }))} /> : null },
  ];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Customer Success charts" description="The same counts as the observability tables, drawn." actions={<Link href="/projects/customer-success/observability" className="text-[13px] underline">Tables</Link>} />
      {panels.map((p) => (
        <Card key={p.title}>
          <CardHeader title={p.title} />
          <div className="px-4 pb-4 sm:px-5">{p.node ?? <p className="text-[13px] text-muted">Nothing to chart.</p>}</div>
        </Card>
      ))}
    </div>
  );
}
