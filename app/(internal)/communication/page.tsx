import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listActiveConversations } from '@/modules/crm/queries';
import { listDeferredSends, listFailedDeliveries } from '@/lib/observability/queries';
import { Badge, Card, CardHeader, EmptyState, IconInbox, PageHeader } from '@/ui';

export const metadata: Metadata = { title: 'Communication' };

function when(clock: AgencyClock, value: string): string {
  return clock.dateTime(value);
}

/**
 * Communication Center — SCR-057. Ties together what was scattered across
 * three places: conversations (per-lead only, until now), delivery failures
 * and deferred sends (already surfaced on Operations, mirrored here for the
 * "everything communication" view). Config stays on Settings → Communication
 * — this is operational visibility, not configuration.
 */
export default async function CommunicationCenterPage() {
  const context = await requireInternal('/communication');
  if (!can(context.role, 'lead.read')) redirect('/dashboard');
  const clock = await agencyClock();

  const [conversations, failedDeliveries, deferred] = await Promise.all([
    listActiveConversations(),
    listFailedDeliveries(20),
    listDeferredSends(20),
  ]);

  const pausedCount = conversations.filter((c) => c.agentPausedAt).length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Communication"
        description={
          conversations.length === 0
            ? 'No active conversations.'
            : `${conversations.length} active conversation${conversations.length === 1 ? '' : 's'}${pausedCount > 0 ? `, ${pausedCount} waiting on a person` : ''}.`
        }
      />

      <Card>
        <CardHeader title="Conversations" description="Agent-paused first — a thread waiting for a person." />
        {conversations.length > 0 ? (
          <ul className="divide-y divide-line">
            {conversations.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/leads/${c.leadId}`}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm hover:bg-surface-hover sm:px-5"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{c.leadTitle}</span>
                      <Badge tone="neutral">{c.channel}</Badge>
                      {c.agentPausedAt ? <Badge tone="warning">waiting on you</Badge> : null}
                    </span>
                    {c.lastMessagePreview ? (
                      <span className="truncate text-xs text-muted">{c.lastMessagePreview}</span>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted">
                    {c.agentPausedReason ?? (c.lastMessageAt ? when(clock, c.lastMessageAt) : when(clock, c.updatedAt))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<IconInbox size={20} />} title="No active conversations" />
        )}
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Failed deliveries" description={failedDeliveries.length === 0 ? undefined : 'Most recent 20 — full history on Operations'} />
          {failedDeliveries.length > 0 ? (
            <ul className="divide-y divide-line">
              {failedDeliveries.slice(0, 8).map((f, i) => (
                <li key={`${f.occurredAt}-${i}`} className="px-4 py-3 text-[13px] sm:px-5">
                  <span className="block text-muted">{when(clock, f.occurredAt)}</span>
                  <span className="block truncate">{f.body}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<IconInbox size={20} />} title="Nothing failed" />
          )}
        </Card>

        <Card>
          <CardHeader title="Deferred sends" description={deferred.length === 0 ? undefined : 'Waiting for the 24-hour window to reopen'} />
          {deferred.length > 0 ? (
            <ul className="divide-y divide-line">
              {deferred.slice(0, 8).map((d) => (
                <li key={d.id} className="px-4 py-3 text-[13px] sm:px-5">
                  <span className="block text-muted">
                    <code className="tabular">{d.counterpartDigits}</code> · {when(clock, d.deferredAt)}
                  </span>
                  <span className="block">{d.reason}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<IconInbox size={20} />} title="Nothing deferred" />
          )}
        </Card>
      </div>
    </div>
  );
}
