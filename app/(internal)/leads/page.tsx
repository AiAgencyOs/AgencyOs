import type { Metadata } from 'next';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { LEAD_STATUSES } from '@/modules/crm/schema';
import { listLeadsForTable, listLeadsNeedingAttention } from '@/modules/crm/queries';
import {
  Avatar,
  buttonClass,
  DataTable,
  DEFAULT_PAGE_SIZE,
  EmptyState,
  FilterBar,
  FilterChips,
  humanize,
  IconImport,
  IconLeads,
  paginate,
  Pagination,
  PageHeader,
  Stat,
  StatGrid,
  statusTone,
  StatusBadge,
  type Column,
  PermissionDenied,
  sortRows,
  type SortDirection,
} from '@/ui';
import Link from 'next/link';

import { SavedViewsBar } from '../saved-views-bar';
import { CreateLeadButton } from './create-lead-button';

export const metadata: Metadata = { title: 'Leads' };

/**
 * What each tier is called, and how loudly.
 *
 * The words are a person's next action rather than the tag: `handed_over` is
 * a state, "asked for a person" is a thing to do about it.
 */
const ATTENTION: Record<string, { label: string; tone: string }> = {
  handed_over: { label: 'Asked for a person', tone: 'bg-warning/15 text-warning' },
  waiting_on_us: { label: 'Waiting on us', tone: 'bg-danger/10 text-danger' },
  revision_asked: { label: 'Asked to change the quote', tone: 'bg-warning/15 text-warning' },
  quoted_no_answer: { label: 'Quote out, no answer', tone: 'bg-surface-sunken' },
  ready_to_quote: { label: 'Ready to quote', tone: 'bg-success/10 text-success' },
  open_objection: { label: 'Concern unanswered', tone: 'bg-warning/10 text-warning' },
  never_answered: { label: 'Never answered', tone: 'bg-danger/10 text-danger' },
  quiet: { label: 'Quiet', tone: 'bg-surface-sunken' },
};

/**
 * How long it has been waiting, roughly.
 *
 * Rounded rather than exact: the number is read to decide what to open next,
 * and "3d" answers that as well as "3d 4h 12m" while being possible to scan
 * down a column.
 */
