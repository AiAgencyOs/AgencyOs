import type { Metadata } from 'next';
import Link from 'next/link';

import { formatDurationMs } from '@/lib/admin/agent-runs-eval';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listToolDefinitions } from '@/modules/agents/permissions-schema';
import { listToolPermissionsForTool, readToolCallStats, TOOL_PERIOD_DAYS } from '@/modules/agents/tool-detail-queries';
import { Badge, Card, CardHeader, DataTable, IconAgents, IconAlert, IconSettings, IconUsage, PageHeader, PermissionDenied, Stat, StatGrid, ViewAll, type Column } from '@/ui';

export const metadata: Metadata = { title: 'Tools & Integrations' };

const N = new Intl.NumberFormat('en-IN');

/**
 * SCR-061 "Tools & Integrations" — every tool an agent can be bound to, with
 * what this organisation allowed or denied it for, how often it was called
 * and how often the call failed in the period. One row per tool of the
 * registry in code; each opens its detail. The integrations the tools reach
 * (the provider, WhatsApp, GitHub...) live on /integrations, linked here.
 * Read-only, gated on `audit.read` like the dashboard that links here.
 */
export default async function ToolsIndexPage() {
  const context = await requireInternal('/agents/tools');
  if (!can(context, 'audit.read')) return <PermissionDenied />;

  const tools = listToolDefinitions();
  const details = await Promise.all(
    tools.map(async (t) => {
      const [stats, permissions] = await Promise.all([readToolCallStats(t.name, 1), listToolPermissionsForTool(t.name)]);
      return { tool: t, stats, allowed: permissions.filter((p) => p.allowed).length, denied: permissions.filter((p) => !p.allowed).length };
    }),
  );
  const totalCalls = details.reduce((n, d) => n + d.stats.calls, 0);
  const totalFailed = details.reduce((n, d) => n + d.stats.failed, 0);
  const clientFacing = details.filter((d) => d.tool.clientFacing).length;

  type Row = (typeof details)[number];
  const columns: Column<Row>[] = [
    { key: 'tool', header: 'Tool', primary: true, cell: (d) => <code className="text-xs">{d.tool.name}</code> },
    { key: 'class', header: 'Action class', badge: true, cell: (d) => <Badge tone={d.tool.actionClass === 'L0' ? 'success' : d.tool.actionClass === 'L1' ? 'info' : 'warning'}>{d.tool.actionClass}</Badge> },
    { key: 'purpose', header: 'What it does', desktopOnly: true, cellClassName: 'max-w-[26rem] truncate text-muted', cell: (d) => d.tool.purpose },
    { key: 'bound', header: 'Bound agents', align: 'right', cellClassName: 'tabular', cell: (d) => d.tool.boundAgents.length },
    { key: 'perm', header: 'Allowed / denied', align: 'right', desktopOnly: true, cellClassName: 'tabular text-muted', cell: (d) => `${d.allowed} / ${d.denied}` },
    { key: 'calls', header: `Calls (${TOOL_PERIOD_DAYS}d)`, align: 'right', cellClassName: 'tabular', cell: (d) => N.format(d.stats.calls) },
    { key: 'fail', header: 'Failure rate', align: 'right', desktopOnly: true, cellClassName: 'tabular text-muted', cell: (d) => (d.stats.failureRate === null ? '—' : `${Math.round(d.stats.failureRate * 100)}%`) },
    { key: 'latency', header: 'Avg latency', align: 'right', desktopOnly: true, cellClassName: 'tabular text-muted', cell: (d) => formatDurationMs(d.stats.averageLatencyMs) ?? '—' },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="AI Workforce"
        title="Tools & Integrations"
        description="Every tool an agent can be bound to, from the registry in code, with what this organisation allowed, how often it was called and how often it failed."
        actions={<ViewAll href="/agents" label="AI Workforce" />}
      />

      <StatGrid>
        <Stat label="Tools" value={String(tools.length)} caption={`${clientFacing} can put something in front of a client`} icon={<IconSettings size={16} />} />
        <Stat label={`Calls (${TOOL_PERIOD_DAYS}d)`} value={N.format(totalCalls)} caption="Tool-call steps in the run ledger" icon={<IconUsage size={16} />} href="/usage/runs" />
        <Stat label="Failed calls" value={N.format(totalFailed)} caption="Calls that answered an error" tone={totalFailed > 0 ? 'danger' : 'neutral'} icon={<IconAlert size={16} />} />
        <Stat label="Integrations" value="Open" caption="Provider, WhatsApp, GitHub and the rest" icon={<IconAgents size={16} />} href="/integrations" />
      </StatGrid>

      <Card>
        <CardHeader title="Tool Registry" description="Open a tool for its calls, failures and per-agent permissions." />
        <div className="px-4 pb-4 sm:px-5">
          <DataTable dense rows={details} columns={columns} getKey={(d) => d.tool.name} href={(d) => `/agents/tools/${encodeURIComponent(d.tool.name)}`} />
        </div>
      </Card>

      <p className="text-xs leading-relaxed text-muted">
        A tool&apos;s permission per agent is set on the agent&apos;s own page. The systems the tools reach are verified on{' '}
        <Link href="/integrations" className="font-medium text-brand underline-offset-2 hover:underline">Integrations</Link>.
      </p>
    </div>
  );
}
