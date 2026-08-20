import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can, type Capability } from '@/lib/authz/permissions';
import { humanize } from '@/ui';

import { SignOutButton } from '../(auth)/sign-out-button';
import { CommandPalette } from './command-palette';
import { BottomTabs, CurrentSectionTitle, MobileNav, SidebarNav, Wordmark } from './nav';

/**
 * Gate for the internal application, and the control plane's navigation.
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
 * The nav is grouped into sections so the growing control plane stays legible.
 * Each item still carries its own capability, and a group renders only if the
 * role can see at least one item in it. An item with no capability (Approvals)
 * is always shown: the queue admits exactly the internal roles its RLS policy
 * admits, and what a given approver may settle is decided per request under a
 * lock (ADM-08) — no static capability says that without being a worse copy.
 *
 * The shell is a fixed rail plus a scrolling column on a desktop, and a top bar
 * plus bottom tabs on a phone. Both are fed by the same filtered list below, so
 * a role can never reach a destination on one that it cannot reach on the other.
 */

type NavItem = { href: string; label: string; capability?: Capability };
type NavGroup = { title: string | null; items: NavItem[] };

const GROUPS: NavGroup[] = [
  { title: null, items: [{ href: '/dashboard', label: 'Overview', capability: 'project.read' }] },
  {
    title: 'Core',
    items: [
      { href: '/leads', label: 'Leads', capability: 'lead.read' },
      { href: '/projects', label: 'Projects', capability: 'project.read' },
      { href: '/invoices', label: 'Invoices', capability: 'invoice.read' },
      { href: '/portfolio', label: 'Portfolio', capability: 'portfolio.write' },
      { href: '/agents', label: 'Agents', capability: 'audit.read' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { href: '/operations', label: 'Operations', capability: 'audit.read' },
      { href: '/approvals', label: 'Approvals' },
      { href: '/security', label: 'Security', capability: 'audit.read' },
      { href: '/audit', label: 'Audit', capability: 'audit.read' },
      { href: '/usage', label: 'Usage & costs', capability: 'audit.read' },
      { href: '/production-readiness', label: 'Production readiness', capability: 'organization.settings' },
    ],
  },
  {
    title: 'Configuration',
    items: [
      { href: '/integrations', label: 'Integrations', capability: 'organization.settings' },
      { href: '/import', label: 'Import', capability: 'organization.settings' },
      { href: '/settings', label: 'Settings', capability: 'organization.settings' },
    ],
  },
];

export default async function InternalLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const context = await requireInternal();

  const visibleGroups = GROUPS.map((g) => ({
    title: g.title,
    items: g.items
      .filter((i) => i.capability === undefined || can(context.role, i.capability))
      .map(({ href, label }) => ({ href, label })),
  })).filter((g) => g.items.length > 0);

  // The command palette searches exactly what the sidebar shows — already
  // capability-filtered, so it can only ever jump to a page this role may open.
  const commands = visibleGroups.flatMap((g) =>
    g.items.map((i) => ({ href: i.href, label: i.label, group: g.title ?? 'Overview' })),
  );

  const identity = { email: context.email, role: context.role };

  return (
    <div className="min-h-screen bg-background">
      {/* ── Desktop rail ──────────────────────────────────────────────────
          Fixed rather than a flex sibling, so a long page scrolls under a
          stationary nav instead of dragging it out of view. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-line bg-surface md:flex">
        <div className="flex h-14 shrink-0 items-center px-4">
          <Link href="/dashboard" className="rounded-lg">
            <Wordmark />
          </Link>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-4">
          <SidebarNav groups={visibleGroups} />
        </div>

        <div className="shrink-0 border-t border-line p-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[13px] font-semibold uppercase text-brand">
              {context.email.slice(0, 2)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-foreground">
                {context.email}
              </span>
              <span className="block truncate text-[11px] text-muted">
                {humanize(context.role)}
              </span>
            </span>
          </div>
          <div className="mt-2">
            <SignOutButton full />
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
              signOut={<SignOutButton full />}
            />

            <div className="min-w-0 flex-1 md:hidden">
              <CurrentSectionTitle groups={visibleGroups} />
            </div>

            <div className="flex min-w-0 shrink-0 items-center md:flex-1">
              <CommandPalette commands={commands} />
            </div>
          </div>
        </header>

        {/* Bottom padding clears the phone tab bar; a fixed bar over the last
            row of a table is the classic way to lose a delete button. */}
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 pb-28 pt-5 sm:px-6 sm:pt-6 md:pb-10 lg:px-8">
          {children}
        </main>
      </div>

      <BottomTabs groups={visibleGroups} />
    </div>
  );
}
