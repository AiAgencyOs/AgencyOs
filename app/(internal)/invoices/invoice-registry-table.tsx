'use client';

import { useId, useState } from 'react';

import { Badge, DataTable, StatusBadge, buttonClass, type Column, type RowAction, type SortDirection, type SortState } from '@/ui';

import { PreviewButton } from '../preview-drawer';
import { ReminderHistoryButton, type ReminderHistoryEntry } from './reminder-history-drawer';

/**
 * The invoice registry with a selection column — PDF SCR-051 "bulk actions".
 *
 * A client component only because a selection is client state; every value
 * arrived pre-formatted from the server (dates through the agency clock,
 * money as text), so nothing here can disagree with the page across
 * hydration. The bulk action is the one that needs no new write path and is
 * safe on any selection: EXPORT — the same CSV route the page's Export button
 * uses, with `ids`. A selection is never sent to a door that moves money.
 */
export type RegistryRow = {
  id: string;
  number: string;
  status: string;
  needsReminder: boolean;
  kindLabel: string;
  milestoneLabel: string;
  lastSent: string;
  history: ReminderHistoryEntry[];
  totalLabel: string;
  verifiedLabel: string;
  /** Recorded but not yet verified, pre-formatted, or null when there is none. */
  awaitingLabel: string | null;
  issuedLabel: string;
  dueLabel: string;
  projectId: string | null;
  clientId: string;
  canVoid: boolean;
};

export function InvoiceRegistryTable({
  rows,
  sortKey,
  sortDirection,
  sortHrefPrefix,
  exportHref,
}: {
  rows: RegistryRow[];
  sortKey?: string;
  sortDirection: SortDirection;
  /** The list URL with the kept filters and a trailing `?` or `&`, so `sort=…&dir=…` can be appended. */
  sortHrefPrefix: string;
  /** The export route with the page's filters already applied, and a trailing `?` or `&`. */
  exportHref: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const allId = useId();
  const sort: SortState = { key: sortKey, direction: sortDirection, makeHref: (key, direction) => `${sortHrefPrefix}sort=${key}&dir=${direction}` };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allShownSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const columns: Column<RegistryRow>[] = [
    {
      key: 'select',
      header: '',
      width: '2rem',
      cell: (r) => <input type="checkbox" aria-label={`Select ${r.number}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />,
    },
    { key: 'number', header: 'Number', primary: true, cellClassName: 'font-mono text-xs', cell: (r) => r.number },
    { key: 'type', header: 'Type', cellClassName: 'text-muted whitespace-nowrap', cell: (r) => r.kindLabel },
    {
      key: 'status',
      header: 'Status',
      badge: true,
      cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <StatusBadge status={r.status} />
          {r.needsReminder ? <Badge tone="warning">needs reminder</Badge> : null}
        </span>
      ),
    },
    { key: 'milestone', header: 'Milestone', desktopOnly: true, cellClassName: 'text-muted', cell: (r) => r.milestoneLabel },
    { key: 'sent', header: 'Last sent', desktopOnly: true, cellClassName: 'text-muted', cell: (r) => r.lastSent },
    { key: 'history', header: 'Reminders', desktopOnly: true, cell: (r) => <ReminderHistoryButton invoiceId={r.id} number={r.number} entries={r.history} /> },
    { key: 'quick', header: '', align: 'right', desktopOnly: true, cell: (r) => <PreviewButton group="Invoice" id={r.id} /> },
    {
      key: 'pdf',
      header: '',
      align: 'right',
      desktopOnly: true,
      cell: (r) => (
        <a href={`/invoices/${r.id}#pdf-preview`} className="text-xs font-medium text-brand hover:underline">
          Preview PDF
        </a>
      ),
    },
    { key: 'total', header: 'Total', align: 'right', cellClassName: 'tabular font-medium', sortKey: 'total', cell: (r) => r.totalLabel },
    {
      key: 'verified',
      header: 'Verified',
      align: 'right',
      cellClassName: 'tabular text-muted',
      sortKey: 'paid',
      cell: (r) => (
        <span className="block">
          {r.verifiedLabel}
          {r.awaitingLabel ? <span className="block text-[11px] text-warning">+{r.awaitingLabel} unverified</span> : null}
        </span>
      ),
    },
    { key: 'issued', header: 'Issued', align: 'right', cellClassName: 'text-muted', sortKey: 'issued', cell: (r) => r.issuedLabel },
    { key: 'due', header: 'Due', align: 'right', cellClassName: 'text-muted', sortKey: 'due', cell: (r) => r.dueLabel },
  ];

  const actionsFor = (r: RegistryRow): RowAction[] => [
    { key: 'open', label: 'Open invoice', href: `/invoices/${r.id}` },
    { key: 'preview', label: 'Preview PDF', href: `/invoices/${r.id}#pdf-preview` },
    { key: 'pdf', label: 'Download PDF', href: `/api/invoices/${r.id}/pdf` },
    { key: 'send', label: 'Send or resend', href: `/invoices/${r.id}#send` },
    { key: 'remind', label: 'Issue a reminder', href: `/invoices/${r.id}#reminders` },
    ...(r.canVoid ? [{ key: 'void', label: 'Void…', href: `/invoices/${r.id}#void`, tone: 'danger' as const }] : []),
    ...(r.projectId ? [{ key: 'project', label: 'Open project', href: `/projects/${r.projectId}` }] : []),
    { key: 'client', label: 'Open client', href: `/clients/${r.clientId}` },
  ];

  const ids = [...selected];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-muted">
        <label htmlFor={allId} className="flex items-center gap-2">
          <input
            id={allId}
            type="checkbox"
            checked={allShownSelected}
            onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
          />
          Select every invoice shown
        </label>
        {ids.length > 0 ? (
          <span className="flex flex-wrap items-center gap-2" role="status">
            <span className="font-medium text-foreground">{ids.length} selected</span>
            <a href={`${exportHref}ids=${ids.join(',')}`} className={buttonClass('secondary', 'sm')}>
              Export selected (CSV)
            </a>
            <button type="button" onClick={() => setSelected(new Set())} className={buttonClass('ghost', 'sm')}>
              Clear selection
            </button>
          </span>
        ) : (
          <span>Select invoices to export them together.</span>
        )}
      </div>
      <DataTable rows={rows} columns={columns} getKey={(r) => r.id} rowActions={actionsFor} sort={sort} ariaLabel="Invoices" />
    </div>
  );
}
