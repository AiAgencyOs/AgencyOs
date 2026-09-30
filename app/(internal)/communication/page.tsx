import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { LiveRefresh } from '@/lib/realtime';
import { listDeferredSends, listFailedDeliveries } from '@/lib/observability/queries';
import { readRetryHistory } from '@/lib/observability/retry-queries';
import { RetryDeliveryForm } from '../operations/retry-delivery-form';
import { EscalateControl } from '../notifications/escalate-form';
import { AnnouncementsPanel } from '../settings/communication/announcements-panel';
import { readEscalationsByKey } from '@/lib/admin/escalations';
import { listAnnouncements } from '@/modules/crm/announcements-queries';
import { listUnansweredConversations } from '@/modules/crm/unread-queries';
import { listLeadAssignees } from '@/modules/crm/escalation-queries';
import { listActiveConversations } from '@/modules/crm/queries';
import { listWhatsAppTemplates } from '@/modules/crm/template-queries';
import { listInternalRoster } from '@/modules/projects/queries';

import { HandoffForm } from './handoff-form';
import {
  buttonClass,
  IconSearch,
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
export default async function CommunicationCenterPage({ searchParams }: { searchParams: Promise<{ unread?: string; waiting?: string; q?: string }> }) {
  const { unread: unreadParam, waiting: waitingParam, q } = await searchParams;
  const waitingOnly = waitingParam === '1';
  // SCR-057 (bucket F): the Unread tile opens this list filtered to exactly its count.
  const unreadOnly = unreadParam === '1';
  const context = await requireInternal('/communication');
  if (!can(context, 'lead.read')) return <PermissionDenied />;
  const clock = await agencyClock();

  const mayAssign = can(context, 'lead.assign');
  const canManage = can(context, 'organization.settings');
  const [conversations, failedDeliveries, deferred, templates, roster, announcements, unanswered, draftAnnouncements] = await Promise.all([
    listActiveConversations(),
    listFailedDeliveries(20),
    listDeferredSends(20),
    listWhatsAppTemplates(),
    mayAssign ? listInternalRoster() : Promise.resolve([]),
    listAnnouncements({ status: 'published', limit: 8 }),
    // SCR-057 (bucket F): the honest "unread" — threads whose newest message is the client's.
    listUnansweredConversations(),
    // SCR-057/059 (bucket F): drafts, including the scheduled ones, for the create/schedule panel and the due tile.
    listAnnouncements({ status: 'draft', limit: 50 }),
  ]);
  // SCR-060 (bucket F): retries are a count — total attempts across the failed deliveries shown.
  const retryTotal = failedDeliveries.reduce((n, f) => n + (f.retryCount ?? 0), 0);
  // SCR-060 (bucket F): F-A's escalations, keyed by the message id for the failed deliveries shown.
  const escalationsByKey = await readEscalationsByKey();
  const canAnswerEscalation = can(context, 'audit.read');
  const dueAnnouncements = draftAnnouncements.filter((a) => a.scheduledFor !== null);
  const assignees = await listLeadAssignees(conversations.map((c) => c.leadId));
  const rosterOptions = roster.map((m) => ({ userId: m.userId, fullName: m.fullName || m.email }));
  const now = Date.now();

  const paused = conversations.filter((c) => c.agentPausedAt);
  // SCR-057/060: a failed delivery can be retried here — a new send through
  // the same door, so the window and consent decide again — and each row
  // says how its retries went.
  const retryHistory = await readRetryHistory(failedDeliveries.map((f) => f.id).filter((id): id is string => Boolean(id)));
  const mayRetry = can(context, 'lead.write');
  // SCR-057: the escalation queue — longest wait first.
  const waiting = [...paused].sort((a, b) => new Date(a.agentPausedAt!).getTime() - new Date(b.agentPausedAt!).getTime());
  const approvedTemplates = templates.filter((t) => t.active && t.status === 'approved').length;
  const channels = new Map<string, number>();
  for (const c of conversations) channels.set(c.channel, (channels.get(c.channel) ?? 0) + 1);
  const unansweredIds = new Set(unanswered.map((u) => u.conversationId));
  const sorted = [...paused, ...conversations.filter((c) => !c.agentPausedAt)].filter((c) => !unreadOnly || unansweredIds.has(c.id))
    .filter((c) => !waitingOnly || Boolean(c.agentPausedAt))
    .filter((c) => !q?.trim() || `${c.leadTitle} ${c.lastMessagePreview ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Communication"
        description="Every open client conversation, what is waiting on a person, and what did not get through."
        actions={
          <>
            <LiveRefresh topics={['conversations', 'jobs']} />
            {can(context, 'organization.settings') ? (
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
        {/* SCR-057 (bucket F): unread, honestly — no per-person receipt exists, so this counts threads whose newest message is the client's. */}
        <Stat label="Unread" value={String(unanswered.length)} caption="Threads the client wrote to last" tone={unanswered.length > 0 ? 'warning' : 'success'} icon={<IconInbox size={16} />} href="/communication?unread=1#conversations" />
        <Stat label="Waiting on a person" value={String(paused.length)} caption="Agent paused" tone={paused.length > 0 ? 'warning' : 'success'} icon={<IconUser size={16} />} href="#escalations" />
        <Stat label="Failed deliveries" value={String(failedDeliveries.length)} caption={retryTotal > 0 ? `${retryTotal} retr${retryTotal === 1 ? 'y' : 'ies'} so far` : 'Most recent 20'} tone={failedDeliveries.length > 0 ? 'danger' : 'success'} icon={<IconAlert size={16} />} href="/operations" />
        {/* SCR-057 (bucket F): announcements due — drafts with a scheduled moment. */}
        <Stat label="Announcements due" value={String(dueAnnouncements.length)} caption={dueAnnouncements[0]?.scheduledFor ? `Next ${clock.dateTime(dueAnnouncements[0].scheduledFor)}` : 'None scheduled'} tone={dueAnnouncements.length > 0 ? 'info' : 'neutral'} icon={<IconSettings size={16} />} href="#announcements" />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(20rem,1fr)]">
        <Card id="conversations">
          <CardHeader title="Conversations" actions={unreadOnly ? <ViewAll href="/communication" label="All conversations" /> : <ViewAll href="/leads" label="All leads" />} />
          <div className="flex flex-col gap-3 px-4 pb-3 sm:px-5">
            <form action="/communication" method="GET" className="relative">
              {unreadOnly ? <input type="hidden" name="unread" value="1" /> : null}
              {waitingOnly ? <input type="hidden" name="waiting" value="1" /> : null}
              <label>
                <span className="sr-only">Search conversations</span>
                <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"><IconSearch size={15} /></span>
                <input type="search" name="q" defaultValue={q ?? ''} placeholder="Search conversations..." className="h-10 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-[13px] text-foreground placeholder:text-faint" />
              </label>
            </form>
            <nav aria-label="Conversation filter" className="flex flex-wrap gap-2 text-[13px] font-medium">
              {[
                { label: 'All', href: '/communication#conversations', on: !unreadOnly && !waitingOnly, n: conversations.length },
                { label: 'Unread', href: '/communication?unread=1#conversations', on: unreadOnly, n: unanswered.length },
                { label: 'Waiting on you', href: '/communication?waiting=1#conversations', on: waitingOnly, n: paused.length },
              ].map((f) => (
                <Link key={f.label} href={f.href} aria-current={f.on ? 'true' : undefined} className={cx('inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5', f.on ? 'border-brand/40 bg-brand-soft text-brand' : 'border-line bg-surface text-muted hover:bg-surface-hover')}>
                  {f.label}
                  <span className="rounded-full bg-surface-sunken px-1.5 text-[11px] tabular text-muted">{f.n}</span>
                </Link>
              ))}
            </nav>
          </div>
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
                        {unansweredIds.has(c.id) ? <Badge tone="info">Unread</Badge> : null}
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
            <CardHeader title="Conversations by Channel" />
            {channels.size === 0 ? (
              <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No open conversation on any channel.</p>
            ) : (
              <ul className="divide-y divide-line">
                {[...channels.entries()].map(([channel, n]) => {
                  const last = conversations.filter((c) => c.channel === channel).map((c) => c.lastMessageAt).filter((v): v is string => Boolean(v)).sort().pop();
                  return (
                    <li key={channel} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand"><IconMessage size={16} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium text-foreground">{n} {humanize(channel)} conversation{n === 1 ? '' : 's'}</span>
                        <span className="block text-xs text-muted">{last ? `Last message: ${clock.dateTime(last)}` : 'No message yet'}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

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
                      {mayRetry && f.id ? (
                        <span className="mt-1 flex flex-wrap items-center gap-2">
                          <RetryDeliveryForm messageId={f.id} />
                          <EscalateControl
                            subjectType="delivery"
                            subjectKey={f.id}
                            title={`Failed delivery: ${f.body.slice(0, 80)}`}
                            canAnswer={canAnswerEscalation}
                            compact
                            escalation={(() => {
                              const e = escalationsByKey.get(f.id as string);
                              return e ? { id: e.id, toRole: e.toRole, reason: e.reason, state: e.state, fromUserName: e.fromUserName, acknowledgedByName: e.acknowledgedByName, createdAtLabel: clock.dateTime(e.createdAt) } : null;
                            })()}
                          />
                        </span>
                      ) : null}
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
              actions={can(context, 'organization.settings') ? <ViewAll href="/settings/communication" label="Manage" /> : null}
            />
            {templates.length > 0 ? (
              <ul className="divide-y divide-line">
                {templates.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 text-[13px] sm:px-5">
                    <span className="flex min-w-0 flex-col">
                      {/* SCR-059 (bucket F): each row opens the template's detail page. */}
                      <Link href={`/communication/templates/${t.id}`} className="truncate font-medium hover:underline">{humanize(t.situationKey)}</Link>
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

          {/* SCR-057/059 (bucket F): create and schedule announcements HERE,
              through the same panel and doors Settings › Communication uses.
              Published records show below; nothing is sent. */}
          <Card id="announcements">
            <CardHeader
              title="Create announcement"
              description={dueAnnouncements.length > 0 ? `${dueAnnouncements.length} scheduled — the tick publishes each at its moment.` : 'Drafts and scheduled announcements. A record, not a send.'}
              actions={canManage ? <ViewAll href="/settings/communication" label="Settings" /> : null}
            />
            <div className="px-4 pb-4 sm:px-5">
              <AnnouncementsPanel
                canWrite={canManage}
                announcements={draftAnnouncements.map((a) => ({
                  id: a.id,
                  title: a.title,
                  body: a.body,
                  audience: a.audience,
                  status: a.status,
                  when: a.scheduledFor ? `scheduled ${clock.dateTime(a.scheduledFor)}` : `drafted ${clock.dateTime(a.createdAt)}`,
                  scheduledFor: a.scheduledFor,
                }))}
              />
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Announcements"
              description={announcements.length === 0 ? 'Nothing published.' : 'Published — a record, not a send.'}
              actions={can(context, 'organization.settings') ? <ViewAll href="/settings/communication" label="Manage" /> : null}
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
            title="Quick Actions"
            actions={[
              { label: 'Leads', icon: <IconUser size={13} />, href: '/leads' },
              { label: 'Follow-ups', icon: <IconClock size={13} />, href: '/follow-ups' },
              { label: 'Operations', icon: <IconAlert size={13} />, href: '/operations' },
              ...(can(context, 'organization.settings') ? [{ label: 'Templates & channels', icon: <IconSettings size={13} />, href: '/settings/communication' }] : []),
            ]}
          />
        </div>
      </div>

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
    </div>
  );
}
