import 'server-only';

import { hasConfiguredProvider } from '@/lib/ai/router';
import { createClient } from '@/lib/db/server';
import { readCronAgeSeconds } from '@/lib/observability/queries';

import { configStatus } from './config-status';
import { evaluateIntegrations, integrationsSummary, type Integration } from './integrations-eval';
import type { Avail } from './overview-eval';

/**
 * The integration registry, from real signals — the same reads the rest of the
 * Admin uses, run through the pure lifecycle evaluator. A live database read is
 * the database's own verification; everything else is CONFIGURED at most, because
 * proving it needs the explicit verify actions this page links to.
 */

async function avail<T>(p: Promise<T>): Promise<Avail<T>> {
  try {
    return { ok: true, value: await p };
  } catch {
    return { ok: false };
  }
}

/** A trivial read that THROWS on failure — so a down database becomes FAILED, not a false VERIFIED. */
async function pingDatabase(): Promise<true> {
  const supabase = await createClient();
  const { error } = await supabase.schema('core').from('organizations').select('id', { head: true, count: 'exact' });
  if (error) throw error;
  return true;
}

async function readOrgNumber(): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').from('organizations').select('settings').limit(1);
  if (error) throw error;
  const settings = (data?.[0]?.settings ?? {}) as Record<string, unknown>;
  return typeof settings.whatsapp_phone_number_id === 'string' && settings.whatsapp_phone_number_id.trim().length > 0;
}

export type IntegrationsView = { integrations: Integration[]; summary: Record<string, number> };

export async function getIntegrations(): Promise<IntegrationsView> {
  const config = configStatus();
  const present = (key: string) => config.items.find((i) => i.key === key)?.present ?? false;

  const [database, cronAgeSeconds, numberConfigured, aiProviderConfigured] = await Promise.all([
    avail(pingDatabase()),
    readCronAgeSeconds(),
    avail(readOrgNumber()),
    avail(Promise.resolve().then(() => hasConfiguredProvider())),
  ]);

  const integrations = evaluateIntegrations({
    database,
    cronAgeSeconds,
    whatsapp: { tokenConfigured: present('WHATSAPP_ACCESS_TOKEN'), numberConfigured },
    aiProviderConfigured,
    alertWebhookConfigured: present('ALERT_WEBHOOK_URL'),
  });

  return { integrations, summary: integrationsSummary(integrations) };
}
