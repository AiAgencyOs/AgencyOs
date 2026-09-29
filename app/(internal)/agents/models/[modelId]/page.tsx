import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { formatCostMinor } from '@/lib/admin/agent-eval';
import { agencyClock } from '@/lib/admin/agency-clock';
import { readModelDetail } from '@/lib/admin/model-detail';
import { formatDurationMs } from '@/lib/admin/agent-runs-eval';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { Badge, Card, CardHeader, DataTable, DetailFields, EmptyState, IconSparkle, IconUsage, PageHeader, PermissionDenied, Stat, StatGrid, StatusBadge, ViewAll, buttonClass, humanize, type Column, type DetailField } from '@/ui';

import { TrailLabel } from '../../../trail-label';

import type { ModelRunRow } from '@/lib/admin/model-detail';

export const metadata: Metadata = { title: 'Model' };

const N = new Intl.NumberFormat('en-IN');
const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

/**
 * SCR-061 — "Open model detail". One model of the registry (`ai.models`):
 * its provider, capabilities and rates; who added it and when (the audit
 * entry); which categories, agents and fallback chains route to it; what
 * the runs that carried it did in the last 30 days; and the last twenty of
 * those runs, each linking to the run detail. Read-only, gated on
 * `audit.read` like the dashboard that links here. An id the registry does
 * not hold is the shell's not-found page. Rates and costs are the rows'
 * own; nothing is estimated.
 */
