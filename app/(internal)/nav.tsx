'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  cx,
  IconAgents,
  IconApprovals,
  IconAudit,
  IconClose,
  IconImport,
  IconIntegrations,
  IconInvoices,
  IconLeads,
  IconMenu,
  IconMore,
  IconOperations,
  humanize,
  IconOverview,
  IconPortfolio,
  IconProjects,
  IconReadiness,
  IconSecurity,
  IconSettings,
  IconUsage,
  type IconProps,
} from '@/ui';

/**
 * The control plane's navigation, in its three presentations.
 *
 * The *contents* are decided on the server: the layout filters every item
 * against the signed-in role's capabilities and hands the survivors down. This
 * file only decides what navigation looks like and which entry is current, so
 * nothing here can widen what a role can reach — the worst a bug in this file
 * can do is draw a link badly.
 *
 * Three presentations, one list:
 *   · a persistent rail on a desktop, where there is room for it;
 *   · a slide-over drawer on a phone, holding every destination;
 *   · a bottom tab bar on a phone, holding the four that get used hourly.
 *
 * The bottom bar is the reason this app is usable one-handed. A hamburger
 * alone puts every destination two taps away and at the top of the screen,
 * which is the corner a thumb reaches last.
 */

export type NavItem = { href: string; label: string };
export type NavGroup = { title: string | null; items: NavItem[] };

/**
 * Icons are matched here rather than passed from the server, because a
 * component is not serialisable across that boundary. Keyed by href so an
 * unknown route degrades to a dot instead of throwing.
 */
const ICONS: Record<string, (p: IconProps) => React.ReactElement> = {
  '/dashboard': IconOverview,
  '/leads': IconLeads,
  '/projects': IconProjects,
  '/invoices': IconInvoices,
  '/portfolio': IconPortfolio,
  '/agents': IconAgents,
  '/operations': IconOperations,
  '/approvals': IconApprovals,
  '/security': IconSecurity,
  '/audit': IconAudit,
  '/usage': IconUsage,
  '/production-readiness': IconReadiness,
  '/integrations': IconIntegrations,
  '/import': IconImport,
  '/settings': IconSettings,
};

/** Which destinations earn a thumb-reachable slot, best first. */
const TAB_PRIORITY = ['/leads', '/dashboard', '/approvals', '/projects', '/invoices'];

function NavIcon({ href, ...rest }: { href: string } & IconProps) {
  const Icon = ICONS[href];
  return Icon ? (
    <Icon {...rest} />
  ) : (
    <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
  );
}

/**
 * `/leads` must stay lit while reading `/leads/<id>`, so a nested route counts
 * as its section. Anchored at a segment boundary — otherwise `/import` would
 * also light up for a hypothetical `/importers`.
 */
function useIsCurrent() {
  const pathname = usePathname();
  return (href: string) => pathname === href || pathname.startsWith(href + '/');
}

/* ── Desktop rail ─────────────────────────────────────────────────────────── */

