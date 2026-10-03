import 'server-only';

import type { SearchGroup, SearchPageResult } from '@/lib/admin/global-search-page';
import type { SearchCondition } from '@/lib/admin/search-conditions';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { looksLikeCredential } from './embeddable-text';
import { embeddingCostMinor, resolveEmbeddingProvider } from './embedding-provider';
import { passesConditions } from './semantic-results';
import { AGENT_CAPABILITY, agentResult, SEMANTIC_GROUPS, SEMANTIC_SOURCES, specFor, type AgentSource } from './semantic-sources';

/**
 * Search by meaning — the reader behind the /search "Meaning" and "Both" modes
 * (decision 14). The ⌘K palette never calls this: it stays keyword-only.
 *
 * What a caller can see is decided three times, on purpose:
 *   1. the entity types are limited to the capabilities the caller's roles
 *      hold (`can`, the same checks the keyword search makes);
 *   2. `core.semantic_search` limits them again in the database, by role, and
 *      to the caller's own organisation;
 *   3. every hit is re-read through the caller's own row-level security, and a
 *      row that cannot be read (or is deleted) is dropped — so a record a role
 *      cannot open is never returned, and no stored text exists to leak (the
 *      vectors table holds only numbers).
 *
 * Off is a state, not an error: no key, not turned on, over budget, or a
 * vendor that did not answer each return `off` with a sentence, and the page
 * shows it beside the keyword results, which are unaffected.
 */

export type SemanticResult = SearchPageResult & { score: number };

export type SemanticOffReason = 'not_enabled' | 'no_key' | 'budget' | 'model_changed' | 'credential_in_query' | 'unavailable';

export const SEMANTIC_OFF_MESSAGES: Record<SemanticOffReason, string> = {
  not_enabled: 'Search by meaning is off. The owner can turn it on from this page; keyword search is unaffected.',
  no_key: 'Search by meaning needs an embedding key (OPENAI_API_KEY or OPENROUTER_API_KEY), and none is configured. Keyword search is unaffected.',
  budget: 'Search by meaning is paused: this month’s AI budget for the embedding model has been reached. Keyword search is unaffected.',
  model_changed: 'The embedding model changed since the records were indexed; the index is being rebuilt, so meaning results return once it has caught up.',
  credential_in_query: 'That query looks like it contains a key or password, so it was not sent to an embedding service. Keyword search ran as usual.',
  unavailable: 'The embedding service did not answer, so meaning results are missing from this page. Keyword search ran as usual.',
};

export type SemanticOutcome = {
  results: SemanticResult[];
  off: { reason: SemanticOffReason; message: string } | null;
  /** The index is still being built: results may be partial. */
  indexing: boolean;
};

export type SemanticFilter = {
  q: string;
  group?: SearchGroup;
  sinceDays?: number;
  conditions?: SearchCondition[];
  agents?: readonly AgentSource[];
};

const off = (reason: SemanticOffReason): SemanticOutcome => ({ results: [], off: { reason, message: SEMANTIC_OFF_MESSAGES[reason] }, indexing: false });

const MEANING_RESULTS = 40;

// The tables are data here, so the typed client cannot follow the names.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseDb = { schema(name: string): any; rpc?: never };

