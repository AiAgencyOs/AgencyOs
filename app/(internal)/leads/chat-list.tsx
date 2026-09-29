'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import {
  ChatListItem,
  cx,
  humanize,
  IconLeads,
  IconSearch,
  StatusBadge,
} from '@/ui';

import { BulkActionsBar, type BulkRoster } from './bulk-actions-bar';

/**
 * The chat list.
 *
 * Filtering happens here, in the browser, over a list the server already
 * fetched and already scoped — it narrows what is on screen and cannot widen
 * it. A round trip per keystroke would buy nothing: the page loads at most a
 * hundred leads, and RLS decided which hundred before this file saw them.
 *
 * Every date arrives pre-formatted from the server. Formatting a "yesterday"
 * on both sides of hydration is how you get a timestamp that renders one way
 * on the server and another in the browser, and React tears the tree apart
 * over it.
 */

export type ChatLead = {
  id: string;
  title: string;
  status: string;
  source: string;
  contactName: string | null;
  company: string | null;
  /** Already formatted server-side. */
  time: string;
  /** SCR-006: what the bulk actions read and the row shows. */
  ownerName?: string | null;
  tags?: string[];
  /** Already formatted server-side, or null when no budget is on file. */
  budget?: string | null;
};

/**
 * SCR-006's multi-select. Present only when the page decided the role may
 * do at least one of the three bulk actions; the checkboxes are otherwise
 * not drawn at all.
 */
export type BulkConfig = {
  roster: BulkRoster;
  statuses: readonly string[];
  nurtureReasons: readonly string[];
  canAssign: boolean;
  canWrite: boolean;
};

export function LeadChatList({ leads, bulk }: { leads: ChatLead[]; bulk?: BulkConfig }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string>('all');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const statuses = useMemo(() => {
    const seen = new Map<string, number>();
    for (const l of leads) seen.set(l.status, (seen.get(l.status) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [leads]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return leads.filter((l) => {
      if (status !== 'all' && l.status !== status) return false;
      if (!q) return true;
      return (
        l.title.toLowerCase().includes(q) ||
        (l.contactName ?? '').toLowerCase().includes(q) ||
        (l.company ?? '').toLowerCase().includes(q) ||
        l.source.toLowerCase().includes(q)
      );
    });
  }, [leads, query, status]);

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-[var(--wa-panel)] shadow-sm">
      {/* ── Search + filters ───────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-[var(--wa-divider)] px-3 py-2.5 sm:px-4">
        <div className="relative">
          <IconSearch
            size={17}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search leads, contacts or companies"
            aria-label="Search leads"
            className="h-10 w-full rounded-lg border border-transparent bg-surface-sunken pl-10 pr-3 text-[14px] text-foreground outline-none transition-colors placeholder:text-faint focus:border-[var(--wa-header)] focus:bg-surface"
          />
        </div>

        <div className="no-scrollbar snap-rail -mx-1 mt-2.5 flex gap-1.5 overflow-x-auto px-1">
          <FilterChip active={status === 'all'} onClick={() => setStatus('all')}>
            All {leads.length}
          </FilterChip>
          {statuses.map(([value, count]) => (
            <FilterChip
              key={value}
              active={status === value}
              onClick={() => setStatus(value)}
            >
              {humanize(value)} {count}
            </FilterChip>
          ))}
        </div>
      </div>

      {bulk ? (
        <div className="flex items-center gap-2 border-b border-[var(--wa-divider)] px-3 py-1.5 text-[12px] text-muted sm:px-4">
          <input
            type="checkbox"
            aria-label="Select every lead shown"
            checked={shown.length > 0 && shown.every((l) => selected.has(l.id))}
            onChange={(e) =>
              setSelected(e.target.checked ? new Set(shown.map((l) => l.id)) : new Set())
            }
          />
          <span>Select all shown ({shown.length})</span>
        </div>
      ) : null}

      {bulk && selected.size > 0 ? (
        <BulkActionsBar
          selected={[...selected]}
          roster={bulk.roster}
          statuses={bulk.statuses}
          nurtureReasons={bulk.nurtureReasons}
          canAssign={bulk.canAssign}
          canWrite={bulk.canWrite}
          onDone={() => setSelected(new Set())}
        />
      ) : null}

      {/* ── Rows ───────────────────────────────────────────────────────── */}
      {shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
          <IconLeads size={26} className="text-faint" />
          <p className="text-sm font-medium text-foreground">Nothing matches that</p>
          <p className="text-[13px] text-muted">
            {leads.length} lead{leads.length === 1 ? '' : 's'} are loaded — try a different
            search or filter.
          </p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {shown.map((lead) => (
            <li key={lead.id} className={cx(bulk && 'flex items-stretch')}>
              {bulk ? (
                <label className="flex shrink-0 items-center px-3 sm:pl-4">
                  <input
                    type="checkbox"
                    aria-label={`Select ${lead.title}`}
                    checked={selected.has(lead.id)}
                    onChange={() => toggle(lead.id)}
                  />
                </label>
              ) : null}
              <Link href={`/leads/${lead.id}`} className="block min-w-0 flex-1">
                <ChatListItem
                  name={lead.title}
                  time={lead.time}
                  preview={
                    lead.contactName ? (
                      <>
                        <span className="font-medium text-foreground/70">{lead.contactName}</span>
                        {lead.company ? ` · ${lead.company}` : ''}
                      </>
                    ) : (
                      <span className="italic">No contact recorded</span>
                    )
                  }
                  badge={<StatusBadge status={lead.status} />}
                  meta={
                    <>
                      <span className="text-[11px] text-faint">via {humanize(lead.source)}</span>
                      {lead.ownerName ? <span className="text-[11px] text-faint"> · {lead.ownerName}</span> : null}
                      {lead.budget ? <span className="text-[11px] text-faint"> · {lead.budget}</span> : null}
                      {lead.tags && lead.tags.length > 0 ? (
                        <span className="text-[11px] text-faint"> · {lead.tags.join(', ')}</span>
                      ) : null}
                    </>
                  }
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium whitespace-nowrap transition-colors',
        active
          ? 'bg-[var(--wa-header)] text-[var(--wa-header-fg)]'
          : 'bg-surface-sunken text-muted hover:bg-surface-hover hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
