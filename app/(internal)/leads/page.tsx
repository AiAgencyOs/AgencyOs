import type { Metadata } from 'next';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { LiveRefresh } from '@/lib/realtime';
import { LEAD_STATUSES, NURTURE_REASONS } from '@/modules/crm/schema';
import { listLeadsForTable, listLeadsNeedingAttention } from '@/modules/crm/queries';
import { readLeadFacts } from '@/modules/crm/lead-list-queries';
import { readLeadScores, type LeadScoreSummary } from '@/modules/crm/lead-score-queries';
import { readLeadServices } from '@/modules/crm/lead-service-queries';
import { listInternalRoster } from '@/modules/projects/queries';
import {
  Avatar,
  Badge,
  BarChart,
  buttonClass,
  Card,
  CardHeader,
  IconActivity,
  IconList,
  IconPhone,
  IconSearch,
  IconTarget,
  IconUser,
  cx,
  DataTable,
  DEFAULT_PAGE_SIZE,
  EmptyState,
  FilterBar,
  humanize,
  inputClass,
  IconImport,
  IconLeads,
  paginate,
  Pagination,
  PageHeader,
  selectClass,
  Stat,
  StatGrid,
  StatusBadge,
  type Column,
  PermissionDenied,
  sortRows,
  type SortDirection,
} from '@/ui';
import Link from 'next/link';

import { SavedViewsBar } from '../saved-views-bar';
import { LeadBulkTable, type BulkLeadRow } from './bulk-table';
import { CreateLeadButton } from './create-lead-button';
import { LeadPreviewButton } from './preview-drawer';
import { RescoreAllLeadsButton } from './rescore-all-button';

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

