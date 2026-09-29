'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';

import { cx } from '../tokens';
import { IconMore } from '../icons';

/**
 * One entry in a row's overflow menu — the shared rule "primary + overflow
 * actions" (bucket F). A `href` is a link; a `node` is a control the page
 * rendered on the server (a server-action form button), so a governed
 * write in the menu is still the page's own door and nothing here pretends
 * a click succeeded.
 */
export type RowAction = {
  key: string;
  label: string;
  href?: string;
  node?: React.ReactNode;
  tone?: 'default' | 'danger';
};

const ITEM =
  'flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-surface-hover [&_button]:h-auto [&_button]:w-full [&_button]:justify-start [&_button]:border-0 [&_button]:bg-transparent [&_button]:p-0 [&_button]:shadow-none [&_form]:w-full';

/**
 * The "⋯" at the end of a table row, opening a small menu of the row's
 * secondary actions. Kept to links and pre-rendered nodes so a server-
 * rendered `DataTable` can describe the menu without passing a function
 * across the client boundary.
 */
export function RowActionsMenu({ actions, label = 'Row actions' }: { actions: readonly RowAction[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (actions.length === 0) return null;

  return (
    <div ref={ref} className="relative inline-block text-left">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="grid size-8 place-items-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        <IconMore size={16} />
      </button>
      {open ? (
        <div
          id={id}
          role="menu"
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-full z-40 mt-1 min-w-44 overflow-hidden rounded-lg border border-line bg-surface-overlay p-1 shadow-lg"
        >
          {actions.map((a) =>
            a.node ? (
              <div key={a.key} role="menuitem" className={cx(ITEM, a.tone === 'danger' && 'text-danger')}>
                {a.node}
              </div>
            ) : a.href ? (
              <Link key={a.key} role="menuitem" href={a.href} onClick={() => setOpen(false)} className={cx(ITEM, a.tone === 'danger' && 'text-danger')}>
                {a.label}
              </Link>
            ) : (
              <span key={a.key} role="menuitem" aria-disabled className={cx(ITEM, 'opacity-60')}>
                {a.label}
              </span>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
