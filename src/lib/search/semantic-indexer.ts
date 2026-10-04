import 'server-only';

import { AgentBudgetRefusal, refuseIfOverBudget } from '@/lib/ai/run-gates';
import type { createAdminClient } from '@/lib/db/admin';
import type { SearchGroup } from '@/lib/admin/global-search-page';

import { contentHash, embeddableText } from './embeddable-text';
import { recordCapabilityDecision } from '@/lib/ai/capability-decision';
import { EMBEDDING_BATCH, embeddingCostMinor, resolveEmbeddingProvider, type EmbedFn, type EmbeddingProvider } from './embedding-provider';
import { agentFields, SEMANTIC_GROUPS, specFor, type AgentSource, type SourceSpec } from './semantic-sources';

/**
 * The indexing job for search by meaning — decision 14. Runs from the job
 * runner's tick (`app/api/jobs/run/route.ts`) beside the other sweeps.
 *
 * For every organisation whose owner turned search by meaning on, it walks
 * the searchable records a page at a time, hashes each record's safe text and
 * embeds ONLY what is new or changed (content-hash skip). It is bounded on
 * purpose: one page per type per tick and at most MAX_EMBEDS_PER_TICK
 * embeddings, so a first backfill spreads over minutes and an unchanged
 * database costs a few reads. Every embedding batch passes the monthly budget
 * gates first (`refuseIfOverBudget`, the same one agent runs pass) and its
 * tokens are written to the cost ledger afterwards; a refused budget parks
 * the job as `blocked` with the reason and retries at most every
 * BLOCKED_RETRY_MINUTES. No key configured parks it the same way.
 *
 * The core (`indexPage`, `runIndexingTick`) takes its store, embedder and
 * gates as arguments, so it is tested with a fake embedding function and an
 * in-memory store; `adminStore` is the real, tenant-scoped one.
 */

type Admin = ReturnType<typeof createAdminClient>;
// The table names here are data (one list drives all eleven types), so the typed client cannot follow them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseDb = { schema(name: string): any };

export const PAGE_SIZE = 100;
export const MAX_EMBEDS_PER_TICK = 300;
export const BLOCKED_RETRY_MINUTES = 30;
export const IDLE_RESCAN_MINUTES = 5;

/** One record, normalised by the store: its id, the words it may be embedded from, and whether it has been deleted. */
export type SourceRow = { id: string; fields: Record<string, string | null | undefined>; deleted: boolean };

export type IndexStore = {
  /** A page of rows in id order after `afterId` (null = from the start). Fewer than `limit` means the type is exhausted. */
  readPage(group: SearchGroup, afterId: string | null, limit: number): Promise<SourceRow[]>;
  storedHashes(group: SearchGroup, ids: string[]): Promise<Map<string, string>>;
  upsert(group: SearchGroup, rows: { id: string; hash: string; vector: number[] }[]): Promise<void>;
  remove(group: SearchGroup, ids: string[]): Promise<void>;
};

export type IndexDeps = {
  store: IndexStore;
  embed: EmbedFn;
  model: string;
  dimensions: number;
  pricePerMtokMinor: number | null;
  /** Throws (AgentBudgetRefusal) when the provider's or model's monthly cap has been reached. */
  gate: () => Promise<void>;
  /** Puts one call's tokens and cost in the ledger. */
  recordUsage: (tokens: number, costMinor: number) => Promise<void>;
};

export type PageOutcome = { embedded: number; removed: number; unchanged: number; withheld: number; tokens: number };