const columnsFor = (clock: AgencyClock, scores: Map<string, LeadScoreSummary>, services: Map<string, string | null>, createdOf: (id: string) => string | undefined): Column<Row>[] => [
  {
    key: 'title',
    header: 'Name',
    primary: true,
    cell: (l) => (
      <span className="flex items-center gap-2.5">
        <Avatar name={l.contact?.fullName ?? l.title} size="md" />
        <span className="block max-w-[10rem] truncate">{l.contact?.fullName ?? l.title}</span>
      </span>
    ),
  },
  {
    key: 'contact',
    header: 'Contact Details',
    desktopOnly: true,
    cellClassName: 'text-xs text-muted',
    cell: (l) => (
      <span className="block min-w-0">
        <span className="block max-w-[11rem] truncate">{l.contact?.email ?? '—'}</span>
        <span className="block">{l.contact?.phone ?? ''}</span>
      </span>
    ),
  },
  { key: 'source', header: 'Source', desktopOnly: true, cell: (l) => <Badge tone="neutral" dot={false}>{humanize(l.source)}</Badge> },
  { key: 'status', header: 'Status', badge: true, cell: (l) => <StatusBadge status={l.status} /> },
  { key: 'interest', header: 'Interested In', desktopOnly: true, cellClassName: 'text-muted', cell: (l) => <span className="block max-w-[9rem] truncate">{services.get(l.id) ?? '—'}</span> },
  {
    key: 'assigned',
    header: 'Assigned To',
    desktopOnly: true,
    cell: (l) =>
      l.assignedEmail ? (
        <span className="flex items-center gap-2">
          <Avatar name={l.assignedEmail} size="sm" />
          <span className="max-w-[7rem] truncate">{l.assignedEmail.split('@')[0]}</span>
        </span>
      ) : (
        <span className="text-muted">Unassigned</span>
      ),
  },
  // ADM-88 — Decision: reversed by the owner on 2026-09-29. The stored score,
  // which never exists without its reasons; unscored is a dash, not a zero.
  {
    key: 'score',
    header: 'Score',
    align: 'right',
    cellClassName: 'tabular',
    cell: (l) => {
      const s = scores.get(l.id);
      return s ? <span title={s.reasons.map((r) => `${r.points >= 0 ? '+' : ''}${r.points} ${r.detail}`).join('\n')}>{s.score}</span> : <span className="text-muted">—</span>;
    },
    sortKey: 'score',
  },
  {
    key: 'activity',
    header: 'Created On',
    cellClassName: 'text-muted whitespace-nowrap',
    cell: (l) => { const c = createdOf(l.id); return c ? clock.date(c) : clock.dateTime(l.updated_at); },
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
const PALETTE = ['var(--danger)', 'var(--info)', 'var(--warning)', 'var(--success)', 'var(--accent)', 'var(--brand)'];
const STATUS_COLOR: Record<string, string> = { new: 'var(--info)', qualifying: 'var(--warning)', qualified: 'var(--accent)', nurture: 'var(--muted)', disqualified: 'var(--danger)', converted: 'var(--success)' };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function money(minor: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(minor / 100);
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    page?: string;
    sort?: string;
    dir?: string;
    q?: string;
    source?: string;
    owner?: string;
    budgetMin?: string;
    budgetMax?: string;
    createdFrom?: string;
    createdTo?: string;
    service?: string;
  }>;
}) {
  const context = await requireInternal('/leads');
  if (!can(context, 'lead.read')) return <PermissionDenied />;

  const { status, page: pageParam, sort: sortKey, dir, q, source, owner, budgetMin, budgetMax, createdFrom: createdFromParam, createdTo: createdToParam, service: serviceParam } = await searchParams;
  // SCR-006 — `?service=`: the lead's recorded service, matched whole and
  // case-insensitively; the datalist offers the distinct values in use.
  const service = (serviceParam ?? '').trim().slice(0, 80);
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  // SCR-006 — budget and created-date bounds. Only a value that parses is
  // applied; a stranger is dropped. Budgets are typed in rupees and compared
  // in paise against the qualification's `budgetMinor`.
  const toMinor = (v: string | undefined) => {
    const n = Number(v);
    return v && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined;
  };
  const budgetMinMinor = toMinor(budgetMin);
  const budgetMaxMinor = toMinor(budgetMax);
  const createdFrom = DATE.test(createdFromParam ?? '') ? createdFromParam : undefined;
  const createdTo = DATE.test(createdToParam ?? '') ? createdToParam : undefined;
  const keep = [
    status ? `status=${status}` : '',
    q ? `q=${encodeURIComponent(q)}` : '',
    source ? `source=${source}` : '',
    owner ? `owner=${owner}` : '',
    budgetMinMinor !== undefined ? `budgetMin=${budgetMin}` : '',
    budgetMaxMinor !== undefined ? `budgetMax=${budgetMax}` : '',
    createdFrom ? `createdFrom=${createdFrom}` : '',
    createdTo ? `createdTo=${createdTo}` : '',
    service ? `service=${encodeURIComponent(service)}` : '',
  ].filter(Boolean);
  const currentQuery = [...keep, sortKey ? `sort=${sortKey}&dir=${direction}` : ''].filter(Boolean).join('&');
  const qs = (extra: string) => `/leads?${[...keep, extra].filter(Boolean).join('&')}`;

  const [allLeads, waiting, clock, savedViews] = await Promise.all([
    listLeadsForTable(),
    listLeadsNeedingAttention(),
    agencyClock(),
    listSavedViews('/leads'),
  ]);
  const now = new Date();
  const facts = await readLeadFacts(allLeads.map((l) => l.id));
  // ADM-88 (reversed 2026-09-29): the stored score per lead, with its reasons.
  const scores = await readLeadScores(allLeads.map((l) => l.id));
  const services = await readLeadServices(allLeads.map((l) => l.id));
  const canWriteLeads = can(context, 'lead.write');
  const roster = canWriteLeads ? await listInternalRoster() : [];
  const boundedByBudget = budgetMinMinor !== undefined || budgetMaxMinor !== undefined;

  const countByStatus = new Map<string, number>();
  for (const l of allLeads) countByStatus.set(l.status, (countByStatus.get(l.status) ?? 0) + 1);

  const needle = (q ?? '').trim().toLowerCase();
  const filtered = allLeads.filter(
    (l) =>
      (!status || l.status === status) &&
      (!source || l.source === source) &&
      (!owner || (owner === 'unassigned' ? l.assigned_to === null : l.assigned_to === owner)) &&
      // SCR-006 — name, phone, EMAIL and company, one box.
      (!needle || `${l.title} ${l.contact?.fullName ?? ''} ${l.contact?.company ?? ''} ${l.contact?.phone ?? ''} ${l.contact?.email ?? ''}`.toLowerCase().includes(needle)) &&
      (!boundedByBudget ||
        (() => {
          const b = facts.get(l.id)?.budgetMinor ?? null;
          return b !== null && (budgetMinMinor === undefined || b >= budgetMinMinor) && (budgetMaxMinor === undefined || b <= budgetMaxMinor);
        })()) &&
      (!createdFrom || (facts.get(l.id)?.createdAt ?? '') >= `${createdFrom}T00:00:00`) &&
      (!createdTo || (facts.get(l.id)?.createdAt ?? '') <= `${createdTo}T23:59:59.999Z`) &&
      (!service || (services.byLead.get(l.id) ?? '').toLowerCase() === service.toLowerCase()),
  );
  const sources = [...new Set(allLeads.map((l) => l.source))].sort();
  const owners = [...new Map(allLeads.filter((l) => l.assigned_to && l.assignedEmail).map((l) => [l.assigned_to as string, l.assignedEmail as string])).entries()];
  const comparators = {
    ...COMPARATORS,
    created: (a: Row, b: Row) => (facts.get(a.id)?.createdAt ?? '').localeCompare(facts.get(b.id)?.createdAt ?? ''),
    // Unscored sorts below every score, whichever way the column is sorted.
    score: (a: Row, b: Row) => (scores.get(a.id)?.score ?? -1) - (scores.get(b.id)?.score ?? -1),
  };
  const leads = sortRows(filtered, sortKey, direction, comparators);
  const { page, pageCount, rows: pageRows } = paginate(leads, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);

  const monthStart = `${clock.dayKey(now).slice(0, 7)}-01`;
  const newThisMonth = allLeads.filter((l) => (facts.get(l.id)?.createdAt ?? '') >= `${monthStart}T00:00:00`).length;
  const pct = (n: number) => (allLeads.length > 0 ? `${Math.round((n / allLeads.length) * 100)}% of total` : '');
  const sourceCounts = new Map<string, number>();
  for (const l of allLeads) sourceCounts.set(l.source, (sourceCounts.get(l.source) ?? 0) + 1);
  const sourceRows = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1]).map(([src, n]) => ({ source: src, pct: Math.round((n / allLeads.length) * 100) }));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Leads"
        description={
          allLeads.length === 0
            ? 'Manage your incoming leads, track conversations and convert them into clients. Conversations captured from WhatsApp, referrals and the website land here.'
            : `Manage your incoming leads, track conversations and convert them into clients · ${allLeads.length} in the pipeline.`
        }
        actions={
          <>
            {/* E4: the list is a live screen (test matrix §5 scenario 1 watches it from a second session). */}
            <LiveRefresh topics={['leads']} />
            {can(context, 'organization.settings') ? (
              <Link href="/import" className={buttonClass('secondary', 'sm')}>
                <IconImport size={14} />
                Import leads
              </Link>
            ) : null}
            {can(context, 'lead.write') ? <RescoreAllLeadsButton /> : null}
            {can(context, 'lead.write') ? <CreateLeadButton /> : null}
          </>
        }
      />

      {allLeads.length > 0 ? (
        <StatGrid cols={5}>
          <Stat label="Total Leads" value={String(allLeads.length)} caption={`${countByStatus.get('disqualified') ?? 0} disqualified`} tone="brand" icon={<IconLeads size={16} />} />
          <Stat label="New This Month" value={String(newThisMonth)} caption="Created this month" tone="info" icon={<IconActivity size={16} />} href={`/leads?createdFrom=${monthStart}`} />
          <Stat label="Qualifying" value={String(countByStatus.get('qualifying') ?? 0)} caption={pct(countByStatus.get('qualifying') ?? 0)} tone="warning" icon={<IconPhone size={16} />} href="/leads?status=qualifying" />
          <Stat label="Qualified" value={String(countByStatus.get('qualified') ?? 0)} caption={pct(countByStatus.get('qualified') ?? 0)} tone="success" icon={<IconTarget size={16} />} href="/leads?status=qualified" />
          <Stat label="Converted" value={String(countByStatus.get('converted') ?? 0)} caption={pct(countByStatus.get('converted') ?? 0)} tone="accent" icon={<IconUser size={16} />} href="/leads?status=converted" />
        </StatGrid>
      ) : null}

      <FilterBar clearHref="/leads" filtered={Boolean(status || q || source || owner || boundedByBudget || createdFrom || createdTo || service)}>
        <form method="get" action="/leads" className="flex w-full flex-wrap items-center gap-2 [&_input]:w-auto [&_select]:w-auto">
          <label className="relative min-w-[14rem] flex-1">
            <span className="sr-only">Search leads</span>
            <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"><IconSearch size={15} /></span>
            <input name="q" defaultValue={q ?? ''} placeholder="Search leads by name, email, phone, source…" className={cx(inputClass, '!w-full pl-9')} />
          </label>
          <select name="source" defaultValue={source ?? ''} aria-label="Source" className={cx(selectClass, 'w-auto')}>
            <option value="">All Sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
          <select name="status" defaultValue={status ?? ''} aria-label="Status" className={cx(selectClass, 'w-auto')}>
            <option value="">All Status</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)} ({countByStatus.get(s) ?? 0})
              </option>
            ))}
          </select>
          <select name="owner" defaultValue={owner ?? ''} aria-label="Assigned to" className={cx(selectClass, 'w-auto')}>
            <option value="">All Assigned</option>
            <option value="unassigned">Unassigned</option>
            {owners.map(([id, email]) => (
              <option key={id} value={id}>
                {email.split('@')[0]}
              </option>
            ))}
          </select>
          <details className="group relative" open={Boolean(boundedByBudget || createdFrom || createdTo || service)}>
            <summary className={cx(buttonClass('secondary', 'sm'), 'cursor-pointer list-none [&::-webkit-details-marker]:hidden')}>
              <IconList size={14} /> Filter
            </summary>
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-3 lg:absolute lg:right-0 lg:z-20 lg:w-[22rem] lg:shadow-lg">
              <input type="number" min="0" name="budgetMin" defaultValue={budgetMin ?? ''} placeholder="Budget ≥ ₹" aria-label="Budget at least" className={cx(inputClass, 'w-32')} />
              <input type="number" min="0" name="budgetMax" defaultValue={budgetMax ?? ''} placeholder="Budget ≤ ₹" aria-label="Budget at most" className={cx(inputClass, 'w-32')} />
              <input type="date" name="createdFrom" defaultValue={createdFrom ?? ''} aria-label="Created from" className={cx(inputClass, 'w-40')} />
              <input type="date" name="createdTo" defaultValue={createdTo ?? ''} aria-label="Created to" className={cx(inputClass, 'w-40')} />
              <input name="service" list="leads-service-values" defaultValue={service} maxLength={80} placeholder="Service" aria-label="Service" className={cx(inputClass, 'w-40')} />
              <datalist id="leads-service-values">
                {services.distinct.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
          </details>
          <button type="submit" className={buttonClass('primary', 'sm')}>
            Apply
          </button>
          {q || source || status || owner || boundedByBudget || createdFrom || createdTo || service ? (
            <Link href="/leads" className="text-xs font-medium text-brand hover:underline">
              Reset
            </Link>
          ) : null}
        </form>
      </FilterBar>

      <SavedViewsBar page="/leads" currentQuery={currentQuery} views={savedViews} />

      {leads.length > 0 && canWriteLeads ? (
        <>
          {/* SCR-006 — the multi-select table. Only a role that may write
              leads sees the checkboxes; everyone else gets the plain table. */}
          <LeadBulkTable
            rows={pageRows.map(
              (l): BulkLeadRow => ({
                id: l.id,
                name: l.contact?.fullName ?? l.title,
                subtitle: l.contact?.company ?? l.title,
                phone: l.contact?.phone ?? null,
                email: l.contact?.email ?? null,
                service: services.byLead.get(l.id) ?? null,
                source: l.source,
                status: l.status,
                assigned: l.assignedEmail ?? 'Unassigned',
                lastActivity: clock.dateTime(l.updated_at),
                created: facts.get(l.id) ? clock.date(facts.get(l.id)!.createdAt) : '—',
                budget: facts.get(l.id)?.budgetMinor !== null && facts.get(l.id)?.budgetMinor !== undefined ? money(facts.get(l.id)!.budgetMinor as number) : null,
                tags: facts.get(l.id)?.tags ?? [],
                score: scores.get(l.id)?.score ?? null,
              }),
            )}
            roster={roster.map((m) => ({ userId: m.userId, fullName: m.fullName }))}
            statuses={LEAD_STATUSES}
            nurtureReasons={NURTURE_REASONS}
            canAssign={canWriteLeads}
            canWrite={canWriteLeads}
            sortKey={sortKey}
            sortDirection={direction}
            sortHrefPrefix={`/leads?${keep.length > 0 ? `${keep.join('&')}&` : ''}`}
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            makeHref={(p) => qs(`${sortKey ? `sort=${sortKey}&dir=${direction}&` : ''}page=${p}`)}
          />
        </>
      ) : leads.length > 0 ? (
        <>
          <DataTable
            rows={pageRows}
            columns={columnsFor(clock, scores, services.byLead, (id) => facts.get(id)?.createdAt)}
            getKey={(l) => l.id}
            // Bucket F: the shared per-row overflow menu — the row's secondary
            // destinations, each a page that already exists.
            rowActions={(l) => [
              { key: 'preview', label: 'Preview', node: <LeadPreviewButton leadId={l.id} name={l.contact?.fullName ?? l.title} /> },
              { key: 'open', label: 'Open lead', href: `/leads/${l.id}` },
              { key: 'meeting', label: 'Request a meeting', href: `/leads/${l.id}#meetings` },
              { key: 'quotation', label: 'Quotations', href: `/leads/${l.id}#quotations` },
              { key: 'search', label: 'Find related records', href: `/search?q=${encodeURIComponent(l.title)}` },
            ]}
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
          icon={<IconLeads size={22} />}
          title={status || q || source || owner || boundedByBudget || createdFrom || createdTo || service ? 'No matching leads' : 'No leads yet'}
          description={
            q || source || owner || boundedByBudget || createdFrom || createdTo || service
              ? 'No lead matches these filters.'
              : status
              ? `No leads are currently "${humanize(status)}".`
              : 'Leads captured from WhatsApp, referrals, and the website will appear here. Nothing is missing — none have arrived.'
          }
          action={status || q || source || owner || boundedByBudget || createdFrom || createdTo || service ? <Link href="/leads" className={buttonClass('secondary', 'sm')}>Clear filters</Link> : <Link href="/import" className={buttonClass('secondary', 'sm')}>Import historical leads</Link>}
        />
      )}
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

      {allLeads.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Lead Source Breakdown" />
            <ul className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
              {sourceRows.map((r, i) => (
                <li key={r.source} className="grid grid-cols-[6.5rem_1fr_2.75rem] items-center gap-3 text-[13px]">
                  <span className="truncate text-muted">{humanize(r.source)}</span>
                  <span className="h-2 overflow-hidden rounded-full bg-surface-sunken">
                    <span className="block h-full rounded-full" style={{ width: `${r.pct}%`, background: PALETTE[i % PALETTE.length] }} />
                  </span>
                  <span className="tabular text-right text-muted">{r.pct}%</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Lead Status Funnel" />
            <div className="px-4 pb-4 sm:px-5">
              <BarChart data={LEAD_STATUSES.map((s) => ({ label: humanize(s), value: countByStatus.get(s) ?? 0 }))} colors={LEAD_STATUSES.map((s) => STATUS_COLOR[s] ?? 'var(--brand)')} height={170} />
            </div>
          </Card>
        </div>
      ) : null}

    </div>
  );
}