export async function semanticSearch(filter: SemanticFilter): Promise<SemanticOutcome> {
  const q = filter.q.trim();
  const context = await requireInternal();
  const supabase = await createClient();
  const db = supabase as unknown as LooseDb;

  const stateRead = await db.schema('core').from('semantic_search_state').select('enabled, status, model').maybeSingle();
  if (stateRead.error) unreadable('semanticSearch.state', stateRead.error);
  const state = stateRead.data as { enabled: boolean; status: string; model: string | null } | null;
  if (!state?.enabled) return off('not_enabled');

  const provider = await resolveEmbeddingProvider();
  if (!provider) return off('no_key');
  if (state.model && state.model !== provider.model) return off('model_changed');
  if (looksLikeCredential(q)) return off('credential_in_query');

  const allowed = await supabase.schema('ai').rpc('semantic_budget_allows', { p_provider: provider.id, p_model: provider.model });
  if (allowed.error) unreadable('semanticSearch.budget', allowed.error);
  if (allowed.data === false) return off('budget');

  const wantsOwner = (filter.conditions ?? []).some((c) => c.field === 'owner');
  const groups = SEMANTIC_GROUPS.filter((g) => {
    if (filter.group && filter.group !== g) return false;
    const spec = specFor(g);
    if (g === 'Agent') return can(context, AGENT_CAPABILITY) && !wantsOwner;
    return spec ? can(context, spec.capability) && (!wantsOwner || spec.owner !== undefined) : false;
  });
  if (groups.length === 0) return { results: [], off: null, indexing: state.status === 'requested' || state.status === 'running' };

  let vector: number[];
  try {
    const embedded = await provider.embed([q]);
    vector = embedded.vectors[0] ?? [];
    const price = await db.schema('ai').from('models').select('input_cost_minor_per_mtok').eq('model_id', provider.model).maybeSingle();
    const perMtok = typeof price.data?.input_cost_minor_per_mtok === 'number' || typeof price.data?.input_cost_minor_per_mtok === 'string' ? Number(price.data.input_cost_minor_per_mtok) : null;
    // A failure to record is logged, not shown: the search itself succeeded.
    const recorded = await supabase.schema('ai').rpc('record_query_embedding_usage', {
      p_model: provider.model,
      p_provider: provider.id,
      p_input_tokens: embedded.tokens,
      p_cost_minor: embeddingCostMinor(embedded.tokens, perMtok),
    });
    if (recorded.error) console.error(JSON.stringify({ level: 'warn', scope: 'semanticSearch.record', detail: recorded.error.message }));
  } catch (failure) {
    console.error(JSON.stringify({ level: 'warn', scope: 'semanticSearch.embed', detail: failure instanceof Error ? failure.message : String(failure) }));
    return off('unavailable');
  }
  if (vector.length === 0) return off('unavailable');

  const ranked = await supabase.schema('core').rpc('semantic_search', { p_query: vector, p_model: provider.model, p_types: groups, p_limit: MEANING_RESULTS });
  if (ranked.error) unreadable('semanticSearch.rank', ranked.error);
  const hits = (ranked.data ?? []) as { entity_type: SearchGroup; entity_id: string; score: number }[];

  const since = filter.sinceDays ? Date.now() - filter.sinceDays * 86_400_000 : null;
  const conditions = filter.conditions ?? [];
  const results: SemanticResult[] = [];

  for (const group of groups) {
    const mine = hits.filter((h) => h.entity_type === group);
    if (mine.length === 0) continue;
    const scoreById = new Map(mine.map((h) => [h.entity_id, Number(h.score)]));

    if (group === 'Agent') {
      for (const a of filter.agents ?? []) {
        const score = scoreById.get(a.key);
        if (score === undefined) continue;
        if (since || conditions.some((c) => c.field !== 'status')) continue; // an agent has no creation date or owner
        results.push({ ...agentResult(a), score });
      }
      continue;
    }

    const spec = specFor(group);
    if (!spec) continue;
    let query = db.schema(spec.schema).from(spec.table).select(spec.columns).in('id', [...scoreById.keys()]);
    if (spec.softDelete) query = query.is('deleted_at', null);
    const read = await query;
    if (read.error) unreadable(`semanticSearch.hydrate.${group}`, read.error);
    const rows = (read.data ?? []) as Record<string, unknown>[];

    const hrefs = await resolveHrefs(db, group, rows);

    for (const row of rows) {
      const id = String(row.id);
      const createdAt = spec.createdAt(row);
      if (since && createdAt && new Date(createdAt).getTime() < since) continue;
      if (!passesConditions({ status: spec.status?.(row) ?? null, owner: spec.owner ? spec.owner(row) : undefined, createdAt }, conditions)) continue;
      const href = hrefs ? hrefs.get(id) : spec.href(row);
      if (!href) continue;
      results.push({ id, label: spec.label(row), group, href, createdAt, detail: spec.detail(row), score: scoreById.get(id) ?? 0 });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return { results, off: null, indexing: state.status === 'requested' || state.status === 'running' };
}

/** The two types whose link needs a second read, exactly as the keyword search does it; null means the spec's own href serves. */
async function resolveHrefs(db: LooseDb, group: SearchGroup, rows: Record<string, unknown>[]): Promise<Map<string, string> | null> {
  if (group === 'Quotation') {
    const oppIds = [...new Set(rows.map((r) => String(r.opportunity_id)))];
    const { data, error } = oppIds.length > 0 ? await db.schema('sales').from('opportunities').select('id, lead_id').in('id', oppIds) : { data: [], error: null };
    if (error) unreadable('semanticSearch.quotationLeads', error);
    const leadByOpp = new Map(((data ?? []) as { id: string; lead_id: string | null }[]).map((o) => [o.id, o.lead_id]));
    return new Map(rows.map((r) => {
      const leadId = leadByOpp.get(String(r.opportunity_id)) ?? null;
      return [String(r.id), leadId ? `/leads/${leadId}#quotations` : '/quotations'] as [string, string];
    }));
  }
  if (group === 'Requirement') {
    const versionIds = [...new Set(rows.map((r) => String(r.scope_version_id)))];
    const { data, error } = versionIds.length > 0 ? await db.schema('projects').from('scope_versions').select('id, project_id').in('id', versionIds) : { data: [], error: null };
    if (error) unreadable('semanticSearch.requirementVersions', error);
    const projectByVersion = new Map(((data ?? []) as { id: string; project_id: string }[]).map((v) => [v.id, v.project_id]));
    const out = new Map<string, string>();
    for (const r of rows) {
      const projectId = projectByVersion.get(String(r.scope_version_id));
      if (projectId) out.set(String(r.id), `/projects/${projectId}/requirements`);
    }
    return out;
  }
  return null;
}

/** Referenced so the list the indexer walks and the list this reader hydrates cannot drift apart unnoticed. */
export const SEMANTIC_SPEC_GROUPS: readonly SearchGroup[] = SEMANTIC_SOURCES.map((s) => s.group);
