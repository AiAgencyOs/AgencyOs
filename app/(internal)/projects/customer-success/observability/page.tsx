import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { ageInDays, readPhaseEightObservability, type ObservabilityBucket, type ObservabilityMetric } from '@/modules/projects/phase-eight-observability-queries';
import { Badge, Card, CardHeader, DataTable, PageHeader, PermissionDenied, humanize, type Column, type Tone } from '@/ui';

export const metadata: Metadata = { title: 'Customer Success observability' };

const TONE: Record<string, Tone> = {
  healthy: 'success', stable: 'info', watch: 'warning', at_risk: 'danger', critical: 'danger', breached: 'danger', running: 'info', met: 'success', met_late: 'warning', not_started: 'neutral',
  expired: 'danger', renewal_approaching: 'warning',
};

const SECTIONS: { metric: ObservabilityMetric; title: string; note: string; ageLabel: string }[] = [
  { metric: 'tickets_by_state', title: 'Support tickets by state', note: 'Every ticket, by its stored state.', ageLabel: 'Oldest raised' },
  { metric: 'tickets_by_sla', title: 'Open tickets by resolution SLA', note: 'Open tickets only, read from the support clock.', ageLabel: 'Oldest raised' },
  { metric: 'tickets_by_response_sla', title: 'Open tickets by response SLA', note: 'Open tickets only, read from the support clock.', ageLabel: 'Oldest raised' },
  { metric: 'health_distribution', title: 'Health distribution', note: 'Live accounts by their DERIVED health: nothing stores or scores it.', ageLabel: 'Longest in customer success' },
  { metric: 'recovery_plans', title: 'Recovery plans open', note: 'Open and in-progress plans.', ageLabel: 'Oldest opened' },
  { metric: 'renewals_due', title: 'Renewals', note: 'Plans approaching renewal, proposed, awaiting the client, or expired. Age counts from the plan end date.', ageLabel: 'Earliest end date' },
  { metric: 'opportunities_by_stage', title: 'Expansion opportunities by stage', note: 'Stored stage. Nothing here is priced.', ageLabel: 'Oldest detected' },
];

function columns(ageLabel: string, now: Date): Column<ObservabilityBucket>[] {
  return [
    { key: 'bucket', header: 'Bucket', primary: true, cell: (b) => <Badge tone={TONE[b.bucket] ?? 'neutral'}>{humanize(b.bucket)}</Badge> },
    { key: 'count', header: 'Count', align: 'right', cell: (b) => b.count },
    { key: 'age', header: ageLabel, align: 'right', cell: (b) => { const d = ageInDays(b.oldestAt, now); return d === null ? '—' : `${d} day${d === 1 ? '' : 's'}`; } },
  ];
}

/**
 * Phase 8 observability (CUS-IMP-009): counts and ages from the existing Phase 8A tables, read-only. The overview at /projects/customer-success lists
 * accounts; this page counts them. The database groups; nothing here computes a status.
 */
export default async function CustomerSuccessObservabilityPage() {
  const context = await requireInternal('/projects/customer-success/observability');
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const data = await readPhaseEightObservability();
  const now = new Date();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Customer Success observability"
        description="Counts and ages across every live Phase 8 account: tickets, SLA state, health, recovery, renewals and opportunities."
        actions={<Link href="/projects/customer-success" className="text-[13px] underline">Back to the accounts</Link>}
      />
      {SECTIONS.map((s) => (
        <Card key={s.metric}>
          <CardHeader title={s.title} description={s.note} />
          {data[s.metric].length > 0 ? (
            <DataTable dense rows={data[s.metric]} columns={columns(s.ageLabel, now)} getKey={(b) => b.bucket} />
          ) : (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">Nothing to count.</p>
          )}
        </Card>
      ))}
    </div>
  );
}
