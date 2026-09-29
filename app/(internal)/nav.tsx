'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  cx,
  IconAgents,
  IconAlert,
  IconApprovals,
  IconAudit,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconClose,
  IconCode,
  IconImport,
  IconInbox,
  IconIntegrations,
  IconInvoices,
  IconLeads,
  IconMenu,
  IconMore,
  IconOperations,
  humanize,
  IconOverview,
  IconPalette,
  IconPortfolio,
  IconProjects,
  IconReadiness,
  IconSecurity,
  IconSettings,
  IconUsage,
  IconUser,
  type IconProps,
} from '@/ui';

import { currentItem, trailFor, type VisibleItem, type VisibleModule } from './nav-config';

/**
 * The control plane's navigation, in its three presentations.
 *
 * The *contents* are decided on the server: the layout filters every module
 * against the signed-in role's capabilities and hands the survivors down. This
 * file only decides what navigation looks like and which entry is current, so
 * nothing here can widen what a role can reach — the worst a bug in this file
 * can do is draw a link badly.
 *
 * Three presentations, one list:
 *   · a persistent rail on a desktop, sectioned into the screen
 *     architecture's fifteen modules, each collapsible so the rail stays one
 *     screen tall with forty destinations in it;
 *   · a slide-over drawer on a phone, holding every destination;
 *   · a bottom tab bar on a phone, holding the four that get used hourly.
 *
 * The bottom bar is the reason this app is usable one-handed. A hamburger
 * alone puts every destination two taps away and at the top of the screen,
 * which is the corner a thumb reaches last.
 */

export type NavItem = VisibleItem;
export type NavGroup = VisibleModule;

/**
 * Icons are matched here rather than passed from the server, because a
 * component is not serialisable across that boundary. Keyed by href so an
 * unknown route degrades to a dot instead of throwing. Module titles get an
 * icon too, so a collapsed module still says what it holds.
 */
const ICONS: Record<string, (p: IconProps) => React.ReactElement> = {
  '/dashboard': IconOverview,
  '/my-tasks': IconCheck,
  '/notifications': IconAlert,
  '/leads': IconLeads,
  '/sales-funnel': IconLeads,
  '/quotations': IconInvoices,
  '/meetings': IconClock,
  '/follow-ups': IconClock,
  '/communication': IconInbox,
  '/settings/communication': IconInbox,
  '/requirements': IconCheck,
  '/clients': IconUser,
  '/projects': IconProjects,
  '/projects/escalations': IconAlert,
  '/design': IconPalette,
  '/development': IconCode,
  '/finance': IconInvoices,
  '/invoices': IconInvoices,
  '/invoices/verify': IconCheck,
  '/finance/payments': IconInvoices,
  '/finance/expenses': IconInvoices,
  '/finance/tax': IconInvoices,
  '/qa': IconCheck,
  '/portfolio': IconPortfolio,
  '/agents': IconAgents,
  '/agents/routing': IconAgents,
  '/agents/automations': IconAgents,
  '/operations': IconOperations,
  '/approvals': IconApprovals,
  '/security': IconSecurity,
  '/security/users': IconUser,
  '/audit': IconAudit,
  '/usage': IconUsage,
  '/reports': IconUsage,
  '/production-readiness': IconReadiness,
  '/integrations': IconIntegrations,
  '/import': IconImport,
  '/settings': IconSettings,
};

