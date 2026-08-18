'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import { filterCommands, type Command } from '@/lib/admin/command-palette-eval';

/**
 * The ⌘K command palette — a keyboard-first way to jump anywhere in the control
 * plane. The command list is prepared on the server and is already
 * capability-filtered, so the palette can only navigate to pages the role may
 * open; it makes no authority decision, only text matching and navigation.
 */
export function CommandPalette({ commands }: { commands: Command[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      const id = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = results[active];
      if (c) go(c.href);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center justify-between gap-2 rounded-md border border-black/10 px-2 py-1.5 text-xs text-muted transition-colors hover:bg-black/[0.04] dark:border-white/15 dark:hover:bg-white/[0.06]"
      >
        <span>Search…</span>
        <kbd className="rounded border border-black/15 px-1 font-mono text-[10px] dark:border-white/20">⌘K</kbd>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[15vh]"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border border-black/10 bg-background shadow-2xl dark:border-white/15"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
          >
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKey}
              placeholder="Jump to a page…"
              aria-label="Command search"
              className="w-full border-b border-black/10 bg-transparent px-4 py-3 text-sm outline-none dark:border-white/15"
            />
            <ul className="max-h-80 overflow-y-auto py-1">
              {results.length === 0 ? (
                <li className="px-4 py-3 text-sm text-muted">No matches.</li>
              ) : (
                results.map((c, i) => (
                  <li key={c.href}>
                    <button
                      type="button"
                      onClick={() => go(c.href)}
                      onMouseEnter={() => setActive(i)}
                      className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm ${
                        i === active ? 'bg-black/[0.05] dark:bg-white/[0.08]' : ''
                      }`}
                    >
                      <span>{c.label}</span>
                      <span className="text-xs text-muted">{c.group}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
