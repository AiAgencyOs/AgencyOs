import 'server-only';

import { redirect } from 'next/navigation';
import { cache } from 'react';

import { createClient } from '@/lib/db/server';

import {
  claimsFromAccessToken,
  isClientRole,
  isInternalRole,
  isUnprovisioned,
  ROLES,
  type AppClaims,
  type Role,
} from './claims';

export type AuthContext = {
  userId: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  claims: AppClaims;
  /** The PRIMARY role — what the JWT carries and what routing decisions key on. */
  role: Role | undefined;
  /**
   * Every role the session holds: the primary first, then the secondary roles
   * an owner granted (`core.membership_roles`). Decision 2026-09-30 (F2):
   * `can(context, …)` reads this union. Loaded by `requireInternal()`; a
   * context from `getAuthContext()` / `requireUser()` carries the primary
   * alone, because the client portal has no secondary roles to load.
   */
  roles: readonly Role[];
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
    roles: claims.role ? [claims.role] : [],
    organizationId: claims.organization_id,
    clientAccountId: claims.client_account_id,
  };
}

/**
 * The secondary roles this person's active membership holds in this
 * organisation — decision 2026-09-30 (F2). One read per request however
 * many components and services call `requireInternal()`: `cache()` keys on
 * the arguments, so the layout, the page and the door share the answer.
 *
 * Degrades to none: a read that fails (the table not yet deployed, a
 * transient error) is logged and the session keeps its primary role — nobody
 * gets LESS than their primary grants — rather than the whole internal app
 * refusing to render. RLS bounds the read to the caller's own organisation;
 * the `user_id` filter narrows it to their own membership.
 */
const loadSecondaryRoles = cache(async (userId: string, organizationId: string | undefined): Promise<Role[]> => {
  if (!organizationId) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('core')
    .from('membership_roles')
    .select('role, memberships!inner(user_id, status)')
    .eq('organization_id', organizationId)
    .eq('memberships.user_id', userId)
    .eq('memberships.status', 'active');

  if (error) {
    console.error(JSON.stringify({ level: 'warn', scope: 'loadSecondaryRoles', detail: error.message }));
    return [];
  }
  return (data ?? [])
    .map((r) => r.role)
    .filter((r): r is Role => (ROLES as readonly string[]).includes(r));
});

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

  // Decision 2026-09-30 (F2): the union of every role the person holds, so
  // `can(context, …)` honours a secondary role wherever it is checked.
  const secondary = await loadSecondaryRoles(context.userId, context.organizationId);
  const roles: Role[] = context.role ? [context.role] : [];
  for (const r of secondary) if (!roles.includes(r)) roles.push(r);

  return { ...context, roles };
}

/** Gate for the client portal. */
export async function requireClient(returnTo?: string): Promise<AuthContext> {
  const context = await requireUser(returnTo);

  if (isUnprovisioned(context.claims)) redirect('/no-access');
  if (!isClientRole(context.role)) redirect('/dashboard');
  if (!context.clientAccountId) redirect('/no-access');

  return context;
}
