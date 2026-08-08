import Link from 'next/link';

import { requireClient } from '@/lib/auth/session';

import { SignOutButton } from '../(auth)/sign-out-button';

/**
 * Gate for the client portal.
 *
 * Portal users are scoped to a single client account. That scope is carried in
 * the JWT and enforced by RLS — this layout only ensures the right shell is
 * rendered for the right audience.
 */
export default async function ClientLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const context = await requireClient();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between gap-6 border-b border-black/10 px-6 py-3 dark:border-white/15">
        <Link href="/portal" className="text-sm font-semibold tracking-tight">
          Client portal
        </Link>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted">{context.email}</span>
          <SignOutButton />
        </div>
      </header>

      <main className="flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
