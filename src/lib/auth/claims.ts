import { z } from 'zod';

/**
 * Typed access to the tenancy claims stamped by core.custom_access_token_hook
 * (migration 011).
 *
 * ── What these claims are for ─────────────────────────────────────────────
 * Routing and UI decisions: which shell to render, which nav to show, whether
 * to display a button. They are NOT the security boundary.
 *
 * The security boundary is Row Level Security, which reads the same values
 * server-side from the *verified* token via core.current_organization_id().
 * Even if this decoding were wrong or tampered with, the database would still
 * refuse to return another tenant's rows. See ARCHITECTURE.md §8.1 — two
 * layers, answering different questions.
 */

export const ROLES = [
  'owner',
  'ops_admin',
  'delivery_lead',
  'member',
  'contractor',
  'client_admin',
  'client_member',
] as const;

export type Role = (typeof ROLES)[number];

export const INTERNAL_ROLES: readonly Role[] = [
  'owner',
  'ops_admin',
  'delivery_lead',
  'member',
  'contractor',
];

export const CLIENT_ROLES: readonly Role[] = ['client_admin', 'client_member'];

const claimsSchema = z.object({
  organization_id: z.uuid().optional(),
  client_account_id: z.uuid().optional(),
  role: z.enum(ROLES).optional(),
  audience: z.enum(['internal', 'client']).optional(),
});

export type AppClaims = z.infer<typeof claimsSchema>;

export const EMPTY_CLAIMS: AppClaims = {};

/**
 * Decodes a JWT payload without verifying the signature.
 *
 * Verification is deliberately skipped here: the token came from the Supabase
 * client, which already validated the session, and nothing security-relevant
 * hangs on the result (see the note above). Re-verifying would mean shipping
 * the JWT secret into the app, which is strictly worse.
 */
function decodeJwtPayload(token: string): unknown {
  const segments = token.split('.');
  const payload = segments[1];
  if (segments.length !== 3 || !payload) return null;

  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const json = atob(padded);
    // Recover multi-byte UTF-8 that atob leaves as raw bytes.
    const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** Extracts app_metadata claims from an access token. Never throws. */
export function claimsFromAccessToken(accessToken: string | null | undefined): AppClaims {
  if (!accessToken) return EMPTY_CLAIMS;

  const payload = decodeJwtPayload(accessToken);
  if (!payload || typeof payload !== 'object') return EMPTY_CLAIMS;

  const appMetadata = (payload as Record<string, unknown>)['app_metadata'];
  const parsed = claimsSchema.safeParse(appMetadata ?? {});
  return parsed.success ? parsed.data : EMPTY_CLAIMS;
}

export function isInternalRole(role: Role | undefined): boolean {
  return role !== undefined && INTERNAL_ROLES.includes(role);
}

export function isClientRole(role: Role | undefined): boolean {
  return role !== undefined && CLIENT_ROLES.includes(role);
}

/**
 * True when the hook has not stamped claims — an unprovisioned user. They are
 * authenticated but belong to no organization, so every RLS policy denies.
 */
export function isUnprovisioned(claims: AppClaims): boolean {
  return !claims.organization_id || !claims.role;
}
