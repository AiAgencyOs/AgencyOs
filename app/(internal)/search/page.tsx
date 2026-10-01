import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { isPreviewGroup } from '@/lib/admin/entity-preview-types';
import {
  conditionToParam,
  groupLabel,
  groupResults,
  isSearchGroup,
  MIN_SEARCH_LENGTH,
  OWNER_COLUMN,
  parseConditions,
  SEARCH_GROUPS,
  SEARCH_SINCE,
  searchRecords,
  type SearchPageResult,
} from '@/lib/admin/global-search-page';
import { listMySearches, normalizeFilters } from '@/lib/admin/saved-searches';
import { hasRole } from '@/lib/authz/permissions';
import { estimateBackfill, getSemanticPanel } from '@/lib/search/semantic-admin';
import { mergeResults, parseMode, scoreLabel, SEARCH_MODE_LABELS, SEARCH_MODES, type MatchedBy } from '@/lib/search/semantic-results';
import { semanticSearch, type SemanticOutcome } from '@/lib/search/semantic-search';
import { requireInternal } from '@/lib/auth/session';
import { AGENT_DEFINITIONS } from '@/modules/agents/registry';
import { listInternalRoster } from '@/modules/projects/queries';
import {
  Badge,
  buttonClass,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  FilterBar,
  FilterChips,
  FilterSearch,
  IconSearch,
  PageHeader,
  ProgressBar,
  type Column,
} from '@/ui';

import { PreviewButton, PreviewDrawerProvider } from '../preview-drawer';
import { CopyIdButton } from './copy-id-button';
import { AdvancedFilters } from './advanced-filters';
import { ConfirmBackfillForm, StopSemanticForm } from './semantic-controls';
import { RecordSearch, SaveSearchForm, SearchChip } from './saved-search-controls';

export const metadata: Metadata = { title: 'Search' };

