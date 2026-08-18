import 'server-only';

import { hasConfiguredProvider } from '@/lib/ai/router';
import { createClient } from '@/lib/db/server';
import { readBacklog, readCronAgeSeconds } from '@/lib/observability/queries';

import { configStatus } from './config-status';
import type { Avail } from './overview-eval';
import {
  evaluateReadiness,
  readinessSummary,
  type ReadinessCheck,
  type ReadinessSignals,
} from './production-readiness-eval';

/**
 * Production readiness, from real signals — the same reads the Overview and
 * Settings pages use, run through the pure evaluator. A signal that could not be
 * read becomes an UNKNOWN check (DATA UNAVAILABLE), never a green one, so the
 * page cannot report ready on missing evidence.
 */

async function avail<T>(p: Promise<T>): Promise<Avail<T>> {
  try {
    return { ok: true, value: await p };
  } catch {
    return { ok: false };
  }
}

async function readOrg(): Promise<{ timezone: string | null; numberConfigured: boolean }> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').from('organizations').select('timezone, settings').limit(1);
  if (error) throw error;
  const row = data?.[0];
  const settings = (row?.settings ?? {}) as Record<string, unknown>;
  return {
    timezone: (row?.timezone as string | null) ?? null,
    numberConfigured: typeof settings.whatsapp_phone_number_id === 'string' && settings.whatsapp_phone_number_id.trim().length > 0,
  };
}

export type ProductionReadiness = {
  checks: ReadinessCheck[];
  summary: ReturnType<typeof readinessSummary>;
};

export async function getProductionReadiness(): Promise<ProductionReadiness> {
  const config = configStatus();
  const present = (key: string) => config.items.find((i) => i.key === key)?.present ?? false;

  const [org, cronAgeSeconds, backlog, aiProviderConfigured] = await Promise.all([
    avail(readOrg()),
    readCronAgeSeconds(),
    avail(readBacklog()),
    avail(Promise.resolve().then(() => hasConfiguredProvider())),
  ]);

  const signals: ReadinessSignals = {
    looksLocal: config.looksLocal,
    productionProblems: config.productionProblems.map((p) => p.variable),
    timezone: org.ok ? { ok: true, value: org.value.timezone } : { ok: false },
    whatsapp: {
      tokenConfigured: present('WHATSAPP_ACCESS_TOKEN'),
      numberConfigured: org.ok ? { ok: true, value: org.value.numberConfigured } : { ok: false },
    },
    aiProviderConfigured,
    cronAgeSeconds,
    backlog,
    alertWebhookConfigured: present('ALERT_WEBHOOK_URL'),
  };

  const checks = evaluateReadiness(signals);
  return { checks, summary: readinessSummary(checks) };
}
