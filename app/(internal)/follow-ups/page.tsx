import type { Metadata } from 'next';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { situationFor } from '@/modules/crm/follow-up-situations';
import { listFollowUpSequences } from '@/modules/crm/queries';
import { SavedViewsBar } from '../saved-views-bar';
import { SequenceControls } from './sequence-controls';
import {
  Badge,
  DataTable,
  DEFAULT_PAGE_SIZE,
  EmptyState,
  FilterBar,
  FilterChips,
  humanize,
  IconAlert,
  IconCheck,
  IconClock,
  IconSend,
  PageHeader,
  paginate,
  Pagination,
  PermissionDenied,
  sortRows,
  Stat,
  StatGrid,
  statusTone,
  type Column,
  type SortDirection,
} from '@/ui';

export const metadata: Metadata = { title: 'Follow-ups' };

const STATUS_FILTERS = ['active', 'escalated', 'exhausted', 'stopped'];

type Row = Awaited<ReturnType<typeof listFollowUpSequences>>[number];

const columnsFor = (clock: AgencyClock): Column<Row>[] => [
  {
    key: 'subject',
    header: 'Chasing',
    primary: true,
    cell: (r) => (
      <>
        <span className="block font-medium text-foreground">
          {situationFor(r.situation_key)?.name ?? humanize(r.situation_key)}
        </span>
        <span className="block text-xs text-muted">
          {r.subjectTitle ?? `${humanize(r.subject_type)} ${r.subject_id.slice(0, 8)}`}
        </span>
      </>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    badge: true,
    cell: (r) => <Badge tone={statusTone(r.status)}>{humanize(r.status)}</Badge>,
  },
  {
    key: 'attempts',
    header: 'Attempts',
    align: 'right',
    cellClassName: 'tabular',
    cell: (r) => r.attempts_sent,
    sortKey: 'attempts',
  },
  {
    key: 'next_due',
    header: 'Next due',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (r) => (r.next_due_at ? clock.dateTime(r.next_due_at) : '—'),
    sortKey: 'next_due',
  },
  {
    key: 'last_sent',
    header: 'Last sent',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (r) => (r.last_sent_at ? clock.dateTime(r.last_sent_at) : '—'),
    sortKey: 'last_sent',
  },
  {
    key: 'stop_reason',
    header: 'Stop reason',
    cellClassName: 'text-muted',
    cell: (r) => r.stop_reason ?? '—',
  },
  {
    key: 'controls',
    header: '',
    align: 'right',
    cell: (r) => <SequenceControls sequenceId={r.id} status={r.status} />,
  },
];

const COMPARATORS: Record<string, (a: Row, b: Row) => number> = {
  attempts: (a, b) => a.attempts_sent - b.attempts_sent,
  next_due: (a, b) => (a.next_due_at ?? '').localeCompare(b.next_due_at ?? ''),
  last_sent: (a, b) => (a.last_sent_at ?? '').localeCompare(b.last_sent_at ?? ''),
};

/**
 * Every follow-up rhythm running against a lead, proposal, approval or
 * project — SCR-013. Confirmed genuinely missing by the traceability sweep:
 * `crm.follow_up_sequences` has had a writer (the worker) since it was built,
 * but no screen ever rendered it, so a chased lead's cadence was invisible to
 * everyone but the database. Read-only — starting, stopping and escalating a
 * sequence stays the worker's job and the follow-up contract's rules; this
 * only makes what it already decided visible, per AGENTS.md's "nothing
 * important should disappear inside backend-only state."
 */
export default async function FollowUpsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string; sort?: string; dir?: string }>;
}) {
  const context = await requireInternal('/follow-ups');
  const clock = await agencyClock();
  if (!can(context.role, 'lead.read')) return <PermissionDenied />;

  const { status, page: pageParam, sort: sortKey, dir } = await searchParams;
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  const currentQuery = [status ? `status=${status}` : '', sortKey ? `sort=${sortKey}&dir=${direction}` : '']
    .filter(Boolean)
    .join('&');
  const [allSequences, rawSequences, savedViews] = await Promise.all([
    listFollowUpSequences({}),
    listFollowUpSequences({ status }),
    listSavedViews('/follow-ups'),
  ]);
  const sequences = sortRows(rawSequences, sortKey, direction, COMPARATORS);
  const { page, pageCount, rows: pageRows } = paginate(sequences, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Follow-ups"
        description={
          sequences.length === 0
            ? 'No follow-up sequences match this filter.'
            : `${sequences.length} sequence${sequences.length === 1 ? '' : 's'}. Stopping one here is a person's decision, recorded as its stop reason.`
        }
      />

      {allSequences.length > 0 ? (
        <StatGrid cols={5}>
          <Stat label="Sequences" value={String(allSequences.length)} tone="brand" icon={<IconClock size={16} />} href="/follow-ups" />
          <Stat label="Active" value={String(allSequences.filter((r) => r.status === 'active').length)} caption={`${allSequences.filter((r) => r.status === 'active' && r.next_due_at && r.next_due_at <= new Date().toISOString()).length} due now`} tone="success" icon={<IconCheck size={16} />} href="/follow-ups?status=active" />
          <Stat label="Escalated" value={String(allSequences.filter((r) => r.status === 'escalated').length)} caption="Waiting on a person" tone={allSequences.some((r) => r.status === 'escalated') ? 'warning' : 'neutral'} icon={<IconAlert size={16} />} href="/follow-ups?status=escalated" />
          <Stat label="Stopped" value={String(allSequences.filter((r) => r.status === 'stopped').length)} tone="neutral" icon={<IconClock size={16} />} href="/follow-ups?status=stopped" />
          <Stat label="Attempts sent" value={String(allSequences.reduce((n, r) => n + r.attempts_sent, 0))} caption="Across every sequence" tone="info" icon={<IconSend size={16} />} />
        </StatGrid>
      ) : null}

      <FilterBar>
        <FilterChips
          options={[
            { key: 'all', label: 'All', href: '/follow-ups', active: !status },
            ...STATUS_FILTERS.map((s) => ({
              key: s,
              label: humanize(s),
              href: `/follow-ups?status=${s}`,
              active: status === s,
            })),
          ]}
        />
      </FilterBar>

      <SavedViewsBar page="/follow-ups" currentQuery={currentQuery} views={savedViews} />

      {sequences.length > 0 ? (
        <>
          <DataTable
            rows={pageRows}
            columns={columnsFor(clock)}
            getKey={(r) => r.id}
            sort={{
              key: sortKey,
              direction,
              makeHref: (key, nextDirection) =>
                `/follow-ups?${status ? `status=${status}&` : ''}sort=${key}&dir=${nextDirection}`,
            }}
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            makeHref={(p) =>
              `/follow-ups?${status ? `status=${status}&` : ''}${sortKey ? `sort=${sortKey}&dir=${direction}&` : ''}page=${p}`
            }
          />
        </>
      ) : (
        <EmptyState
          icon={<IconClock size={22} />}
          title={status ? 'No matching sequences' : 'No follow-ups running'}
          description={
            status
              ? `No sequences are currently “${humanize(status)}”.`
              : 'A follow-up starts automatically when a tracked situation is observed — a quotation with no reply, a meeting that was missed, and so on.'
          }
        />
      )}
    </div>
  );
}
