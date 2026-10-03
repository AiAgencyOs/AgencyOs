'use client';

import Link from 'next/link';
import { useActionState, useEffect, useId, useState } from 'react';

import type { SavedSearch } from '@/lib/admin/saved-searches';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, cx, FormMessage, IconClose, IconPlus } from '@/ui';

import { editSearchAction, forgetSearchAction, recordSearchAction, saveSearchAction } from './search-actions';

/**
 * Records a run search once per (q, type, since) after the results have
 * rendered — a write the page itself must not make on a GET.
 */
export function RecordSearch({ q, type, since, f }: { q: string; type?: string; since?: string; f?: string[] }) {
  useEffect(() => {
    if (q.trim().length < 2) return;
    recordSearchAction(q, { type, since, f }).catch(() => {
      /* a recent-search that failed to record costs nothing; the results are on screen */
    });
  }, [q, type, since, f?.join('|')]);
  return null;
}

/** "Save this search" — names the current query + filters. */
export function SaveSearchForm({ q, type, since, f, alreadyNamed }: { q: string; type?: string; since?: string; f?: string[]; alreadyNamed: string | null }) {
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
      {(f ?? []).map((c) => (
        <input key={c} type="hidden" name="f" value={c} />
      ))}
      <input
        type="text"
        name="name"
        aria-label="Search name"
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

/** One recent or saved entry as a chip with a remove button; a saved one can be renamed or re-queried. */
export function SearchChip({ entry }: { entry: SavedSearch }) {
  const [, action] = useActionState(forgetSearchAction, IDLE_STATE);
  const [editing, setEditing] = useState(false);
  const [editState, editAction, editPending] = useActionState(editSearchAction, IDLE_STATE);
  const uid = useId();
  useEffect(() => {
    if (editState.status === 'success') setEditing(false);
  }, [editState]);
  const conditionCount = entry.filters.f?.length ?? 0;
  const filterText = [
    entry.filters.type ? `${entry.filters.type}s` : null,
    entry.filters.since ? `last ${entry.filters.since} days` : null,
    conditionCount > 0 ? `${conditionCount} condition${conditionCount === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (editing && entry.name) {
    return (
      <form action={editAction} className="flex flex-wrap items-center gap-1.5 rounded-xl border border-line bg-surface p-2">
        <input type="hidden" name="id" value={entry.id} />
        <label htmlFor={`${uid}-n`} className="sr-only">Saved search name</label>
        <input id={`${uid}-n`} name="name" defaultValue={entry.name} required maxLength={60} className="w-36 rounded-full border border-line bg-surface px-3 py-1 text-[12.5px] outline-none focus:border-brand" />
        <label htmlFor={`${uid}-q`} className="sr-only">Saved search query</label>
        <input id={`${uid}-q`} name="q" defaultValue={entry.query} required minLength={2} maxLength={200} className="w-44 rounded-full border border-line bg-surface px-3 py-1 text-[12.5px] outline-none focus:border-brand" />
        <button type="submit" disabled={editPending} className={buttonClass('secondary', 'sm')}>
          {editPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={() => setEditing(false)} className={buttonClass('ghost', 'sm')}>
          Cancel
        </button>
        <FormMessage status={editState.status} message={editState.message} className="text-xs" />
      </form>
    );
  }
  return (
    <span className="group flex items-center gap-1 rounded-full border border-line bg-surface py-1 pl-3 pr-1 text-[12.5px]">
      <Link href={entry.href} className="hover:underline">
        {entry.name ?? entry.query}
        {entry.name ? <span className="ml-1 text-muted">“{entry.query}”</span> : null}
        {filterText ? <span className="ml-1 text-faint">({filterText})</span> : null}
      </Link>
      {entry.name ? (
        <button type="button" onClick={() => setEditing(true)} aria-label={`Edit saved search "${entry.name}"`} className="rounded-full px-1.5 py-0.5 text-[11px] text-muted hover:bg-surface-hover hover:text-foreground">
          Edit
        </button>
      ) : null}
      <form action={action}>
        <input type="hidden" name="id" value={entry.id} />
        <button
          type="submit"
          aria-label={`Remove search "${entry.name ?? entry.query}"`}
          className="rounded-full p-0.5 text-faint opacity-0 transition-opacity hover:bg-surface-hover hover:text-danger focus:opacity-100 group-hover:opacity-100"
        >
          <IconClose size={12} />
        </button>
      </form>
    </span>
  );
}
