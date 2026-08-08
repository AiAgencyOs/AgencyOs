import { NextResponse, type NextRequest } from 'next/server';

import { createClient } from '@/lib/db/server';
import { safeRedirectPath } from '@/lib/url';
import { completeSignIn, ensureProvisioned } from '@/modules/identity/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /auth/callback
 *
 * Terminates both sign-in flows, which arrive in different shapes:
 *   OAuth (PKCE) → ?code=...
 *   Magic link   → ?token_hash=...&type=magiclink
 *
 * On success it establishes the session cookie, runs the one-time owner
 * bootstrap, and forwards to a validated same-origin path.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;

  const next = safeRedirectPath(searchParams.get('next'), '/dashboard');
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type');

  // The provider reports its own failures here (e.g. consent denied).
  const providerError = searchParams.get('error_description') ?? searchParams.get('error');
  if (providerError) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(providerError)}`,
    );
  }

  let userId: string;

  if (code) {
    const result = await completeSignIn(code);
    if (!result.ok) {
      return NextResponse.redirect(
        `${origin}/login?error=${encodeURIComponent(result.error.message)}`,
      );
    }
    userId = result.data.userId;
  } else if (tokenHash && type) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as 'magiclink' | 'email' | 'recovery' | 'invite',
    });
    if (error || !data.user) {
      return NextResponse.redirect(
        `${origin}/login?error=${encodeURIComponent('That sign-in link is invalid or has expired.')}`,
      );
    }
    userId = data.user.id;
  } else {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent('Missing sign-in credentials.')}`,
    );
  }

  // First user on a fresh install becomes owner. No-op afterwards.
  await ensureProvisioned(userId);

  return NextResponse.redirect(`${origin}${next}`);
}
