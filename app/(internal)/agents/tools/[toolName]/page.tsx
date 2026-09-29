import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { formatDurationMs } from '@/lib/admin/agent-runs-eval';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { toolDetailFor } from '@/modules/agents/permissions-schema';
import { listToolPermissionsForTool, readToolCallStats, type ToolCallRow } from '@/modules/agents/tool-detail-queries';
import { Badge, Card, CardHeader, DataTable, DetailFields, EmptyState, IconAgents, IconAlert, IconUsage, PageHeader, PermissionDenied, Stat, StatGrid, StatusBadge, ViewAll, buttonClass, type Column, type DetailField } from '@/ui';

import { TrailLabel } from '../../../trail-label';

export const metadata: Metadata = { title: 'Tool' };

const N = new Intl.NumberFormat('en-IN');

/**
 * SCR-061 — "Open tool detail". One tool of the registry (`TOOLS` in
 * src/modules/agents/tools.ts): what it does, its action class, which
 * agents' definitions bind it, which agents this organisation has allowed or
 * denied it for (`ai.agent_tool_permissions`), how often it was called in
 * the last 30 days and how often the call failed (`ai.agent_steps`, kind
 * tool_call, `request->>tool`), and the last twenty calls, each linking to
 * its run. Read-only, gated on `audit.read`. A name the registry has never
 * heard of is the shell's not-found page.
 */
