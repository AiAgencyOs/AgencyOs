import type { Metadata } from 'next';

import { getAuthContext } from '@/lib/auth/session';

import { SignOutButton } from '../sign-out-button';

export const metadata: Metadata = { title: 'No access · AgencyOS' };

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
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-6">
      <h1 className="text-2xl font-semibold tracking-tight">No access yet</h1>

      <p className="text-sm text-muted">
        You&rsquo;re signed in{context?.email ? ` as ${context.email}` : ''}, but your account
        isn&rsquo;t attached to an organisation yet. Ask an administrator to invite you, then sign
        in again.
      </p>

      <SignOutButton />
    </main>
  );
}
