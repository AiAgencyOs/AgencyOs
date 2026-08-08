import type { Metadata } from 'next';

import { requireClient } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Portal · AgencyOS' };

/** Placeholder. The deliverable review flow lands with the portal feature. */
export default async function PortalPage() {
  const context = await requireClient('/portal');

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">Your projects</h1>
      <p className="text-sm text-muted">
        Signed in as {context.email}. Nothing to review yet.
      </p>
    </div>
  );
}
