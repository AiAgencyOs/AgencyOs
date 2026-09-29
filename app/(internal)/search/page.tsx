import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import {
  isSearchGroup,
  MIN_SEARCH_LENGTH,
  SEARCH_GROUPS,
  SEARCH_SINCE,
  searchRecords,
  type SearchPageResult,
} from '@/lib/admin/global-search-page';
import { listMySearches, normalizeFilters } from '@/lib/admin/saved-searches';
import { requireInternal } from '@/lib/auth/session';
import {
  Badge,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  FilterBar,
  FilterChips,
  FilterSearch,
  IconSearch,
  PageHeader,
  type Column,
} from '@/ui';

import { CopyIdButton } from './copy-id-button';
import { RecordSearch, SaveSearchForm, SearchChip } from './saved-search-controls';

export const metadata: Metadata = { title: 'Search' };

/**
 * Global search results — SCR-002. The ⌘K palette shows five matches per
 * entity; this is the page its "see all results" row lands on: every match
 * under the same capabilities and RLS, filterable by entity and by when the
 * row was created, with the record's id one click from the clipboard.
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
  searchParams: Promise<{ q?: string; type?: string; since?: string }>;
}) {
  await requireInternal('/search');
  const params = await searchParams;
  const clock = await agencyClock();

  const q = (params.q ?? '').trim();
  const group = isSearchGroup(params.type) ? params.type : undefined;
  const since = SEARCH_SINCE.find((s) => s.key === params.since);

  const [results, mine] = await Promise.all([searchRecords({ q, group, sinceDays: since?.days }), listMySearches()]);
  const currentFilters = normalizeFilters({ type: group, since: since?.key });
  const alreadyNamed =
    q.length >= MIN_SEARCH_LENGTH
      ? (mine.saved.find((e) => e.query === q && e.filters.type === currentFilters.type && e.filters.since === currentFilters.since)?.name ?? null)
      : null;

  const href = (over: Partial<{ type: string; since: string }>) => {
    const next = { q, type: group ?? '', since: since?.key ?? '', ...over };
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) query.set(k, v);
    const s = query.toString();
    return `/search${s ? `?${s}` : ''}`;
  };

  const columns: Column<SearchPageResult>[] = [
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
        </>
      ),
    },
    { key: 'group', header: 'Type', badge: true, cell: (r) => <Badge tone="neutral">{r.group}</Badge> },
    {
      key: 'created',
      header: 'Created',
      align: 'right',
      cellClassName: 'text-muted',
      cell: (r) => clock.date(r.createdAt),
    },
    {
      key: 'id',
      header: 'Reference',
      align: 'right',
      cell: (r) => (
        <span className="flex items-center justify-end gap-2">
          <span className="font-mono text-[11px] text-faint">{r.id.slice(0, 8)}</span>
          <CopyIdButton id={r.id} />
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Search"
        description={
          q.length < MIN_SEARCH_LENGTH
            ? 'Leads, clients, projects and invoices — the same records the ⌘K palette matches, all of them.'
            : `${results.length} result${results.length === 1 ? '' : 's'} for “${q}”.`
        }
      />

      <FilterBar>
        <FilterSearch
          action="/search"
          defaultValue={q}
          placeholder="Search by lead title, client or project name, invoice number…"
          preserve={{ type: group, since: since?.key }}
        />
        <FilterChips
          options={[
            { key: 'all', label: 'All types', href: href({ type: '' }), active: !group },
            ...SEARCH_GROUPS.map((g) => ({ key: g, label: `${g}s`, href: href({ type: g }), active: group === g })),
          ]}
        />
        <FilterChips
          options={[
            { key: 'any', label: 'Any date', href: href({ since: '' }), active: !since },
            ...SEARCH_SINCE.map((s) => ({ key: s.key, label: s.label, href: href({ since: s.key }), active: since?.key === s.key })),
          ]}
        />
      </FilterBar>

      {q.length >= MIN_SEARCH_LENGTH ? (
        <div className="flex flex-wrap items-center gap-2">
          <RecordSearch q={q} type={group} since={since?.key} />
          <SaveSearchForm q={q} type={group} since={since?.key} alreadyNamed={alreadyNamed} />
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
        />
      ) : results.length === 0 ? (
        <EmptyState
          icon={<IconSearch size={22} />}
          title="No matches"
          description={`Nothing named like “${q}”${group ? ` among ${group.toLowerCase()}s` : ''}${since ? ` created in the ${since.label.toLowerCase()}` : ''}.`}
        />
      ) : (
        <DataTable rows={results} columns={columns} getKey={(r) => `${r.group}-${r.id}`} />
      )}
    </div>
  );
}
