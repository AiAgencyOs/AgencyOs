/**
 * The integration registry's lifecycle logic — pure, so the one rule the spec is
 * emphatic about is tested without a database: **CONFIGURED is never VERIFIED**.
 * Only an integration a live signal actually exercised (the database answered, the
 * scheduler ticked) may be VERIFIED here. WhatsApp and the AI provider can be
 * CONFIGURED at most from this page — proving them needs the explicit verify
 * actions, which this page points to rather than fakes.
 */

import type { Avail } from './overview-eval';

export type Lifecycle = 'NOT_CONFIGURED' | 'CONFIGURED' | 'VERIFIED' | 'DEGRADED' | 'FAILED' | 'DISABLED';

export type Integration = {
  id: string;
  name: string;
  category: string;
  lifecycle: Lifecycle;
  /** One line of real evidence for the lifecycle state. */
  detail: string;
  /** Where the owner goes to configure or verify it. */
  href: string;
  /** True when moving it forward needs an external credential/action. */
  external: boolean;
};

export type IntegrationSignals = {
  database: Avail<true>; // ok:true means a live read succeeded -> VERIFIED
  cronAgeSeconds: number | null;
  whatsapp: { tokenConfigured: boolean; numberConfigured: Avail<boolean> };
  aiProviderConfigured: Avail<boolean>;
  alertWebhookConfigured: boolean;
};

export function evaluateIntegrations(s: IntegrationSignals): Integration[] {
  const out: Integration[] = [];

  // Database — a successful read IS its verification.
  out.push({
    id: 'database',
    name: 'Supabase (database)',
    category: 'Infrastructure',
    lifecycle: s.database.ok ? 'VERIFIED' : 'FAILED',
    detail: s.database.ok ? 'a live query succeeded' : 'DATA UNAVAILABLE — a live query failed',
    href: '/production-readiness',
    external: false,
  });

  // Scheduler — the heartbeat verifies or fails it.
  const stale = s.cronAgeSeconds === null || s.cronAgeSeconds > 15 * 60;
  out.push({
    id: 'scheduler',
    name: 'Cron scheduler',
    category: 'Infrastructure',
    lifecycle: s.cronAgeSeconds === null ? 'FAILED' : stale ? 'DEGRADED' : 'VERIFIED',
    detail:
      s.cronAgeSeconds === null
        ? 'DATA UNAVAILABLE — no heartbeat could be read'
        : stale
          ? `last tick ${Math.floor(s.cronAgeSeconds / 60)}m ago`
          : `last tick ${s.cronAgeSeconds}s ago`,
    href: '/operations',
    external: true,
  });

  // WhatsApp / Meta — CONFIGURED at most from here; verification is an action.
  const number = s.whatsapp.numberConfigured;
  const whatsappConfigured = s.whatsapp.tokenConfigured && number.ok && number.value;
  out.push({
    id: 'whatsapp',
    name: 'WhatsApp / Meta',
    category: 'Messaging',
    lifecycle: !number.ok ? 'FAILED' : whatsappConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED',
    detail: !number.ok
      ? 'DATA UNAVAILABLE'
      : whatsappConfigured
        ? 'token + phone number id present — verify on Settings (not proven here)'
        : 'token or phone number id missing',
    href: '/settings',
    external: true,
  });

  // AI provider — CONFIGURED at most; runtime verification is an action.
  const ai = s.aiProviderConfigured;
  out.push({
    id: 'ai-provider',
    name: 'AI provider',
    category: 'AI',
    lifecycle: !ai.ok ? 'FAILED' : ai.value ? 'CONFIGURED' : 'NOT_CONFIGURED',
    detail: !ai.ok ? 'DATA UNAVAILABLE' : ai.value ? 'a provider key is present — verify before enabling agents' : 'no provider configured',
    href: '/agents',
    external: true,
  });

  // Alerts — configured or degraded (only logged).
  out.push({
    id: 'alerts',
    name: 'Operational alerting',
    category: 'Observability',
    lifecycle: s.alertWebhookConfigured ? 'CONFIGURED' : 'DEGRADED',
    detail: s.alertWebhookConfigured ? 'ALERT_WEBHOOK_URL is set' : 'unset — failures are only written to the log',
    href: '/settings',
    external: true,
  });

  return out;
}

export function integrationsSummary(list: readonly Integration[]): Record<Lifecycle, number> {
  const base: Record<Lifecycle, number> = {
    NOT_CONFIGURED: 0, CONFIGURED: 0, VERIFIED: 0, DEGRADED: 0, FAILED: 0, DISABLED: 0,
  };
  for (const i of list) base[i.lifecycle] += 1;
  return base;
}
