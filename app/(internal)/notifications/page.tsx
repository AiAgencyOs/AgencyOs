import type { Metadata } from 'next';

import { agencyClock } from '@/lib/admin/agency-clock';
import { listNotificationHistory } from '@/lib/admin/notification-state';
import { requireInternal } from '@/lib/auth/session';
import { LiveRefresh } from '@/lib/realtime';
import { listInternalRoster } from '@/modules/projects/queries';
import { Card, CardHeader, EmptyState, FilterBar, FilterChips, humanize, IconCheck, PageHeader } from '@/ui';

import { ACTION_CATEGORY_LABEL, categoryOf } from './action-items';
import { listAnnotatedActionItems } from './annotated-items';
import { NotificationList } from './notification-list';

export const metadata: Metadata = { title: 'Notifications' };

/**
 * Notifications & Action Center — SCR-003. Every source here already has
 * its own screen and its own real data; this is the aggregation nothing
 * tied together before — an owner had to open six pages to answer "what
 * needs me right now". Every row traces to the real record on the page it
 * links to, and resolving it there is what removes it from this list.
 *
 * The rows are still DERIVED live; `core.notification_states` only
 * annotates them (read, snoozed until, resolved with a note, assigned).
 * An annotated row keeps existing while its source is pending — it stops
 * counting against this person, and a snooze that has ended counts again.
 * The header bell's number is the number of rows shown here as needing
 * attention. The list is live: the same tables that feed it push a refresh
 * when they change (`LiveRefresh`).
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; severity?: string; show?: string }>;
}) {
  const context = await requireInternal('/notifications');
  const clock = await agencyClock();
  const { category, severity, show } = await searchParams;
  const [all, history, roster] = await Promise.all([listAnnotatedActionItems(context, clock), listNotificationHistory(30), listInternalRoster()]);

  const attention = all.filter((r) => r.attention);
  const parked = all.filter((r) => !r.attention);
  const pool = show === 'parked' ? parked : show === 'all' ? all : attention;
  const urgentCount = attention.filter((r) => r.urgent).length;
  const categories = [...new Set(pool.map(categoryOf))];
  const rows = pool.filter((r) => (!category || categoryOf(r) === category) && (!severity || (severity === 'urgent' ? r.urgent : !r.urgent)));
  const link = (over: Partial<{ category: string; severity: string; show: string }>) => {
    const next = { category: category ?? '', severity: severity ?? '', show: show ?? '', ...over };
    const q = Object.entries(next)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    return `/notifications${q ? `?${q}` : ''}`;
  };
  const rosterOptions = roster.filter((m) => m.userId !== context.userId).map((m) => ({ userId: m.userId, fullName: m.fullName || m.email }));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Notifications"
        description={
          attention.length === 0
            ? parked.length > 0
              ? `Nothing needs your attention right now — ${parked.length} read, snoozed or resolved.`
              : 'Nothing needs your attention right now.'
            : `${attention.length} item${attention.length === 1 ? '' : 's'} need attention${urgentCount > 0 ? `, ${urgentCount} urgent` : ''}${parked.length > 0 ? ` · ${parked.length} parked` : ''}.`
        }
        actions={<LiveRefresh topics={['approvals', 'finance', 'jobs', 'qa', 'tasks', 'conversations']} />}
      />

      {all.length > 0 ? (
        <FilterBar>
          <FilterChips
            options={[
              { key: 'attention', label: `Needs attention (${attention.length})`, href: link({ show: '', category: '' }), active: !show },
              { key: 'parked', label: `Read, snoozed & resolved (${parked.length})`, href: link({ show: 'parked', category: '' }), active: show === 'parked' },
              { key: 'all', label: `Everything (${all.length})`, href: link({ show: 'all', category: '' }), active: show === 'all' },
            ]}
          />
          <FilterChips
            options={[
              { key: 'all', label: `All (${pool.length})`, href: link({ category: '' }), active: !category },
              ...categories.map((c) => ({ key: c, label: `${ACTION_CATEGORY_LABEL[c] ?? c} (${pool.filter((r) => categoryOf(r) === c).length})`, href: link({ category: c }), active: category === c })),
            ]}
          />
          <FilterChips
            options={[
              { key: 'any', label: 'Any severity', href: link({ severity: '' }), active: !severity },
              { key: 'urgent', label: `Urgent (${pool.filter((r) => r.urgent).length})`, href: link({ severity: 'urgent' }), active: severity === 'urgent' },
              { key: 'normal', label: `Normal (${pool.filter((r) => !r.urgent).length})`, href: link({ severity: 'normal' }), active: severity === 'normal' },
            ]}
          />
        </FilterBar>
      ) : null}

      {rows.length > 0 ? (
        <Card>
          <NotificationList
            roster={rosterOptions}
            rows={rows.map((r) => ({
              key: r.key,
              title: r.title,
              detail: r.detail,
              href: r.href,
              urgent: r.urgent,
              attention: r.attention,
              state: r.state
                ? {
                    state: r.state.state,
                    snoozedUntil: r.state.snoozedUntil,
                    assignedToName: r.state.assignedToName,
                    note: r.state.note,
                    assignedToMe: r.state.assignedToMe,
                    byName: r.state.byName,
                  }
                : null,
              snoozedUntilLabel: r.state?.snoozedUntil ? clock.dateTime(r.state.snoozedUntil) : null,
            }))}
          />
        </Card>
      ) : (
        <EmptyState
          icon={<IconCheck size={22} />}
          title={all.length > 0 ? 'Nothing in this filter' : 'All clear'}
          description={all.length > 0 ? 'Widen the filters to see the rest.' : 'No pending approvals, failed deliveries, overdue tasks or open blockers.'}
        />
      )}

      <Card>
        <CardHeader
          title="History"
          description="What you marked read, snoozed, resolved or assigned — and what others assigned to you — newest first. Resolutions and assignments are also in the audit log."
        />
        {history.length > 0 ? (
          <ul className="divide-y divide-line">
            {history.map((e) => {
              const title = all.find((r) => r.key === e.itemKey)?.title ?? e.itemKey;
              const verb =
                e.event === 'assigned'
                  ? `assigned to ${e.assignedToName ?? 'a member'}`
                  : e.event === 'snoozed'
                    ? `snoozed${e.snoozedUntil ? ` until ${clock.dateTime(e.snoozedUntil)}` : ''}`
                    : e.event === 'unread'
                      ? 'marked unread'
                      : e.event === 'read'
                        ? 'marked read'
                        : 'resolved';
              return (
                <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-2.5 text-[13px] sm:px-5">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-foreground">{title}</span>{' '}
                    <span className="text-muted">
                      {verb}
                      {e.byName ? ` by ${e.byName}` : ''}
                      {e.fromState && e.fromState !== e.toState ? ` (${humanize(e.fromState)} → ${humanize(e.toState)})` : ''}
                    </span>
                    {e.note ? <span className="block text-xs text-muted">Note: {e.note}</span> : null}
                  </span>
                  <span className="shrink-0 text-xs text-faint">{clock.dateTime(e.createdAt)}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">Nothing recorded yet — the first mark-read, snooze, resolve or assign appears here.</p>
        )}
      </Card>
    </div>
  );
}
