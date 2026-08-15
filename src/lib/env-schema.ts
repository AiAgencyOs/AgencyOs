import { z } from 'zod';

/**
 * The environment shape and the production rules, with NO side effects.
 *
 * Split out from env.ts so that a tool which needs to INSPECT an environment
 * — scripts/config-doctor.ts — can import the schemas and the production check
 * without triggering env.ts's eager parse, which throws the moment a public
 * variable is missing. env.ts imports these and does the parsing; this file
 * only describes.
 */

export const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url({
    message: 'NEXT_PUBLIC_SUPABASE_URL must be a full URL (https://<ref>.supabase.co)',
  }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z
    .string()
    .min(20, 'NEXT_PUBLIC_SUPABASE_ANON_KEY looks too short to be valid'),
  NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
});

export const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(20, 'SUPABASE_SERVICE_ROLE_KEY looks too short to be valid'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * Shared secret authenticating the job runner (app/api/jobs/run).
   *
   * Optional in the schema so a development or test deployment stays inert
   * rather than failing to parse — but REQUIRED in production, enforced by
   * productionConfigProblems below.
   */
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 characters').optional(),

  /** Anthropic API key (src/lib/ai/claude.ts). Optional: unset disables AI. */
  ANTHROPIC_API_KEY: z.string().min(8, 'ANTHROPIC_API_KEY looks too short').optional(),

  /**
   * The token Meta echoes during the webhook subscription handshake. Optional
   * alone; in production it must be set together with WHATSAPP_APP_SECRET.
   */
  WHATSAPP_VERIFY_TOKEN: z
    .string()
    .min(16, 'WHATSAPP_VERIFY_TOKEN must be at least 16 characters')
    .optional(),

  /** The Meta app secret, verifying the X-Hub-Signature-256 HMAC on inbound. */
  WHATSAPP_APP_SECRET: z.string().min(16, 'WHATSAPP_APP_SECRET looks too short').optional(),

  /** Where an operational alert is delivered (src/lib/observability/alert.ts). */
  ALERT_WEBHOOK_URL: z.string().url('ALERT_WEBHOOK_URL must be a URL').optional(),

  /** The token outbound WhatsApp messages are sent with (G-014, ADM-09). */
  WHATSAPP_ACCESS_TOKEN: z.string().min(16, 'WHATSAPP_ACCESS_TOKEN looks too short').optional(),

  /**
   * Where the Graph API lives. Set only by tests, which point it at a stub so
   * the send path is exercised without a real message reaching a real person.
   * Production must NOT set it (productionConfigProblems refuses it).
   */
  WHATSAPP_GRAPH_BASE_URL: z.string().url().optional(),

  /**
   * Where the Anthropic API lives. Set only by tests. Modelled so it is
   * validated and so claude.ts can pass it explicitly rather than letting the
   * SDK read it from the ambient environment — an unmodelled variable that
   * redirects the real API key at an arbitrary host is a credential edge.
   * Production must NOT set it.
   */
  ANTHROPIC_BASE_URL: z.string().url().optional(),
});

export type ServerEnv = z.infer<typeof serverSchema>;

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}

/**
 * What production requires that development does not.
 *
 * Technical enforcement of the runbook's "required in production" table — not
 * new policy, and it NEVER supplies or defaults a value (those are ADM-60's
 * blanks only the owner can fill). It names what is missing or unsafe; it does
 * not invent it. Returns an empty list outside production.
 */
export type ConfigProblem = { variable: string; problem: string };

export function productionConfigProblems(server: ServerEnv, appUrl: string): ConfigProblem[] {
  if (server.NODE_ENV !== 'production') return [];
  const problems: ConfigProblem[] = [];

  // The scheduler is AgencyOS's heartbeat. Without its secret the runner is
  // inert (503 on every tick) — a production deployment that cannot run jobs.
  if (!server.CRON_SECRET) {
    problems.push({ variable: 'CRON_SECRET', problem: 'required in production — the job runner is inert (503) without it' });
  }

  // The webhook's two halves are useless apart: the verify token answers the
  // subscription handshake, the app secret checks each delivery's signature.
  const hasVerify = Boolean(server.WHATSAPP_VERIFY_TOKEN);
  const hasSecret = Boolean(server.WHATSAPP_APP_SECRET);
  if (hasVerify !== hasSecret) {
    problems.push({
      variable: hasVerify ? 'WHATSAPP_APP_SECRET' : 'WHATSAPP_VERIFY_TOKEN',
      problem: 'WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET must be set together or not at all — one without the other is a webhook that only half-authenticates',
    });
  }

  // The test-only base-URL overrides redirect the real credentials at an
  // arbitrary host. In production their presence is never legitimate.
  for (const v of ['WHATSAPP_GRAPH_BASE_URL', 'ANTHROPIC_BASE_URL'] as const) {
    if (server[v]) {
      problems.push({ variable: v, problem: 'must NOT be set in production — it points the real credential at a test stub' });
    }
  }

  // The app's own public URL becomes OAuth redirect targets and links in
  // messages. A localhost or http value in production sends users nowhere real.
  if (!/^https:\/\//.test(appUrl)) {
    problems.push({ variable: 'NEXT_PUBLIC_APP_URL', problem: 'must be https in production' });
  } else if (/^https:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])([:/]|$)/i.test(appUrl)) {
    problems.push({ variable: 'NEXT_PUBLIC_APP_URL', problem: 'must not be a loopback/any address in production' });
  }

  return problems;
}