/** Embeds what changed on one page of rows. Budget refusal propagates; nothing is embedded past it. */
export async function indexPage(deps: IndexDeps, group: SearchGroup, rows: SourceRow[]): Promise<PageOutcome> {
  const outcome: PageOutcome = { embedded: 0, removed: 0, unchanged: 0, withheld: 0, tokens: 0 };
  if (rows.length === 0) return outcome;

  const stored = await deps.store.storedHashes(group, rows.map((r) => r.id));
  const toRemove: string[] = [];
  const toEmbed: { id: string; hash: string; text: string }[] = [];

  for (const row of rows) {
    const { text, withheld } = row.deleted ? { text: null, withheld: [] as string[] } : embeddableText(group, row.fields);
    outcome.withheld += withheld.length;
    if (!text) {
      // Deleted, or nothing safe left to say: it must not be findable by meaning.
      if (stored.has(row.id)) toRemove.push(row.id);
      continue;
    }
    const hash = contentHash(deps.model, deps.dimensions, text);
    if (stored.get(row.id) === hash) {
      outcome.unchanged += 1;
      continue;
    }
    toEmbed.push({ id: row.id, hash, text });
  }

  if (toRemove.length > 0) {
    await deps.store.remove(group, toRemove);
    outcome.removed = toRemove.length;
  }

  for (let i = 0; i < toEmbed.length; i += EMBEDDING_BATCH) {
    const batch = toEmbed.slice(i, i + EMBEDDING_BATCH);
    await deps.gate();
    const { vectors, tokens } = await deps.embed(batch.map((b) => b.text));
    if (vectors.length !== batch.length || vectors.some((v) => v.length !== deps.dimensions)) throw new Error('The embedding service returned vectors of an unexpected size.');
    await deps.recordUsage(tokens, embeddingCostMinor(tokens, deps.pricePerMtokMinor));
    await deps.store.upsert(group, batch.map((b, k) => ({ id: b.id, hash: b.hash, vector: vectors[k] as number[] })));
    outcome.embedded += batch.length;
    outcome.tokens += tokens;
  }
  return outcome;
}

export type TickState = {
  status: 'requested' | 'running' | 'done' | 'blocked';
  cursors: Record<string, string | null>;
  passes: Record<string, boolean>;
};

export type TickResult = {
  state: TickState;
  embedded: number;
  removed: number;
  /** Set when the tick stopped because a gate refused. */
  blockedReason: string | null;
};

/**
 * One bounded pass over every group: one page each, in order, stopping when
 * the tick's embedding allowance is spent or a gate refuses. A group whose
 * page comes back short has been read to the end: its cursor resets (so the
 * next pass picks up changes) and its first-pass flag is set; when every
 * group has had a first pass the backfill is `done` and the job goes on
 * rescanning for changes at a gentler rate.
 */
export async function runIndexingTick(deps: IndexDeps, state: TickState, groups: readonly SearchGroup[] = SEMANTIC_GROUPS, maxEmbeds = MAX_EMBEDS_PER_TICK): Promise<TickResult> {
  const cursors = { ...state.cursors };
  const passes = { ...state.passes };
  let embedded = 0;
  let removed = 0;
  let blockedReason: string | null = null;

  for (const group of groups) {
    if (embedded >= maxEmbeds) break;
    if (state.status !== 'done' && passes[group]) continue;
    const after = cursors[group] ?? null;
    const rows = await deps.store.readPage(group, after, PAGE_SIZE);
    try {
      const outcome = await indexPage(deps, group, rows);
      embedded += outcome.embedded;
      removed += outcome.removed;
    } catch (error) {
      if (error instanceof AgentBudgetRefusal) {
        blockedReason = error.message;
        break;
      }
      throw error;
    }
    if (rows.length < PAGE_SIZE) {
      cursors[group] = null;
      passes[group] = true;
    } else {
      cursors[group] = rows[rows.length - 1]?.id ?? null;
    }
  }

  const allDone = groups.every((g) => passes[g]);
  const status: TickState['status'] = blockedReason ? 'blocked' : allDone ? 'done' : 'running';
  return { state: { status, cursors, passes }, embedded, removed, blockedReason };
}

/**
 * One page of a source type in id order, normalised. Used by the job (service
 * role, `organizationId` given: scoped by hand) and by the owner's estimate
 * (the owner's own client, where row-level security scopes it).
 */
