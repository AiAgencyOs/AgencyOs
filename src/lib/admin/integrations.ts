import 'server-only';

import { hasConfiguredImageGenerator, hasConfiguredProvider, hasConfiguredTranscriber } from '@/lib/ai/router';
import { createClient } from '@/lib/db/server';
import { readGithubTokenScopes } from '@/lib/git/github';
import { readCronAgeSeconds } from '@/lib/observability/queries';

import { configStatusResolved } from './config-status-resolved';
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

/**
 * How many projects have linked a GitHub repository — Decision: reversed by
 * the owner on 2026-09-29. A count of links under RLS, THROWING on failure so
 * the row reads FAILED rather than "0 linked". Nothing here asks GitHub.
 */
async function countRepositoryLinks(): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .schema('projects')
    .from('repository_links')
    .select('id', { head: true, count: 'exact' });
  if (error) throw error;
  return count ?? 0;
}

export type IntegrationsView = { integrations: Integration[]; summary: Record<string, number> };

export async function getIntegrations(): Promise<IntegrationsView> {
  const config = await configStatusResolved();
  const present = (key: string) => config.items.find((i) => i.key === key)?.present ?? false;

  const [database, cronAgeSeconds, numberConfigured, aiProviderConfigured, transcriberConfigured, imageGeneratorConfigured, linkedRepositories, githubScopes] =
    await Promise.all([
      avail(pingDatabase()),
      readCronAgeSeconds(),
      avail(readOrgNumber()),
      avail(Promise.resolve().then(() => hasConfiguredProvider())),
      avail(Promise.resolve().then(() => hasConfiguredTranscriber())),
      avail(hasConfiguredImageGenerator()),
      avail(countRepositoryLinks()),
      // Bucket F — which scopes the token carries, read once per process; a failed read is "not read yet", never a claim.
      present('GITHUB_TOKEN') ? readGithubTokenScopes() : Promise.resolve(null),
    ]);

  const integrations = evaluateIntegrations({
    database,
    cronAgeSeconds,
    whatsapp: { tokenConfigured: present('WHATSAPP_ACCESS_TOKEN'), numberConfigured },
    aiProviderConfigured,
    transcriberConfigured,
    imageGeneratorConfigured,
    alertWebhookConfigured: present('ALERT_WEBHOOK_URL'),
    github: {
      tokenConfigured: present('GITHUB_TOKEN'),
      linkedRepositories,
      scopes: githubScopes?.ok ? githubScopes.data.scopes : undefined,
      mayWrite: githubScopes?.ok ? githubScopes.data.mayWrite : undefined,
    },
  });

  return { integrations, summary: integrationsSummary(integrations) };
}
