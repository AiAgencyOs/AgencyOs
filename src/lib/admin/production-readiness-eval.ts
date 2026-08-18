/**
 * Production readiness as a live checklist — pure, so each verdict can be tested
 * without a database. The rule the spec is emphatic about lives here: a value
 * being CONFIGURED is never GREEN on its own. WhatsApp and the AI provider are
 * at best YELLOW until a human verifies them against the real provider; a signal
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
  whatsapp: { tokenConfigured: boolean; numberConfigured: Avail<boolean> };
  aiProviderConfigured: Avail<boolean>;
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
  checks.push({
    id: 'whatsapp',
    title: 'WhatsApp is configured AND verified with Meta',
    status: !s.whatsapp.numberConfigured.ok ? 'unknown' : whatsappConfigured ? 'yellow' : 'red',
    evidence: !s.whatsapp.numberConfigured.ok
      ? 'DATA UNAVAILABLE'
      : whatsappConfigured
        ? 'token and phone number id present — NOT yet verified against Meta'
        : 'token or phone number id missing',
    remediation: whatsappConfigured
      ? 'Run "Verify configuration" on Settings, then a test send to a configured internal recipient.'
      : 'Set WHATSAPP_ACCESS_TOKEN and the org phone number id, then verify.',
    external: true,
  });

  const providerConfigured = avail(s.aiProviderConfigured);
  checks.push({
    id: 'ai-provider',
    title: 'An AI provider is configured (and runtime-verified)',
    status: !s.aiProviderConfigured.ok ? 'unknown' : providerConfigured ? 'yellow' : 'red',
    evidence: !s.aiProviderConfigured.ok
      ? 'DATA UNAVAILABLE'
      : providerConfigured
        ? 'a provider key is present — NOT yet exercised against the API'
        : 'no provider configured',
    remediation: providerConfigured
      ? 'Verify the provider from the Agents/AI page before enabling any agent.'
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
