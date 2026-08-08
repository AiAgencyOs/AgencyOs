import { z } from 'zod';

/**
 * Environment validation. Fails fast and loudly rather than surfacing as a
 * confusing runtime error three layers deep.
 *
 * Split into two schemas because the boundary is real:
 *   - clientEnv  — NEXT_PUBLIC_*, inlined into the browser bundle. Never secret.
 *   - serverEnv  — secrets. Throws if read from browser code.
 *
 * Every NEXT_PUBLIC_ var must be referenced as a *literal* `process.env.X`
 * below. Next.js only inlines static references; `process.env[name]` yields
 * undefined in the browser.
 */

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url({
    message: 'NEXT_PUBLIC_SUPABASE_URL must be a full URL (https://<ref>.supabase.co)',
  }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z
    .string()
    .min(20, 'NEXT_PUBLIC_SUPABASE_ANON_KEY looks too short to be valid'),
  NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
});

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(20, 'SUPABASE_SERVICE_ROLE_KEY looks too short to be valid'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * Shared secret authenticating the job runner (app/api/jobs/run).
   *
   * Optional: when unset the runner refuses to run rather than running
   * unauthenticated, so a deployment that has not configured it is inert
   * rather than open.
   */
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 characters').optional(),
});

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}

const clientParsed = clientSchema.safeParse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
});

if (!clientParsed.success) {
  throw new Error(
    `Invalid public environment variables:\n${formatIssues(clientParsed.error)}\n\n` +
      `Copy .env.local.example to .env.local and fill it in.`,
  );
}

/** Safe to read anywhere — server or browser. */
export const clientEnv = clientParsed.data;

let cachedServerEnv: z.infer<typeof serverSchema> | null = null;

/**
 * Server-only secrets. Lazy so that merely importing this module from a
 * Client Component does not blow up on a missing service-role key.
 */
export function serverEnv(): z.infer<typeof serverSchema> {
  if (typeof window !== 'undefined') {
    throw new Error('serverEnv() was called in the browser. Secrets must never reach the client.');
  }
  if (cachedServerEnv) return cachedServerEnv;

  const parsed = serverSchema.safeParse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    NODE_ENV: process.env.NODE_ENV,
    CRON_SECRET: process.env.CRON_SECRET,
  });

  if (!parsed.success) {
    throw new Error(
      `Invalid server environment variables:\n${formatIssues(parsed.error)}\n\n` +
        `Copy .env.local.example to .env.local and fill it in.`,
    );
  }

  cachedServerEnv = parsed.data;
  return cachedServerEnv;
}

export const isProduction = process.env.NODE_ENV === 'production';
