import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { viewFailedDelivery } from '@/lib/observability/delivery';
import { listDeferredSends, listFailedDeliveries } from '@/lib/observability/queries';
import { listActiveConversations } from '@/modules/crm/queries';
import { listLeadAssignees } from '@/modules/crm/escalation-queries';
import { listWhatsAppTemplates } from '@/modules/crm/template-queries';
import { listInternalRoster } from '@/modules/projects/queries';
import { Badge, Card, CardHeader, EmptyState, IconInbox, PageHeader, Stat, StatGrid, StatusBadge } from '@/ui';

import { HandoffForm } from './handoff-form';

export const metadata: Metadata = { title: 'Communication' };

function when(clock: AgencyClock, value: string): string {
  return clock.dateTime(value);
}

function waitingFor(since: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - new Date(since).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / (60 * 24))}d ${Math.floor((minutes % (60 * 24)) / 60)}h`;
}

/**
 * Communication Center — SCR-057. Ties together what was scattered across
 * three places: conversations (per-lead only, until now), delivery failures
 * and deferred sends (already surfaced on Operations, mirrored here for the
 * "everything communication" view), and the registered templates that
 * decide what can be said outside the 24-hour window. Config stays on
 * Settings → Communication — this is operational visibility plus the one
 * write the centre owes: handing a waiting thread to a person.
 *
 * No "retry" on a failed delivery. The failure is stamped on the message
 * itself (`crm.mark_outbound_delivery`) and carries no job id, so there is
 * no dead job to requeue; re-sending a bounced client message is a consent
 * and content decision made from the lead's own thread, and /operations
 * holds the full history.
 */
export default async function CommunicationCenterPage() {
  const context = await requireInternal('/communication');
  if (!can(context.role, 'lead.read')) redirect('/dashboard');
  const clock = await agencyClock();
  const mayAssign = can(context.role, 'lead.assign');

  const [conversations, failedDeliveries, deferred, templates, roster] = await Promise.all([
    listActiveConversations(),
    listFailedDeliveries(20),
    listDeferredSends(20),
    listWhatsAppTemplates(),
    mayAssign ? listInternalRoster() : Promise.resolve([]),
  ]);
  const assignees = await listLeadAssignees(conversations.map((c) => c.leadId));

  const now = Date.now();
  const waiting = conversations
    .filter((c) => c.agentPausedAt !== null)
    .sort((a, b) => new Date(a.agentPausedAt!).getTime() - new Date(b.agentPausedAt!).getTime());
  const failed = failedDeliveries.map(viewFailedDelivery);
  const approvedTemplates = templates.filter((t) => t.active && t.status === 'approved').length;
  const rosterOptions = roster.map((m) => ({ userId: m.userId, fullName: m.fullName || m.email }));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Communication"
        description={
          conversations.length === 0
            ? 'No active conversations.'
            : `${conversations.length} active conversation${conversations.length === 1 ? '' : 's'}${waiting.length > 0 ? `, ${waiting.length} waiting on a person` : ''}.`
        }
      />

      <StatGrid>
        <Stat label="Active threads" value={conversations.length} />
        <Stat label="Waiting on a person" value={waiting.length} tone={waiting.length > 0 ? 'warning' : 'neutral'} href="#escalations" />
        <Stat label="Failed deliveries" value={failed.length} tone={failed.length > 0 ? 'danger' : 'neutral'} caption="most recent 20" href="/operations" />
        <Stat label="Approved templates" value={approvedTemplates} caption={`of ${templates.length} registered`} href="/settings/communication" />
      </StatGrid>

      {/*
        The escalation queue — threads the agent handed to a person, longest
        waiting first. `agent_paused_at` is when the agent stopped; the
        client has been waiting since then, which is the only number that
        matters in this list.
      */}
      <Card id="escalations">
        <CardHeader
          title="Waiting on a person"
          description="Threads the agent paused for a human, longest wait first. Assigning hands the lead — and so the thread — to somebody."
        />
        {waiting.length > 0 ? (
          <ul className="divide-y divide-line">
            {waiting.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 px-4 py-3 text-sm sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <Link href={`/leads/${c.leadId}`} className="font-medium underline-offset-2 hover:underline">
                        {c.leadTitle}
                      </Link>
                      <Badge tone="warning" dot>
                        waiting {waitingFor(c.agentPausedAt!, now)}
                      </Badge>
                    </span>
                    <span className="text-xs text-muted">{c.agentPausedReason ?? 'No reason recorded.'}</span>
                  </span>
                  <span className="text-xs text-muted">since {when(clock, c.agentPausedAt!)}</span>
                </div>
                {mayAssign ? (
                  <HandoffForm leadId={c.leadId} current={assignees.get(c.leadId) ?? null} roster={rosterOptions} />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<IconInbox size={20} />} title="Nobody is waiting" description="A thread the agent hands to a person appears here until it is resumed." />
        )}
      </Card>

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
                      {c.agentPausedAt ? <Badge tone="warning">waiting on you</Badge> : <Badge tone="success">agent</Badge>}
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
          <CardHeader
            title="Failed deliveries"
            description={
              failedDeliveries.length === 0
                ? undefined
                : 'Most recent 20. No retry here: a bounced client message carries no job to requeue — re-send from the lead’s thread.'
            }
            actions={
              <Link href="/operations" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
                Full history
              </Link>
            }
          />
          {failed.length > 0 ? (
            <ul className="divide-y divide-line">
              {failed.slice(0, 8).map((f, i) => (
                <li key={`${f.occurredAt}-${i}`} className="px-4 py-3 text-[13px] sm:px-5">
                  <span className="block text-danger">{f.reason}</span>
                  <span className="block truncate text-muted">“{f.preview}” · {when(clock, f.occurredAt)}</span>
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

      <Card>
        <CardHeader
          title="Templates"
          description="What can be said outside the 24-hour window, per situation and language. The wording lives at Meta; the registration is on Settings → Communication."
          actions={
            <Link href="/settings/communication" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
              Manage
            </Link>
          }
        />
        {templates.length > 0 ? (
          <ul className="divide-y divide-line">
            {templates.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5 text-[13px] sm:px-5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t.situationKey.replace(/_/g, ' ')}</span>
                  <code className="text-xs text-muted">{t.templateName}</code>
                  <Badge tone="neutral">{t.languageCode}</Badge>
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={t.status} />
                  {!t.active ? <Badge tone="neutral">inactive</Badge> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<IconInbox size={20} />}
            title="No templates registered"
            description="Until an approved template is registered, nothing can be sent outside the 24-hour window."
          />
        )}
      </Card>
    </div>
  );
}
