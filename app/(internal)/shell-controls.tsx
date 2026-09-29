'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { Avatar, cx, humanize, IconChevronDown, IconClock, IconPlus, IconSettings, IconUser, IconUsers } from '@/ui';

/** The event the header's Create button raises; the command palette listens. */
export const OPEN_CREATE_EVENT = 'agencyos:open-create';

/**
 * The global header's right-hand controls, as the reference draws them: a
 * dark "+ Create" button and the signed-in person as an avatar · name · role
 * chip with a menu. (The "?" beside them is `HelpLink` in help-link.tsx —
 * bucket E, decision E3 made it the Help link rather than a menu of four
 * pages the rail already carries.) Client components only because they open
 * things; every destination is a plain link and sign-out is the same
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

export function UserMenu({
  name,
  email,
  role,
  timeZone,
  signOut,
}: {
  name: string;
  email: string;
  role: string;
  /** The zone this request's dates are shown in — the person's preference, else the organisation's. */
  timeZone?: string;
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
          <Link href="/profile" role="menuitem" className={ITEM} onClick={() => setOpen(false)}>
            <IconUser size={15} className="text-muted" />
            Profile &amp; preferences
          </Link>
          {timeZone ? (
            <p className="flex items-center gap-2.5 px-2.5 pb-1.5 text-[11px] text-muted">
              <IconClock size={13} className="shrink-0" />
              <span className="truncate">Times shown in {timeZone}</span>
            </p>
          ) : null}
          <Link href="/settings/team" role="menuitem" className={ITEM} onClick={() => setOpen(false)}>
            <IconUsers size={15} className="text-muted" />
            Team
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
