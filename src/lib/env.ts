import {
  clientSchema,
  serverSchema,
  formatIssues,
  productionConfigProblems,
  type ServerEnv,
} from './env-schema';

/**
 * Environment validation. Fails fast and loudly rather than surfacing as a
 * confusing runtime error three layers deep.
 *
 * The shapes and the production rules live in env-schema.ts (side-effect-free,
 * so scripts/config-doctor.ts can inspect an environment without importing the
 * eager parse below). This module does the parsing and exposes the values.
 *
 *   - clientEnv  — NEXT_PUBLIC_*, inlined into the browser bundle. Never secret.
 *   - serverEnv  — secrets. Throws if read from browser code.
 *
 * Every NEXT_PUBLIC_ var is referenced as a *literal* `process.env.X` below.
 * Next.js only inlines static references; `process.env[name]` yields undefined
 * in the browser.
 */

export type { ConfigProblem } from './env-schema';
export { productionConfigProblems } from './env-schema';

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

let cachedServerEnv: ServerEnv | null = null;

/**
 * Server-only secrets. Lazy so that merely importing this module from a
 * Client Component does not blow up on a missing service-role key.
 *
 * Validates the SHAPE of every variable (a malformed value throws here). The
 * production-completeness check is deliberately separate — see
 * assertProductionConfig — because this runs during `next build`'s page-data
 * collection (which is production mode with the developer's env), and a
 * required-in-production check there would fail the build on values the
 * deployment will supply. Shape is safe to check anywhere; completeness is a
 * runtime-startup concern.
 */
export function serverEnv(): ServerEnv {
  if (typeof window !== 'undefined') {
    throw new Error('serverEnv() was called in the browser. Secrets must never reach the client.');
  }
  if (cachedServerEnv) return cachedServerEnv;

  const parsed = serverSchema.safeParse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    NODE_ENV: process.env.NODE_ENV,
    CRON_SECRET: process.env.CRON_SECRET,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
    WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
    ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL,
    WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_GRAPH_BASE_URL: process.env.WHATSAPP_GRAPH_BASE_URL,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
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

/**
 * The production-completeness check, run once at real server startup by
 * src/instrumentation.ts — NOT at build time. A missing or unsafe
 * required-in-production value refuses the server to start, naming every
 * offender, rather than booting and 503-ing the cron heartbeat or 500-ing per
 * request. Never supplies a value; the blanks are ADM-60's, the owner's.
 */
export function assertProductionConfig(): void {
  const problems = productionConfigProblems(serverEnv(), clientEnv.NEXT_PUBLIC_APP_URL);
  if (problems.length > 0) {
    throw new Error(
      `Production configuration is incomplete or unsafe:\n${
        problems.map((p) => `  • ${p.variable}: ${p.problem}`).join('\n')
      }\n\nThese are the runbook's required-in-production values. Set them in the deployment environment; this check will not invent them.`,
    );
  }
}

export const isProduction = process.env.NODE_ENV === 'production';
