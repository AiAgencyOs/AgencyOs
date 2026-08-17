import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';

import { SignOutButton } from '../(auth)/sign-out-button';

/**
 * Gate for the internal application.
 *
 * Route protection lives here rather than in middleware because the role
 * claims are only meaningful once the session is resolved, and a layout can
 * redirect with full knowledge of who the user is. Middleware's single job
 * stays session refresh (ARCHITECTURE.md §7.3).
 *
 * This is a convenience boundary, not the security boundary: RLS independently
 * refuses to return rows to a principal without the right claims, so a bug
 * here leaks navigation, not data.
 */
export default async function InternalLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const context = await requireInternal();

  const nav = [
    { href: '/dashboard', label: 'Dashboard', capability: 'project.read' as const },
    { href: '/leads', label: 'Leads', capability: 'lead.read' as const },
    { href: '/projects', label: 'Projects', capability: 'project.read' as const },
    { href: '/invoices', label: 'Invoices', capability: 'invoice.read' as const },
    { href: '/portfolio', label: 'Portfolio', capability: 'portfolio.write' as const },
    { href: '/operations', label: 'Operations', capability: 'audit.read' as const },
    { href: '/agents', label: 'Agents', capability: 'audit.read' as const },
    { href: '/audit', label: 'Audit', capability: 'audit.read' as const },
    { href: '/settings', label: 'Settings', capability: 'organization.settings' as const },
  ].filter((item) => can(context.role, item.capability));

  // Approvals is not capability-filtered, unlike everything above it. The
  // queue admits exactly the internal roles its RLS policy admits, and what a
  // given approver may settle is decided per request, under a lock, against
  // the role snapshotted when it was raised. There is no static capability
  // that says the same thing without being a worse copy of it (ADM-08).
  const links = [...nav, { href: '/approvals', label: 'Approvals' }];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between gap-6 border-b border-black/10 px-6 py-3 dark:border-white/15">
        <div className="flex items-center gap-6">
          <Link href="/dashboard" className="text-sm font-semibold tracking-tight">
            AgencyOS
          </Link>
          <nav className="flex items-center gap-4">
            {links.map((item) => (
              <Link key={item.href} href={item.href} className="text-sm text-muted hover:text-foreground">
                {item.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-muted">
            {context.email} · {context.role}
          </span>
          <SignOutButton />
        </div>
      </header>

      <main className="flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
