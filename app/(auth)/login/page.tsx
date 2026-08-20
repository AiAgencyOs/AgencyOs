import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getAuthContext } from '@/lib/auth/session';
import { isClientRole, isInternalRole } from '@/lib/auth/claims';
import { safeRedirectPath } from '@/lib/url';
import { signInWithGoogleAction } from '@/modules/identity/actions';
import { buttonClass, Callout, IconAlert } from '@/ui';

import { MagicLinkForm } from './magic-link-form';

export const metadata: Metadata = { title: 'Sign in' };

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
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-lg font-bold text-brand-fg shadow-sm">
            A
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">AgencyOS</h1>
            <p className="mt-1 text-[13px] text-muted">Sign in to continue.</p>
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
          {params.error ? (
            <div role="alert" className="mb-5">
              <Callout tone="danger" icon={<IconAlert size={15} />}>
                {params.error}
              </Callout>
            </div>
          ) : null}

          <section className="flex flex-col gap-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Team</h2>
            <form action={signInWithGoogleAction}>
              <input type="hidden" name="next" value={next} />
              <button type="submit" className={buttonClass('secondary', 'md', 'w-full')}>
                Continue with Google
              </button>
            </form>
          </section>

          <div className="my-5 flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-line" />
            <span className="text-[11px] uppercase tracking-wider text-faint">or</span>
            <span className="h-px flex-1 bg-line" />
          </div>

          <section className="flex flex-col gap-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Clients</h2>
            <MagicLinkForm next={next} />
          </section>
        </div>
      </div>
    </main>
  );
}
