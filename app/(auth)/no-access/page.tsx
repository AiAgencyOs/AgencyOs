import type { Metadata } from 'next';

import { getAuthContext } from '@/lib/auth/session';
import { IconLock } from '@/ui';

import { SignOutButton } from '../sign-out-button';

export const metadata: Metadata = { title: 'No access' };

/**
 * Terminal page for an authenticated user carrying no tenancy claims.
 *
 * This is a genuinely distinct state from "signed out", and conflating the two
 * causes a redirect loop: sending them to /login would just sign them back in
 * to the same claimless session. They need a human to grant them a membership.
 */
export default async function NoAccessPage() {
  const context = await getAuthContext();

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 text-center shadow-sm">
        <span className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-warning-soft text-warning">
          <IconLock size={20} />
        </span>

        <h1 className="text-lg font-semibold tracking-tight">No access yet</h1>

        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          You&rsquo;re signed in{context?.email ? ` as ${context.email}` : ''}, but your account
          isn&rsquo;t attached to an organisation yet. Ask an administrator to invite you, then sign
          in again.
        </p>

        <div className="mt-5 flex justify-center">
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
