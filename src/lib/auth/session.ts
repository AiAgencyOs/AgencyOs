import 'server-only';

import { redirect } from 'next/navigation';

import { createClient } from '@/lib/db/server';

import {
  claimsFromAccessToken,
  isClientRole,
  isInternalRole,
  isUnprovisioned,
  type AppClaims,
  type Role,
} from './claims';

export type AuthContext = {
  userId: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  claims: AppClaims;
  role: Role | undefined;
  organizationId: string | undefined;
  clientAccountId: string | undefined;
};

/**
 * Resolves the current user, or null when signed out.
 *
 * Identity comes from `getUser()`, which revalidates against the auth server.
 * `getSession()` is only used afterwards to read the access token for claims —
 * its user object is not trusted on the server, because the cookie it reads
 * could in principle be tampered with.
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return null;

  const {
    data: { session },
  } = await supabase.auth.getSession();

  const claims = claimsFromAccessToken(session?.access_token);

  return {
    userId: user.id,
    email: user.email ?? '',
    fullName:
      (user.user_metadata?.['full_name'] as string | undefined) ??
      (user.user_metadata?.['name'] as string | undefined) ??
      null,
    avatarUrl: (user.user_metadata?.['avatar_url'] as string | undefined) ?? null,
    claims,
    role: claims.role,
    organizationId: claims.organization_id,
    clientAccountId: claims.client_account_id,
  };
}

/** Redirects to sign-in when there is no session. */
export async function requireUser(returnTo?: string): Promise<AuthContext> {
  const context = await getAuthContext();
  if (!context) {
    redirect(returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : '/login');
  }
  return context;
}

/**
 * Gate for the internal app.
 *
 * An authenticated user with no claims is *provisioned*, not unauthorised —
 * the token hook found no membership for them. Sending them to /login would
 * loop, so they get a distinct destination that explains the situation.
 */
export async function requireInternal(returnTo?: string): Promise<AuthContext> {
  const context = await requireUser(returnTo);

  if (isUnprovisioned(context.claims)) redirect('/no-access');
  if (!isInternalRole(context.role)) redirect('/portal');

  return context;
}

/** Gate for the client portal. */
export async function requireClient(returnTo?: string): Promise<AuthContext> {
  const context = await requireUser(returnTo);

  if (isUnprovisioned(context.claims)) redirect('/no-access');
  if (!isClientRole(context.role)) redirect('/dashboard');
  if (!context.clientAccountId) redirect('/no-access');

  return context;
}