/**
 * Global search results — SCR-002. The ⌘K palette shows five matches per
 * entity; this is the page its "see all results" row lands on: every match
 * under the same capabilities and RLS, filterable by entity and by when the
 * row was created, with the record's id one click from the clipboard.
 *
 * Bucket F (stream F-A) finished the screen: results are grouped into a
 * section per entity type (leads, clients, projects, invoices, quotations,
 * meetings, tasks); each row carries a Preview that opens the shared
 * `PreviewDrawer` on the record's own header; and the advanced filter
 * builder adds owner and status to type and date — every filter a URL
 * parameter, so a filtered search is something a person can save or send.
 *
 * Recent and saved searches (`core.saved_searches`) are the person's own: a
 * run search is recorded after render, "Save this search" names it, and
 * both lists appear here and in the palette.
 *
 * No rail entry: it is reached from the palette or by URL, and the phone
 * header falls back to the product name for a route the rail does not list.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string; since?: string; owner?: string; status?: string; mode?: string; backfill?: string; f?: string | string[] }>;
}) {
  const context = await requireInternal('/search');
  const isOwner = hasRole(context, 'owner');
  const params = await searchParams;
  const clock = await agencyClock();

  const q = (params.q ?? '').trim();
  const mode = parseMode(params.mode);
  const group = isSearchGroup(params.type) ? params.type : undefined;
  const since = SEARCH_SINCE.find((s) => s.key === params.since);
  const owner = /^[0-9a-f-]{36}$/.test(params.owner ?? '') ? params.owner : undefined;
  const status = (params.status ?? '').trim().slice(0, 40) || undefined;

  // The builder's conditions; the older single `owner=` / `status=` links still
  // work and are folded in as the first conditions.
  const conditions = [
    ...(owner ? [{ field: 'owner' as const, op: 'is', value: owner }] : []),
    ...(status ? [{ field: 'status' as const, op: 'is', value: status }] : []),
    ...parseConditions(params.f),
  ];
  const conditionParams = conditions.map(conditionToParam);
  const wantsKeyword = mode !== 'meaning';
  const wantsMeaning = mode !== 'keyword' && q.length >= MIN_SEARCH_LENGTH;
  const [keywordResults, meaningOutcome, mine, roster, panel] = await Promise.all([
    wantsKeyword ? searchRecords({ q, group, sinceDays: since?.days, conditions, agents: AGENT_DEFINITIONS }) : Promise.resolve([] as SearchPageResult[]),
    wantsMeaning ? semanticSearch({ q, group, sinceDays: since?.days, conditions, agents: AGENT_DEFINITIONS }) : Promise.resolve(null as SemanticOutcome | null),
    listMySearches(),
    listInternalRoster().catch(() => []),
    getSemanticPanel(),
  ]);
  // Each result says which mode found it; a keyword-only page is unchanged.
  const results: (SearchPageResult & { matched?: MatchedBy; score?: number })[] =
    mode === 'keyword' ? keywordResults : mergeResults(keywordResults, meaningOutcome?.results ?? []);
  const estimate = isOwner && params.backfill === 'confirm' && panel.provider ? await estimateBackfill(AGENT_DEFINITIONS) : null;
  const currentFilters = normalizeFilters({ type: group, since: since?.key, f: conditionParams });
  const alreadyNamed =
    q.length >= MIN_SEARCH_LENGTH
      ? (mine.saved.find((e) => e.query === q && e.filters.type === currentFilters.type && e.filters.since === currentFilters.since && (e.filters.f ?? []).join('|') === (currentFilters.f ?? []).join('|'))?.name ?? null)
      : null;
  const filtered = Boolean(group || since || conditions.length > 0);
  const sections = groupResults(results);

  const href = (over: Partial<{ type: string; since: string; owner: string; status: string; mode: string }>) => {
    const next = { q, type: group ?? '', since: since?.key ?? '', mode: mode === 'keyword' ? '' : mode, ...over };
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) query.set(k, v);
    // Conditions ride along unless the caller clears them (owner/status '' = clear all).
    if (!('owner' in over) && !('status' in over)) for (const c of conditionParams) query.append('f', c);
    const s = query.toString();
    return `/search${s ? `?${s}` : ''}`;
  };

  const columns: Column<SearchPageResult & { matched?: MatchedBy; score?: number }>[] = [
    {
      key: 'label',
      header: 'Record',
      primary: true,
      cell: (r) => (
        <>
          <Link href={r.href} className="block font-medium text-foreground hover:underline">
            {r.label}
          </Link>
          {r.detail ? <span className="block text-xs text-muted">{r.detail}</span> : null}
          {mode !== 'keyword' && r.matched ? (
            <Badge tone={r.matched === 'keyword' ? 'neutral' : r.matched === 'both' ? 'success' : 'info'} className="mt-1">
              {r.matched === 'keyword' ? 'Keyword match' : r.matched === 'both' ? `Keyword and meaning${scoreLabel(r.score) ? ` · ${scoreLabel(r.score)}` : ''}` : `Meaning match${scoreLabel(r.score) ? ` · ${scoreLabel(r.score)}` : ''}`}
            </Badge>
          ) : null}
        </>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      align: 'right',
      cellClassName: 'text-muted',
      cell: (r) => (r.createdAt ? clock.date(r.createdAt) : 'Defined in code'),
    },
    {
      key: 'id',
      header: 'Reference',
      align: 'right',
      cell: (r) => (
        <span className="flex items-center justify-end gap-2">
          <span className="font-mono text-[11px] text-faint">{r.id.slice(0, 8)}</span>
          <CopyIdButton id={r.id} />
          {isPreviewGroup(r.group) ? <PreviewButton group={r.group} id={r.id} /> : null}
        </span>
      ),
    },
  ];

  return (
    <PreviewDrawerProvider>
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Search"
        description={
          q.length < MIN_SEARCH_LENGTH
            ? 'Leads, clients, projects, invoices, quotations, meetings, tasks, requirements, files, agents and audit events — the records your role may already open.'
            : `${results.length} result${results.length === 1 ? '' : 's'} for “${q}”${sections.length > 1 ? ` across ${sections.length} types` : ''}.`
        }
      />

      <FilterBar clearHref={href({ type: '', since: '', owner: '', status: '' })} filtered={filtered}>
        <FilterSearch
          action="/search"
          defaultValue={q}
          placeholder="Search by name, number, title, file, agent or audit action…"
          preserve={{ type: group, since: since?.key, mode: mode === 'keyword' ? undefined : mode }}
        />
        <FilterChips
          options={SEARCH_MODES.map((m) => ({ key: m, label: SEARCH_MODE_LABELS[m], href: href({ mode: m === 'keyword' ? '' : m }), active: mode === m }))}
        />
        <FilterChips
          options={[
            { key: 'all', label: 'All types', href: href({ type: '' }), active: !group },
            ...SEARCH_GROUPS.map((g) => ({ key: g, label: groupLabel(g), href: href({ type: g }), active: group === g })),
          ]}
        />
        <FilterChips
          options={[
            { key: 'any', label: 'Any date', href: href({ since: '' }), active: !since },
            ...SEARCH_SINCE.map((s) => ({ key: s.key, label: s.label, href: href({ since: s.key }), active: since?.key === s.key })),
          ]}
        />
      </FilterBar>

      {/* SCR-002 "Advanced filter builder": owner and status, as a GET form
          that carries the rest of the URL through. */}
      <AdvancedFilters
        q={q}
        type={group}
        since={since?.key}
        mode={mode === 'keyword' ? undefined : mode}
        conditions={conditionParams}
        roster={roster.map((m) => ({ userId: m.userId, label: m.fullName || m.email }))}
        ownerApplies={group === undefined || OWNER_COLUMN[group] !== undefined}
      />

      <SemanticCard
        panel={panel}
        isOwner={isOwner}
        confirmHref={href({ mode: mode === 'keyword' ? 'meaning' : mode }) + (href({}).includes('?') ? '&' : '?') + 'backfill=confirm'}
        cancelHref={href({})}
        estimate={estimate}
        confirming={params.backfill === 'confirm'}
      />

      {mode !== 'keyword' && meaningOutcome?.off ? (
        <p role="status" className="rounded-xl border border-line bg-surface-sunken px-4 py-3 text-[13px] text-muted">
          {meaningOutcome.off.message}
        </p>
      ) : null}
      {mode !== 'keyword' && meaningOutcome?.indexing ? (
        <p role="status" className="rounded-xl border border-line bg-surface-sunken px-4 py-3 text-[13px] text-muted">
          Meaning results may be incomplete: records are still being indexed ({panel.done.toLocaleString('en-IN')} of about {panel.total.toLocaleString('en-IN')} so far).
        </p>
      ) : null}

      {q.length >= MIN_SEARCH_LENGTH ? (
        <div className="flex flex-wrap items-center gap-2">
          <RecordSearch q={q} type={group} since={since?.key} f={conditionParams} />
          <SaveSearchForm q={q} type={group} since={since?.key} f={conditionParams} alreadyNamed={alreadyNamed} />
        </div>
      ) : null}

      {mine.saved.length > 0 || mine.recent.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Saved searches" description={mine.saved.length === 0 ? 'Name a search to keep it here.' : 'Yours alone — a click re-runs it with its filters.'} />
            {mine.saved.length > 0 ? (
              <div className="flex flex-wrap gap-2 px-4 pb-4 sm:px-5">
                {mine.saved.map((e) => (
                  <SearchChip key={e.id} entry={e} />
                ))}
              </div>
            ) : null}
          </Card>
          <Card>
            <CardHeader title="Recent searches" description={mine.recent.length === 0 ? 'Nothing run yet.' : 'The last twenty, most recent first.'} />
            {mine.recent.length > 0 ? (
              <div className="flex flex-wrap gap-2 px-4 pb-4 sm:px-5">
                {mine.recent.map((e) => (
                  <SearchChip key={e.id} entry={e} />
                ))}
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}

      {q.length < MIN_SEARCH_LENGTH ? (
        <EmptyState
          icon={<IconSearch size={22} />}
          title="Type at least two characters"
          description="Results are the rows your role may already open from their own pages; nothing here widens that."
          action={
            <Link href="/dashboard" className={buttonClass('secondary', 'sm')}>
              Back to the Command Center
            </Link>
          }
        />
      ) : results.length === 0 && mode === 'meaning' && meaningOutcome?.off ? null : results.length === 0 ? (
        <EmptyState
          icon={<IconSearch size={22} />}
          title="No matches"
          description={`Nothing named like “${q}”${group ? ` among ${groupLabel(group).toLowerCase()}` : ''}${since ? ` created in the ${since.label.toLowerCase()}` : ''}${conditions.length > 0 ? ` matching ${conditions.length} filter condition${conditions.length === 1 ? '' : 's'}` : ''}.`}
          action={
            filtered ? (
              <Link href={href({ type: '', since: '', owner: '', status: '' })} className={buttonClass('secondary', 'sm')}>
                Clear filters
              </Link>
            ) : (
              <Link href="/leads" className={buttonClass('secondary', 'sm')}>
                Open leads
              </Link>
            )
          }
        />
      ) : (
        // SCR-002 "Result sections grouped by entity type": one section per
        // type, in the order the type chips list them.
        sections.map((section) => (
          <Card key={section.group}>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  {groupLabel(section.group)}
                  <Badge tone="neutral">{section.rows.length}</Badge>
                </span>
              }
              actions={
                group ? undefined : (
                  <Link href={href({ type: section.group })} className="text-xs font-medium text-brand hover:underline">
                    Only {groupLabel(section.group).toLowerCase()}
                  </Link>
                )
              }
            />
            <div className="px-4 pb-4 sm:px-5">
              <DataTable dense rows={section.rows} columns={columns} getKey={(r) => `${r.group}-${r.id}`} stickyHeader={false} />
            </div>
          </Card>
        ))
      )}
    </div>
    </PreviewDrawerProvider>
  );
}

