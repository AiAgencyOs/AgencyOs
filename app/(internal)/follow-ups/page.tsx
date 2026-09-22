import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { situationFor } from '@/modules/crm/follow-up-situations';
import { listFollowUpSequences } from '@/modules/crm/queries';
import {
  Badge,
  DataTable,
  EmptyState,
  FilterBar,
  FilterChips,
  humanize,
  IconClock,
  PageHeader,
  statusTone,
  type Column,
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
  },
  {
    key: 'next_due',
    header: 'Next due',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (r) => (r.next_due_at ? clock.dateTime(r.next_due_at) : '—'),
  },
  {
    key: 'last_sent',
    header: 'Last sent',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (r) => (r.last_sent_at ? clock.dateTime(r.last_sent_at) : '—'),
  },
  {
    key: 'stop_reason',
    header: 'Stop reason',
    cellClassName: 'text-muted',
    cell: (r) => r.stop_reason ?? '—',
  },
];

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
  searchParams: Promise<{ status?: string }>;
}) {
  const context = await requireInternal('/follow-ups');
  const clock = await agencyClock();
  if (!can(context.role, 'lead.read')) redirect('/dashboard');

  const { status } = await searchParams;
  const sequences = await listFollowUpSequences({ status });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Follow-ups"
        description={
          sequences.length === 0
            ? 'No follow-up sequences match this filter.'
            : `${sequences.length} sequence${sequences.length === 1 ? '' : 's'}.`
        }
      />

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

      {sequences.length > 0 ? (
        <DataTable rows={sequences} columns={columnsFor(clock)} getKey={(r) => r.id} />
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
