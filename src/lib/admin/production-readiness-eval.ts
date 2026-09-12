/**
 * Production readiness as a live checklist — pure, so each verdict can be tested
 * without a database. The rule the spec is emphatic about lives here: a value
 * being CONFIGURED is never GREEN on its own. WhatsApp and the AI provider are
 * YELLOW until a human verifies them against the real provider AND that
 * verification is RECORDED (G-236) — a form message that vanished was not
 * evidence, and the page said so by never moving; a signal
 * that could not be read is UNKNOWN, never green. Nothing here is marked ready
 * because "the setting exists" — only because the evidence supports it.
 */

import type { BacklogRow } from '@/lib/observability/backlog';

import type { Avail } from './overview-eval';

export type ReadinessStatus = 'green' | 'yellow' | 'red' | 'unknown';

export type ReadinessCheck = {
  id: string;
  title: string;
  status: ReadinessStatus;
  /** What was actually observed — the evidence, not a claim. */
  evidence: string;
  /** How to move it to green. */
  remediation: string;
  /** True when the fix needs an external fact/credential a human must supply. */
  external: boolean;
};

export type ReadinessSignals = {
  looksLocal: boolean;
  /** Production-required config the app would refuse to boot without, as variable names. */
  productionProblems: string[];
  timezone: Avail<string | null>;
  whatsapp: {
    tokenConfigured: boolean;
    numberConfigured: Avail<boolean>;
    /** G-236: when a person last verified the number with Meta, and what Meta answered. */
    verifiedAt: string | null;
    verifiedNumber: string | null;
    /** G-236: when the controlled first send to the internal recipient last went. */
    testSentAt: string | null;
  };
  aiProviderConfigured: Avail<boolean>;
  /** G-236: when a real call last answered, and which model served it. */
  aiProviderVerifiedAt: string | null;
  aiProviderVerifiedModel: string | null;
  cronAgeSeconds: number | null;
  backlog: Avail<BacklogRow>;
  alertWebhookConfigured: boolean;
};

function avail<T>(a: Avail<T>): T | undefined {
  return a.ok ? a.value : undefined;
}

