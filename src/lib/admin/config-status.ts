import 'server-only';

import { productionConfigProblems, serverSchema, type ConfigProblem } from '@/lib/env-schema';

/**
 * What the Admin needs to answer "is this deployment configured?" — WITHOUT
 * ever learning a secret value.
 *
 * This is the runnable half of config-doctor (scripts/config-doctor.ts) made
 * available to a server component. It reuses the exact schema and production
 * rules the app boots with (src/lib/env-schema.ts) — the same source
 * `src/instrumentation.ts` refuses a bad production start with — so the page can
 * never disagree with what the app actually enforces.
 *
 * It reads process.env on the SERVER only. For every variable it reports
 * PRESENCE (set and non-empty) and NEVER the value, its length, or any prefix:
 * the output is safe to render to an owner and safe to paste into an issue. A
 * secret is a red "not configured" or a green "configured", nothing more.
 */

export type ConfigArea = 'Database' | 'Application' | 'Scheduler' | 'WhatsApp' | 'AI provider' | 'Alerts';

export type ConfigItem = {
  key: string;
  area: ConfigArea;
  /** Server-only secret: set in the deployment env, never shown, never in preview. */
  secret: boolean;
  requiredInProduction: boolean;
  /** Set and non-empty in this environment. NEVER the value. */
  present: boolean;
  /** Safe, value-free explanation of what it does and what "missing" costs. */
  note: string;
};

const ITEMS: readonly Omit<ConfigItem, 'present'>[] = [
  { key: 'NEXT_PUBLIC_SUPABASE_URL', area: 'Database', secret: false, requiredInProduction: true, note: 'The Supabase project URL. Public by design.' },
  { key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', area: 'Database', secret: false, requiredInProduction: true, note: 'The publishable anon key. Public by design — RLS gates it.' },
  { key: 'SUPABASE_SERVICE_ROLE_KEY', area: 'Database', secret: true, requiredInProduction: true, note: 'Server-only. Bypasses RLS — never sent to the browser, never in preview.' },
  { key: 'NEXT_PUBLIC_APP_URL', area: 'Application', secret: false, requiredInProduction: true, note: 'The production URL. Must be https and non-localhost; inlined at build time.' },
  { key: 'CRON_SECRET', area: 'Scheduler', secret: true, requiredInProduction: true, note: 'Authenticates the job runner. Without it the scheduler is inert (every tick 503s).' },
  { key: 'WHATSAPP_VERIFY_TOKEN', area: 'WhatsApp', secret: true, requiredInProduction: false, note: 'Answers Meta’s webhook subscription handshake. Set together with the app secret.' },
  { key: 'WHATSAPP_APP_SECRET', area: 'WhatsApp', secret: true, requiredInProduction: false, note: 'Verifies the X-Hub-Signature-256 HMAC on inbound webhooks.' },
  { key: 'WHATSAPP_ACCESS_TOKEN', area: 'WhatsApp', secret: true, requiredInProduction: false, note: 'The token outbound WhatsApp messages are sent with. Unset ⇒ sending disabled.' },
  { key: 'ANTHROPIC_API_KEY', area: 'AI provider', secret: true, requiredInProduction: false, note: 'Server-only AI key. Unset ⇒ AI_PROVIDER_NOT_CONFIGURED (never a silent fake result).' },
  { key: 'ANTHROPIC_BASE_URL', area: 'AI provider', secret: false, requiredInProduction: false, note: 'Test-only override; production must NOT point it at an external host.' },
  { key: 'ALERT_WEBHOOK_URL', area: 'Alerts', secret: true, requiredInProduction: false, note: 'Where operational alerts are POSTed. Unset ⇒ alerts log only, never delivered.' },
];

export type ConfigStatus = {
  nodeEnv: string;
  items: ConfigItem[];
  /**
   * What a real production boot would refuse, from the same
   * productionConfigProblems() src/instrumentation.ts calls. Empty when the
   * environment satisfies every production-required value.
   */
  productionProblems: ConfigProblem[];
  /** True when NEXT_PUBLIC_APP_URL points at localhost/127.0.0.1 — i.e. not a real deployment. */
  looksLocal: boolean;
};

const isPresent = (v: string | undefined): boolean => typeof v === 'string' && v.trim().length > 0;

/**
 * Compute the config status from the current server environment. Pure w.r.t.
 * process.env: no database, no I/O, so it is directly unit-testable by setting
 * env vars.
 */
export function configStatus(env: Record<string, string | undefined> = process.env): ConfigStatus {
  const items: ConfigItem[] = ITEMS.map((it) => ({ ...it, present: isPresent(env[it.key]) }));

  // Parse under PRODUCTION rules so the problem list is exactly what a real
  // deployment would refuse — the same call the app boots with. A shape failure
  // (a required server secret missing/malformed) is surfaced as a problem too,
  // named by variable, never by value.
  const serverParsed = serverSchema.safeParse({ ...env, NODE_ENV: 'production' });
  const appUrl = env.NEXT_PUBLIC_APP_URL ?? '';
  const productionProblems: ConfigProblem[] = serverParsed.success
    ? productionConfigProblems(serverParsed.data, appUrl)
    : serverParsed.error.issues.map((i) => ({ variable: i.path.join('.') || '(root)', problem: i.message }));

  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    items,
    productionProblems,
    looksLocal: /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(appUrl),
  };
}
