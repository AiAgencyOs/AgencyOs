import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getAuthContext } from '@/lib/auth/session';
import { isClientRole, isInternalRole } from '@/lib/auth/claims';
import { safeRedirectPath } from '@/lib/url';
import { signInWithGoogleAction } from '@/modules/identity/actions';

import { MagicLinkForm } from './magic-link-form';

export const metadata: Metadata = { title: 'Sign in · AgencyOS' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = safeRedirectPath(params.next, '/dashboard');

  // Already signed in — send them where they belong rather than showing a
  // form that would immediately bounce.
  const context = await getAuthContext();
  if (context) {
    if (isInternalRole(context.role)) redirect(next);
    if (isClientRole(context.role)) redirect('/portal');
    redirect('/no-access');
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">AgencyOS</h1>
        <p className="text-sm text-muted">Sign in to continue.</p>
      </header>

      {params.error ? (
        <p
          role="alert"
          className="rounded-lg border border-red-600/30 bg-red-500/10 px-4 py-3 text-sm"
        >
          {params.error}
        </p>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Team</h2>
        <form action={signInWithGoogleAction}>
          <input type="hidden" name="next" value={next} />
          <button
            type="submit"
            className="w-full rounded-lg border border-black/15 px-4 py-2 text-sm font-medium transition-colors hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
          >
            Continue with Google
          </button>
        </form>
      </section>

      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-black/10 dark:bg-white/15" />
        <span className="text-xs text-muted">or</span>
        <span className="h-px flex-1 bg-black/10 dark:bg-white/15" />
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Clients</h2>
        <MagicLinkForm next={next} />
      </section>
    </main>
  );
}
