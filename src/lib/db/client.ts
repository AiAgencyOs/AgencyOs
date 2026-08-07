import { createBrowserClient } from '@supabase/ssr';

import { clientEnv } from '@/lib/env';

import type { Database } from './types';

/**
 * Supabase client for Client Components.
 *
 * Carries the signed-in user's JWT, so Row Level Security applies. This client
 * can only ever see what the user's policies allow — it holds no elevated key.
 */
export function createClient() {
  return createBrowserClient<Database>(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