type Panel = Awaited<ReturnType<typeof getSemanticPanel>>;

/**
 * Search by meaning, its state and the owner's controls (decision 14). The
 * help text is the scaling limit, stated plainly: the vectors are scanned in
 * the database, which is right for tens of thousands of records; past that a
 * pgvector index is the upgrade.
 */
function SemanticCard({
  panel,
  isOwner,
  confirmHref,
  cancelHref,
  estimate,
  confirming,
}: {
  panel: Panel;
  isOwner: boolean;
  confirmHref: string;
  cancelHref: string;
  estimate: Awaited<ReturnType<typeof estimateBackfill>> | null;
  confirming: boolean;
}) {
  const pct = panel.total > 0 ? Math.min(100, (panel.done / panel.total) * 100) : panel.status === 'done' ? 100 : 0;
  const stateLabel = !panel.provider && !panel.enabled
    ? 'Off — no embedding key'
    : !panel.enabled
      ? 'Off'
      : panel.status === 'done'
        ? 'On — index up to date'
        : panel.status === 'blocked'
          ? 'On — paused'
          : 'On — indexing';
  const money = (minor: number) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Search by meaning
            <Badge tone={panel.enabled ? (panel.status === 'blocked' ? 'warning' : 'success') : 'neutral'}>{stateLabel}</Badge>
          </span>
        }
        description="Finds records by what they are about, not only by the words in their name. Choose Meaning or Both above; the ⌘K palette stays keyword-only."
      />
      <div className="flex flex-col gap-3 px-4 pb-4 text-[13px] text-muted sm:px-5">
        {panel.enabled ? (
          <div className="flex flex-col gap-1.5">
            <ProgressBar value={pct} tone={panel.status === 'blocked' ? 'warning' : 'success'} label="Records indexed for search by meaning" />
            <span>
              {panel.done.toLocaleString('en-IN')} of about {panel.total.toLocaleString('en-IN')} records indexed
              {panel.provider ? ` with ${panel.provider.model}` : ''}.{panel.note ? ` ${panel.note}` : ''}
            </span>
          </div>
        ) : !panel.provider ? (
          <p>No embedding key is configured. Add OPENAI_API_KEY or OPENROUTER_API_KEY in Settings › Keys & secrets, then the owner can turn this on. Keyword search is unaffected.</p>
        ) : (
          <p>Off. {isOwner ? 'Turning it on first shows what indexing every record is estimated to cost, and asks you to confirm.' : 'Only the owner can turn it on.'}</p>
        )}

        {confirming && isOwner ? (
          estimate && estimate.ok ? (
            <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface-sunken p-3">
              <p className="font-medium text-foreground">Estimate before anything is spent</p>
              <p>
                {estimate.data.truncated ? 'At least ' : ''}
                {estimate.data.records.toLocaleString('en-IN')} records, about {estimate.data.tokens.toLocaleString('en-IN')} tokens through {estimate.data.model} ({estimate.data.provider}).{' '}
                {estimate.data.costMinor === null
                  ? `No price is set for ${estimate.data.model} under Settings › Models, so the cost cannot be shown; set one to see it here.`
                  : `Estimated cost ${money(estimate.data.costMinor)}, charged to the AI cost ledger and held to the monthly budgets.`}
                {estimate.data.withheld > 0 ? ` ${estimate.data.withheld} field${estimate.data.withheld === 1 ? '' : 's'} that look like credentials will be left out.` : ''}
              </p>
              <p className="text-xs">{estimate.data.byGroup.filter((g) => g.records > 0).map((g) => `${g.group} ${g.records.toLocaleString('en-IN')}`).join(' · ')}</p>
              <ConfirmBackfillForm records={estimate.data.records} cancelHref={cancelHref} />
            </div>
          ) : (
            <p role="alert" className="text-danger">
              {estimate && !estimate.ok ? estimate.error.message : 'The estimate could not be made.'}
            </p>
          )
        ) : null}

        {isOwner && !confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            {!panel.enabled && panel.provider ? (
              <Link href={confirmHref} className={buttonClass('primary', 'sm')}>
                Index everything…
              </Link>
            ) : null}
            {panel.enabled ? <StopSemanticForm /> : null}
          </div>
        ) : null}

        <p className="text-xs">
          Limits: vectors are stored as plain number lists and compared inside the database over a bounded set of recent records. That is fast for tens of thousands of records and slows beyond that; a pgvector index is the upgrade when the agency outgrows it. Audit events from the last 90 days are indexed; credentials and secret fields are never sent.
        </p>
      </div>
    </Card>
  );
}