const MODULE_ICONS: Record<string, (p: IconProps) => React.ReactElement> = {
  sales: IconLeads,
  clients: IconUser,
  projects: IconProjects,
  requirements: IconCheck,
  design: IconPalette,
  development: IconCode,
  qa: IconReadiness,
  finance: IconInvoices,
  communication: IconInbox,
  ai: IconAgents,
  operations: IconOperations,
  governance: IconApprovals,
  integrations: IconIntegrations,
  settings: IconSettings,
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
 * Which entry is lit. Longest-prefix, at a segment boundary, across every
 * module — see `currentItem`. `/finance` and `/finance/payments` both sit in
 * the rail, and only one of them may be current at a time.
 */
function useCurrent(groups: readonly NavGroup[]) {
  const pathname = usePathname();
  return useMemo(() => currentItem(pathname, groups), [pathname, groups]);
}

/* ── Desktop rail ─────────────────────────────────────────────────────────── */

export function SidebarNav({ groups }: { groups: NavGroup[] }) {
  const current = useCurrent(groups);
  const currentHref = current?.item.href;
  const currentModule = current?.module.key;

  // A module is open when the reader opened it or is inside it. Kept in
  // component state rather than storage: the rail is rebuilt per navigation
  // anyway, and a module that closes itself the moment you leave it is the
  // behaviour that keeps forty destinations on one screen.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (currentModule) setOpened((o) => (o[currentModule] ? o : { ...o, [currentModule]: true }));
  }, [currentModule]);

  return (
    <nav className="flex flex-col gap-1" aria-label="Sections">
      {groups.map((group) => {
        // Command Center (no title) and single-destination modules render as
        // plain rows — a disclosure that hides one link is a tap for nothing.
        const flat = group.title === null || group.items.length === 1;
        if (flat) {
          return (
            <div key={group.key} className={cx('flex flex-col gap-0.5', group.title === null && 'mb-3')}>
              {group.items.map((item) => (
                <RailLink
                  key={item.href}
                  item={{ ...item, label: group.title && group.items.length === 1 ? group.title : item.label }}
                  iconHref={item.href}
                  current={item.href === currentHref}
                />
              ))}
            </div>
          );
        }

        const open = opened[group.key] ?? group.key === currentModule;
        const ModuleIcon = MODULE_ICONS[group.key];
        const panelId = `nav-${group.key}`;
        return (
          <div key={group.key} className="flex flex-col gap-0.5">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpened((o) => ({ ...o, [group.key]: !open }))}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors',
                !open && group.key === currentModule
                  ? 'text-sidebar-fg'
                  : 'text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-fg',
              )}
            >
              {ModuleIcon ? <ModuleIcon size={17} className="shrink-0" /> : null}
              <span className="flex-1 truncate text-left">{group.title}</span>
              {open ? (
                <IconChevronDown size={14} className="shrink-0 opacity-70" />
              ) : (
                <IconChevronRight size={14} className="shrink-0 opacity-70" />
              )}
            </button>
            {open ? (
              <div id={panelId} className="ml-4 flex flex-col gap-0.5 border-l border-sidebar-border pl-2">
                {group.items.map((item) => (
                  <RailLink key={item.href} item={item} iconHref={item.href} current={item.href === currentHref} nested />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}

function RailLink({
  item,
  iconHref,
  current,
  nested,
}: {
  item: NavItem;
  iconHref: string;
  current: boolean;
  nested?: boolean;
}) {
  return (
    <Link
      href={item.href}
      aria-current={current ? 'page' : undefined}
      className={cx(
        'flex items-center gap-2.5 rounded-lg px-3 text-[13px] font-medium transition-colors',
        nested ? 'py-1.5' : 'py-2',
        current
          ? 'bg-sidebar-active-bg text-sidebar-active-fg'
          : 'text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-fg',
      )}
    >
      {nested ? null : <NavIcon href={iconHref} size={17} className="shrink-0" />}
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

/* ── Header: where am I ───────────────────────────────────────────────────── */

/**
 * The breadcrumb trail the screen architecture's context header asks for —
 * module › page — derived from the same filtered modules the rail draws, so
 * it can never name a room the role cannot enter. A page that is a record
 * (`/leads/<id>`) adds its own title below; this only says which module and
 * list it belongs to.
 */
export function HeaderTrail({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  const trail = useMemo(() => trailFor(pathname, groups), [pathname, groups]);
  const last = trail[trail.length - 1];
  if (!last) return null;
  const deeper = pathname !== last.href;
  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1 text-[12.5px] text-muted md:flex">
      {trail.map((crumb, i) => (
        <span key={crumb.href + i} className="flex min-w-0 items-center gap-1">
          {i > 0 ? <IconChevronRight size={12} className="shrink-0 text-faint" /> : null}
          {i === trail.length - 1 && !deeper ? (
            <span aria-current="page" className="truncate font-medium text-foreground">
              {crumb.label}
            </span>
          ) : (
            <Link href={crumb.href} className="truncate hover:text-foreground">
              {crumb.label}
            </Link>
          )}
        </span>
      ))}
      {deeper ? (
        <span className="flex items-center gap-1">
          <IconChevronRight size={12} className="shrink-0 text-faint" />
          <span aria-current="page" className="font-medium text-foreground">
            Detail
          </span>
        </span>
      ) : null}
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
  const current = useCurrent(groups);

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
                className="animate-sheet absolute inset-y-0 left-0 flex w-[82vw] max-w-xs flex-col bg-sidebar-bg shadow-lg"
              >
                <div className="pt-safe flex items-center justify-between border-b border-sidebar-border px-4 py-3">
                  <span className="flex items-center gap-2">
                    <Wordmark dark />
                  </span>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label="Close navigation"
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-sidebar-muted hover:bg-sidebar-hover"
                  >
                    <IconClose size={20} />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto px-3 py-4">
                  <nav className="flex flex-col gap-5" aria-label="Sections">
                    {groups.map((group) => (
                      <div key={group.key} className="flex flex-col gap-0.5">
                        {group.title ? (
                          <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-sidebar-muted">
                            {group.title}
                          </div>
                        ) : null}
                        {group.items.map((item) => {
                          const isCurrent = item.href === current?.item.href;
                          return (
                            <Link
                              key={item.href}
                              href={item.href}
                              aria-current={isCurrent ? 'page' : undefined}
                              className={cx(
                                'flex min-h-11 items-center gap-3 rounded-lg px-3 text-[15px] font-medium transition-colors',
                                isCurrent
                                  ? 'bg-sidebar-active-bg text-sidebar-active-fg'
                                  : 'text-sidebar-fg/85 active:bg-sidebar-hover',
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

                <div className="pb-safe border-t border-sidebar-border px-4 py-3">
                  <p className="truncate text-[13px] font-medium text-sidebar-fg">{identity.email}</p>
                  <p className="mb-3 text-xs text-sidebar-muted">{humanize(identity.role)}</p>
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
  const current = useCurrent(groups);
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
          const isCurrent = item.href === current?.item.href;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={isCurrent ? 'page' : undefined}
                className={cx(
                  'flex min-h-[3.25rem] flex-col items-center justify-center gap-1 px-1 py-1.5 text-[10px] font-medium transition-colors',
                  isCurrent ? 'text-brand' : 'text-muted',
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

export function Wordmark({ className, dark }: { className?: string; dark?: boolean }) {
  return (
    <span className={cx('flex items-center gap-2', className)}>
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-[13px] font-bold text-accent-fg">
        A
      </span>
      <span className="flex flex-col leading-none">
        <span
          className={cx(
            'text-[15px] font-semibold tracking-tight',
            dark ? 'text-sidebar-fg' : 'text-foreground',
          )}
        >
          AgencyOS
        </span>
        <span className={cx('mt-0.5 text-[9.5px] tracking-wide', dark ? 'text-sidebar-muted' : 'text-faint')}>
          Run. Grow. Scale.
        </span>
      </span>
    </span>
  );
}

/** The current section's name, for the phone header. */
export function CurrentSectionTitle({ groups }: { groups: NavGroup[] }) {
  const current = useCurrent(groups);
  return <span className="truncate text-[15px] font-semibold">{current?.item.label ?? 'AgencyOS'}</span>;
}
