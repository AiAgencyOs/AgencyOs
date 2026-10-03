import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { listRoutingLog } from '@/lib/admin/routing-log';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { Badge, Callout, Card, DataTable, PageHeader, PermissionDenied, type Column } from '@/ui';

export const metadata: Metadata = { title: 'Routing log' };

/**
 * Which model served each call, newest first — and, on a row that is a
 * fallback, the model whose failure led to it. The routing page says what the
 * owner CHOSE; this says what HAPPENED. Read-only, from the run trace.
 */
export default async function RoutingLogPage() {
  const context = await requireInternal('/agents/routing-log');
  if (!can(context, 'audit.read')) return <PermissionDenied />;
  const clock = await agencyClock();
  const rows = await listRoutingLog();

  const fallbacks = rows.filter((r) => r.attempt > 0);
  const failures = rows.filter((r) => r.failed);

  const columns: Column<(typeof rows)[number]>[] = [
    { key: 'at', header: 'When', cellClassName: 'text-muted', cell: (r) => clock.dateTime(r.at) },
    {
      key: 'agent',
      header: 'Agent',
      primary: true,
      cell: (r) => (
        <Link href={`/agents/${r.agentKey}`} className="underline-offset-2 hover:underline">
          {r.agentKey}
        </Link>
      ),
    },
    { key: 'model', header: 'Model', cellClassName: 'font-mono text-xs', cell: (r) => `${r.provider}/${r.model}` },
    {
      key: 'attempt',
      header: 'Route',
      badge: true,
      cell: (r) =>
        r.attempt === 0 ? (
          <Badge tone="neutral">first choice</Badge>
        ) : (
          <Badge tone="warning">{`fallback ${r.attempt} · after ${r.fallbackOf ?? '?'}`}</Badge>
        ),
    },
    { key: 'latency', header: 'Latency', cellClassName: 'tabular', desktopOnly: true, cell: (r) => (r.latencyMs === null ? '—' : `${r.latencyMs} ms`) },
    {
      key: 'result',
      header: 'Result',
      badge: true,
      cell: (r) => (r.failed ? <Badge tone="danger">failed</Badge> : <Badge tone="success">ok</Badge>),
    },
    { key: 'error', header: 'Why', cellClassName: 'text-xs text-muted', desktopOnly: true, cell: (r) => r.error ?? '' },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Routing log"
        description={`${rows.length} most recent model call${rows.length === 1 ? '' : 's'} · ${fallbacks.length} served by a fallback · ${failures.length} failed.`}
        actions={
          <Link href="/agents/routing" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
            Model routing &amp; providers
          </Link>
        }
      />
      <Callout tone="info" title="What a fallback is">
        A call moves to the next model only when the first could not serve it at all (rate limit, server error, timeout,
        a rejected key, a missing model). A refusal or a malformed request is never retried elsewhere. Money-bearing work
        (quotations, finance) stays with the same vendor.
      </Callout>
      <Card>
        <DataTable ariaLabel="Model calls" rows={rows} columns={columns} getKey={(r) => r.id} />
      </Card>
    </div>
  );
}