export function SidebarNav({ groups }: { groups: NavGroup[] }) {
  const isCurrent = useIsCurrent();

  return (
    <nav className="flex flex-col gap-5" aria-label="Sections">
      {groups.map((group) => (
        <div key={group.title ?? 'top'} className="flex flex-col gap-0.5">
          {group.title ? (
            <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
              {group.title}
            </div>
          ) : null}
          {group.items.map((item) => {
            const current = isCurrent(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className={cx(
                  'group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors',
                  current
                    ? 'bg-brand-soft text-brand'
                    : 'text-muted hover:bg-surface-hover hover:text-foreground',
                )}
              >
                {/* The lit rail marker. `aria-current` above is what actually
                    announces the state; this is the visual half of the pair. */}
                <span
                  aria-hidden
                  className={cx(
                    'absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-brand transition-opacity',
                    current ? 'opacity-100' : 'opacity-0',
                  )}
                />
                <NavIcon href={item.href} size={17} className="shrink-0" />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/* ── Phone: drawer ────────────────────────────────────────────────────────── */

export function MobileNav({
  groups,
  identity,
  signOut,
}: {
  groups: NavGroup[];
  identity: { email: string; role?: string | null };
  signOut: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();
  const isCurrent = useIsCurrent();

  // The drawer is portalled to <body>, and this is not a stylistic choice.
  // The header it lives in carries `backdrop-blur`, and any backdrop-filter
  // makes that element a containing block for `position: fixed` descendants —
  // so a `fixed inset-0` overlay rendered in place sizes itself to the 56px
  // header instead of the viewport, and the drawer appears as a sliver with
  // its links clipped off. Escaping to <body> is what makes `inset-0` mean the
  // screen again. `mounted` keeps the portal off the server render, where
  // there is no document to portal into.
  useEffect(() => setMounted(true), []);

  // Navigating is the drawer's whole purpose, so arriving somewhere closes it.
  useEffect(() => setOpen(false), [pathname]);

  // A drawer over a scrollable page scrolls the page underneath it on iOS
  // unless the body is pinned while it is open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        aria-expanded={open}
        className="-ml-1.5 flex h-10 w-10 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground md:hidden"
      >
        <IconMenu size={22} />
      </button>

      {open && mounted
        ? createPortal(
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="animate-fade absolute inset-0 bg-black/50"
            onClick={() => setOpen(false)}
            role="presentation"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="animate-sheet absolute inset-y-0 left-0 flex w-[82vw] max-w-xs flex-col bg-surface shadow-lg"
          >
            <div className="pt-safe flex items-center justify-between border-b border-line px-4 py-3">
              <span className="flex items-center gap-2">
                <Wordmark />
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-surface-hover"
              >
                <IconClose size={20} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-4">
              <nav className="flex flex-col gap-5" aria-label="Sections">
                {groups.map((group) => (
                  <div key={group.title ?? 'top'} className="flex flex-col gap-0.5">
                    {group.title ? (
                      <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
                        {group.title}
                      </div>
                    ) : null}
                    {group.items.map((item) => {
                      const current = isCurrent(item.href);
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          aria-current={current ? 'page' : undefined}
                          className={cx(
                            'flex min-h-11 items-center gap-3 rounded-lg px-3 text-[15px] font-medium transition-colors',
                            current
                              ? 'bg-brand-soft text-brand'
                              : 'text-foreground/85 active:bg-surface-hover',
                          )}
                        >
                          <NavIcon href={item.href} size={19} className="shrink-0" />
                          <span className="truncate">{item.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                ))}
              </nav>
            </div>

            <div className="pb-safe border-t border-line px-4 py-3">
              <p className="truncate text-[13px] font-medium text-foreground">{identity.email}</p>
              <p className="mb-3 text-xs text-muted">{humanize(identity.role)}</p>
              {signOut}
            </div>
          </div>
        </div>,
            document.body,
          )
        : null}
    </>
  );
}

/* ── Phone: bottom tabs ───────────────────────────────────────────────────── */

export function BottomTabs({ groups }: { groups: NavGroup[] }) {
  const isCurrent = useIsCurrent();
  const all = groups.flatMap((g) => g.items);

  // Four tabs, chosen by how often they are opened, and only ones this role
  // can actually reach. Anything that does not fit stays in the drawer.
  const tabs = TAB_PRIORITY.map((href) => all.find((i) => i.href === href)).filter(
    (i): i is NavItem => Boolean(i),
  );
  const shown = tabs.slice(0, 4);
  if (shown.length === 0) return null;

  return (
    <nav
      aria-label="Primary"
      className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface-overlay/95 backdrop-blur-lg md:hidden"
    >
      <ul className="flex items-stretch">
        {shown.map((item) => {
          const current = isCurrent(item.href);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className={cx(
                  'flex min-h-[3.25rem] flex-col items-center justify-center gap-1 px-1 py-1.5 text-[10px] font-medium transition-colors',
                  current ? 'text-brand' : 'text-muted',
                )}
              >
                <NavIcon href={item.href} size={21} />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
        <li className="flex-1">
          <MoreTab />
        </li>
      </ul>
    </nav>
  );
}

/**
 * The fifth tab opens the drawer. It dispatches rather than holding the
 * drawer's state, so the drawer stays a single instance in the header and two
 * copies of it can never disagree about whether it is open.
 */
function MoreTab() {
  return (
    <button
      type="button"
      onClick={() => {
        const trigger = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Open navigation"]',
        );
        trigger?.click();
      }}
      className="flex min-h-[3.25rem] w-full flex-col items-center justify-center gap-1 px-1 py-1.5 text-[10px] font-medium text-muted"
    >
      <IconMore size={21} />
      <span>More</span>
    </button>
  );
}

/* ── Shared bits ──────────────────────────────────────────────────────────── */

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cx('flex items-center gap-2', className)}>
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-[13px] font-bold text-brand-fg">
        A
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-foreground">AgencyOS</span>
    </span>
  );
}

/** The current section's name, for the phone header. */
export function CurrentSectionTitle({ groups }: { groups: NavGroup[] }) {
  const isCurrent = useIsCurrent();
  const match = groups.flatMap((g) => g.items).find((i) => isCurrent(i.href));
  return <span className="truncate text-[15px] font-semibold">{match?.label ?? 'AgencyOS'}</span>;
}
