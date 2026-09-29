import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { LiveRefresh } from '@/lib/realtime';
import { listDeferredSends, listFailedDeliveries } from '@/lib/observability/queries';
import { readRetryHistory } from '@/lib/observability/retry-queries';
import { RetryDeliveryForm } from '../operations/retry-delivery-form';
import { listAnnouncements } from '@/modules/crm/announcements-queries';
import { listLeadAssignees } from '@/modules/crm/escalation-queries';
import { listActiveConversations } from '@/modules/crm/queries';
import { listWhatsAppTemplates } from '@/modules/crm/template-queries';
import { listInternalRoster } from '@/modules/projects/queries';

import { HandoffForm } from './handoff-form';
import {
  buttonClass,
  Avatar,
  Badge,
  Card,
  CardHeader,
  cx,
  EmptyState,
  humanize,
  IconAlert,
  IconClock,
  IconInbox,
  IconMessage,
  IconSettings,
  IconUser,
  PageHeader,
  PermissionDenied,
  QuickActions,
  Stat,
  StatGrid,
  StatusBadge,
  ViewAll,
} from '@/ui';

export const metadata: Metadata = { title: 'Communication' };

function waitingFor(since: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - new Date(since).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / (60 * 24))}d ${Math.floor((minutes % (60 * 24)) / 60)}h`;
}

/**
 * Communication Center — SCR-057, laid out as the reference's inbox: figures,
 * the conversation list with the last message and a "waiting on you" mark,
 * and a rail of delivery failures, deferred sends and quick actions. Ties
 * together what was scattered across three places: conversations (per-lead
 * only, until now), delivery failures and deferred sends (already surfaced
 * on Operations, mirrored here for the "everything communication" view).
 * Config stays on Settings → Communication — this is operational
 * visibility, not configuration. Opening a thread goes to the lead, where
 * the chat and its composer live.
 */
export default async function CommunicationCenterPage() {
  const context = await requireInternal('/communication');
  if (!can(context.role, 'lead.read')) return <PermissionDenied />;
  const clock = await agencyClock();

  const mayAssign = can(context.role, 'lead.assign');
  const [conversations, failedDeliveries, deferred, templates, roster, announcements] = await Promise.all([
    listActiveConversations(),
    listFailedDeliveries(20),
    listDeferredSends(20),
    listWhatsAppTemplates(),
    mayAssign ? listInternalRoster() : Promise.resolve([]),
    listAnnouncements({ status: 'published', limit: 8 }),
  ]);
  const assignees = await listLeadAssignees(conversations.map((c) => c.leadId));
  const rosterOptions = roster.map((m) => ({ userId: m.userId, fullName: m.fullName || m.email }));
  const now = Date.now();

  const paused = conversations.filter((c) => c.agentPausedAt);
  // SCR-057/060: a failed delivery can be retried here — a new send through
  // the same door, so the window and consent decide again — and each row
  // says how its retries went.
  const retryHistory = await readRetryHistory(failedDeliveries.map((f) => f.id).filter((id): id is string => Boolean(id)));
  const mayRetry = can(context.role, 'lead.write');
  // SCR-057: the escalation queue — longest wait first.
  const waiting = [...paused].sort((a, b) => new Date(a.agentPausedAt!).getTime() - new Date(b.agentPausedAt!).getTime());
  const approvedTemplates = templates.filter((t) => t.active && t.status === 'approved').length;
  const channels = new Map<string, number>();
  for (const c of conversations) channels.set(c.channel, (channels.get(c.channel) ?? 0) + 1);
  const sorted = [...paused, ...conversations.filter((c) => !c.agentPausedAt)];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Communication"
        description="Every open client conversation, what is waiting on a person, and what did not get through."
        actions={
          <>
            <LiveRefresh topics={['conversations', 'jobs']} />
            {can(context.role, 'organization.settings') ? (
              <Link href="/settings/communication" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium shadow-xs hover:bg-surface-hover">
                <IconSettings size={14} />
                Channels
              </Link>
            ) : null}
          </>
        }
      />

      <StatGrid cols={5}>
        <Stat label="Active conversations" value={String(conversations.length)} caption="Open client threads" tone="brand" icon={<IconMessage size={16} />} />
        <Stat label="Waiting on a person" value={String(paused.length)} caption="Agent paused" tone={paused.length > 0 ? 'warning' : 'success'} icon={<IconUser size={16} />} />
        <Stat label="Channels" value={String(channels.size)} caption={[...channels.entries()].map(([k, n]) => `${humanize(k)} ${n}`).join(' · ') || 'None yet'} tone="info" icon={<IconInbox size={16} />} />
        <Stat label="Failed deliveries" value={String(failedDeliveries.length)} caption="Most recent 20" tone={failedDeliveries.length > 0 ? 'danger' : 'success'} icon={<IconAlert size={16} />} href="/operations" />
        <Stat label="Deferred sends" value={String(deferred.length)} caption="Waiting for the 24-hour window" tone={deferred.length > 0 ? 'warning' : 'neutral'} icon={<IconClock size={16} />} href="/operations" />
      </StatGrid>

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
                      <Link href={`/leads/${c.leadId}`} className="font-medium underline-offset-2 hover:underline">{c.leadTitle}</Link>
                      <Badge tone="warning" dot>waiting {waitingFor(c.agentPausedAt!, now)}</Badge>
                    </span>
                    <span className="text-xs text-muted">{c.agentPausedReason ?? 'No reason recorded.'}</span>
                  </span>
                  <span className="text-xs text-muted">since {clock.dateTime(c.agentPausedAt!)}</span>
                </div>
                {mayAssign ? <HandoffForm leadId={c.leadId} current={assignees.get(c.leadId) ?? null} roster={rosterOptions} /> : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<IconInbox size={20} />} title="Nobody is waiting" description="A thread the agent hands to a person appears here until it is resumed." action={<Link href="/leads" className={buttonClass('secondary', 'sm')}>Open leads</Link>} />
        )}
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(19rem,1fr)]">
        <Card>
          <CardHeader title="Conversations" description="Threads waiting for a person come first." actions={<ViewAll href="/leads" label="All leads" />} />
          {sorted.length > 0 ? (
            <ul className="divide-y divide-line">
              {sorted.map((c) => (
                <li key={c.id}>
                  <Link href={`/leads/${c.leadId}`} className={cx('flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-hover sm:px-5', c.agentPausedAt && 'bg-warning-soft/40')}>
                    <Avatar name={c.leadTitle} size="lg" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-medium text-foreground">{c.leadTitle}</span>
                        <span className="shrink-0 text-[11px] text-faint">{clock.dateTime(c.lastMessageAt ?? c.updatedAt)}</span>
                      </span>
                      <span className="block truncate text-[13px] text-muted">{c.lastMessagePreview ?? 'No message yet'}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge tone="neutral">{humanize(c.channel)}</Badge>
                        {c.agentPausedAt ? <Badge tone="warning" dot>Waiting on you{c.agentPausedReason ? ` · ${c.agentPausedReason}` : ''}</Badge> : null}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<IconInbox size={20} />} title="No active conversations" description="A lead's WhatsApp thread appears here while it is open." action={<Link href="/leads" className={buttonClass('secondary', 'sm')}>Open leads</Link>} />
          )}
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Failed deliveries" description={failedDeliveries.length === 0 ? 'Nothing failed.' : 'Most recent — full history on Operations.'} actions={<ViewAll href="/operations" />} />
            {failedDeliveries.length > 0 ? (
              <ul className="divide-y divide-line">
                {failedDeliveries.slice(0, 6).map((f, i) => (
                  <li key={`${f.occurredAt}-${i}`} className="flex items-start gap-3 px-4 py-2.5 sm:px-5">
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger"><IconAlert size={13} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-foreground">{f.body}</span>
                      <span className="block text-[11px] text-faint">
                        {clock.dateTime(f.occurredAt)}
                        {' · '}
                        {(f.retryCount ?? 0) === 0
                          ? 'not retried'
                          : `retried ${f.retryCount} time${f.retryCount === 1 ? '' : 's'}${(() => {
                              const last = f.id ? retryHistory.get(f.id)?.last : undefined;
                              return last ? `, last ${last.delivery ?? 'unrecorded'}${last.error ? ` — ${last.error}` : ''}` : '';
                            })()}`}
                      </span>
                      {mayRetry && f.id ? <span className="mt-1 block"><RetryDeliveryForm messageId={f.id} /></span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>

          <Card>
            <CardHeader title="Deferred sends" description={deferred.length === 0 ? 'Nothing deferred.' : 'Waiting for the 24-hour window to reopen.'} />
            {deferred.length > 0 ? (
              <ul className="divide-y divide-line">
                {deferred.slice(0, 6).map((d) => (
                  <li key={d.id} className="flex items-start gap-3 px-4 py-2.5 sm:px-5">
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-warning-soft text-warning"><IconClock size={13} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-foreground">{d.reason}</span>
                      <span className="block text-[11px] text-faint"><code className="tabular">{d.counterpartDigits}</code> · {clock.dateTime(d.deferredAt)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>

          <Card>
            <CardHeader
              title="Templates"
              description={`${approvedTemplates} approved of ${templates.length} registered — what can be said outside the 24-hour window.`}
              actions={can(context.role, 'organization.settings') ? <ViewAll href="/settings/communication" label="Manage" /> : null}
            />
            {templates.length > 0 ? (
              <ul className="divide-y divide-line">
                {templates.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 text-[13px] sm:px-5">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{humanize(t.situationKey)}</span>
                      <code className="truncate text-[11px] text-muted">{t.templateName} · {t.languageCode}</code>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <StatusBadge status={t.status} dot={false} />
                      {!t.active ? <Badge tone="neutral">inactive</Badge> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No template registered — nothing can be sent outside the window.</p>
            )}
          </Card>

          {/* SCR-057 — announcements, read-only here: recorded on Settings ›
              Communication, never sent (WhatsApp broadcast is declined,
              traceability row 59). */}
          <Card>
            <CardHeader
              title="Announcements"
              description={announcements.length === 0 ? 'Nothing published.' : 'Published — a record, not a send.'}
              actions={can(context.role, 'organization.settings') ? <ViewAll href="/settings/communication" label="Manage" /> : null}
            />
            {announcements.length > 0 ? (
              <ul className="divide-y divide-line">
                {announcements.map((a) => (
                  <li key={a.id} className="flex flex-col gap-0.5 px-4 py-2.5 text-[13px] sm:px-5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{a.title}</span>
                      <Badge tone={a.audience === 'clients' ? 'info' : 'neutral'}>{a.audience === 'clients' ? 'For clients' : 'Internal'}</Badge>
                    </span>
                    <span className="line-clamp-2 text-muted">{a.body}</span>
                    <span className="text-[11px] text-faint">{a.publishedAt ? clock.dateTime(a.publishedAt) : ''}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>

          <QuickActions
            actions={[
              { label: 'Leads', icon: <IconUser size={13} />, href: '/leads' },
              { label: 'Follow-ups', icon: <IconClock size={13} />, href: '/follow-ups' },
              { label: 'Operations', icon: <IconAlert size={13} />, href: '/operations' },
              ...(can(context.role, 'organization.settings') ? [{ label: 'Templates & channels', icon: <IconSettings size={13} />, href: '/settings/communication' }] : []),
            ]}
          />
        </div>
      </div>
    </div>
  );
}
