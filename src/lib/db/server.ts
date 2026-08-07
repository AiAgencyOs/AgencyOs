import 'server-only';

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { clientEnv } from '@/lib/env';

import type { Database } from './types';

/**
 * Per-request Supabase client for Server Components, Server Actions, and Route
 * Handlers.
 *
 * Carries the user's JWT, so **RLS applies to our own server code** — the
 * database enforces isolation even if an application-level check is missed.
 * This is the default client; reach for the admin client only in the four
 * places listed in ARCHITECTURE.md §7.3.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // Safe to ignore: middleware refreshes the session on every request.
          }
        },
      },
    },
  );
}
