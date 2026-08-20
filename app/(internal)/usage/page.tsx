import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { formatCostMinor } from '@/lib/admin/agent-eval';
import { getAgentUsage } from '@/lib/admin/usage';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  DataTable,
  EmptyState,
  IconUsage,
  PageHeader,
  Stat,
  StatGrid,
  type Column,
} from '@/ui';

export const metadata: Metadata = { title: 'Usage & costs' };

/**
 * AI usage & cost — what the agents actually consumed, from `ai.agent_runs`
 * (tokens) and `ai.agent_steps` (cost). Every figure is recorded, not estimated;
 * there is no rate card and no invented number. When nothing has run the page
 * says so rather than showing zeros dressed as insight. Gated on `audit.read`
 * (owner + ops_admin), like the Agents page.
 */

const N = new Intl.NumberFormat('en-IN');

type Row = Awaited<ReturnType<typeof getAgentUsage>>['perAgent'][number];

export default async function UsagePage() {
  const context = await requireInternal('/usage');
  if (!can(context.role, 'audit.read')) redirect('/dashboard');

  const { perAgent, totals, capped } = await getAgentUsage();
  const cost = (minor: number) => `₹${formatCostMinor(minor) ?? '0.00'}`;

  const columns: Column<Row>[] = [
    { key: 'agent', header: 'Agent', primary: true, cell: (a) => a.agentKey },
    {
      key: 'runs',
      header: 'Runs',
      align: 'right',
      cellClassName: 'tabular',
      cell: (a) => N.format(a.runs),
    },
    {
      key: 'in',
      header: 'Input tokens',
      align: 'right',
      cellClassName: 'tabular text-muted',
      cell: (a) => N.format(a.inputTokens),
    },
    {
      key: 'out',
      header: 'Output tokens',
      align: 'right',
      cellClassName: 'tabular text-muted',
      cell: (a) => N.format(a.outputTokens),
    },
    {
      key: 'cost',
      header: 'Cost',
      align: 'right',
      cellClassName: 'tabular font-medium',
      cell: (a) => cost(a.costMinor),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Usage & costs"
        description="What the AI agents actually consumed — recorded per run and per step, never estimated. Cost is what the runtime wrote down; there is no rate card here."
      />

      <StatGrid>
        <Stat label="Agent runs" value={N.format(totals.runs)} />
        <Stat label="Input tokens" value={N.format(totals.inputTokens)} />
        <Stat label="Output tokens" value={N.format(totals.outputTokens)} />
        <Stat label="Cost" value={cost(totals.costMinor)} tone="brand" />
      </StatGrid>

      {perAgent.length === 0 ? (
        <EmptyState
          icon={<IconUsage size={22} />}
          title="No agent usage recorded yet"
          description="Agents run only when enabled and a provider is configured — usage and cost appear here once they do."
        />
      ) : (
        <DataTable rows={perAgent} columns={columns} getKey={(a) => a.agentKey} />
      )}

      <p className="text-xs leading-relaxed text-muted">
        Scoped to your organization (RLS).{' '}
        {capped
          ? 'Showing the most recent records (capped); older usage is not summed here. '
          : ''}
        Cost is the sum of what each step recorded — an empty table means nothing has run, not that
        it was free.
      </p>
    </div>
  );
}
