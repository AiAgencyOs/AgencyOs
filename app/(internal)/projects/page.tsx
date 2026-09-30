import type { Metadata } from 'next';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { isLate, projectHealth } from '@/lib/admin/project-health';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { normaliseSearch } from '@/lib/db/search';
import { can } from '@/lib/authz/permissions';
import { listPendingPaymentClaims } from '@/modules/finance/queries';
import { HEALTH_FILTERS, LIFECYCLE_PHASE_LABEL, LIFECYCLE_PHASES, healthOf, type HealthFilter, type LifecyclePhase } from '@/modules/projects/project-archive-schema';
import { readProjectFilterFacets } from '@/modules/projects/project-filters-queries';
import { readProjectLifecycles } from '@/modules/projects/project-lifecycle-queries';
import { listPhaseFourEscalations, listProjectsForTable } from '@/modules/projects/queries';
import { PROJECT_STATUSES } from '@/modules/projects/schema';
import { SavedViewsBar } from '../saved-views-bar';
import Link from 'next/link';

import {
  Avatar,
  Badge,
  buttonClass,
  DataTable,
  DEFAULT_PAGE_SIZE,
  EmptyState,
  FilterBar,
  FilterChips,
  humanize,
  IconAlert,
  IconInvoices,
  IconProjects,
  labelClass,
  paginate,
  Pagination,
  PageHeader,
  ProgressBar,
  Stat,
  StatGrid,
  StatusBadge,
  statusTone,
  type Column,
  PermissionDenied,
  selectClass,
  sortRows,
  type SortDirection,
  DomainSearch,
  SearchSummary,
} from '@/ui';

import { ArchiveProjectButton } from './archive-button';

export const metadata: Metadata = { title: 'Projects' };

function money(minor: number | null, currency: string): string {
  if (minor === null) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 })
    .format(minor / 100);
}

type Row = Awaited<ReturnType<typeof listProjectsForTable>>[number] & { phase: LifecyclePhase; health: HealthFilter; archivedAt: string | null };

const HEALTH_LABEL: Record<HealthFilter, string> = { healthy: 'Healthy', at_risk: 'At risk', blocked: 'Blocked' };
const HEALTH_TONE: Record<HealthFilter, 'success' | 'warning' | 'danger'> = { healthy: 'success', at_risk: 'warning', blocked: 'danger' };

const columnsFor = (clock: AgencyClock, mayArchive: boolean): Column<Row>[] => [
  {
    key: 'name',
    header: 'Project name',
    primary: true,
    cell: (p) => (
      <span className="flex items-center gap-2.5">
        <Avatar name={p.name} size="md" square tone="sidebar" />
        <span className="min-w-0">
          <span className="block truncate">{p.name}</span>
          <span className="block truncate font-mono text-[11px] font-normal text-muted">{p.code}</span>
        </span>
      </span>
    ),
  },
  { key: 'client', header: 'Client', desktopOnly: true, cellClassName: 'text-muted', cell: (p) => p.clientName ?? 'Internal' },
  {
    key: 'status',
    header: 'Stage',
    badge: true,
    // SCR-018: the pause/cancel reason rides on the chip's title.
    cell: (p) =>
      p.statusReason ? (
        <span title={p.statusReason} className="inline-flex cursor-help">
          <StatusBadge status={p.status} dot={false} />
        </span>
      ) : (
        <StatusBadge status={p.status} dot={false} />
      ),
  },
  // SCR-018: the lifecycle phase (derived from the phase tables) and health.
  { key: 'phase', header: 'Phase', badge: true, cell: (p) => <Badge tone={p.phase === 'archived' ? 'neutral' : 'info'}>{LIFECYCLE_PHASE_LABEL[p.phase]}</Badge> },
  { key: 'health', header: 'Health', badge: true, desktopOnly: true, cell: (p) => <Badge tone={HEALTH_TONE[p.health]} dot>{HEALTH_LABEL[p.health]}</Badge> },
  {
    key: 'progress',
    header: 'Progress',
    width: '11rem',
    cell: (p) =>
      p.milestonesTotal > 0 ? (
        <ProgressBar value={(p.milestonesMet / p.milestonesTotal) * 100} label={`${p.name} milestones met`} />
      ) : (
        <span className="text-xs text-muted">No plan yet</span>
      ),
  },
  {
    key: 'due',
    header: 'Due date',
    align: 'right',
    cellClassName: 'text-muted whitespace-nowrap',
    cell: (p) => (p.endsOn ? clock.date(p.endsOn) : '—'),
    sortKey: 'due',
  },
  {
    key: 'budget',
    header: 'Budget',
    align: 'right',
    cellClassName: 'tabular',
    cell: (p) => money(p.budget_minor, p.currency),
    sortKey: 'budget',
  },
  {
    key: 'created',
    header: 'Created',
    align: 'right',
    desktopOnly: true,
    cellClassName: 'text-muted whitespace-nowrap',
    cell: (p) => clock.date(p.created_at),
    sortKey: 'created',
  },
  ...(mayArchive
    ? [
        {
          key: 'archive',
          header: '',
          align: 'right' as const,
          // SCR-018: archive a COMPLETED project. The door refuses any other status.
          cell: (p: Row) => (p.status === 'completed' && !p.archivedAt ? <ArchiveProjectButton projectId={p.id} projectName={p.name} compact /> : p.archivedAt ? <span className="text-xs text-muted">archived {clock.date(p.archivedAt)}</span> : null),
        },
      ]
    : []),
];

