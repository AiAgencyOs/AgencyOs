'use server';

import { redirect } from 'next/navigation';

import { newCorrelationId } from '@/lib/errors';
import { safeRedirectPath } from '@/lib/url';

import { magicLinkSchema } from './schema';
import { sendMagicLink, signOut, startGoogleSignIn } from './service';
import type { FormState } from './types';

/**
 * Server Actions — thin wrappers: validate, delegate to service.ts, translate
 * the Result into something a form can render.
 *
 * Deliberately no business logic here. ARCHITECTURE.md §3.2.
 */

/**
 * Returns void so it can be used directly as a `<form action>`: this flow
 * always ends in a navigation, either to Google or back to /login with an
 * error, so there is no state for a caller to render.
 */
export async function signInWithGoogleAction(formData: FormData): Promise<void> {
  const next = safeRedirectPath(formData.get('next')?.toString(), '/dashboard');

  const result = await startGoogleSignIn(next);
  if (!result.ok) {
    redirect(`/login?error=${encodeURIComponent(result.error.message)}`);
  }

  // redirect() signals by throwing, so it must sit outside any try/catch.
  redirect(result.data.url);
}

export async function sendMagicLinkAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = magicLinkSchema.safeParse({
    email: formData.get('email')?.toString() ?? '',
    next: formData.get('next')?.toString() || undefined,
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || 'form';
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return { status: 'error', message: 'Please check the form.', fieldErrors };
  }

  const result = await sendMagicLink(parsed.data);
  if (!result.ok) {
    return { status: 'error', message: result.error.message };
  }

  return {
    status: 'success',
    message: 'Check your inbox — if that address has access, a sign-in link is on its way.',
  };
}

export async function signOutAction(): Promise<void> {
  const result = await signOut();

  if (!result.ok) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'signOutAction',
        correlationId: newCorrelationId(),
        detail: result.error.message,
      }),
    );
  }

  redirect('/login');
}
