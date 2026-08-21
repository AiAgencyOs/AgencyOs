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
};

export function LeadChatList({ leads }: { leads: ChatLead[] }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string>('all');

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
            <li key={lead.id}>
              <Link href={`/leads/${lead.id}`} className="block">
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
