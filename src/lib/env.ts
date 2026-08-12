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

  /**
   * Anthropic API key, used by the Claude provider (src/lib/ai/claude.ts).
   *
   * Optional: when unset the provider does not register, and requirement
   * extraction fails with AI_PROVIDER_NOT_CONFIGURED rather than the build
   * failing. A deployment without AI configured stays fully functional
   * everywhere else.
   */
  ANTHROPIC_API_KEY: z.string().min(8, 'ANTHROPIC_API_KEY looks too short').optional(),

  /**
   * The token Meta echoes during the webhook subscription handshake
   * (app/api/webhooks/whatsapp).
   *
   * Optional, on the CRON_SECRET pattern: unset and the webhook answers 503
   * rather than accepting traffic it cannot authenticate. Chosen by us and
   * entered in the Meta app dashboard, so any sufficiently unguessable string
   * will do.
   */
  WHATSAPP_VERIFY_TOKEN: z
    .string()
    .min(16, 'WHATSAPP_VERIFY_TOKEN must be at least 16 characters')
    .optional(),

  /**
   * The Meta app secret, used to verify the X-Hub-Signature-256 HMAC on every
   * inbound delivery. This is what makes the webhook's authenticity checkable;
   * without it any caller could post a message as any client.
   *
   * Optional for the same reason and with the same consequence: unset means the
   * webhook is inert, not open.
   */
  WHATSAPP_APP_SECRET: z.string().min(16, 'WHATSAPP_APP_SECRET looks too short').optional(),

  /**
   * Where an operational alert is delivered (src/lib/observability/alert.ts).
   *
   * Any endpoint that accepts a JSON POST — a Slack incoming webhook, a
   * PagerDuty events URL, an internal receiver. Repo-owned rather than an
   * agent or a vendor SDK, so a money-handling deployment adds no third-party
   * code to its runtime for the sake of being told when a job dies.
   *
   * Optional, on the CRON_SECRET pattern, but the consequence is different and
   * worth stating: unset does not make alerting inert, it makes it local. The
   * situation is still written to the log at error level, once per situation
   * rather than every minute. What is lost is the part that reaches a person.
   */
  ALERT_WEBHOOK_URL: z.string().url('ALERT_WEBHOOK_URL must be a URL').optional(),
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
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
    WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
    ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL,
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
