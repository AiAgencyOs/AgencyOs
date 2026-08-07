import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { clientEnv } from '@/lib/env';

import type { Database } from './types';

/**
 * Refreshes the Supabase auth session on every request and rewrites the auth
 * cookies onto the outgoing response.
 *
 * Without this, Server Components read an expired token and the user is
 * silently logged out mid-session.
 *
 * Two rules this implementation depends on, both easy to break by accident:
 *   1. `supabase.auth.getUser()` must be awaited — that call performs the
 *      refresh. Removing it makes this middleware a no-op.
 *   2. The returned response object must be the one Supabase wrote cookies to.
 *      Constructing a fresh NextResponse afterwards drops the refreshed
 *      session.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Performs the token refresh. Do not remove.
  await supabase.auth.getUser();

  return response;
}
