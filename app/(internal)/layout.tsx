import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can, type Capability } from '@/lib/authz/permissions';

import { SignOutButton } from '../(auth)/sign-out-button';
import { CommandPalette } from './command-palette';

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
    items: g.items.filter((i) => i.capability === undefined || can(context.role, i.capability)),
  })).filter((g) => g.items.length > 0);

  // The command palette searches exactly what the sidebar shows — already
  // capability-filtered, so it can only ever jump to a page this role may open.
  const commands = visibleGroups.flatMap((g) => g.items.map((i) => ({ href: i.href, label: i.label, group: g.title ?? 'Overview' })));

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col gap-4 border-b border-black/10 px-4 py-4 md:w-56 md:border-b-0 md:border-r dark:border-white/15">
        <Link href="/dashboard" className="px-2 text-sm font-semibold tracking-tight">
          AgencyOS
        </Link>
        <CommandPalette commands={commands} />
        <nav className="flex flex-col gap-4">
          {visibleGroups.map((group) => (
            <div key={group.title ?? 'top'} className="flex flex-col gap-1">
              {group.title ? (
                <div className="px-2 text-[10px] font-medium uppercase tracking-wider text-muted">{group.title}</div>
              ) : null}
              {group.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.06]"
                >
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-3 border-b border-black/10 px-6 py-3 dark:border-white/15">
          <span className="text-sm text-muted">
            {context.email} · {context.role}
          </span>
          <SignOutButton />
        </header>
        <main className="flex-1 px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
