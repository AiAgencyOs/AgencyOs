import Link from 'next/link';

import { requireClient } from '@/lib/auth/session';

import { SignOutButton } from '../(auth)/sign-out-button';

/**
 * Gate for the client portal.
 *
 * Portal users are scoped to a single client account. That scope is carried in
 * the JWT and enforced by RLS — this layout only ensures the right shell is
 * rendered for the right audience.
 *
 * Deliberately a plainer shell than the internal one: a client has exactly two
 * destinations, so a sidebar and a tab bar would be navigation furniture around
 * an empty room. The header is sticky and safe-area aware because this is the
 * surface most likely to be opened on a phone, from a link in a message.
 */
export default async function ClientLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const context = await requireClient();

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="pt-safe sticky top-0 z-30 border-b border-line bg-surface/85 backdrop-blur-lg">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/portal" className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-[13px] font-bold text-brand-fg">
              A
            </span>
            <span className="text-[15px] font-semibold tracking-tight">Client portal</span>
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden text-[13px] text-muted sm:block">{context.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 pb-16 pt-5 sm:px-6 sm:pt-6">{children}</main>
    </div>
  );
}
