import type { Metadata } from 'next';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { countPeriods, periodDelta, trendOf } from '@/lib/admin/period-delta';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { LiveRefresh } from '@/lib/realtime';
import { LEAD_STATUSES, NURTURE_REASONS } from '@/modules/crm/schema';
import { listLeadsForTable, listLeadsNeedingAttention } from '@/modules/crm/queries';
import { readLeadHeat } from '@/modules/crm/lead-heat-queries';
import { readLeadFacts } from '@/modules/crm/lead-list-queries';
import { isQuickFilterKey, matchesQuickFilter } from '@/modules/crm/lead-quick-filters';
import { heatRank, heatTitle, deriveLeadHeat, type LeadHeatReading } from '@/modules/crm/lead-heat';
import { LeadHeatBadge } from '@/modules/crm/lead-heat-badge';
import { readLeadServices } from '@/modules/crm/lead-service-queries';
import { readLeadIndicators } from '@/modules/crm/lead-indicators-queries';
import { LeadFlags, type LeadFlagsData } from './lead-flags';
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
  FilterChips,
  DetailPanel,
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

const columnsFor = (clock: AgencyClock, heats: Map<string, LeadHeatReading>, services: Map<string, string | null>, flagsOf: (id: string) => LeadFlagsData, createdOf: (id: string) => string | undefined, factsOf: (id: string) => { budget: string | null; tags: string[] }): Column<Row>[] => [
  {
    key: 'title',
    header: 'Name',
    primary: true,
    cell: (l) => (
      <span className="flex items-center gap-2.5">
        <Avatar name={l.contact?.fullName ?? l.title} size="sm" />
        <span className="min-w-0">
          <span className="block max-w-[5.5rem] truncate">{l.contact?.fullName ?? l.title}</span>
          <span className="block max-w-[5.5rem] truncate text-[11px] font-normal text-muted">{humanize(l.source)}</span>
        </span>
      </span>
    ),
  },
  {
    key: 'contact',
    header: 'Contact Details',
    desktopOnly: true,
    cellClassName: 'text-[11px] text-muted',
    cell: (l) => (
      <span className="block min-w-0">
        <span className="block max-w-[6rem] truncate">{l.contact?.email ?? '—'}</span>
        <span className="block">{l.contact?.phone ?? ''}</span>
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    badge: true,
    sortKey: 'heat',
    cell: (l) => (
      <span className="flex flex-col items-start gap-1">
        <StatusBadge status={l.status} />
        {heats.get(l.id) ? <LeadHeatBadge label={heats.get(l.id)!.label} title={heatTitle(heats.get(l.id)!)} /> : null}
      </span>
    ),
  },
  { key: 'flags', header: 'Flags', desktopOnly: true, cell: (l) => <LeadFlags flags={flagsOf(l.id)} /> },
  { key: 'interest', header: 'Interested In', desktopOnly: true, cellClassName: 'text-muted', cell: (l) => <span className="block max-w-[5.5rem] truncate">{services.get(l.id) ?? '—'}</span> },
  { key: 'budget', header: 'Budget', desktopOnly: true, cellClassName: 'tabular whitespace-nowrap text-muted', cell: (l) => factsOf(l.id).budget ?? '—' },
  {
    key: 'tags',
    header: 'Tags',
    desktopOnly: true,
    cell: (l) => {
      const tags = factsOf(l.id).tags;
      return tags.length === 0 ? (
        <span className="text-muted">—</span>
      ) : (
        <span className="flex max-w-[6rem] gap-1">
          {tags.slice(0, 1).map((t) => (
            <Badge key={t} tone="info" dot={false}>{t}</Badge>
          ))}
        </span>
      );
    },
  },
  {
    key: 'assigned',
    header: 'Assigned To',
    desktopOnly: true,
    cell: (l) =>
      l.assignedEmail ? (
        <span className="flex items-center gap-2">
          <Avatar name={l.assignedEmail} size="sm" />
          <span className="hidden max-w-[5rem] truncate min-[1800px]:inline">{l.assignedEmail.split('@')[0]}</span>
        </span>
      ) : (
        <span className="text-muted">Unassigned</span>
      ),
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
    lead?: string;
    quick?: string;
  }>;
}) {
  const context = await requireInternal('/leads');
  if (!can(context, 'lead.read')) return <PermissionDenied />;

  const { status, page: pageParam, sort: sortKey, dir, q, source, owner, budgetMin, budgetMax, createdFrom: createdFromParam, createdTo: createdToParam, service: serviceParam, lead: leadParam, quick: quickParam } = await searchParams;
  // Decision 14: the rail's Hot Leads / No Response, read from when the lead last wrote.
  const quick = isQuickFilterKey(quickParam) ? quickParam : undefined;
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
    quick ? `quick=${quick}` : '',
  ].filter(Boolean);
  const currentQuery = [...keep, sortKey ? `sort=${sortKey}&dir=${direction}` : ''].filter(Boolean).join('&');
  const statusHref = (st: string | null) => `/leads?${[st ? `status=${st}` : '', ...keep.filter((k) => !k.startsWith('status='))].filter(Boolean).join('&')}`;
  const qs = (extra: string) => `/leads?${[...keep, extra].filter(Boolean).join('&')}`;

  const [allLeads, waiting, clock, savedViews] = await Promise.all([
    listLeadsForTable(),
    listLeadsNeedingAttention(200),
    agencyClock(),
    listSavedViews('/leads'),
  ]);
  const now = new Date();
  const facts = await readLeadFacts(allLeads.map((l) => l.id));
  const heat = await readLeadHeat();
  const services = await readLeadServices(allLeads.map((l) => l.id));
  const indicators = await readLeadIndicators(allLeads.map((l) => l.id));
  const replyBy = new Map(waiting.map((w) => [w.lead_id, ATTENTION[w.reason]?.label ?? null]));
  const flagsOf = (id: string): LeadFlagsData => ({ consent: indicators.get(id)?.consent ?? 'none', handoff: indicators.get(id)?.handoff ?? false, reply: replyBy.get(id) ?? null, duplicateCount: indicators.get(id)?.duplicates.length ?? 0 });
  const canWriteLeads = can(context, 'lead.write');
  const roster = canWriteLeads ? await listInternalRoster() : [];
  const boundedByBudget = budgetMinMinor !== undefined || budgetMaxMinor !== undefined;

  const countByStatus = new Map<string, number>();
  for (const l of allLeads) countByStatus.set(l.status, (countByStatus.get(l.status) ?? 0) + 1);

  const heatOf = (l: Row) => ({ status: l.status, dealStage: heat.get(l.id)?.dealStage ?? null, createdAt: facts.get(l.id)?.createdAt ?? l.updated_at, lastInboundAt: heat.get(l.id)?.lastInboundAt ?? null });
  // Owner decision 1 (round 2): a Hot / Warm / Cold label with its reasons, never a number.
  const heats = new Map(allLeads.map((l) => [l.id, deriveLeadHeat({ ...heatOf(l), budgetRecorded: (facts.get(l.id)?.budgetMinor ?? null) !== null }, now)]));
  const hotLeads = allLeads.filter((l) => matchesQuickFilter('hot_leads', heatOf(l), now)).length;
  const noResponse = allLeads.filter((l) => matchesQuickFilter('no_response', heatOf(l), now)).length;
  const needle = (q ?? '').trim().toLowerCase();
  const filtered = allLeads.filter(
    (l) =>
      (!status || l.status === status) &&
      (!source || l.source === source) &&
      (!owner || (owner === 'unassigned' ? l.assigned_to === null : l.assigned_to === owner)) &&
      // SCR-006 — name, phone, EMAIL and company, one box.
      (!needle || `${l.title} ${l.contact?.fullName ?? ''} ${l.contact?.company ?? ''} ${l.contact?.phone ?? ''} ${l.contact?.email ?? ''} ${l.source.replace(/_/g, ' ')}`.toLowerCase().includes(needle)) &&
      (!boundedByBudget ||
        (() => {
          const b = facts.get(l.id)?.budgetMinor ?? null;
          return b !== null && (budgetMinMinor === undefined || b >= budgetMinMinor) && (budgetMaxMinor === undefined || b <= budgetMaxMinor);
        })()) &&
      (!createdFrom || (facts.get(l.id)?.createdAt ?? '') >= `${createdFrom}T00:00:00`) &&
      (!createdTo || (facts.get(l.id)?.createdAt ?? '') <= `${createdTo}T23:59:59.999Z`) &&
      (!service || (services.byLead.get(l.id) ?? '').toLowerCase() === service.toLowerCase()) &&
      (!quick || matchesQuickFilter(quick, heatOf(l), now)),
  );
  const sources = [...new Set(allLeads.map((l) => l.source))].sort();
  const owners = [...new Map(allLeads.filter((l) => l.assigned_to && l.assignedEmail).map((l) => [l.assigned_to as string, l.assignedEmail as string])).entries()];
  const comparators = {
    ...COMPARATORS,
    created: (a: Row, b: Row) => (facts.get(a.id)?.createdAt ?? '').localeCompare(facts.get(b.id)?.createdAt ?? ''),
    // Hot above Warm above Cold when sorted high-first.
    heat: (a: Row, b: Row) => heatRank(heats.get(a.id)?.label ?? 'Cold') - heatRank(heats.get(b.id)?.label ?? 'Cold'),
  };
  const leads = sortRows(filtered, sortKey, direction, comparators);
  const { page, pageCount, rows: pageRows } = paginate(leads, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);

  const selected = pageRows.find((l) => l.id === leadParam) ?? pageRows[0] ?? null;
  const selectedFacts = selected ? facts.get(selected.id) : undefined;
  const detailsPrefix = `/leads?${keep.length > 0 ? `${keep.join('&')}&` : ''}`;
  const createdDelta = countPeriods(allLeads.map((l) => facts.get(l.id)?.createdAt), now);
  const convertedDelta = countPeriods(allLeads.filter((l) => l.status === 'converted').map((l) => facts.get(l.id)?.createdAt), now);
  const todayKey = clock.dayKey(now);
  const followUpToday = allLeads.filter((l) => {
    const at = facts.get(l.id)?.nextFollowUpAt;
    return at ? clock.dayKey(new Date(at)) === todayKey : false;
  }).length;
  const highValue = allLeads.filter((l) => (facts.get(l.id)?.budgetMinor ?? 0) >= 5_000_000).length;
  const unassigned = allLeads.filter((l) => l.assigned_to === null).length;
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
            {can(context, 'lead.write') ? <CreateLeadButton /> : null}
          </>
        }
      />

      {allLeads.length > 0 ? (
        <StatGrid cols={5}>
          <Stat label="Total Leads" value={String(allLeads.length)} caption={`${countByStatus.get('disqualified') ?? 0} disqualified`} trend={trendOf(periodDelta(createdDelta))} tone="brand" icon={<IconLeads size={16} />} />
          <Stat label="New This Month" value={String(newThisMonth)} caption="Created this month" trend={trendOf(periodDelta(createdDelta))} tone="info" icon={<IconActivity size={16} />} href={`/leads?createdFrom=${monthStart}`} />
          <Stat label="Qualifying" value={String(countByStatus.get('qualifying') ?? 0)} caption={pct(countByStatus.get('qualifying') ?? 0)} tone="warning" icon={<IconPhone size={16} />} href="/leads?status=qualifying" />
          <Stat label="Qualified" value={String(countByStatus.get('qualified') ?? 0)} caption={pct(countByStatus.get('qualified') ?? 0)} tone="success" icon={<IconTarget size={16} />} href="/leads?status=qualified" />
          <Stat label="Converted" value={String(countByStatus.get('converted') ?? 0)} caption={pct(countByStatus.get('converted') ?? 0)} trend={trendOf(periodDelta(convertedDelta))} tone="accent" icon={<IconUser size={16} />} href="/leads?status=converted" />
        </StatGrid>
      ) : null}

      <div className="grid items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="flex min-w-0 flex-col gap-4">
      {allLeads.length > 0 ? (
        <FilterChips
          options={[
            { key: 'all', label: `All Leads (${allLeads.length})`, href: statusHref(null), active: !status },
            ...LEAD_STATUSES.map((st) => ({ key: st, label: `${humanize(st)} (${countByStatus.get(st) ?? 0})`, href: statusHref(st), active: status === st })),
          ]}
        />
      ) : null}

      <FilterBar clearHref="/leads" filtered={Boolean(status || q || source || owner || boundedByBudget || createdFrom || createdTo || service || quick)}>
        <form method="get" action="/leads" className="flex w-full flex-wrap items-center gap-2 [&_input]:w-auto [&_select]:w-auto">
          {quick ? <input type="hidden" name="quick" value={quick} /> : null}
          <label className="relative min-w-[14rem] flex-1">
            <span className="sr-only">Search leads</span>
            <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"><IconSearch size={15} /></span>
            <input name="q" defaultValue={q ?? ''} placeholder="Search leads by name, phone, email, company, source…" className={cx(inputClass, '!w-full pl-9')} />
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
                heat: heats.get(l.id) ? { label: heats.get(l.id)!.label, title: heatTitle(heats.get(l.id)!) } : null,
                flags: flagsOf(l.id),
                duplicates: indicators.get(l.id)?.duplicates ?? [],
              }),
            )}
            roster={roster.map((m) => ({ userId: m.userId, fullName: m.fullName }))}
            statuses={LEAD_STATUSES}
            nurtureReasons={NURTURE_REASONS}
            canAssign={canWriteLeads}
            canWrite={canWriteLeads}
            canMerge={can(context, 'organization.settings')}
            sortKey={sortKey}
            sortDirection={direction}
            sortHrefPrefix={`/leads?${keep.length > 0 ? `${keep.join('&')}&` : ''}`}
            detailsHrefPrefix={detailsPrefix}
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            makeHref={(p) => qs(`${sortKey ? `sort=${sortKey}&dir=${direction}&` : ''}page=${p}`)}
          />
        </>
      ) : leads.length > 0 ? (
        <>
          <Card className="px-1 pb-1">
          <DataTable
            dense
            tight
            rows={pageRows}
            columns={columnsFor(clock, heats, services.byLead, flagsOf, (id) => facts.get(id)?.createdAt, (id) => ({ budget: facts.get(id)?.budgetMinor !== null && facts.get(id)?.budgetMinor !== undefined ? money(facts.get(id)!.budgetMinor as number) : null, tags: facts.get(id)?.tags ?? [] }))}
            getKey={(l) => l.id}
            // Bucket F: the shared per-row overflow menu — the row's secondary
            // destinations, each a page that already exists.
            rowActions={(l) => [
              { key: 'preview', label: 'Preview', node: <LeadPreviewButton leadId={l.id} name={l.contact?.fullName ?? l.title} /> },
              { key: 'details', label: 'Show details', href: `${detailsPrefix}lead=${l.id}` },
              { key: 'open', label: 'Open lead', href: `/leads/${l.id}` },
              { key: 'conversation', label: 'Open conversation', href: `/leads/${l.id}?tab=conversation` },
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
          </Card>
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
        </div>

        {allLeads.length > 0 && selected ? (
          <aside className="flex min-w-0 flex-col gap-4" aria-label="Lead details and quick filters">
            <DetailPanel
              title="Lead Details"
              actions={<Link href={`/leads/${selected.id}`} className="text-xs font-medium text-brand hover:underline">Open</Link>}
              rows={[
                { label: 'Lead', value: selected.contact?.fullName ?? selected.title },
                { label: 'Status', value: <StatusBadge status={selected.status} /> },
                { label: 'Email', value: selected.contact?.email ?? null },
                { label: 'Phone', value: selected.contact?.phone ?? null },
                { label: 'Source', value: <Badge tone="neutral" dot={false}>{humanize(selected.source)}</Badge> },
                { label: 'Interested in', value: services.byLead.get(selected.id) ?? null },
                { label: 'Budget', value: selectedFacts && typeof selectedFacts.budgetMinor === 'number' ? money(selectedFacts.budgetMinor) : null },
                { label: 'Timeline', value: selectedFacts?.timelineNote ?? null },
                { label: 'Company', value: selected.contact?.company ?? null },
                { label: 'Team member', value: selected.assignedEmail ? selected.assignedEmail.split('@')[0] : 'Unassigned' },
              ]}
            >
              <div className="border-t border-line px-4 py-3 sm:px-5">
                <p className="mb-1.5 text-sm font-bold text-foreground">Notes</p>
                <p className="text-[13px] text-muted">{selectedFacts?.notes ?? 'No notes yet.'}</p>
              </div>
              <div className="border-t border-line px-4 py-3 sm:px-5">
                <p className="mb-1.5 text-sm font-bold text-foreground">Next Follow-up</p>
                <p className="text-[13px] text-muted">{selectedFacts?.nextFollowUpAt ? clock.dateTime(selectedFacts.nextFollowUpAt) : 'None scheduled.'}</p>
              </div>
              <div className="border-t border-line px-4 py-3 sm:px-5">
                <p className="mb-1.5 text-sm font-bold text-foreground">Tags</p>
                {(selectedFacts?.tags ?? []).length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {(selectedFacts?.tags ?? []).map((t) => (
                      <Badge key={t} tone="info" dot={false}>{t}</Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-[13px] text-muted">No tags yet.</p>
                )}
              </div>
              <div className="flex flex-col gap-2 border-t border-line px-4 py-3 sm:px-5">
                <Link href={`/leads/${selected.id}#activity`} className={buttonClass('primary', 'sm')}>Log Activity</Link>
                <Link href={`/leads/${selected.id}#sales`} className={buttonClass('secondary', 'sm')}>Convert to Client</Link>
                <Link href={`/leads/${selected.id}#quotations`} className={buttonClass('secondary', 'sm')}>Create Quotation</Link>
              </div>
            </DetailPanel>
            <Card>
              <CardHeader title="Quick Filters" />
              <ul className="flex flex-col divide-y divide-line px-4 pb-2 text-[13px] sm:px-5">
                {[
                  { label: 'Hot Leads', href: '/leads?quick=hot_leads', n: hotLeads, active: quick === 'hot_leads' },
                  { label: 'Follow-up Today', href: '/leads', n: followUpToday, link: '/follow-ups' },
                  { label: 'No Response (3+ days)', href: '/leads?quick=no_response', n: noResponse, active: quick === 'no_response' },
                  { label: 'New This Month', href: `/leads?createdFrom=${monthStart}`, n: newThisMonth },
                  { label: 'Unassigned', href: '/leads?owner=unassigned', n: unassigned },
                  { label: 'High Value (₹50K+)', href: '/leads?budgetMin=50000', n: highValue },
                ].map((f) => (
                  <li key={f.label}>
                    <Link href={f.link ?? f.href} aria-current={f.active ? 'true' : undefined} className={cx('flex items-center justify-between gap-2 py-2 hover:text-brand', f.active ? 'font-semibold text-brand' : '')}>
                      <span>{f.label}</span>
                      <span className="tabular rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-muted">{f.n}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          </aside>
        ) : null}
      </div>

      {/* Doc 09 §31, under ADM-88: a fact-tier order, never a score. At the
          top because at 200-300 leads a month the first question of the day is
          not "what is my pipeline" but "who is waiting for me". */}
      {waiting.length > 0 ? (
        <section className="rounded-lg border border-line bg-surface p-4">
          <p className="mb-2 text-[12.5px] text-muted">Who needs you first</p>
          <div className="flex flex-col divide-y divide-line">
            {waiting.slice(0, 8).map((lead) => (
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
