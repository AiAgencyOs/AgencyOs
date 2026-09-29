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
import { requireInternal } from '@/lib/auth/session';
import {
  Badge,
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

export const metadata: Metadata = { title: 'Search' };

/**
 * Global search results — SCR-002. The ⌘K palette shows five matches per
 * entity; this is the page its "see all results" row lands on: every match
 * under the same capabilities and RLS, filterable by entity and by when the
 * row was created, with the record's id one click from the clipboard.
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

  const results = await searchRecords({ q, group, sinceDays: since?.days });

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
