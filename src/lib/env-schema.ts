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
   * The Figma personal access token — Designer §24; G-301.
   *
   * Optional, and its absence is a supported state rather than a degraded
   * one: without it a person pastes the file key and node id and the record
   * says the reference is unverified. With it the same reference can be
   * checked and the version read from the file. Nothing about it lets
   * AgencyOS create a Figma artifact.
   */
  FIGMA_ACCESS_TOKEN: z.string().min(8, 'FIGMA_ACCESS_TOKEN looks too short').optional(),

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
   * Speech-to-text, and the one credential AgencyOS has that is not
   * Anthropic's — see ADM-94.
   *
   * Optional, on the same pattern as every other key here: without it there is
   * no transcriber, a voice note is recorded and not heard, and the transcript
   * says so. Nothing pretends.
   */
  OPENAI_API_KEY: z.string().min(8, 'OPENAI_API_KEY looks too short').optional(),
  OPENAI_BASE_URL: z.string().url().optional(),

  /**
   * Where the Anthropic API lives. Set only by tests. Modelled so it is
   * validated and so claude.ts can pass it explicitly rather than letting the
   * SDK read it from the ambient environment — an unmodelled variable that
   * redirects the real API key at an arbitrary host is a credential edge.
   * Production must NOT set it.
   */
  ANTHROPIC_BASE_URL: z.string().url().optional(),

  /**
   * The providers ADM-85 added beside Anthropic (src/lib/ai/providers.ts),
   * each optional on the same contract: unset, and that vendor's models are
   * simply not served. OPENAI_API_KEY above now serves generation too, as the
   * decision says. The base URLs are the harness's, forbidden on an external
   * host in production below.
   */
  GEMINI_API_KEY: z.string().min(8, 'GEMINI_API_KEY looks too short').optional(),
  GEMINI_BASE_URL: z.string().url().optional(),
  XAI_API_KEY: z.string().min(8, 'XAI_API_KEY looks too short').optional(),
  XAI_BASE_URL: z.string().url().optional(),
  OPENROUTER_API_KEY: z.string().min(8, 'OPENROUTER_API_KEY looks too short').optional(),
  OPENROUTER_BASE_URL: z.string().url().optional(),

  /**
   * Google Calendar + Meet (ADM-102, G-242): a service account acting as the
   * mailbox the agency books against. All four optional on the same contract
   * as every provider key: unset, and availability keeps answering
   * `unconfigured` (BLK-005). The two base URLs are the harness's.
   */
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email('GOOGLE_SERVICE_ACCOUNT_EMAIL must be the account’s client_email').optional(),
  GOOGLE_SERVICE_ACCOUNT_KEY: z.string().min(64, 'GOOGLE_SERVICE_ACCOUNT_KEY looks too short to be a PEM key').optional(),
  GOOGLE_CALENDAR_ID: z.string().min(3, 'GOOGLE_CALENDAR_ID looks too short').optional(),
  GOOGLE_IMPERSONATE: z.string().email('GOOGLE_IMPERSONATE must be a Workspace user’s address').optional(),
  GOOGLE_OAUTH_BASE_URL: z.string().url().optional(),
  GOOGLE_CALENDAR_BASE_URL: z.string().url().optional(),

  /**
   * The vault the owner asked for, overturning ADM-84 §9: encrypts every
   * provider key an admin enters through Settings and stores in
   * ai.provider_credentials (src/modules/ai/vault.ts, AES-256-GCM). Required
   * in production below, on the same footing as CRON_SECRET — without it the
   * vault is unusable rather than silently insecure.
   */
  VAULT_ENCRYPTION_KEY: z.string().min(32, 'VAULT_ENCRYPTION_KEY must be at least 32 characters').optional(),
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

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])([:/]|$)/i;

/** Every base-URL override a credential could be redirected through. One list, read by the check and by its test. */
export const OVERRIDABLE_BASE_URLS = [
  'WHATSAPP_GRAPH_BASE_URL', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'GEMINI_BASE_URL', 'XAI_BASE_URL', 'OPENROUTER_BASE_URL',
  'GOOGLE_OAUTH_BASE_URL', 'GOOGLE_CALENDAR_BASE_URL',
] as const;

export function productionConfigProblems(server: ServerEnv, appUrl: string): ConfigProblem[] {
  if (server.NODE_ENV !== 'production') return [];
  const problems: ConfigProblem[] = [];

  // The scheduler is AgencyOS's heartbeat. Without its secret the runner is
  // inert (503 on every tick) — a production deployment that cannot run jobs.
  // Always enforced, even for the harness (CI sets it).
  if (!server.CRON_SECRET) {
    problems.push({ variable: 'CRON_SECRET', problem: 'required in production — the job runner is inert (503) without it' });
  }

  // Without it, a vault-stored provider key encrypts to bytes nothing can
  // ever decrypt again — set once, before the first key is entered.
  if (!server.VAULT_ENCRYPTION_KEY) {
    problems.push({ variable: 'VAULT_ENCRYPTION_KEY', problem: 'required in production — a provider key entered through Settings could never be decrypted without it' });
  }

  // The webhook's two halves are useless apart: the verify token answers the
  // subscription handshake, the app secret checks each delivery's signature.
  // Always enforced.
  const hasVerify = Boolean(server.WHATSAPP_VERIFY_TOKEN);
  const hasSecret = Boolean(server.WHATSAPP_APP_SECRET);
  if (hasVerify !== hasSecret) {
    problems.push({
      variable: hasVerify ? 'WHATSAPP_APP_SECRET' : 'WHATSAPP_VERIFY_TOKEN',
      problem: 'WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET must be set together or not at all — one without the other is a webhook that only half-authenticates',
    });
  }

  // A base-URL override is only dangerous when it points at an EXTERNAL host —
  // that is the credential-redirection edge. A LOOPBACK override cannot
  // exfiltrate anything, and it is the signature of the verification harness:
  // CI builds and starts the app in production mode to exercise HTTP paths
  // against local stubs. So an external override is forbidden, a loopback one
  // is allowed and marks a harness — which then exempts the localhost app-URL
  // rule below (a harness runs on localhost by definition). CRON_SECRET and
  // the webhook pair above are still enforced, so this is not a blanket bypass.
  let harness = false;
  for (const v of OVERRIDABLE_BASE_URLS) {
    const url = server[v];
    if (!url) continue;
    if (LOOPBACK.test(url)) harness = true;
    else problems.push({ variable: v, problem: 'must NOT point at an external host in production — it would redirect the real credential' });
  }

  // The app's own public URL becomes OAuth redirect targets and links in
  // messages. A localhost or http value in a real deployment sends users
  // nowhere real; in the harness it is expected and skipped.
  if (!harness) {
    if (!/^https:\/\//.test(appUrl)) {
      problems.push({ variable: 'NEXT_PUBLIC_APP_URL', problem: 'must be https in production' });
    } else if (LOOPBACK.test(appUrl)) {
      problems.push({ variable: 'NEXT_PUBLIC_APP_URL', problem: 'must not be a loopback/any address in production' });
    }
  }

  return problems;
}
