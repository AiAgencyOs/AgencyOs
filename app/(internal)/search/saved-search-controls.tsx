'use client';

import Link from 'next/link';
import { useActionState, useEffect, useState } from 'react';

import type { SavedSearch } from '@/lib/admin/saved-searches';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, cx, FormMessage, IconClose, IconPlus } from '@/ui';

import { forgetSearchAction, recordSearchAction, saveSearchAction } from './search-actions';

/**
 * Records a run search once per (q, type, since) after the results have
 * rendered — a write the page itself must not make on a GET.
 */
export function RecordSearch({ q, type, since }: { q: string; type?: string; since?: string }) {
  useEffect(() => {
    if (q.trim().length < 2) return;
    recordSearchAction(q, { type, since }).catch(() => {
      /* a recent-search that failed to record costs nothing; the results are on screen */
    });
  }, [q, type, since]);
  return null;
}

/** "Save this search" — names the current query + filters. */
export function SaveSearchForm({ q, type, since, alreadyNamed }: { q: string; type?: string; since?: string; alreadyNamed: string | null }) {
  const [adding, setAdding] = useState(false);
  const [state, action, pending] = useActionState(saveSearchAction, IDLE_STATE);
  useEffect(() => {
    if (state.status === 'success') setAdding(false);
  }, [state]);

  if (alreadyNamed && state.status !== 'error') {
    return <span className="text-xs text-muted">Saved as “{alreadyNamed}”.</span>;
  }

  return adding ? (
    <form action={action} className="flex items-center gap-1.5">
      <input type="hidden" name="q" value={q} />
      {type ? <input type="hidden" name="type" value={type} /> : null}
      {since ? <input type="hidden" name="since" value={since} /> : null}
      <input
        type="text"
        name="name"
        required
        autoFocus
        maxLength={60}
        placeholder="Search name"
        className="w-36 rounded-full border border-line bg-surface px-3 py-1 text-[12.5px] outline-none focus:border-brand"
      />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : 'Save'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  ) : (
    <button
      type="button"
      onClick={() => setAdding(true)}
      className={cx('flex items-center gap-1 rounded-full border border-dashed border-line-strong px-3 py-1 text-[12.5px] text-muted transition-colors hover:border-line hover:text-foreground')}
    >
      <IconPlus size={12} />
      Save this search
    </button>
  );
}

/** One recent or saved entry as a chip with a remove button. */
export function SearchChip({ entry }: { entry: SavedSearch }) {
  const [, action] = useActionState(forgetSearchAction, IDLE_STATE);
  const filterText = [entry.filters.type ? `${entry.filters.type}s` : null, entry.filters.since ? `last ${entry.filters.since} days` : null].filter(Boolean).join(' · ');
  return (
    <span className="group flex items-center gap-1 rounded-full border border-line bg-surface py-1 pl-3 pr-1 text-[12.5px]">
      <Link href={entry.href} className="hover:underline">
        {entry.name ?? entry.query}
        {entry.name ? <span className="ml-1 text-muted">“{entry.query}”</span> : null}
        {filterText ? <span className="ml-1 text-faint">({filterText})</span> : null}
      </Link>
      <form action={action}>
        <input type="hidden" name="id" value={entry.id} />
        <button
          type="submit"
          aria-label={`Remove search "${entry.name ?? entry.query}"`}
          className="rounded-full p-0.5 text-faint opacity-0 transition-opacity hover:bg-surface-hover hover:text-danger group-hover:opacity-100"
        >
          <IconClose size={12} />
        </button>
      </form>
    </span>
  );
}
