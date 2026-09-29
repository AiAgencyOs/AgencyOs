'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { Avatar, cx, humanize, IconChevronDown, IconHelp, IconPlus, IconSettings, IconUser } from '@/ui';

/** The event the header's Create button raises; the command palette listens. */
export const OPEN_CREATE_EVENT = 'agencyos:open-create';

/**
 * The global header's right-hand controls, as the reference draws them: a
 * dark "+ Create" button, a "?" help menu and the signed-in person as an
 * avatar · name · role chip with a menu. Client components only because they
 * open things; every destination is a plain link and sign-out is the same
 * server-action form the rail already carries.
 */
export type CreateMode = 'lead' | 'client';

/** Raise the quick-create dialog, optionally straight onto one form. */
export function openQuickCreate(mode?: CreateMode) {
  window.dispatchEvent(new CustomEvent<CreateMode | undefined>(OPEN_CREATE_EVENT, { detail: mode }));
}

export function CreateButton({ enabled }: { enabled: boolean }) {
  if (!enabled) return null;
  return (
    <button
      type="button"
      onClick={() => openQuickCreate()}
      className="hidden h-9 shrink-0 items-center gap-1.5 rounded-lg bg-sidebar-bg px-3 text-[13px] font-medium text-sidebar-fg shadow-xs transition-colors hover:bg-brand sm:inline-flex"
    >
      <IconPlus size={15} />
      Create
      <IconChevronDown size={14} className="text-sidebar-muted" />
    </button>
  );
}

function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
  return { open, setOpen, ref };
}

const MENU =
  'absolute right-0 top-full z-40 mt-2 w-56 overflow-hidden rounded-xl border border-line bg-surface-overlay p-1.5 shadow-lg';
const ITEM =
  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-surface-hover';

export function HelpMenu({ links }: { links: readonly { href: string; label: string }[] }) {
  const { open, setOpen, ref } = useMenu();
  return (
    <div ref={ref} className="relative hidden md:block">
      <button
        type="button"
        aria-label="Help"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        <IconHelp size={19} />
      </button>
      {open ? (
        <div role="menu" className={MENU}>
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">Help</p>
          <p className="px-2.5 pb-2 text-xs text-muted">
            Press <kbd className="rounded border border-line bg-surface px-1 font-mono text-[10px]">⌘K</kbd> to search anything.
          </p>
          {links.map((l) => (
            <Link key={l.href} href={l.href} role="menuitem" className={ITEM} onClick={() => setOpen(false)}>
              {l.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function UserMenu({
  name,
  email,
  role,
  signOut,
}: {
  name: string;
  email: string;
  role: string;
  signOut: React.ReactNode;
}) {
  const { open, setOpen, ref } = useMenu();
  return (
    <div ref={ref} className="relative hidden md:block">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${name}, ${humanize(role)} — account menu`}
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 items-center gap-2 rounded-lg pl-1 pr-2 transition-colors hover:bg-surface-hover"
      >
        <Avatar name={name} size="md" />
        <span className="hidden min-w-0 text-left lg:block">
          <span className="block max-w-[10rem] truncate text-[13px] font-medium leading-tight text-foreground">{name}</span>
          <span className="block text-[11px] leading-tight text-muted">{humanize(role)}</span>
        </span>
        <IconChevronDown size={14} className={cx('text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div role="menu" className={MENU}>
          <div className="px-2.5 pb-2 pt-1.5">
            <p className="truncate text-[13px] font-medium text-foreground">{name}</p>
            <p className="truncate text-[11px] text-muted">{email}</p>
          </div>
          <Link href="/settings/team" role="menuitem" className={ITEM} onClick={() => setOpen(false)}>
            <IconUser size={15} className="text-muted" />
            Team &amp; profile
          </Link>
          <Link href="/settings" role="menuitem" className={ITEM} onClick={() => setOpen(false)}>
            <IconSettings size={15} className="text-muted" />
            Settings
          </Link>
          <div className="mt-1 border-t border-line pt-1.5 [&_button]:h-9 [&_button]:w-full [&_button]:justify-start [&_button]:border-0 [&_button]:shadow-none [&_form]:w-full">{signOut}</div>
        </div>
      ) : null}
    </div>
  );
}
