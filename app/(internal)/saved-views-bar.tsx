'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, cx, IconClose, IconPlus } from '@/ui';
import type { SavedView } from '@/lib/admin/saved-views';

import { deleteSavedViewAction, saveViewAction } from './saved-views-actions';

/**
 * The shared filtering rule's "saved views for frequent workflows" —
 * one instance per list screen. `currentQuery` is that page's own
 * `useSearchParams`-free query string (the caller already builds it for its
 * own filter chips/sort links), so this component never re-derives what a
 * page's filters mean; it only names the string and hands the name back as
 * a link to the exact same query.
 */
export function SavedViewsBar({
  page,
  currentQuery,
  views,
}: {
  page: string;
  currentQuery: string;
  views: SavedView[];
}) {
  const [adding, setAdding] = useState(false);
  const [saveState, saveAction, savePending] = useActionState(saveViewAction, IDLE_STATE);
  const [, deleteAction] = useActionState(deleteSavedViewAction, IDLE_STATE);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {views.map((view) => (
        <span
          key={view.id}
          className="group flex items-center gap-1 rounded-full border border-line bg-surface py-1 pl-3 pr-1 text-[12.5px]"
        >
          <Link href={`${page}${view.query ? `?${view.query}` : ''}`} className="hover:underline">
            {view.name}
          </Link>
          <form action={deleteAction}>
            <input type="hidden" name="id" value={view.id} />
            <input type="hidden" name="page" value={page} />
            <button
              type="submit"
              aria-label={`Remove saved view "${view.name}"`}
              className="rounded-full p-0.5 text-faint opacity-0 transition-opacity hover:bg-surface-hover hover:text-danger group-hover:opacity-100"
            >
              <IconClose size={12} />
            </button>
          </form>
        </span>
      ))}

      {adding ? (
        <form
          action={saveAction}
          className="flex items-center gap-1.5"
          onSubmit={() => {
            // Optimistic close — a failed save still shows its message below,
            // re-opening costs one click and beats a form that never leaves.
            setAdding(false);
          }}
        >
          <input type="hidden" name="page" value={page} />
          <input type="hidden" name="query" value={currentQuery} />
          <input
            type="text"
            name="name"
            required
            autoFocus
            maxLength={60}
            placeholder="View name"
            className="w-32 rounded-full border border-line bg-surface px-3 py-1 text-[12.5px] outline-none focus:border-brand"
          />
          <button type="submit" disabled={savePending} className={buttonClass('secondary', 'sm')}>
            Save
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={cx(
            'flex items-center gap-1 rounded-full border border-dashed border-line-strong px-3 py-1 text-[12.5px] text-muted transition-colors hover:border-line hover:text-foreground',
          )}
        >
          <IconPlus size={12} />
          Save this view
        </button>
      )}

      {saveState.status === 'error' && saveState.message ? (
        <span className="text-xs text-danger">{saveState.message}</span>
      ) : null}
    </div>
  );
}
