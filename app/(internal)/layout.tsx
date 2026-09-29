import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { humanize } from '@/ui';

import { SignOutButton } from '../(auth)/sign-out-button';
import { ActionBell } from './action-bell';
import { CommandPalette } from './command-palette';
import { BottomTabs, CurrentSectionTitle, HeaderTrail, MobileNav, SidebarNav, Wordmark } from './nav';
import { visibleModulesFor } from './nav-config';

/**
 * Gate for the internal application, and the control plane's shell.
 *
 * Route protection lives here rather than in middleware because the role claims
 * are only meaningful once the session is resolved, and a layout can redirect
 * with full knowledge of who the user is. Middleware's single job stays session
 * refresh (ARCHITECTURE.md §7.3).
 *
 * This is a convenience boundary, not the security boundary: RLS independently
 * refuses to return rows to a principal without the right claims, so a bug here
 * leaks navigation, not data.
 *
 * The navigation itself is a table in `nav-config.ts` — the screen
 * architecture's fifteen modules, each item carrying the capability that
 * guards its page. The layout filters that table by role once, and every
 * presentation (rail, drawer, tabs, palette, breadcrumb, bell) reads the same
 * filtered result, so a role can never reach a destination on one that it
 * cannot reach on another. An item with no capability (Approvals) is always
 * shown: the queue admits exactly the internal roles its RLS policy admits,
 * and what a given approver may settle is decided per request under a lock
 * (ADM-08) — no static capability says that without being a worse copy.
 *
 * The shell is the screen architecture's §4 Global Header — search with a
 * shortcut, quick create, notifications with a live count, the signed-in
 * person and role — over a fixed dark rail on a desktop, and a top bar plus
 * bottom tabs on a phone. The layout itself makes NO database read: the bell's
 * count is fetched by the browser after paint and kept current by the live
 * channel, so forty pages do not each pay for six queries before they render.
 */
export default async function InternalLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const context = await requireInternal();

  const visibleGroups = visibleModulesFor(context.role);

  // The command palette searches exactly what the sidebar shows — already
  // capability-filtered, so it can only ever jump to a page this role may open.
  const commands = visibleGroups.flatMap((g) =>
    g.items.map((i) => ({ href: i.href, label: i.label, group: g.title ?? 'Command Center' })),
  );

  const identity = { email: context.email, role: context.role };

  return (
    <div className="min-h-screen bg-background">
      {/* Keyboard users land on the rail's forty links first; this jumps them
          past it. Visually hidden until focused, so it costs sighted readers
          nothing. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-brand-fg"
      >
        Skip to content
      </a>
      {/* ── Desktop rail ──────────────────────────────────────────────────
          Fixed rather than a flex sibling, so a long page scrolls under a
          stationary nav instead of dragging it out of view. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-sidebar-border bg-sidebar-bg md:flex">
        <div className="flex h-14 shrink-0 items-center px-4">
          <Link href="/dashboard" className="rounded-lg">
            <Wordmark dark />
          </Link>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-4">
          <SidebarNav groups={visibleGroups} />
        </div>

        <div className="shrink-0 border-t border-sidebar-border p-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sidebar-active-bg text-[13px] font-semibold uppercase text-sidebar-active-fg">
              {context.email.slice(0, 2)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-sidebar-fg">
                {context.fullName ?? context.email}
              </span>
              <span className="block truncate text-[11px] text-sidebar-muted">
                {humanize(context.role)}
              </span>
            </span>
          </div>
          <div className="mt-2">
            <SignOutButton full variant="sidebar" />
          </div>
        </div>
      </aside>

      {/* ── Content column ───────────────────────────────────────────────── */}
      <div className="flex min-h-screen min-w-0 flex-col md:pl-64">
        <header className="pt-safe sticky top-0 z-30 border-b border-line bg-surface/85 backdrop-blur-lg">
          <div className="flex h-14 items-center gap-2 px-4 sm:px-6">
            <MobileNav
              groups={visibleGroups}
              identity={identity}
              signOut={<SignOutButton full variant="sidebar" />}
            />

            <div className="min-w-0 flex-1 md:hidden">
              <CurrentSectionTitle groups={visibleGroups} />
            </div>

            {/* Where am I — module › page, from the same filtered table. */}
            <div className="hidden min-w-0 flex-1 lg:block">
              <HeaderTrail groups={visibleGroups} />
            </div>

            <div className="flex min-w-0 shrink-0 items-center gap-1 md:flex-1 lg:flex-none lg:w-[24rem]">
              <CommandPalette
                commands={commands}
                canCreateLead={can(context.role, 'lead.write')}
                canCreateClient={can(context.role, 'project.write')}
              />
              <ActionBell />
            </div>
          </div>
        </header>

        {/* Bottom padding clears the phone tab bar; a fixed bar over the last
            row of a table is the classic way to lose a delete button. */}
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1400px] outline-none flex-1 px-4 pb-28 pt-5 sm:px-6 sm:pt-6 md:pb-10 lg:px-8">
          {children}
        </main>
      </div>

      <BottomTabs groups={visibleGroups} />
    </div>
  );
}