function waitedFor(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

type Row = Awaited<ReturnType<typeof listLeadsForTable>>[number];

const columnsFor = (clock: AgencyClock): Column<Row>[] => [
  {
    key: 'title',
    header: 'Name',
    primary: true,
    cell: (l) => (
      <span className="flex items-center gap-2.5">
        <Avatar name={l.contact?.fullName ?? l.title} size="md" />
        <span className="min-w-0">
          <span className="block truncate">{l.contact?.fullName ?? l.title}</span>
          <span className="block truncate text-xs font-normal text-muted">{l.contact?.company ?? l.title}</span>
        </span>
      </span>
    ),
  },
  {
    key: 'phone',
    header: 'Phone',
    desktopOnly: true,
    cellClassName: 'font-mono text-xs text-muted',
    cell: (l) => l.contact?.phone ?? '—',
  },
  {
    key: 'source',
    header: 'Source',
    desktopOnly: true,
    cellClassName: 'text-muted',
    cell: (l) => humanize(l.source),
  },
  { key: 'status', header: 'Status', badge: true, cell: (l) => <StatusBadge status={l.status} /> },
  {
    key: 'assigned',
    header: 'Assigned',
    desktopOnly: true,
    cellClassName: 'text-muted',
    cell: (l) => l.assignedEmail ?? 'Unassigned',
  },
  {
    key: 'activity',
    header: 'Last activity',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (l) => clock.dateTime(l.updated_at),
    sortKey: 'activity',
  },
];

const COMPARATORS: Record<string, (a: Row, b: Row) => number> = {
  activity: (a, b) => a.updated_at.localeCompare(b.updated_at),
};

/**
 * Lead pipeline — the full table view (SCR-006), alongside the existing
 * "Who needs you first" fact-tier queue (Doc 09 §31, ADM-88), which stays:
 * at 200-300 leads a month the first question of the day is not "what is my
 * pipeline" but "who is waiting for me", and no status tab answers that.
 *
 * `DataTable` already renders a card list under `lg`, so the phone-first
 * reading this page cared about is not lost — it is the same shared table
 * primitive every other list screen uses, not a bespoke chat view.
 *
 * The nav in the internal layout hides this entry for roles without
 * `lead.read`, but hiding a link is not access control — a contractor can
 * still type the URL. The capability is therefore re-checked here, and RLS
 * independently refuses the rows underneath, so a mistake in either layer
 * still fails closed.
 */
export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string; sort?: string; dir?: string }>;
}) {
  const context = await requireInternal('/leads');
  if (!can(context.role, 'lead.read')) return <PermissionDenied />;

  const { status, page: pageParam, sort: sortKey, dir } = await searchParams;
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  const currentQuery = [status ? `status=${status}` : '', sortKey ? `sort=${sortKey}&dir=${direction}` : '']
    .filter(Boolean)
    .join('&');

  const [allLeads, waiting, clock, savedViews] = await Promise.all([
    listLeadsForTable(),
    listLeadsNeedingAttention(),
    agencyClock(),
    listSavedViews('/leads'),
  ]);
  const now = new Date();

  const countByStatus = new Map<string, number>();
  for (const l of allLeads) countByStatus.set(l.status, (countByStatus.get(l.status) ?? 0) + 1);

  const filtered = status ? allLeads.filter((l) => l.status === status) : allLeads;
  const leads = sortRows(filtered, sortKey, direction, COMPARATORS);
  const { page, pageCount, rows: pageRows } = paginate(leads, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Leads"
        description={
          allLeads.length === 0
            ? 'Manage, track and convert your leads into clients. Conversations captured from WhatsApp, referrals and the website land here.'
            : `Manage, track and convert your leads into clients · ${allLeads.length} in the pipeline.`
        }
        actions={
          <>
            {can(context.role, 'organization.settings') ? (
              <Link href="/import" className={buttonClass('secondary', 'sm')}>
                <IconImport size={14} />
                Import leads
              </Link>
            ) : null}
            {can(context.role, 'lead.write') ? <CreateLeadButton /> : null}
          </>
        }
      />

      {allLeads.length > 0 ? (
        <StatGrid cols={6}>
          <Stat
            label="Total leads"
            value={String(allLeads.length)}
            caption={`${countByStatus.get('disqualified') ?? 0} disqualified`}
            tone="brand"
            icon={<IconLeads size={16} />}
          />
          {LEAD_STATUSES.filter((s) => s !== 'disqualified').map((s) => (
            <Stat
              key={s}
              label={humanize(s)}
              value={String(countByStatus.get(s) ?? 0)}
              caption={allLeads.length > 0 ? `${Math.round(((countByStatus.get(s) ?? 0) / allLeads.length) * 100)}% of leads` : undefined}
              tone={statusTone(s)}
              href={`/leads?status=${s}`}
            />
          ))}
        </StatGrid>
      ) : null}

      {/* Doc 09 §31, under ADM-88: a fact-tier order, never a score. At the
          top because at 200-300 leads a month the first question of the day is
          not "what is my pipeline" but "who is waiting for me". */}
      {waiting.length > 0 ? (
        <section className="rounded-lg border border-line bg-surface p-4">
          <p className="mb-2 text-[12.5px] text-muted">Who needs you first</p>
          <div className="flex flex-col divide-y divide-line">
            {waiting.map((lead) => (
              <Link
                key={lead.lead_id}
                href={`/leads/${lead.lead_id}`}
                className="flex items-center gap-3 py-1.5 hover:opacity-80"
              >
                <span
                  className={`w-36 shrink-0 rounded px-1.5 py-0.5 text-center text-[11.5px] ${
                    ATTENTION[lead.reason]?.tone ?? 'bg-surface-sunken'
                  }`}
                >
                  {ATTENTION[lead.reason]?.label ?? lead.reason}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{lead.title}</span>
                <span className="shrink-0 text-[12.5px] tabular text-muted">
                  {lead.waiting_since ? waitedFor(lead.waiting_since, now) : ''}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <FilterBar>
        <FilterChips
          options={[
            { key: 'all', label: 'All', href: '/leads', active: !status },
            ...LEAD_STATUSES.map((s) => ({
              key: s,
              label: `${humanize(s)} (${countByStatus.get(s) ?? 0})`,
              href: `/leads?status=${s}`,
              active: status === s,
            })),
          ]}
        />
      </FilterBar>

      <SavedViewsBar page="/leads" currentQuery={currentQuery} views={savedViews} />

      {leads.length > 0 ? (
        <>
          <DataTable
            rows={pageRows}
            columns={columnsFor(clock)}
            getKey={(l) => l.id}
            href={(l) => `/leads/${l.id}`}
            sort={{
              key: sortKey,
              direction,
              makeHref: (key, nextDirection) =>
                `/leads?${status ? `status=${status}&` : ''}sort=${key}&dir=${nextDirection}`,
            }}
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            makeHref={(p) =>
              `/leads?${status ? `status=${status}&` : ''}${sortKey ? `sort=${sortKey}&dir=${direction}&` : ''}page=${p}`
            }
          />
        </>
      ) : (
        <EmptyState
          icon={<IconLeads size={22} />}
          title={status ? 'No matching leads' : 'No leads yet'}
          description={
            status
              ? `No leads are currently "${humanize(status)}".`
              : 'Leads captured from WhatsApp, referrals, and the website will appear here. Nothing is missing — none have arrived.'
          }
        />
      )}
    </div>
  );
}