export async function readSourcePage(db: LooseDb, spec: SourceSpec, afterId: string | null, limit: number, organizationId?: string): Promise<SourceRow[]> {
  let query = db.schema(spec.schema).from(spec.table).select(spec.columns).order('id', { ascending: true }).limit(limit);
  if (organizationId) query = query.eq('organization_id', organizationId);
  if (afterId !== null) query = query.gt('id', afterId);
  if (spec.windowDays) query = query.gte('created_at', new Date(Date.now() - spec.windowDays * 86_400_000).toISOString());
  const { data, error } = await query;
  if (error) throw new Error(`semantic index: could not read ${spec.group}: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    fields: spec.fields(r),
    deleted: Boolean(spec.softDelete && r.deleted_at),
  }));
}

// ── the real store: service role, tenant scoped by hand ─────────────────────

export function adminStore(admin: Admin, organizationId: string, agents: readonly AgentSource[], model: string): IndexStore {
  const db = admin as unknown as LooseDb;
  return {
    async readPage(group, afterId, limit) {
      if (group === 'Agent') {
        const sorted = [...agents].sort((a, b) => a.key.localeCompare(b.key)).filter((a) => afterId === null || a.key > afterId).slice(0, limit);
        return sorted.map((a) => ({ id: a.key, fields: agentFields(a), deleted: false }));
      }
      const spec = specFor(group);
      if (!spec) return [];
      return readSourcePage(db, spec, afterId, limit, organizationId);
    },
    async storedHashes(group, ids) {
      const map = new Map<string, string>();
      if (ids.length === 0) return map;
      const { data, error } = await db.schema('core').from('search_embeddings').select('entity_id, content_hash').eq('organization_id', organizationId).eq('entity_type', group).in('entity_id', ids);
      if (error) throw new Error(`semantic index: could not read stored hashes: ${error.message}`);
      for (const r of (data ?? []) as { entity_id: string; content_hash: string }[]) map.set(r.entity_id, r.content_hash);
      return map;
    },
    async upsert(group, rows) {
      const { error } = await db.schema('core').rpc('upsert_search_embeddings', {
        p_organization_id: organizationId,
        p_model: model,
        p_rows: rows.map((r) => ({ entity_type: group, entity_id: r.id, content_hash: r.hash, embedding: r.vector })),
      });
      if (error) throw new Error(`semantic index: could not write vectors: ${error.message}`);
    },
    async remove(group, ids) {
      const { error } = await db.schema('core').rpc('delete_search_embeddings', { p_organization_id: organizationId, p_entity_type: group, p_entity_ids: ids });
      if (error) throw new Error(`semantic index: could not remove vectors: ${error.message}`);
    },
  };
}

// ── the per-organisation runner the job tick calls ──────────────────────────

export type SemanticTickSummary = { organizations: number; embedded: number; removed: number; blocked: number; failed: number };

type StateRow = {
  organization_id: string;
  status: TickState['status'];
  model: string | null;
  cursors: Record<string, string | null> | null;
  passes: Record<string, boolean> | null;
  last_run_at: string | null;
};

const minutesSince = (iso: string | null) => (iso ? (Date.now() - new Date(iso).getTime()) / 60_000 : Number.POSITIVE_INFINITY);

/**
 * For every organisation that turned search by meaning on: resolve the
 * vendor, pass the gates, run one tick, and write the state back (progress is
 * the organisation's own vector count). Never throws: a failure is logged and
 * leaves the state to be retried on the next tick.
 */
export async function runSemanticIndexing(admin: Admin, agents: readonly AgentSource[], provider?: EmbeddingProvider | null): Promise<SemanticTickSummary> {
  const summary: SemanticTickSummary = { organizations: 0, embedded: 0, removed: 0, blocked: 0, failed: 0 };
  const db = admin as unknown as LooseDb;
  const { data, error } = await db.schema('core').from('semantic_search_state').select('organization_id, status, model, cursors, passes, last_run_at').eq('enabled', true);
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'runSemanticIndexing.read', detail: error.message }));
    summary.failed += 1;
    return summary;
  }
  const states = (data ?? []) as StateRow[];
  if (states.length === 0) return summary;

  const vendor = provider === undefined ? await resolveEmbeddingProvider() : provider;

  for (const row of states) {
    const org = row.organization_id;
    // A finished backfill rescans gently; a blocked one waits before asking the gates again.
    if (row.status === 'done' && minutesSince(row.last_run_at) < IDLE_RESCAN_MINUTES) continue;
    if (row.status === 'blocked' && minutesSince(row.last_run_at) < BLOCKED_RETRY_MINUTES) continue;
    summary.organizations += 1;
    const touch = (patch: Record<string, unknown>) => db.schema('core').from('semantic_search_state').update({ ...patch, last_run_at: new Date().toISOString() }).eq('organization_id', org);

    try {
      if (!vendor) {
        await touch({ status: 'blocked', note: 'No embedding key is configured. Add OPENAI_API_KEY or OPENROUTER_API_KEY in Settings › Keys & secrets and indexing resumes by itself.' });
        summary.blocked += 1;
        continue;
      }
      const price = await db.schema('ai').from('models').select('input_cost_minor_per_mtok').eq('organization_id', org).eq('model_id', vendor.model).maybeSingle();
      const deps: IndexDeps = {
        store: adminStore(admin, org, agents, vendor.model),
        embed: vendor.embed,
        model: vendor.model,
        dimensions: vendor.dimensions,
        pricePerMtokMinor: price.data?.input_cost_minor_per_mtok === null || price.data?.input_cost_minor_per_mtok === undefined ? null : Number(price.data.input_cost_minor_per_mtok),
        gate: () => refuseIfOverBudget(admin, { organizationId: org, agentKey: 'semantic_indexer', provider: vendor.id, runId: null, model: vendor.model }),
        recordUsage: async (tokens, costMinor) => {
          const { error: ledgerError } = await db.schema('ai').rpc('record_embedding_usage', { p_organization_id: org, p_model: vendor.model, p_provider: vendor.id, p_input_tokens: tokens, p_cost_minor: costMinor });
          if (ledgerError) throw new Error(`semantic index: could not record spend: ${ledgerError.message}`);
        },
      };
      // A model change starts the passes again: vectors of two models are never mixed.
      const modelChanged = row.model !== null && row.model !== vendor.model;
      const start: TickState = { status: row.status === 'blocked' ? 'running' : row.status, cursors: modelChanged ? {} : row.cursors ?? {}, passes: modelChanged ? {} : row.passes ?? {} };
      const result = await runIndexingTick(deps, start);
      const { count } = await db.schema('core').from('search_embeddings').select('entity_id', { count: 'exact', head: true }).eq('organization_id', org).eq('model', vendor.model);
      await touch({
        status: result.state.status,
        model: vendor.model,
        cursors: result.state.cursors,
        passes: result.state.passes,
        done: count ?? 0,
        note: result.blockedReason ? `Paused: ${result.blockedReason}` : null,
      });
      if (result.embedded > 0 || result.blockedReason) {
        await recordCapabilityDecision(admin, {
          organizationId: org,
          agentKey: 'semantic_indexer',
          capability: 'embedding',
          providerId: vendor.id,
          modelId: vendor.model,
          outcome: result.blockedReason ? 'blocked' : 'succeeded',
          detail: result.blockedReason ?? undefined,
          usage: { embedded: result.embedded },
        });
      }
      summary.embedded += result.embedded;
      summary.removed += result.removed;
      if (result.blockedReason) summary.blocked += 1;
    } catch (failure) {
      summary.failed += 1;
      console.error(JSON.stringify({ level: 'error', scope: 'runSemanticIndexing', organizationId: org, detail: failure instanceof Error ? failure.message : String(failure) }));
    }
  }
  return summary;
}
