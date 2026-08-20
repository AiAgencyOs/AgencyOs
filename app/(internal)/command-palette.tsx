'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { filterCommands, type Command } from '@/lib/admin/command-palette-eval';
import { cx, IconChevronRight, IconSearch } from '@/ui';

/**
 * The ⌘K command palette — a keyboard-first way to jump anywhere in the control
 * plane. The command list is prepared on the server and is already
 * capability-filtered, so the palette can only navigate to pages the role may
 * open; it makes no authority decision, only text matching and navigation.
 *
 * One instance, two triggers' worth of appearance: a search field on a desktop
 * and a single icon on a phone, switched by CSS. Rendering the component twice
 * to get both would bind ⌘K twice and open two dialogs on top of each other.
 */
export function CommandPalette({ commands }: { commands: Command[] }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  // Portalled to <body> for the same reason the nav drawer is: this trigger
  // sits inside a `backdrop-blur` header, and a backdrop-filter turns that
  // header into the containing block for `fixed` children — which would
  // squeeze the dialog into a 56px strip instead of centring it on screen.
  useEffect(() => setMounted(true), []);

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
        aria-label="Search pages"
        className={cx(
          'flex items-center gap-2 rounded-lg text-muted transition-colors',
          // Phone: a 40px icon target. Desktop: a real search field.
          'h-10 w-10 justify-center hover:bg-surface-hover hover:text-foreground',
          'md:h-9 md:w-full md:max-w-sm md:justify-start md:border md:border-line md:bg-surface-sunken md:px-3 md:hover:border-line-strong md:hover:bg-surface',
        )}
      >
        <IconSearch size={18} className="shrink-0" />
        <span className="hidden flex-1 text-left text-[13px] md:block">Search…</span>
        <kbd className="hidden rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-faint md:block">
          ⌘K
        </kbd>
      </button>

      {open && mounted
        ? createPortal(
        <div
          className="animate-fade fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-sm"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className="animate-rise w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface-overlay shadow-lg"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
          >
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              <IconSearch size={18} className="shrink-0 text-faint" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKey}
                placeholder="Jump to a page…"
                aria-label="Command search"
                className="w-full bg-transparent py-3.5 text-[15px] text-foreground outline-none placeholder:text-faint"
              />
            </div>
            <ul className="max-h-[60vh] overflow-y-auto p-1.5">
              {results.length === 0 ? (
                <li className="px-3 py-6 text-center text-sm text-muted">No matches.</li>
              ) : (
                results.map((c, i) => (
                  <li key={c.href}>
                    <button
                      type="button"
                      onClick={() => go(c.href)}
                      onMouseEnter={() => setActive(i)}
                      className={cx(
                        'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors',
                        i === active ? 'bg-brand-soft text-brand' : 'text-foreground',
                      )}
                    >
                      <span className="flex-1 font-medium">{c.label}</span>
                      <span className="text-xs text-muted">{c.group}</span>
                      <IconChevronRight size={14} className="text-faint" />
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>,
            document.body,
          )
        : null}
    </>
  );
}
