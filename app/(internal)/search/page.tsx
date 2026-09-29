import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { isPreviewGroup } from '@/lib/admin/entity-preview-types';
import {
  groupResults,
  isSearchGroup,
  MIN_SEARCH_LENGTH,
  OWNER_COLUMN,
  SEARCH_GROUPS,
  SEARCH_SINCE,
  searchRecords,
  type SearchPageResult,
} from '@/lib/admin/global-search-page';
import { listMySearches, normalizeFilters } from '@/lib/admin/saved-searches';
import { requireInternal } from '@/lib/auth/session';
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
  type Column,
} from '@/ui';

import { PreviewButton, PreviewDrawerProvider } from '../preview-drawer';
import { CopyIdButton } from './copy-id-button';
import { AdvancedFilters } from './advanced-filters';
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
  searchParams: Promise<{ q?: string; type?: string; since?: string; owner?: string; status?: string }>;
}) {
  await requireInternal('/search');
  const params = await searchParams;
  const clock = await agencyClock();

  const q = (params.q ?? '').trim();
  const group = isSearchGroup(params.type) ? params.type : undefined;
  const since = SEARCH_SINCE.find((s) => s.key === params.since);
  const owner = /^[0-9a-f-]{36}$/.test(params.owner ?? '') ? params.owner : undefined;
  const status = (params.status ?? '').trim().slice(0, 40) || undefined;

  const [results, mine, roster] = await Promise.all([
    searchRecords({ q, group, sinceDays: since?.days, ownerId: owner, status }),
    listMySearches(),
    listInternalRoster().catch(() => []),
  ]);
  const currentFilters = normalizeFilters({ type: group, since: since?.key });
  const alreadyNamed =
    q.length >= MIN_SEARCH_LENGTH
      ? (mine.saved.find((e) => e.query === q && e.filters.type === currentFilters.type && e.filters.since === currentFilters.since)?.name ?? null)
      : null;
  const filtered = Boolean(group || since || owner || status);
  const sections = groupResults(results);

  const href = (over: Partial<{ type: string; since: string; owner: string; status: string }>) => {
    const next = { q, type: group ?? '', since: since?.key ?? '', owner: owner ?? '', status: status ?? '', ...over };
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
            ? 'Leads, clients, projects, invoices, quotations, meetings and tasks — the same records the ⌘K palette matches, all of them.'
            : `${results.length} result${results.length === 1 ? '' : 's'} for “${q}”${sections.length > 1 ? ` across ${sections.length} types` : ''}.`
        }
      />

      <FilterBar clearHref={href({ type: '', since: '', owner: '', status: '' })} filtered={filtered}>
        <FilterSearch
          action="/search"
          defaultValue={q}
          placeholder="Search by lead title, client or project name, invoice number, quotation, meeting or task…"
          preserve={{ type: group, since: since?.key, owner, status }}
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

      {/* SCR-002 "Advanced filter builder": owner and status, as a GET form
          that carries the rest of the URL through. */}
      <AdvancedFilters
        q={q}
        type={group}
        since={since?.key}
        owner={owner}
        status={status}
        roster={roster.map((m) => ({ userId: m.userId, label: m.fullName || m.email }))}
        ownerApplies={group === undefined || OWNER_COLUMN[group] !== undefined}
      />

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
          action={
            <Link href="/dashboard" className={buttonClass('secondary', 'sm')}>
              Back to the Command Center
            </Link>
          }
        />
      ) : results.length === 0 ? (
        <EmptyState
          icon={<IconSearch size={22} />}
          title="No matches"
          description={`Nothing named like “${q}”${group ? ` among ${group.toLowerCase()}s` : ''}${since ? ` created in the ${since.label.toLowerCase()}` : ''}${status ? ` in status “${status}”` : ''}${owner ? ' owned by that person' : ''}.`}
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
                  {section.group}s
                  <Badge tone="neutral">{section.rows.length}</Badge>
                </span>
              }
              actions={
                group ? undefined : (
                  <Link href={href({ type: section.group })} className="text-xs font-medium text-brand hover:underline">
                    Only {section.group.toLowerCase()}s
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
