'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Avatar, Badge, Card, DataTable, StatusBadge, humanize, type Column, type SortDirection, type SortState } from '@/ui';

import { LeadPreviewButton } from './preview-drawer';
import { BulkActionsBar, type BulkRoster } from './bulk-actions-bar';
import { LeadFlags, type LeadFlagsData } from './lead-flags';
import { MergeDuplicateButton } from './merge-duplicate-button';

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
  email: string | null;
  /** The lead's recorded service — the reference's "Interested In". */
  service: string | null;
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
  /** SCR-006: consent, handoff, reply-waiting and duplicate indicators. */
  flags: LeadFlagsData;
  /** The other live leads on the same contact, for the row's merge entry. */
  duplicates: { id: string; title: string }[];
};

export function LeadBulkTable({
  rows,
  roster,
  statuses,
  nurtureReasons,
  canAssign,
  canWrite,
  canMerge,
  sortKey,
  sortDirection,
  sortHrefPrefix,
  detailsHrefPrefix,
}: {
  rows: BulkLeadRow[];
  roster: BulkRoster;
  statuses: readonly string[];
  nurtureReasons: readonly string[];
  canAssign: boolean;
  canWrite: boolean;
  /** `organization.settings` — the owner-only merge door. */
  canMerge: boolean;
  sortKey?: string;
  sortDirection: SortDirection;
  /** The list URL with the kept filters and a trailing `?` or `&`, so `sort=…&dir=…` can be appended. */
  sortHrefPrefix: string;
  /** The list URL with the kept filters and a trailing `?` or `&`, so `lead=<id>` selects a row for the Lead Details rail. */
  detailsHrefPrefix: string;
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
          <Avatar name={l.name} size="sm" />
          <span className="min-w-0">
            <Link href={`/leads/${l.id}`} className="block max-w-[5.5rem] truncate hover:text-brand">
              {l.name}
            </Link>
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
          <span className="block max-w-[5.5rem] truncate">{l.email ?? '—'}</span>
          <span className="block">{l.phone ?? ''}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      badge: true,
      sortKey: 'score',
      cell: (l) => (
        <span className="flex flex-col items-start gap-1">
          <StatusBadge status={l.status} />
          <span className="tabular text-[11px] text-muted">{l.score === null ? 'Unscored' : `Score ${l.score}`}</span>
        </span>
      ),
    },
    { key: 'flags', header: 'Flags', desktopOnly: true, cell: (l) => <LeadFlags flags={l.flags} /> },
    {
      key: 'interest',
      header: 'Interested In',
      desktopOnly: true,
      cellClassName: 'text-muted',
      cell: (l) => (
        <span className="block min-w-0">
          <span className="block max-w-[5.5rem] truncate">{l.service ?? '—'}</span>
        </span>
      ),
    },
    { key: 'budget', header: 'Budget', desktopOnly: true, cellClassName: 'tabular whitespace-nowrap text-[12px] text-muted', cell: (l) => l.budget ?? '—' },
    {
      key: 'tags',
      header: 'Tags',
      desktopOnly: true,
      cell: (l) =>
        l.tags.length === 0 ? (
          <span className="text-muted">—</span>
        ) : (
          <span className="flex max-w-[4.5rem] gap-1 overflow-hidden">
            {l.tags.slice(0, 1).map((t) => (
              <Badge key={t} tone="info" dot={false}>{t}</Badge>
            ))}
            {l.tags.length > 1 ? <span className="text-xs text-muted">+{l.tags.length - 1}</span> : null}
          </span>
        ),
    },
    {
      key: 'assigned',
      header: 'Assigned To',
      desktopOnly: true,
      cell: (l) =>
        l.assigned === 'Unassigned' ? (
          <span className="text-muted">Unassigned</span>
        ) : (
          <span className="flex items-center gap-2">
            <Avatar name={l.assigned} size="sm" />
            <span className="hidden max-w-[5rem] truncate min-[1800px]:inline">{l.assigned.split('@')[0]}</span>
          </span>
        ),
    },
    { key: 'created', header: 'Created On', cellClassName: 'text-muted whitespace-nowrap', cell: (l) => l.created, sortKey: 'created' },
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

      <Card className="px-1 pb-1">
      <DataTable
        dense
        tight
        rows={rows}
        columns={columns}
        getKey={(l) => l.id}
        sort={sort}
        rowActions={(l) => [
          { key: 'preview', label: 'Preview', node: <LeadPreviewButton leadId={l.id} name={l.name} /> },
          { key: 'details', label: 'Show details', href: `${detailsHrefPrefix}lead=${l.id}` },
          { key: 'open', label: 'Open lead', href: `/leads/${l.id}` },
          { key: 'conversation', label: 'Open conversation', href: `/leads/${l.id}?tab=conversation` },
          ...(canMerge && l.duplicates.length > 0 ? [{ key: 'merge', label: 'Merge duplicate', node: <MergeDuplicateButton leadId={l.id} name={l.name} duplicates={l.duplicates} /> }] : []),
          { key: 'meeting', label: 'Request a meeting', href: `/leads/${l.id}#meetings` },
          { key: 'quotation', label: 'Quotations', href: `/leads/${l.id}#quotations` },
        ]}
      />
      </Card>
    </div>
  );
}