export default async function ToolDetailPage({ params }: { params: Promise<{ toolName: string }> }) {
  const { toolName: raw } = await params;
  const toolName = decodeURIComponent(raw);

  const context = await requireInternal(`/agents/tools/${raw}`);
  const clock = await agencyClock();
  if (!can(context, 'audit.read')) return <PermissionDenied />;

  const tool = toolDetailFor(toolName);
  if (!tool) notFound();

  const [stats, permissions] = await Promise.all([readToolCallStats(tool.name), listToolPermissionsForTool(tool.name)]);
  const allowed = permissions.filter((p) => p.allowed).length;
  const denied = permissions.length - allowed;

  const rows: DetailField[] = [
    { label: 'Tool', value: <code className="text-xs">{tool.name}</code> },
    { label: 'What it does', value: tool.purpose },
    {
      label: 'Action class',
      value: (
        <span className="flex items-center gap-2">
          <Badge tone={tool.actionClass === 'L0' ? 'success' : tool.actionClass === 'L1' ? 'info' : 'warning'}>{tool.actionClass}</Badge>
          <span className="text-muted">{tool.actionClass === 'L0' ? 'reads only' : tool.actionClass === 'L1' ? 'writes, a person decides' : 'consequential — approval or consent gated per call'}</span>
        </span>
      ),
    },
    { label: 'Client-facing', value: tool.clientFacing ? 'Yes — it can put something in front of a client' : 'No' },
    {
      label: 'Bound by definition',
      value:
        tool.boundAgents.length > 0 ? (
          <span className="flex flex-wrap gap-2">
            {tool.boundAgents.map((a) => (
              <Link key={a.key} href={`/agents/${encodeURIComponent(a.key)}`} className="underline-offset-2 hover:underline">
                {a.displayName}
              </Link>
            ))}
          </span>
        ) : (
          'No agent definition binds this tool'
        ),
    },
  ];

  const columns: Column<ToolCallRow>[] = [
    { key: 'agent', header: 'Agent', primary: true, cell: (r) => r.agentKey ?? '—' },
    { key: 'run', header: 'Run', desktopOnly: true, cellClassName: 'font-mono text-xs text-muted', cell: (r) => `${r.runId.slice(0, 8)} · step ${r.seq}` },
    { key: 'outcome', header: 'Outcome', cell: (r) => (r.error ? <Badge tone="danger">failed</Badge> : <Badge tone="success">ok</Badge>) },
    { key: 'error', header: 'Error', desktopOnly: true, cellClassName: 'text-muted', cell: (r) => r.error ?? '—' },
    { key: 'runStatus', header: 'Run status', desktopOnly: true, cell: (r) => (r.runStatus ? <StatusBadge status={r.runStatus} /> : '—') },
    { key: 'latency', header: 'Latency', align: 'right', cellClassName: 'tabular text-muted', cell: (r) => formatDurationMs(r.latencyMs) ?? '—' },
    { key: 'when', header: 'When', align: 'right', cellClassName: 'text-muted', cell: (r) => clock.dateTime(r.createdAt) },
  ];

  return (
    <div className="flex flex-col gap-5">
      <TrailLabel name={tool.name} />
      <PageHeader
        eyebrow="Tools"
        title={tool.name}
        description={tool.purpose}
        meta={<Badge tone={tool.actionClass === 'L0' ? 'success' : 'warning'}>{tool.actionClass}</Badge>}
        actions={<ViewAll href="/agents" label="AI Workforce" />}
      />

      <StatGrid>
        <Stat label={`Calls (${stats.periodDays}d)`} value={N.format(stats.calls)} caption="ai.agent_steps rows of kind tool_call naming this tool" icon={<IconUsage size={16} />} />
        <Stat
          label="Failure rate"
          value={stats.failureRate === null ? '—' : `${Math.round(stats.failureRate * 100)}%`}
          caption={stats.calls > 0 ? `${stats.failed} of ${stats.calls} calls answered an error` : 'Nothing called it in the period'}
          tone={stats.failed > 0 ? 'danger' : 'neutral'}
          icon={<IconAlert size={16} />}
        />
        <Stat label="Avg latency" value={formatDurationMs(stats.averageLatencyMs) ?? '—'} caption="Over calls that recorded one" />
        <Stat label="Bound agents" value={String(tool.boundAgents.length)} caption={`${allowed} allowed · ${denied} denied in this organisation`} icon={<IconAgents size={16} />} />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Definition" description="From the registry in code. An agent's tools come from its definition, never from its input or a model's request." />
          <div className="px-4 pb-4 sm:px-5">
            <DetailFields rows={rows} />
          </div>
        </Card>
        <Card>
          <CardHeader title="Permissions in this organisation" description="What the owner recorded per agent (ai.agent_tool_permissions). A bound agent with no record is refused when it calls." />
          {tool.boundAgents.length === 0 && permissions.length === 0 ? (
            <EmptyState icon={<IconAgents size={22} />} title="No agent is bound to this tool" description="No definition binds it and no permission is recorded for it." action={<Link href="/agents" className={buttonClass('secondary', 'sm')}>Open the registry</Link>} />
          ) : (
            <ul className="divide-y divide-line text-[13px]">
              {[...new Set([...tool.boundAgents.map((a) => a.key), ...permissions.map((p) => p.agentKey)])].map((key) => {
                const record = permissions.find((p) => p.agentKey === key);
                const bound = tool.boundAgents.some((a) => a.key === key);
                return (
                  <li key={key} className="flex flex-wrap items-center gap-2 px-4 py-2 sm:px-5">
                    <Link href={`/agents/${encodeURIComponent(key)}`} className="underline-offset-2 hover:underline">
                      {key}
                    </Link>
                    {bound ? <Badge tone="info">bound by definition</Badge> : null}
                    {!record ? <Badge tone="warning">no record — refused when called</Badge> : record.allowed ? <Badge tone="success">allowed</Badge> : <Badge tone="danger">denied</Badge>}
                    {record?.note ? <span className="text-xs text-muted">— {record.note}</span> : null}
                    {record ? <span className="ml-auto text-xs text-faint">{clock.dateTime(record.updatedAt)}</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title={`Last ${stats.recent.length} calls`} description={`Calls in the last ${stats.periodDays} days, newest first. Each opens the run it belongs to.`} />
        {stats.recent.length === 0 ? (
          <EmptyState
            icon={<IconUsage size={22} />}
            title="No call in the period"
            description={`No ai.agent_steps row of kind tool_call named ${tool.name} in the last ${stats.periodDays} days.`}
            action={<Link href="/usage/runs" className={buttonClass('secondary', 'sm')}>Open agent runs</Link>}
          />
        ) : (
          <DataTable dense rows={stats.recent} columns={columns} getKey={(r) => r.stepId} href={(r) => `/usage/runs/${r.runId}`} />
        )}
      </Card>
    </div>
  );
}
