import Link from 'next/link';

import { getDisplayTimeZone } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readOrganizationName } from '@/lib/admin/organization';
import { listMyOrganizations, type MyOrganization } from '@/lib/admin/organization-switch';
import { Avatar, humanize, IconMore } from '@/ui';

import { SignOutButton } from '../(auth)/sign-out-button';
import { ActionBell } from './action-bell';
import { CommandPalette } from './command-palette';
import { HelpLink } from './help-link';
import { IncidentBanner } from './incident-banner';
import { BottomTabs, CurrentSectionTitle, HeaderTrail, MobileNav, SidebarNav, Wordmark } from './nav';
import { visibleModulesFor } from './nav-config';
import { OrganizationSwitcher } from './organization-switcher';
import { CreateButton, UserMenu } from './shell-controls';
import { SystemStatusDot } from './system-status';

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
 * cannot reach on another.
 *
 * One read the layout DOES make (bucket E, decision E3): the display
 * timezone — the person's own preference, else the organisation's —
 * resolved here once per request through `getDisplayTimeZone()`'s
 * request-scoped cache, so every `agencyClock()` on the page formats in the
 * same zone without a second read, and the user menu can say which. Bucket F
 * (SCR-001) adds one more: the person's own memberships, so the rail can
 * offer the organisation selector to somebody who holds more than one and
 * nothing to everybody else. The header's system-status dot and the bell
 * fetch after paint. An item with no capability (Approvals) is always
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
  const [organizationName, timeZone, memberships] = await Promise.all([
    readOrganizationName(),
    getDisplayTimeZone(),
    listMyOrganizations().catch((): MyOrganization[] => []),
  ]);
  // SCR-001: the organisation selector exists only for a person who could
  // choose; a single membership shows the plain chip, as before.
  const canSwitchOrganization = memberships.length > 1;

  const visibleGroups = visibleModulesFor(context);

  // The command palette searches exactly what the sidebar shows — already
  // capability-filtered, so it can only ever jump to a page this role may open.
  const commands = visibleGroups.flatMap((g) =>
    g.items.map((i) => ({ href: i.href, label: i.label, group: g.title ?? 'Command Center' })),
  );

  const identity = { email: context.email, role: context.role };
  const displayName = context.fullName ?? context.email;

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
          {canSwitchOrganization ? (
            <div className="mb-2">
              <OrganizationSwitcher organizations={memberships} />
            </div>
          ) : null}
          <div className="flex items-center gap-2.5 rounded-lg border border-sidebar-border bg-sidebar-hover px-2 py-2">
            <Avatar name={organizationName ?? displayName} size="md" square tone="warning" className="bg-accent text-accent-fg" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-sidebar-fg">{organizationName ?? 'Organisation'}</span>
              <span className="block truncate text-[11px] text-sidebar-muted">{displayName}</span>
              <span className="block truncate text-[10px] uppercase tracking-wider text-sidebar-muted">{humanize(context.role)}</span>
            </span>
            <Link href="/settings" aria-label="Organisation settings" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-fg">
              <IconMore size={16} />
            </Link>
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

            {/* Where am I — module › page › record, from the same filtered
                table. Shown from the tablet width up (bucket F): a portrait
                iPad has room for it once the phone title yields. */}
            <div className="hidden min-w-0 flex-1 md:block">
              <HeaderTrail groups={visibleGroups} />
            </div>

            <div className="flex min-w-0 shrink-0 items-center justify-end gap-1.5 md:flex-1">
              <CommandPalette
                commands={commands}
                canCreateLead={can(context, 'lead.write')}
                canCreateClient={can(context, 'project.write')}
                canCreateQuotation={can(context, 'proposal.draft')}
                canCreateTask={can(context, 'task.write')}
                canCreateProject={can(context, 'project.write')}
                canCreateInvoice={can(context, 'invoice.create')}
              />
              <CreateButton enabled={can(context, 'lead.write') || can(context, 'project.write')} />
              <SystemStatusDot canOpen={can(context, 'organization.settings')} />
              <ActionBell />
              <HelpLink />
              <UserMenu name={displayName} email={context.email} role={context.role ?? "member"} timeZone={timeZone} signOut={<SignOutButton full variant="secondary" />} />
            </div>
          </div>
        </header>
        {/* SCR-067/068: unacknowledged critical alerts and engaged emergency controls, on every page. */}
        <IncidentBanner />

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
