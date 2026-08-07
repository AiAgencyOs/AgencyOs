import 'server-only';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

import { clientEnv, serverEnv } from '@/lib/env';

import type { Database } from './types';

/**
 * ⚠️  SERVICE-ROLE CLIENT — BYPASSES ROW LEVEL SECURITY ENTIRELY.
 *
 * Permitted call sites (ARCHITECTURE.md §7.3), and no others:
 *   1. Cron handlers      — app/api/cron/*
 *   2. Webhook handlers   — app/api/webhooks/*
 *   3. The job runner     — app/api/jobs/*
 *   4. Migrations / scripts
 *
 * Never use this in a path that accepts user input without an explicit
 * authorization check first. Every use must scope queries by org_id by hand,
 * because the database will not do it for you here.
 *
 * The `server-only` import above makes the build fail if this module is ever
 * pulled into a client bundle.
 */
export function createAdminClient() {
  const { SUPABASE_SERVICE_ROLE_KEY } = serverEnv();

  return createSupabaseClient<Database>(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  );
}
