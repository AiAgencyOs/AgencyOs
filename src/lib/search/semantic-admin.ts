import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { hasRole } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

import { embeddableText } from './embeddable-text';
import { embeddingCostMinor, resolveEmbeddingProvider } from './embedding-provider';
import { readSourcePage, type LooseDb } from './semantic-indexer';
import { agentFields, SEMANTIC_SOURCES, type AgentSource } from './semantic-sources';

/**
 * The owner's side of search by meaning — decision 14: what state it is in,
 * what turning it on would cost (shown first), and the two audited doors
 * (`core.request_semantic_backfill`, `core.stop_semantic_indexing`).
 *
 * No money is spent by looking: the estimate reads the owner's own records
 * and counts characters. Nothing is embedded until the owner confirms, and
 * the indexing job (`semantic-indexer.ts`) then does the work in bounded
 * ticks under the monthly budget gates.
 */

/** Rough English-text rule the vendors themselves quote: four characters to a token. */
export const CHARS_PER_TOKEN = 4;
const ESTIMATE_PAGE = 1000;
const ESTIMATE_MAX_PAGES = 50;

export type SemanticPanel = {
  /** A vendor key resolves (and which vendor). */
  provider: { id: string; model: string } | null;
  enabled: boolean;
  status: 'off' | 'requested' | 'running' | 'done' | 'blocked';
  total: number;
  done: number;
  note: string | null;
  requestedAt: string | null;
  lastRunAt: string | null;
};

export async function getSemanticPanel(): Promise<SemanticPanel> {
  await requireInternal();
  const supabase = await createClient();
  const db = supabase as unknown as LooseDb;
  const [read, provider] = await Promise.all([
    db.schema('core').from('semantic_search_state').select('enabled, status, total, done, note, requested_at, last_run_at').maybeSingle(),
    resolveEmbeddingProvider(),
  ]);
  if (read.error) unreadable('getSemanticPanel', read.error);
  const s = read.data as { enabled: boolean; status: SemanticPanel['status']; total: number; done: number; note: string | null; requested_at: string | null; last_run_at: string | null } | null;
  return {
    provider: provider ? { id: provider.id, model: provider.model } : null,
    enabled: Boolean(s?.enabled),
    status: s?.status ?? 'off',
    total: s?.total ?? 0,
    done: s?.done ?? 0,
    note: s?.note ?? null,
    requestedAt: s?.requested_at ?? null,
    lastRunAt: s?.last_run_at ?? null,
  };
}

export type BackfillEstimate = {
  records: number;
  tokens: number;
  /** Fields left out because they looked like a credential. */
  withheld: number;
  byGroup: { group: string; records: number }[];
  provider: string;
  model: string;
  pricePerMtokMinor: number | null;
  /** Minor units, or null when the owner has not entered a price for the model — never guessed. */
  costMinor: number | null;
  /** A type had more rows than the estimate reads; the figure is a floor. */
  truncated: boolean;
};

/** Pure: the cost half of an estimate. */
export function estimateCost(tokens: number, pricePerMtokMinor: number | null): number | null {
  return pricePerMtokMinor === null ? null : embeddingCostMinor(tokens, pricePerMtokMinor);
}

export async function estimateBackfill(agents: readonly AgentSource[]): Promise<Result<BackfillEstimate>> {
  const context = await requireInternal();
  if (!hasRole(context, 'owner')) return err('FORBIDDEN', 'Only the owner can turn on search by meaning.');
  const provider = await resolveEmbeddingProvider();
  if (!provider) return err('CONFLICT', 'No embedding key is configured. Add OPENAI_API_KEY or OPENROUTER_API_KEY in Settings › Keys & secrets first.');

  const supabase = await createClient();
  const db = supabase as unknown as LooseDb;
  const byGroup: { group: string; records: number }[] = [];
  let tokens = 0;
  let withheld = 0;
  let records = 0;
  let truncated = false;

  const count = (group: string, fields: Record<string, string | null | undefined>) => {
    const { text, withheld: w } = embeddableText(group, fields);
    withheld += w.length;
    if (!text) return 0;
    tokens += Math.ceil(text.length / CHARS_PER_TOKEN);
    return 1;
  };

  for (const spec of SEMANTIC_SOURCES) {
    let n = 0;
    let after: string | null = null;
    for (let page = 0; page < ESTIMATE_MAX_PAGES; page += 1) {
      const rows = await readSourcePage(db, spec, after, ESTIMATE_PAGE);
      for (const r of rows) if (!r.deleted) n += count(spec.group, r.fields);
      if (rows.length < ESTIMATE_PAGE) break;
      after = rows[rows.length - 1]?.id ?? null;
      if (page === ESTIMATE_MAX_PAGES - 1) truncated = true;
    }
    byGroup.push({ group: spec.group, records: n });
    records += n;
  }
  let agentCount = 0;
  for (const a of agents) agentCount += count('Agent', agentFields(a));
  byGroup.push({ group: 'Agent', records: agentCount });
  records += agentCount;

  const price = await db.schema('ai').from('models').select('input_cost_minor_per_mtok').eq('provider', provider.id).eq('model_id', provider.model).maybeSingle();
  if (price.error) unreadable('estimateBackfill.price', price.error);
  const pricePerMtokMinor = typeof price.data?.input_cost_minor_per_mtok === 'number' || typeof price.data?.input_cost_minor_per_mtok === 'string' ? Number(price.data.input_cost_minor_per_mtok) : null;

  return ok({ records, tokens, withheld, byGroup, provider: provider.id, model: provider.model, pricePerMtokMinor, costMinor: estimateCost(tokens, pricePerMtokMinor), truncated });
}

export async function startBackfill(records: number): Promise<Result<{ started: true }>> {
  const context = await requireInternal();
  if (!hasRole(context, 'owner')) return err('FORBIDDEN', 'Only the owner can turn on search by meaning.');
  const provider = await resolveEmbeddingProvider();
  if (!provider) return err('CONFLICT', 'No embedding key is configured. Add OPENAI_API_KEY or OPENROUTER_API_KEY in Settings › Keys & secrets first.');
  if (!Number.isInteger(records) || records < 0 || records > 5_000_000) return err('VALIDATION', 'The estimate this confirms is not valid. Review the estimate again.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('request_semantic_backfill', { p_total: records, p_model: provider.model });
  if (error) return err('INTERNAL', 'Search by meaning could not be turned on. Try again.');
  const outcome = (data as { outcome: string }[] | null)?.[0]?.outcome;
  if (outcome === 'requested') return ok({ started: true });
  if (outcome === 'not_owner') return err('FORBIDDEN', 'Only the owner can turn on search by meaning.');
  return err('VALIDATION', 'Search by meaning could not be turned on.');
}

export async function stopIndexing(): Promise<Result<{ stopped: boolean }>> {
  const context = await requireInternal();
  if (!hasRole(context, 'owner')) return err('FORBIDDEN', 'Only the owner can turn off search by meaning.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('stop_semantic_indexing');
  if (error) return err('INTERNAL', 'Search by meaning could not be turned off. Try again.');
  const outcome = (data as { outcome: string }[] | null)?.[0]?.outcome;
  if (outcome === 'stopped' || outcome === 'unchanged') return ok({ stopped: outcome === 'stopped' });
  return err('FORBIDDEN', 'Only the owner can turn off search by meaning.');
}