/** Not yet finished and not abandoned — what `?status=open` lists. */
const OPEN_STATUSES = new Set(['planning', 'onboarding', 'active', 'on_hold']);

const COMPARATORS: Record<string, (a: Row, b: Row) => number> = {
  budget: (a, b) => (a.budget_minor ?? 0) - (b.budget_minor ?? 0),
  created: (a, b) => a.created_at.localeCompare(b.created_at),
  due: (a, b) => (a.endsOn ?? '9999').localeCompare(b.endsOn ?? '9999'),
};

function isPhase(value: string | undefined): value is LifecyclePhase {
  return (LIFECYCLE_PHASES as readonly string[]).includes(value ?? '');
}
function isHealth(value: string | undefined): value is HealthFilter {
  return (HEALTH_FILTERS as readonly string[]).includes(value ?? '');
}

/**
 * Delivery pipeline. Same two-layer gate as the other internal pages.
 *
 * SCR-018: `?client=` and `?owner=` narrow the table by client account and
 * delivery lead through a GET form, the same shape the status chips use, so
 * a filtered list is a URL somebody can send. `?phase=` filters on the
 * lifecycle phase (derived from the phase tables, never stored), `?health=`
 * on healthy / at risk / blocked, and `?archived=1` shows archived
 * projects, which are otherwise hidden. Every KPI tile opens the list
 * filtered to exactly its number.
 */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; sort?: string; dir?: string; status?: string; client?: string; owner?: string; phase?: string; health?: string; archived?: string; q?: string }>;
}) {
  const context = await requireInternal('/projects');
  const clock = await agencyClock();
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const { page: pageParam, sort: sortKey, dir, status, client, owner, phase: rawPhase, health: rawHealth, archived, q: qRaw } = await searchParams;
  // Search within domain (bucket G-3): `?q=` goes to the reader, which filters server-side.
  const q = normaliseSearch(qRaw);
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  const phase = isPhase(rawPhase) ? rawPhase : undefined;
  const health = isHealth(rawHealth) ? rawHealth : undefined;
  const showArchived = archived === '1' || phase === 'archived';
  const facetQuery = [q ? `q=${encodeURIComponent(q)}` : '', client ? `client=${client}` : '', owner ? `owner=${owner}` : '', phase ? `phase=${phase}` : '', health ? `health=${health}` : '', showArchived && phase !== 'archived' ? 'archived=1' : '']
    .filter(Boolean)
    .join('&');
  const currentQuery = [status ? `status=${status}` : '', facetQuery, sortKey ? `sort=${sortKey}&dir=${direction}` : ''].filter(Boolean).join('&');
  // The same URL with only the search dropped — "Clear search" keeps the facets.
  const withoutSearch = [status ? `status=${status}` : '', ...facetQuery.split('&').filter((p) => p && !p.startsWith('q='))].filter(Boolean).join('&');
  const [rawProjects, savedViews, escalations, pendingClaims, facets, lifecycles] = await Promise.all([
    listProjectsForTable(200, q || undefined),
    listSavedViews('/projects'),
    listPhaseFourEscalations(),
    can(context, 'invoice.issue') ? listPendingPaymentClaims() : Promise.resolve([]),
    readProjectFilterFacets(),
    readProjectLifecycles(),
  ]);
  // The one at-risk rule, shared with the Command Center's project health
  // column (bucket F): escalated, or past its end date while still open.
  const todayKey = clock.dayKey(new Date());
  const escalatedIds = new Set(escalations.map((e) => e.projectId));
  const late = rawProjects.filter((p) => isLate({ status: p.status, endsOn: p.endsOn, todayKey }));
  const atRiskIds = new Set(
    rawProjects.filter((p) => projectHealth({ status: p.status, endsOn: p.endsOn, escalated: escalatedIds.has(p.id), todayKey }) === 'at_risk').map((p) => p.id),
  );
  const paymentBlockedIds = new Set(pendingClaims.map((c) => c.projectId));

  const everything: Row[] = rawProjects.map((p) => {
    const life = lifecycles.get(p.id);
    return {
      ...p,
      phase: life?.phase ?? (p.status === 'completed' ? 'completed' : 'onboarding'),
      archivedAt: life?.archivedAt ?? null,
      health: healthOf({ atRisk: atRiskIds.has(p.id) || paymentBlockedIds.has(p.id), blocked: life?.blocked ?? false }),
    };
  });
  // Archived projects stay out of every count and chip unless asked for.
  const allProjects = showArchived ? everything : everything.filter((p) => p.archivedAt === null);
  const archivedCount = everything.filter((p) => p.archivedAt !== null).length;
  const countByStatus = new Map<string, number>();
  for (const p of allProjects) countByStatus.set(p.status, (countByStatus.get(p.status) ?? 0) + 1);
  const countByPhase = new Map<LifecyclePhase, number>();
  for (const p of allProjects) countByPhase.set(p.phase, (countByPhase.get(p.phase) ?? 0) + 1);
  const blocked = allProjects.filter((p) => p.health === 'blocked');

  const filtered =
    status === 'at_risk'
      ? allProjects.filter((p) => atRiskIds.has(p.id))
      : status === 'payment_blocked'
        ? allProjects.filter((p) => paymentBlockedIds.has(p.id))
        : status === 'open'
          ? // Bucket F: the Command Center's "Active projects" tile — every
            // project not yet finished or abandoned, the same set it counts.
            allProjects.filter((p) => OPEN_STATUSES.has(p.status))
          : status
            ? allProjects.filter((p) => p.status === status)
            : allProjects;
  const faceted = filtered.filter((p) => {
    const f = facets.byProject.get(p.id);
    if (client && f?.clientAccountId !== client) return false;
    if (owner && f?.deliveryLeadId !== owner) return false;
    if (phase && p.phase !== phase) return false;
    if (health && p.health !== health) return false;
    return true;
  });
  const projects = sortRows(faceted, sortKey, direction, COMPARATORS);
  const qs = (extra: string) => `/projects?${status ? `status=${status}&` : ''}${facetQuery ? `${facetQuery}&` : ''}${extra}`;
  const chipHref = (s: string | null) => `/projects?${[s ? `status=${s}` : '', facetQuery].filter(Boolean).join('&')}`;
  const { page, pageCount, rows: pageRows } = paginate(projects, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);
  const mayArchive = can(context, 'project.write');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="All projects"
        description={
          allProjects.length === 0
            ? q
              ? `No project matches ‘${q}’.`
              : 'No projects yet. Winning a deal on a lead creates one.'
            : `Every project, its stage and how far its plan has come · ${allProjects.length} project${allProjects.length === 1 ? '' : 's'}${archivedCount > 0 && !showArchived ? ` · ${archivedCount} archived` : ''}.`
        }
      />

      {allProjects.length > 0 ? (
        <StatGrid cols={6}>
          <Stat label="Total projects" value={String(allProjects.length)} caption={`${countByStatus.get('completed') ?? 0} completed · ${countByStatus.get('cancelled') ?? 0} cancelled`} tone="brand" icon={<IconProjects size={16} />} href="/projects" />
          <Stat label="Active" value={String(countByStatus.get('active') ?? 0)} tone={statusTone('active')} href="/projects?status=active" />
          {/* SCR-018: a blocked count — a blocked task, an unmet plan dependency, an escalation or a hold. */}
          <Stat label="Blocked" value={String(blocked.length)} caption="Blocked work or an unmet dependency" tone={blocked.length > 0 ? 'danger' : 'success'} icon={<IconAlert size={16} />} href="/projects?health=blocked" />
          <Stat label="At risk" value={String(atRiskIds.size)} caption={`${escalations.length} escalated · ${late.length} past due`} tone={atRiskIds.size > 0 ? 'warning' : 'success'} icon={<IconAlert size={16} />} href="/projects?status=at_risk" />
          <Stat label="Completed" value={String(countByStatus.get('completed') ?? 0)} caption={archivedCount > 0 ? `${archivedCount} archived` : undefined} tone={statusTone('completed')} href="/projects?status=completed" />
          {can(context, 'invoice.issue') ? (
            <Stat label="Payment to verify" value={String(paymentBlockedIds.size)} caption={`${pendingClaims.length} claim${pendingClaims.length === 1 ? '' : 's'} waiting`} tone={paymentBlockedIds.size > 0 ? 'warning' : 'neutral'} icon={<IconInvoices size={16} />} href="/projects?status=payment_blocked" />
          ) : (
            <Stat label="On hold" value={String(countByStatus.get('on_hold') ?? 0)} tone={statusTone('on_hold')} href="/projects?status=on_hold" />
          )}
        </StatGrid>
      ) : null}

      {/* SCR-018: the lifecycle-phase distribution — each tile opens the list filtered to that phase. */}
      {allProjects.length > 0 ? (
        <StatGrid cols={6}>
          {LIFECYCLE_PHASES.filter((p) => p !== 'archived').map((p) => (
            <Stat key={p} label={LIFECYCLE_PHASE_LABEL[p]} value={String(countByPhase.get(p) ?? 0)} tone={phase === p ? 'brand' : 'neutral'} href={`/projects?phase=${p}`} />
          ))}
        </StatGrid>
      ) : null}

      {allProjects.length > 0 || archivedCount > 0 || q ? (
        <FilterBar clearHref="/projects" filtered={Boolean(status || client || owner || phase || health || showArchived || q)}>
          {/* Search within domain (bucket G-3): name or code, filtered by the reader. */}
          <DomainSearch action="/projects" value={q} placeholder="Search name or code…" label="Search projects" preserve={{ status, client, owner, phase, health, archived }} />
          <SearchSummary q={q} count={projects.length} clearHref={`/projects${withoutSearch ? `?${withoutSearch}` : ''}`} />
          <FilterChips
            options={[
              { key: 'all', label: 'All', href: chipHref(null), active: !status },
              { key: 'at_risk', label: `At risk (${atRiskIds.size})`, href: chipHref('at_risk'), active: status === 'at_risk' },
              ...PROJECT_STATUSES.map((s) => ({
                key: s,
                label: `${humanize(s)} (${countByStatus.get(s) ?? 0})`,
                href: chipHref(s),
                active: status === s,
              })),
            ]}
          />
          <form action="/projects" method="GET" className="flex flex-wrap items-end gap-2">
            {status ? <input type="hidden" name="status" value={status} /> : null}
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Client</span>
              <select name="client" defaultValue={client ?? ''} className={selectClass}>
                <option value="">Any client</option>
                {facets.clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Owner</span>
              <select name="owner" defaultValue={owner ?? ''} className={selectClass}>
                <option value="">Any owner</option>
                {facets.owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Phase</span>
              <select name="phase" defaultValue={phase ?? ''} className={selectClass}>
                <option value="">Any phase</option>
                {LIFECYCLE_PHASES.map((p) => (
                  <option key={p} value={p}>
                    {LIFECYCLE_PHASE_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Health</span>
              <select name="health" defaultValue={health ?? ''} className={selectClass}>
                <option value="">Any health</option>
                {HEALTH_FILTERS.map((h) => (
                  <option key={h} value={h}>
                    {HEALTH_LABEL[h]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 pb-2 text-[13px]">
              <input type="checkbox" name="archived" value="1" defaultChecked={showArchived} />
              Show archived ({archivedCount})
            </label>
            <button type="submit" className={buttonClass('secondary', 'sm')}>
              Filter
            </button>
            {client || owner || phase || health || showArchived ? (
              <Link href={status ? `/projects?status=${status}` : '/projects'} className={buttonClass('ghost', 'sm')}>
                Clear
              </Link>
            ) : null}
          </form>
        </FilterBar>
      ) : null}

      <SavedViewsBar page="/projects" currentQuery={currentQuery} views={savedViews} />

      {projects.length > 0 ? (
        <>
          <DataTable
            rows={pageRows}
            columns={columnsFor(clock, mayArchive)}
            getKey={(p) => p.id}
            href={(p) => `/projects/${p.id}`}
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
          icon={<IconProjects size={22} />}
          title={status || client || owner || phase || health ? 'No matching projects' : 'No projects yet'}
          description={
            client || owner
              ? 'No project matches the client or owner filter.'
              : phase
                ? `No project is in the ${LIFECYCLE_PHASE_LABEL[phase].toLowerCase()} phase.`
                : health
                  ? `No project is ${HEALTH_LABEL[health].toLowerCase()}.`
                  : status
                    ? `No project is currently "${humanize(status)}".`
                    : 'Projects created from won deals will appear here.'
          }
          action={status || client || owner || phase || health ? <Link href="/projects" className={buttonClass('secondary', 'sm')}>Clear filters</Link> : <Link href="/sales-funnel" className={buttonClass('secondary', 'sm')}>Open the sales funnel</Link>}
        />
      )}
    </div>
  );
}