export function evaluateReadiness(s: ReadinessSignals): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];

  checks.push({
    id: 'environment',
    title: 'Deployment is a real environment, not local',
    status: s.looksLocal ? 'red' : 'green',
    evidence: s.looksLocal ? 'APP URL points at localhost/127.0.0.1' : 'APP URL is a non-local host',
    remediation: 'Set NEXT_PUBLIC_APP_URL to the production domain in the deployment environment.',
    external: true,
  });

  checks.push({
    id: 'config',
    title: 'Every production-required value is present and safe',
    status: s.productionProblems.length === 0 ? 'green' : 'red',
    evidence:
      s.productionProblems.length === 0
        ? 'productionConfigProblems() reports nothing missing'
        : `${s.productionProblems.length} unmet: ${s.productionProblems.slice(0, 6).join(', ')}`,
    remediation: 'Set the missing values in the deployment environment (never in the product).',
    external: true,
  });

  const tz = s.timezone;
  checks.push({
    id: 'timezone',
    title: 'Agency timezone is set (nothing sends until it is)',
    status: !tz.ok ? 'unknown' : tz.value ? 'green' : 'red',
    evidence: !tz.ok ? 'DATA UNAVAILABLE' : tz.value ? `set to ${tz.value}` : 'not set — follow-up sending is paused (G-137)',
    remediation: 'Set the agency timezone on the Settings page.',
    external: false,
  });

  const numberConfigured = avail(s.whatsapp.numberConfigured);
  const whatsappConfigured = s.whatsapp.tokenConfigured && numberConfigured === true;
  // G-236: green only on RECORDED evidence — a person verified the number with
  // Meta AND the controlled first send went. Either half missing is named.
  const whatsappVerified = whatsappConfigured && s.whatsapp.verifiedAt !== null && s.whatsapp.testSentAt !== null;
  checks.push({
    id: 'whatsapp',
    title: 'WhatsApp is configured AND verified with Meta',
    status: !s.whatsapp.numberConfigured.ok ? 'unknown' : !whatsappConfigured ? 'red' : whatsappVerified ? 'green' : 'yellow',
    evidence: !s.whatsapp.numberConfigured.ok
      ? 'DATA UNAVAILABLE'
      : !whatsappConfigured
        ? 'token or phone number id missing'
        : whatsappVerified
          ? `verified with Meta ${s.whatsapp.verifiedAt}${s.whatsapp.verifiedNumber ? ` (${s.whatsapp.verifiedNumber})` : ''} · test message sent ${s.whatsapp.testSentAt}`
          : s.whatsapp.verifiedAt
            ? `verified with Meta ${s.whatsapp.verifiedAt}${s.whatsapp.verifiedNumber ? ` (${s.whatsapp.verifiedNumber})` : ''} — the test send to the internal recipient has not been made`
            : 'token and phone number id present — NOT yet verified against Meta',
    remediation: !whatsappConfigured
      ? 'Set WHATSAPP_ACCESS_TOKEN and the org phone number id, then verify.'
      : s.whatsapp.verifiedAt
        ? 'Send the test message to the internal recipient from Settings.'
        : 'Run "Verify configuration" on Settings, then send the test message to the internal recipient.',
    external: true,
  });

  const providerConfigured = avail(s.aiProviderConfigured);
  const providerVerified = providerConfigured === true && s.aiProviderVerifiedAt !== null;
  checks.push({
    id: 'ai-provider',
    title: 'An AI provider is configured (and runtime-verified)',
    status: !s.aiProviderConfigured.ok ? 'unknown' : !providerConfigured ? 'red' : providerVerified ? 'green' : 'yellow',
    evidence: !s.aiProviderConfigured.ok
      ? 'DATA UNAVAILABLE'
      : !providerConfigured
        ? 'no provider configured'
        : providerVerified
          ? `a real call answered ${s.aiProviderVerifiedAt}${s.aiProviderVerifiedModel ? ` (${s.aiProviderVerifiedModel})` : ''}`
          : 'a provider key is present — NOT yet exercised against the API',
    remediation: providerConfigured
      ? 'Run "Verify provider" on the Agents page — one real call, its answer recorded.'
      : 'Set the provider API key in the deployment environment.',
    external: true,
  });

  const cronStale = s.cronAgeSeconds === null || s.cronAgeSeconds > 15 * 60;
  checks.push({
    id: 'cron',
    title: 'The scheduler is running',
    status: s.cronAgeSeconds === null ? 'unknown' : cronStale ? 'red' : 'green',
    evidence:
      s.cronAgeSeconds === null
        ? 'DATA UNAVAILABLE'
        : cronStale
          ? `last tick ${Math.floor(s.cronAgeSeconds / 60)}m ago — beyond the 15m window`
          : `last tick ${s.cronAgeSeconds}s ago`,
    remediation: 'Confirm the cron/scheduler trigger is deployed and hitting the tick endpoint.',
    external: true,
  });

  const backlog = avail(s.backlog);
  const lost = backlog ? backlog.dead_jobs + backlog.dead_events + backlog.unpublished_events : 0;
  checks.push({
    id: 'backlog',
    title: 'No work has been lost',
    status: !s.backlog.ok ? 'unknown' : lost > 0 ? 'red' : 'green',
    evidence: !s.backlog.ok
      ? 'DATA UNAVAILABLE'
      : lost > 0
        ? `${lost} dead/unpublished item(s) — see Operations`
        : 'no dead jobs, dead events, or stuck unpublished events',
    remediation: 'Investigate and requeue dead work from the Operations page.',
    external: false,
  });

  checks.push({
    id: 'alerts',
    title: 'Operational alerts reach a human',
    status: s.alertWebhookConfigured ? 'green' : 'yellow',
    evidence: s.alertWebhookConfigured ? 'ALERT_WEBHOOK_URL is set' : 'ALERT_WEBHOOK_URL is unset — alerts are only logged',
    remediation: 'Set ALERT_WEBHOOK_URL so failures page a person, not just the log.',
    external: true,
  });

  return checks;
}

export function readinessSummary(checks: readonly ReadinessCheck[]): {
  green: number;
  yellow: number;
  red: number;
  unknown: number;
  /** True only when nothing is red or unknown — the honest gate for "ready". */
  ready: boolean;
} {
  const by = (st: ReadinessStatus) => checks.filter((c) => c.status === st).length;
  const red = by('red');
  const unknown = by('unknown');
  return { green: by('green'), yellow: by('yellow'), red, unknown, ready: red === 0 && unknown === 0 };
}

/**
 * The one sentence the page opens with, from the counts alone.
 *
 * Three states, not two. The first draft had only "NOT ready" and "no hard
 * blockers, but N still need verification" — so the first time every item was
 * verified in production (2026-09-12) the banner read "0 item(s) still need
 * verification … Configured is not proven" over eight green rows. A summary
 * that cannot say "ready" when the evidence does is as dishonest as one that
 * says it early.
 */
export function readinessSentence(summary: ReturnType<typeof readinessSummary>): {
  tone: 'danger' | 'warning' | 'success';
  text: string;
} {
  if (summary.red > 0 || summary.unknown > 0) {
    return {
      tone: 'danger',
      text: `NOT production ready — ${summary.red} blocking, ${summary.unknown} unknown, ${summary.yellow} awaiting verification.`,
    };
  }
  if (summary.yellow > 0) {
    return {
      tone: 'warning',
      text: `No hard blockers, but ${summary.yellow} item(s) still need verification before go-live. Configured is not proven.`,
    };
  }
  return {
    tone: 'success',
    text: `Production ready — every one of the ${summary.green} checks is green on recorded evidence, including the external verifications.`,
  };
}
