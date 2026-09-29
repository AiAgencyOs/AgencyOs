import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { situationFor } from '@/modules/crm/follow-up-situations';
import { listFollowUpSequencesDetailed, listTemplateSituationMapping } from '@/modules/crm/follow-up-detail-queries';
import { listInternalRoster } from '@/modules/projects/queries';
import { SavedViewsBar } from '../saved-views-bar';
import { SequenceControls } from './sequence-controls';
import { SequenceDetailButton, type SequenceDetailView } from './sequence-drawer';
import {
  buttonClass,
  Badge,
  Card,
  CardHeader,
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Awaited<ReturnType<typeof listFollowUpSequencesDetailed>>[number];

const columnsFor = (clock: AgencyClock, viewOf: (r: Row) => SequenceDetailView): Column<Row>[] => [
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
          {r.leadId ? (
            <Link href={`/leads/${r.leadId}`} className="hover:underline">
              {r.subjectTitle ?? `${humanize(r.subject_type)} ${r.subject_id.slice(0, 8)}`}
            </Link>
          ) : (
            (r.subjectTitle ?? `${humanize(r.subject_type)} ${r.subject_id.slice(0, 8)}`)
          )}
          {r.channel ? ` · ${humanize(r.channel)}` : ''}
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
    desktopOnly: true,
    cell: (r) => r.stop_reason ?? '—',
  },
  {
    key: 'controls',
    header: '',
    align: 'right',
    cell: (r) => (
      <span className="flex items-center justify-end gap-1">
        <SequenceDetailButton view={viewOf(r)} />
        <SequenceControls sequenceId={r.id} status={r.status} />
      </span>
    ),
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
 * everyone but the database. Stopping and resuming are a person's decision,
 * recorded as the stop reason; everything else stays the worker's job and the
 * follow-up contract's rules.
 *
 * Channel and owner filters read the conversation's channel and the lead's
 * assignee (a sequence carries neither itself); the detail drawer shows the
 * drafted body and the rest of the row; the mapping card sets the contract's
 * situations beside the templates registered for them.
 */
export default async function FollowUpsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string; sort?: string; dir?: string; channel?: string; owner?: string }>;
}) {
  const context = await requireInternal('/follow-ups');
  const clock = await agencyClock();
  if (!can(context.role, 'lead.read')) return <PermissionDenied />;

  const { status, page: pageParam, sort: sortKey, dir, channel: channelParam, owner: ownerParam } = await searchParams;
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  const [allSequences, rawSequences, savedViews, roster] = await Promise.all([
    listFollowUpSequencesDetailed({}),
    listFollowUpSequencesDetailed({ status }),
    listSavedViews('/follow-ups'),
    listInternalRoster(),
  ]);

  // SCR-013 — channel and owner. Only a value the rows actually carry is
  // applied; a stranger is dropped rather than sent anywhere.
  const channels = [...new Set(allSequences.map((s) => s.channel).filter((c): c is string => c !== null))].sort();
  const channel = channels.includes(channelParam ?? '') ? channelParam : undefined;
  const owner = ownerParam === 'mine' ? context.userId : UUID.test(ownerParam ?? '') ? ownerParam : undefined;
  const ownerIds = [...new Set(allSequences.map((s) => s.ownerId).filter((id): id is string => id !== null))];
  const nameOf = (id: string | null) => (id ? (roster.find((m) => m.userId === id)?.fullName ?? id.slice(0, 8)) : null);

  const keep = [status ? `status=${status}` : '', channel ? `channel=${channel}` : '', ownerParam === 'mine' ? 'owner=mine' : owner ? `owner=${owner}` : ''].filter(Boolean);
  const currentQuery = [...keep, sortKey ? `sort=${sortKey}&dir=${direction}` : ''].filter(Boolean).join('&');
  const qs = (extra: string) => `/follow-ups?${[...keep, extra].filter(Boolean).join('&')}`;
  const chipHref = (over: { status?: string; channel?: string; owner?: string }) => {
    const next = { status: status ?? '', channel: channel ?? '', owner: ownerParam === 'mine' ? 'mine' : (owner ?? ''), ...over };
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
    const s = q.toString();
    return `/follow-ups${s ? `?${s}` : ''}`;
  };

  const filteredRows = rawSequences.filter((s) => (!channel || s.channel === channel) && (!owner || s.ownerId === owner));
  const sequences = sortRows(filteredRows, sortKey, direction, COMPARATORS);
  const { page, pageCount, rows: pageRows } = paginate(sequences, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);
  const mapping = await listTemplateSituationMapping(allSequences);
  const filtering = Boolean(status || channel || owner);

  const viewOf = (r: Row): SequenceDetailView => {
    const situation = situationFor(r.situation_key);
    return {
      id: r.id,
      situationName: situation?.name ?? humanize(r.situation_key),
      situationKey: r.situation_key,
      escalatesTo: situation?.escalatesTo ?? null,
      rhythm: situation?.rhythm ?? null,
      subject: r.subjectTitle ?? `${humanize(r.subject_type)} ${r.subject_id.slice(0, 8)}`,
      leadId: r.leadId,
      status: r.status,
      attemptsSent: r.attempts_sent,
      triggeredAt: clock.dateTime(r.triggered_at),
      nextDueAt: r.next_due_at ? clock.dateTime(r.next_due_at) : null,
      lastSentAt: r.last_sent_at ? clock.dateTime(r.last_sent_at) : null,
      lastEvaluatedAt: r.last_evaluated_at ? clock.dateTime(r.last_evaluated_at) : null,
      escalatedAt: r.escalated_at ? clock.dateTime(r.escalated_at) : null,
      stopReason: r.stop_reason,
      lastBlockReason: r.last_block_reason,
      draftedAt: r.drafted_at ? clock.dateTime(r.drafted_at) : null,
      draftedBody: r.drafted_body,
      draftedLanguage: r.drafted_language,
      draftedByAgent: r.drafted_by_agent,
      channel: r.channel,
      ownerName: nameOf(r.ownerId),
      correlationId: r.correlation_id,
    };
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Follow-ups"
        description={
          sequences.length === 0
            ? 'No follow-up sequences match this filter.'
            : `${sequences.length} sequence${sequences.length === 1 ? '' : 's'}${filtering ? ' matching the filters' : ''}. Stopping one here is a person's decision, recorded as its stop reason.`
        }
        actions={
          <div className="flex flex-wrap gap-3 text-[13px]">
            <Link href="/import" className="text-brand hover:underline">
              Reactivation cohort →
            </Link>
            <Link href="/settings/communication" className="text-brand hover:underline">
              Templates &amp; reactivation settings →
            </Link>
          </div>
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
            { key: 'all', label: 'All', href: chipHref({ status: '' }), active: !status },
            ...STATUS_FILTERS.map((s) => ({
              key: s,
              label: humanize(s),
              href: chipHref({ status: s }),
              active: status === s,
            })),
          ]}
        />
        {channels.length > 0 ? (
          <FilterChips
            options={[
              { key: 'any-channel', label: 'Any channel', href: chipHref({ channel: '' }), active: !channel },
              ...channels.map((c) => ({ key: c, label: humanize(c), href: chipHref({ channel: c }), active: channel === c })),
            ]}
          />
        ) : null}
        <FilterChips
          options={[
            { key: 'anyone', label: 'Any owner', href: chipHref({ owner: '' }), active: !owner },
            { key: 'mine', label: 'Mine', href: chipHref({ owner: 'mine' }), active: ownerParam === 'mine' },
            ...ownerIds
              .filter((id) => id !== context.userId)
              .map((id) => ({ key: id, label: nameOf(id) ?? id.slice(0, 8), href: chipHref({ owner: id }), active: owner === id })),
          ]}
        />
      </FilterBar>

      <SavedViewsBar page="/follow-ups" currentQuery={currentQuery} views={savedViews} />

      {sequences.length > 0 ? (
        <>
          <DataTable
            rows={pageRows}
            columns={columnsFor(clock, viewOf)}
            getKey={(r) => r.id}
            sort={{
              key: sortKey,
              direction,
              makeHref: (key, nextDirection) => qs(`sort=${key}&dir=${nextDirection}`),
            }}
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            makeHref={(p) => qs(`${sortKey ? `sort=${sortKey}&dir=${direction}&` : ''}page=${p}`)}
          />
        </>
      ) : (
        <EmptyState
          icon={<IconClock size={22} />}
          title={filtering ? 'No matching sequences' : 'No follow-ups running'}
          description={
            filtering
              ? 'Nothing matches these filters. That is a count of rows, not a guess.'
              : 'A follow-up starts automatically when a tracked situation is observed — a quotation with no reply, a meeting that was missed, and so on.'
          }
          action={filtering ? <Link href="/follow-ups" className={buttonClass('secondary', 'sm')}>Clear filters</Link> : <Link href="/leads" className={buttonClass('secondary', 'sm')}>Open leads</Link>}
        />
      )}

      {/* SCR-013 — situation ↔ template. A situation whose sequences leave
          the 24-hour window can only continue through an approved template
          registered for its key; one with none is a rhythm the window gate
          will suppress. Registration lives on Settings › Communication. */}
      <Card>
        <CardHeader
          title="Situations and their templates"
          description="crm.whatsapp_templates.situation_key against the follow-up contract's situations. A blank template column means nudges outside the 24-hour window are suppressed for that situation."
        />
        <ul className="divide-y divide-line">
          {mapping.map((m) => (
            <li key={m.situationKey} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-[13px] sm:px-5">
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-foreground">{m.situationName ?? humanize(m.situationKey)}</span>
                <span className="block font-mono text-[11px] text-faint">{m.situationKey}</span>
              </span>
              {m.automation ? <Badge tone={m.automation === 'automated' ? 'success' : 'neutral'}>{m.automation}</Badge> : <Badge tone="warning">not in the contract</Badge>}
              <span className="tabular text-xs text-muted">{m.running} active</span>
              <span className="flex flex-wrap gap-1">
                {m.templates.length === 0 ? (
                  <Badge tone="warning" dot>
                    no template
                  </Badge>
                ) : (
                  m.templates.map((t) => (
                    <Badge key={`${t.name}-${t.language}`} tone={t.active && t.status === 'approved' ? 'success' : 'neutral'} mono>
                      {t.name} · {t.language} · {t.status}
                      {t.active ? '' : ' · inactive'}
                    </Badge>
                  ))
                )}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