export default async function ModelDetailPage({ params }: { params: Promise<{ modelId: string }> }) {
  const { modelId: raw } = await params;
  const modelId = decodeURIComponent(raw);

  const context = await requireInternal(`/agents/models/${raw}`);
  const clock = await agencyClock();
  if (!can(context, 'audit.read')) return <PermissionDenied />;

  const detail = await readModelDetail(modelId);
  if (!detail) notFound();
  const { model, addedBy, routing, period, recentRuns } = detail;

  const rate = (minor: number | null) => (minor === null ? '—' : `${INR.format(minor / 100)} / Mtok`);
  const rows: DetailField[] = [
    { label: 'Model id', value: <code className="text-xs">{model.modelId}</code> },
    { label: 'Provider', value: model.provider },
    { label: 'Status', value: <StatusBadge status={model.status} /> },
    {
      label: 'Capabilities',
      value: model.capabilities.length > 0 ? <span className="flex flex-wrap gap-1">{model.capabilities.map((c) => <Badge key={c} tone="neutral">{humanize(c)}</Badge>)}</span> : '—',
    },
    { label: 'Context window', value: model.contextTokens !== null ? `${N.format(model.contextTokens)} tokens` : '—' },
    { label: 'Input rate', value: rate(model.inputCostMinorPerMtok) },
    { label: 'Output rate', value: rate(model.outputCostMinorPerMtok) },
    {
      label: 'Added',
      value: addedBy ? `${clock.dateTime(addedBy.at)} by ${addedBy.actorName ?? (addedBy.actorId ? addedBy.actorId.slice(0, 8) : 'the system')}${addedBy.action === 'model.reactivated' ? ' (reactivated)' : ''}` : `${clock.dateTime(model.createdAt)} — no audit entry names who added it`,
    },
    { label: 'Last changed', value: clock.dateTime(model.updatedAt) },
  ];

  const routes = routing.policies.length + routing.overrides.length + routing.chains.length;

  const columns: Column<ModelRunRow>[] = [
    { key: 'agent', header: 'Agent', primary: true, cell: (r) => r.agentKey },
    { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
    { key: 'trigger', header: 'Trigger', desktopOnly: true, cellClassName: 'text-muted', cell: (r) => (r.trigger.startsWith('job:') ? `job ${r.trigger.slice(4, 12)}` : humanize(r.trigger)) },
    { key: 'tokens', header: 'Tokens', align: 'right', cellClassName: 'tabular', cell: (r) => `${N.format(r.inputTokens)} / ${N.format(r.outputTokens)}` },
    { key: 'cost', header: 'Cost', align: 'right', cellClassName: 'tabular', cell: (r) => `₹${formatCostMinor(r.costMinor) ?? '0.00'}` },
    { key: 'latency', header: 'Latency', align: 'right', desktopOnly: true, cellClassName: 'tabular text-muted', cell: (r) => formatDurationMs(r.latencyMs) ?? '—' },
    { key: 'when', header: 'When', align: 'right', cellClassName: 'text-muted', cell: (r) => clock.dateTime(r.createdAt) },
  ];

  return (
    <div className="flex flex-col gap-5">
      <TrailLabel name={model.modelId} />
      <PageHeader
        eyebrow="Models"
        title={model.modelId}
        description={`${model.provider} · ${routes} route${routes === 1 ? '' : 's'} point here · ${period.runs} run${period.runs === 1 ? '' : 's'} in the last ${period.days} days.`}
        meta={<StatusBadge status={model.status} />}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <ViewAll href="/agents/routing" label="Model routing" />
            <ViewAll href={`/usage/runs?model=${encodeURIComponent(model.modelId)}`} label="All its runs" />
          </span>
        }
      />

      <StatGrid>
        <Stat label={`Runs (${period.days}d)`} value={N.format(period.runs)} caption={period.failed > 0 ? `${period.failed} failed` : 'None failed'} tone={period.failed > 0 ? 'warning' : 'neutral'} icon={<IconUsage size={16} />} href={`/usage/runs?model=${encodeURIComponent(model.modelId)}`} />
        <Stat label="Tokens" value={N.format(period.inputTokens + period.outputTokens)} caption={`${N.format(period.inputTokens)} in · ${N.format(period.outputTokens)} out`} icon={<IconSparkle size={16} />} />
        <Stat label="Cost" value={`₹${formatCostMinor(period.costMinor) ?? '0.00'}`} caption="Sum of the runs in the period" tone="brand" />
        <Stat label="Avg latency" value={formatDurationMs(period.averageLatencyMs) ?? '—'} caption={period.averageLatencyMs === null ? 'No settled run carried a latency' : 'Over settled runs'} />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Registry row" description="As the owner recorded it on Model routing; the adapter receives the id exactly as stored." />
          <div className="px-4 pb-4 sm:px-5">
            <DetailFields rows={rows} />
          </div>
        </Card>
        <Card>
          <CardHeader title="What routes here" description="Category policies, per-agent overrides and fallback chains that name this model. Position 1 is tried first." />
          {routes === 0 ? (
            <EmptyState
              icon={<IconSparkle size={22} />}
              title="Nothing routes to this model"
              description="No category policy, agent override or fallback chain names it; an agent whose default model is this id still uses it."
              action={<Link href="/agents/routing" className={buttonClass('secondary', 'sm')}>Open model routing</Link>}
            />
          ) : (
            <ul className="divide-y divide-line text-[13px]">
              {routing.policies.map((p) => (
                <li key={`p-${p.category}-${p.role}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-5">
                  <span>
                    <span className="text-muted">Category</span> {humanize(p.category)}
                  </span>
                  <Badge tone={p.role === 'admin_override' ? 'warning' : 'neutral'}>{p.role === 'admin_override' ? 'admin override' : `preferred #${p.position}`}</Badge>
                </li>
              ))}
              {routing.overrides.map((o) => (
                <li key={`o-${o.agentKey}-${o.category}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-5">
                  <span>
                    <span className="text-muted">Agent</span>{' '}
                    <Link href={`/agents/${encodeURIComponent(o.agentKey)}`} className="underline-offset-2 hover:underline">
                      {o.agentKey}
                    </Link>{' '}
                    <span className="text-muted">· {humanize(o.category)}</span>
                  </span>
                  <Badge tone="info">override #{o.position}</Badge>
                </li>
              ))}
              {routing.chains.map((c) => (
                <li key={`c-${c.workClass}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-5">
                  <span>
                    <span className="text-muted">Fallback chain</span> {humanize(c.workClass)}
                  </span>
                  <Badge tone="neutral">#{c.position}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title={`Last ${recentRuns.length} runs`} description={`Runs in the last ${period.days} days that carried this model, newest first. Each opens the run.`} actions={<ViewAll href={`/usage/runs?model=${encodeURIComponent(model.modelId)}`} label="All runs" />} />
        {recentRuns.length === 0 ? (
          <EmptyState
            icon={<IconUsage size={22} />}
            title="No run used this model in the period"
            description={`No ai.agent_runs row in the last ${period.days} days carries this id.`}
            action={<Link href="/usage/runs" className={buttonClass('secondary', 'sm')}>Open agent runs</Link>}
          />
        ) : (
          <DataTable dense rows={recentRuns} columns={columns} getKey={(r) => r.id} href={(r) => `/usage/runs/${r.id}`} />
        )}
      </Card>
    </div>
  );
}
