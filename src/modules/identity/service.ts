import 'server-only';

import { createClient } from '@/lib/db/server';
import { clientEnv } from '@/lib/env';
import { err, ok, type Result } from '@/lib/result';
import { safeRedirectPath } from '@/lib/url';

import type { MagicLinkInput } from './schema';

/**
 * Authentication service — the module's only public surface.
 *
 * Two audiences, one system (ARCHITECTURE.md §7.1):
 *   internal staff → Google OAuth   (no password to manage)
 *   portal clients → magic link     (they sign in a handful of times per
 *                                    project; a password is pure friction)
 */

function callbackUrl(next: string): string {
  const url = new URL('/auth/callback', clientEnv.NEXT_PUBLIC_APP_URL);
  url.searchParams.set('next', next);
  return url.toString();
}

/** Returns the provider URL to redirect to. */
export async function startGoogleSignIn(next?: string): Promise<Result<{ url: string }>> {
  const supabase = await createClient();
  const target = safeRedirectPath(next, '/dashboard');

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: callbackUrl(target),
      queryParams: { access_type: 'offline', prompt: 'consent' },
    },
  });

  if (error || !data.url) {
    return err('PROVIDER_ERROR', 'Could not start Google sign-in. Please try again.');
  }
  return ok({ url: data.url });
}

/**
 * Sends a one-time sign-in link.
 *
 * The result is intentionally identical whether or not the address exists:
 * a differing response turns this endpoint into an account-enumeration oracle.
 */
export async function sendMagicLink(input: MagicLinkInput): Promise<Result<{ sent: true }>> {
  const supabase = await createClient();
  const target = safeRedirectPath(input.next, '/portal');

  const { error } = await supabase.auth.signInWithOtp({
    email: input.email,
    options: {
      emailRedirectTo: callbackUrl(target),
      shouldCreateUser: true,
    },
  });

  if (error) {
    // Rate limiting is the one condition worth surfacing — it is actionable.
    if (error.status === 429) {
      return err('RATE_LIMITED', 'Too many attempts. Please wait a minute and try again.');
    }
    console.error(JSON.stringify({ level: 'error', scope: 'sendMagicLink', detail: error.message }));
  }

  return ok({ sent: true });
}

/** Exchanges an OAuth / magic-link code for a session. */
export async function completeSignIn(code: string): Promise<Result<{ userId: string }>> {
  const supabase = await createClient();

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    return err('UNAUTHORIZED', 'That sign-in link is invalid or has expired.');
  }

  return ok({ userId: data.user.id });
}

/**
 * V1 bootstrap. Resolves the chicken-and-egg problem where memberships grant
 * claims but claims are needed to write memberships: the first user to sign in
 * to a fresh single-organization install becomes its owner.
 *
 * The database function is the authority on whether that applies — it fires
 * only when zero memberships and exactly one organization exist. Calling it
 * on every sign-in is therefore safe and idempotent.
 *
 * Failure is non-fatal: the user simply lands on /no-access.
 */
export async function ensureProvisioned(userId: string): Promise<void> {
  const supabase = await createClient();

  const { error } = await supabase.rpc('bootstrap_first_owner', { p_user_id: userId });

  if (error) {
    console.error(
      JSON.stringify({ level: 'warn', scope: 'ensureProvisioned', detail: error.message }),
    );
  }
}

export async function signOut(): Promise<Result<{ signedOut: true }>> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();

  if (error) return err('INTERNAL', 'Could not sign out. Please try again.');
  return ok({ signedOut: true });
}
