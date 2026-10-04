import type { Metadata } from 'next';

import { serverEnv } from '@/lib/env';
import { verifyUnsubscribe } from '@/modules/crm/outreach/unsubscribe-token';

import { UnsubscribeButton } from './unsubscribe-button';

export const metadata: Metadata = { title: 'Unsubscribe', robots: { index: false, follow: false } };

/**
 * The page behind the link in every outreach email. Public by design - a recipient has no login.
 *
 * Opening it unsubscribes nobody: mailbox scanners and link previews fetch URLs, and an unsubscribe
 * on GET would silently remove people who only had their mail scanned. The person confirms with a
 * button (a POST); the one-click header (RFC 8058) goes to the API route instead.
 */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const env = serverEnv();
  const claim = verifyUnsubscribe(token, env.VAULT_ENCRYPTION_KEY || env.CRON_SECRET || '');

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center gap-4 px-4 py-12">
      {claim ? (
        <>
          <h1 className="text-xl font-semibold">Unsubscribe</h1>
          <p className="text-sm text-muted">
            Stop all further email from us to <strong>{claim.email}</strong>? You will not hear from us again.
          </p>
          <UnsubscribeButton token={token} />
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold">This link is not valid</h1>
          <p className="text-sm text-muted">The unsubscribe link is incomplete or has been changed. Please use the link from the most recent email, or reply to it and ask us to stop.</p>
        </>
      )}
    </main>
  );
}
