import type { Metadata } from 'next';

import { formatCostMinor } from '@/lib/admin/agent-eval';
import { agencyClock } from '@/lib/admin/agency-clock';
import { listAgentRunFacets, listAgentRuns, type AgentRunListRow } from '@/lib/admin/agent-runs';
import { summariseRuns } from '@/lib/admin/agent-runs-eval';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  Badge,
  DataTable,
  EmptyState,
  FilterBar,
  FilterChips,
  IconAlert,
  IconClock,
  IconRupee,
  IconUsage,
  PageHeader,
  PermissionDenied,
  Stat,
  StatGrid,
  StatusBadge,
  ViewAll,
  humanize,
  type Column,
  type FilterChipOption,
} from '@/ui';

export const metadata: Metadata = { title: 'Agent runs' };

const N = new Intl.NumberFormat('en-IN');
const LIMIT = 100;

type Filters = { agent?: string; status?: string; model?: string };

/** The list URL with one filter changed and the others kept — a chip never resets its neighbours. */
function runsHref(current: Filters, patch: Partial<Filters>): string {
  const next = { ...current, ...patch };
  const params = new URLSearchParams();
  for (const key of ['agent', 'status', 'model'] as const) {
    const value = next[key];
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `/usage/runs?${qs}` : '/usage/runs';
}

function chips(
  key: keyof Filters,
  values: readonly string[],
  current: Filters,
  allLabel: string,
): FilterChipOption[] {
  const selected = current[key];
  return [
    { key: `${key}-all`, label: allLabel, href: runsHref(current, { [key]: undefined }), active: !selected },
    ...values.map((v) => ({
      key: `${key}-${v}`,
      label: key === 'status' ? humanize(v) : v,
      href: runsHref(current, { [key]: v }),
      active: selected === v,
    })),
  ];
}

/**
 * The agent runs explorer — SCR-065's "run list with project/agent/provider
 * filters". Every row is one `ai.agent_runs` record as the runtime wrote it;
 * the KPI row sums the rows on screen (the filtered, most-recent set), so a
 * filter narrows the figures with the list rather than showing an org-wide
 * total beside a partial table. Org-wide totals live on `/usage`, from the
 * cost ledger. Read-only, gated on `audit.read` like the pages around it.
 */
import { TrailLabel } from '../../trail-label';

export default async function AgentRunsPage({ searchParams }: { searchParams: Promise<Filters> }) {
  const context = await requireInternal('/usage/runs');
  const clock = await agencyClock();
  if (!can(context.role, 'audit.read')) return <PermissionDenied />;

  const raw = await searchParams;
  const filters: Filters = {
    agent: raw.agent || undefined,
    status: raw.status || undefined,
    model: raw.model || undefined,
  };
  const filtered = Boolean(filters.agent || filters.status || filters.model);

  const [runs, facets] = await Promise.all([
    listAgentRuns({ agentKey: filters.agent, status: filters.status, model: filters.model, limit: LIMIT }),
    listAgentRunFacets(),
  ]);
  const summary = summariseRuns(runs);
  const cost = (minor: number) => `₹${formatCostMinor(minor) ?? '0.00'}`;

  const columns: Column<AgentRunListRow>[] = [
    {
      key: 'agent',
      header: 'Agent',
      primary: true,
      // The row itself is the link to the run; the agent's own page is one
      // hop from there (nesting a second <a> inside it breaks HTML).
      cell: (r) => r.agentKey,
    },
    { key: 'trigger', header: 'Trigger', cellClassName: 'text-muted', cell: (r) => (r.trigger.startsWith('job:') ? <span>Job <code className="font-mono text-[11px]">{r.trigger.slice(4, 12)}</code></span> : humanize(r.trigger)) },
    {
      key: 'subject',
      header: 'Subject',
      desktopOnly: true,
      cellClassName: 'text-muted',
      cell: (r) =>
        r.subjectType ? (
          <span>
            {humanize(r.subjectType)}
            {r.subjectId ? <span className="ml-1 font-mono text-[11px]">{r.subjectId.slice(0, 8)}</span> : null}
          </span>
        ) : (
          '—'
        ),
    },
    { key: 'status', header: 'Status', badge: true, cell: (r) => <StatusBadge status={r.status} /> },
    { key: 'model', header: 'Model', desktopOnly: true, cellClassName: 'font-mono text-xs text-muted', cell: (r) => r.model ?? '—' },
    { key: 'steps', header: 'Steps', align: 'right', cellClassName: 'tabular', cell: (r) => String(r.stepCount) },
    {
      key: 'tokens',
      header: 'Tokens in / out',
      align: 'right',
      desktopOnly: true,
      cellClassName: 'tabular text-muted',
      cell: (r) => `${N.format(r.inputTokens)} / ${N.format(r.outputTokens)}`,
    },
    { key: 'cost', header: 'Cost', align: 'right', cellClassName: 'tabular font-medium', cell: (r) => cost(r.costMinor) },
    { key: 'when', header: 'When', align: 'right', cellClassName: 'text-muted whitespace-nowrap', cell: (r) => clock.dateTime(r.createdAt) },
  ];

  return (
    <div className="flex flex-col gap-5">
      <TrailLabel name="Agent runs" />
      <PageHeader
        eyebrow="Usage & costs"
        title="Agent runs"
        description="Every run an agent made, one row each, as the runtime recorded it — open a run for its step trace. Figures below sum the rows shown."
        meta={
          <Badge tone="neutral">
            {runs.length >= LIMIT ? `latest ${LIMIT}` : `${runs.length} run${runs.length === 1 ? '' : 's'}`}
            {filtered ? ' · filtered' : ''}
          </Badge>
        }
        actions={<ViewAll href="/usage" label="Usage & costs" />}
      />

      {facets.agents.length > 0 ? (
        <FilterBar>
          <FilterChips options={chips('agent', facets.agents, filters, 'All agents')} />
          <FilterChips options={chips('status', facets.statuses, filters, 'All statuses')} />
          {facets.models.length > 0 ? <FilterChips options={chips('model', facets.models, filters, 'All models')} /> : null}
        </FilterBar>
      ) : null}

      <StatGrid>
        <Stat label="Runs" value={N.format(summary.runs)} caption={filtered ? 'Matching the filters' : `Most recent ${LIMIT}`} icon={<IconUsage size={16} />} />
        <Stat
          label="Failed"
          value={N.format(summary.failed)}
          caption={summary.runs > 0 ? `${Math.round((summary.failed / summary.runs) * 100)}% of shown` : 'No runs shown'}
          tone={summary.failed > 0 ? 'danger' : 'neutral'}
          icon={<IconAlert size={16} />}
        />
        <Stat label="Avg steps" value={summary.avgSteps === null ? '—' : String(summary.avgSteps)} caption="Per run shown" icon={<IconClock size={16} />} />
        <Stat label="Total cost" value={cost(summary.totalCostMinor)} caption="Sum of runs shown" tone="brand" icon={<IconRupee size={16} />} />
      </StatGrid>

      {runs.length === 0 ? (
        <EmptyState
          icon={<IconUsage size={22} />}
          title={filtered ? 'No runs match these filters' : 'No agent runs recorded yet'}
          description={
            filtered
              ? 'Clear a filter to widen the list.'
              : 'Agents run only when enabled and a provider is configured — each run appears here once it does.'
          }
        />
      ) : (
        <DataTable dense rows={runs} columns={columns} getKey={(r) => r.id} href={(r) => `/usage/runs/${r.id}`} />
      )}

      <p className="text-xs leading-relaxed text-muted">
        Scoped to your organization (RLS). Showing the {runs.length >= LIMIT ? `${LIMIT} most recent` : `${runs.length}`}{' '}
        {filtered ? 'matching ' : ''}runs, newest first; the filter rail offers values seen in recent runs.
      </p>
    </div>
  );
}
