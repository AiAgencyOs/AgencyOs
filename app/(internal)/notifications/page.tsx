import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { LiveRefresh } from '@/lib/realtime';
import { Card, EmptyState, FilterBar, FilterChips, IconCheck, PageHeader } from '@/ui';

import { ACTION_CATEGORY_LABEL, categoryOf, listActionItems } from './action-items';

export const metadata: Metadata = { title: 'Notifications' };

/**
 * Notifications & Action Center — SCR-003. Every source here already has
 * its own screen and its own real data; this is the aggregation nothing
 * tied together before — an owner had to open six pages to answer "what
 * needs me right now". No new state, no snooze/dismiss mechanism: every row
 * traces to the real record on the page it links to, and resolving it there
 * is what removes it from this list. The list is live: the same tables that
 * feed it push a refresh when they change (`LiveRefresh`), and the header
 * bell's count is this list's length.
 */
export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ category?: string; severity?: string }> }) {
  const context = await requireInternal('/notifications');
  const clock = await agencyClock();
  const { category, severity } = await searchParams;
  const all = await listActionItems(context, clock);
  const urgentCount = all.filter((r) => r.urgent).length;
  const categories = [...new Set(all.map(categoryOf))];
  const rows = all.filter((r) => (!category || categoryOf(r) === category) && (!severity || (severity === 'urgent' ? r.urgent : !r.urgent)));
  const link = (c?: string, s?: string) => `/notifications?${[c ? `category=${c}` : '', s ? `severity=${s}` : ''].filter(Boolean).join('&')}`;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Notifications"
        description={
          rows.length === 0
            ? 'Nothing needs your attention right now.'
            : `${rows.length} item${rows.length === 1 ? '' : 's'} need attention${urgentCount > 0 ? `, ${urgentCount} urgent` : ''}.`
        }
        actions={<LiveRefresh topics={['approvals', 'finance', 'jobs', 'qa', 'tasks', 'conversations']} />}
      />

      {all.length > 0 ? (
        <FilterBar>
          <FilterChips
            options={[
              { key: 'all', label: `All (${all.length})`, href: link(undefined, severity), active: !category },
              ...categories.map((c) => ({ key: c, label: `${ACTION_CATEGORY_LABEL[c] ?? c} (${all.filter((r) => categoryOf(r) === c).length})`, href: link(c, severity), active: category === c })),
            ]}
          />
          <FilterChips
            options={[
              { key: 'any', label: 'Any severity', href: link(category), active: !severity },
              { key: 'urgent', label: `Urgent (${urgentCount})`, href: link(category, 'urgent'), active: severity === 'urgent' },
              { key: 'normal', label: `Normal (${all.length - urgentCount})`, href: link(category, 'normal'), active: severity === 'normal' },
            ]}
          />
        </FilterBar>
      ) : null}

      {rows.length > 0 ? (
        <Card>
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.key}>
                <Link
                  href={r.href}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-surface-hover sm:px-5"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className={`font-medium ${r.urgent ? 'text-danger' : 'text-foreground'}`}>
                      {r.urgent ? <span className="sr-only">Urgent: </span> : null}
                      {r.title}
                    </span>
                    <span className="text-xs text-muted">{r.detail}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <EmptyState icon={<IconCheck size={22} />} title={all.length > 0 ? 'Nothing in this filter' : 'All clear'} description={all.length > 0 ? 'Widen the filters to see the rest.' : 'No pending approvals, failed deliveries, overdue tasks or open blockers.'} />
      )}
    </div>
  );
}
