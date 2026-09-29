'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Avatar, DataTable, StatusBadge, humanize, type Column, type SortDirection, type SortState } from '@/ui';

import { BulkActionsBar, type BulkRoster } from './bulk-actions-bar';

/**
 * The leads table with a selection column — SCR-006's multi-select.
 *
 * A client component only because a selection is client state; every value
 * it draws arrived pre-formatted from the server (dates through the agency
 * clock, budgets as money), so nothing here can disagree with the page
 * across hydration. The whole-row link the shared table offers is not used:
 * a checkbox inside a link toggles nothing, so the name cell is the link.
 */
export type BulkLeadRow = {
  id: string;
  name: string;
  subtitle: string;
  phone: string | null;
  source: string;
  status: string;
  assigned: string;
  /** Already formatted server-side. */
  lastActivity: string;
  /** Already formatted server-side. */
  created: string;
  budget: string | null;
  tags: string[];
  /** ADM-88 (reversed 2026-09-29): the stored score, or null when unscored. */
  score: number | null;
};

export function LeadBulkTable({
  rows,
  roster,
  statuses,
  nurtureReasons,
  canAssign,
  canWrite,
  sortKey,
  sortDirection,
  sortHrefPrefix,
}: {
  rows: BulkLeadRow[];
  roster: BulkRoster;
  statuses: readonly string[];
  nurtureReasons: readonly string[];
  canAssign: boolean;
  canWrite: boolean;
  sortKey?: string;
  sortDirection: SortDirection;
  /** The list URL with the kept filters and a trailing `?` or `&`, so `sort=…&dir=…` can be appended. */
  sortHrefPrefix: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // Built here rather than passed: a function is not serialisable across
  // the server → client boundary, but a URL prefix is.
  const sort: SortState = {
    key: sortKey,
    direction: sortDirection,
    makeHref: (key, direction) => `${sortHrefPrefix}sort=${key}&dir=${direction}`,
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allShownSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const columns: Column<BulkLeadRow>[] = [
    {
      key: 'select',
      header: '',
      width: 'w-8',
      cell: (l) => (
        <input
          type="checkbox"
          aria-label={`Select ${l.name}`}
          checked={selected.has(l.id)}
          onChange={() => toggle(l.id)}
        />
      ),
    },
    {
      key: 'title',
      header: 'Name',
      primary: true,
      cell: (l) => (
        <span className="flex items-center gap-2.5">
          <Avatar name={l.name} size="md" />
          <span className="min-w-0">
            <Link href={`/leads/${l.id}`} className="block truncate hover:text-brand">
              {l.name}
            </Link>
            <span className="block truncate text-xs font-normal text-muted">{l.subtitle}</span>
          </span>
        </span>
      ),
    },
    { key: 'phone', header: 'Phone', desktopOnly: true, cellClassName: 'font-mono text-xs text-muted', cell: (l) => l.phone ?? '—' },
    { key: 'source', header: 'Source', desktopOnly: true, cellClassName: 'text-muted', cell: (l) => humanize(l.source) },
    { key: 'status', header: 'Status', badge: true, cell: (l) => <StatusBadge status={l.status} /> },
    { key: 'assigned', header: 'Assigned', desktopOnly: true, cellClassName: 'text-muted', cell: (l) => l.assigned },
    {
      key: 'budget',
      header: 'Budget',
      align: 'right',
      desktopOnly: true,
      cellClassName: 'tabular text-muted',
      cell: (l) => l.budget ?? '—',
    },
    {
      key: 'tags',
      header: 'Tags',
      desktopOnly: true,
      cellClassName: 'text-xs text-muted',
      cell: (l) => (l.tags.length > 0 ? l.tags.join(', ') : '—'),
    },
    { key: 'score', header: 'Score', align: 'right', cellClassName: 'tabular', cell: (l) => (l.score === null ? <span className="text-muted">—</span> : l.score), sortKey: 'score' },
    { key: 'created', header: 'Created', align: 'right', cellClassName: 'text-muted', cell: (l) => l.created, sortKey: 'created' },
    { key: 'activity', header: 'Last activity', align: 'right', cellClassName: 'text-muted', cell: (l) => l.lastActivity, sortKey: 'activity' },
  ];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <input
          type="checkbox"
          aria-label="Select every lead shown"
          checked={allShownSelected}
          onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
        />
        <span>Select all shown ({rows.length})</span>
      </div>

      {selected.size > 0 ? (
        <div className="overflow-hidden rounded-xl border border-line">
          <BulkActionsBar
            selected={[...selected]}
            roster={roster}
            statuses={statuses}
            nurtureReasons={nurtureReasons}
            canAssign={canAssign}
            canWrite={canWrite}
            onDone={() => setSelected(new Set())}
          />
        </div>
      ) : null}

      <DataTable rows={rows} columns={columns} getKey={(l) => l.id} sort={sort} />
    </div>
  );
}
