import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

/**
 * Recent and saved searches — SCR-002 (`core.saved_searches`, migration
 * 20260929150000). Personal, like `saved-views.ts`: a row is the /search
 * page's own `q` plus its `type`/`since` filters, never interpreted here.
 * One row per (query, filters) per person; a null `name` is a recent
 * search, a name makes it saved — so "Save this search" promotes the recent
 * entry rather than copying it.
 */

export type SearchFilters = { type?: string; since?: string; /** The filter builder's stacked conditions, `field:op:value`. */ f?: string[] };

export type SavedSearch = {
  id: string;
  query: string;
  filters: SearchFilters;
  name: string | null;
  lastUsedAt: string;
  useCount: number;
  /** `/search?…` for this entry. */
  href: string;
};

export const RECENT_SEARCH_LIMIT = 20;

/** Only the two filters the page has, in a fixed key order, so equality in the database means equality here. */
export function normalizeFilters(input: { type?: string | null; since?: string | null; f?: string[] | null }): SearchFilters {
  const out: SearchFilters = {};
  if (input.f && input.f.length > 0) out.f = [...input.f].filter(Boolean).slice(0, 8);
  if (input.since) out.since = input.since;
  if (input.type) out.type = input.type;
  return out;
}

export function searchHref(query: string, filters: SearchFilters): string {
  const params = new URLSearchParams({ q: query });
  if (filters.type) params.set('type', filters.type);
  if (filters.since) params.set('since', filters.since);
  for (const c of filters.f ?? []) params.append('f', c);
  return `/search?${params.toString()}`;
}

function toRow(r: { id: string; query: string; filters: unknown; name: string | null; last_used_at: string; use_count: number }): SavedSearch {
  const filters = normalizeFilters((r.filters ?? {}) as { type?: string; since?: string; f?: string[] });
  return { id: r.id, query: r.query, filters, name: r.name, lastUsedAt: r.last_used_at, useCount: r.use_count, href: searchHref(r.query, filters) };
}

/** The caller's saved (named) searches and their most recent unnamed ones. RLS scopes to the caller. */
export async function listMySearches(): Promise<{ saved: SavedSearch[]; recent: SavedSearch[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('core')
    .from('saved_searches')
    .select('id, query, filters, name, last_used_at, use_count')
    .order('last_used_at', { ascending: false })
    .limit(200);
  if (error) unreadable('listMySearches', error);
  const rows = (data ?? []).map(toRow);
  return {
    saved: rows.filter((r) => r.name !== null).sort((a, b) => a.name!.localeCompare(b.name!)),
    recent: rows.filter((r) => r.name === null).slice(0, RECENT_SEARCH_LIMIT),
  };
}

/**
 * Records a run search: bumps the existing row or inserts a recent one, then
 * prunes unnamed rows beyond the most recent twenty. Never touches names.
 */
export async function recordSearch(query: string, filters: SearchFilters): Promise<Result<{ id: string }>> {
  const q = query.trim();
  if (q.length < 2 || q.length > 200) return err('VALIDATION', 'Nothing to record.');
  const context = await requireInternal();
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');
  const supabase = await createClient();

  const { data: existing, error: readError } = await supabase
    .schema('core')
    .from('saved_searches')
    .select('id, use_count')
    .eq('user_id', context.userId)
    .eq('query', q)
    .eq('filters', filters as never)
    .maybeSingle();
  if (readError) return err('INTERNAL', 'Could not read recent searches.');

  let id: string;
  if (existing) {
    const { error } = await supabase
      .schema('core')
      .from('saved_searches')
      .update({ use_count: existing.use_count + 1, last_used_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (error) return err('INTERNAL', 'Could not record the search.');
    id = existing.id;
  } else {
    const { data, error } = await supabase
      .schema('core')
      .from('saved_searches')
      .insert({ organization_id: context.organizationId, user_id: context.userId, query: q, filters: filters as never })
      .select('id')
      .single();
    if (error || !data) return err('INTERNAL', 'Could not record the search.');
    id = data.id;
  }

  // Prune: unnamed rows past the twenty most recently used.
  const { data: recents, error: pruneRead } = await supabase
    .schema('core')
    .from('saved_searches')
    .select('id')
    .eq('user_id', context.userId)
    .is('name', null)
    .order('last_used_at', { ascending: false });
  if (!pruneRead && recents && recents.length > RECENT_SEARCH_LIMIT) {
    const stale = recents.slice(RECENT_SEARCH_LIMIT).map((r) => r.id);
    const { error } = await supabase.schema('core').from('saved_searches').delete().in('id', stale);
    if (error) console.error(JSON.stringify({ level: 'error', scope: 'recordSearch.prune', detail: error.message }));
  }

  return ok({ id });
}

/** Names a search — promoting the recent row if there is one, inserting otherwise. */
export async function saveSearch(query: string, filters: SearchFilters, name: string): Promise<Result<{ id: string }>> {
  const q = query.trim();
  const n = name.trim();
  if (q.length < 2 || q.length > 200) return err('VALIDATION', 'Run a search before saving it.');
  if (n.length < 1 || n.length > 60) return err('VALIDATION', 'Give the search a name of up to 60 characters.');
  const context = await requireInternal();
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('core')
    .from('saved_searches')
    .upsert(
      { organization_id: context.organizationId, user_id: context.userId, query: q, filters: filters as never, name: n, last_used_at: new Date().toISOString() },
      { onConflict: 'user_id,query,filters' },
    )
    .select('id')
    .single();
  if (error || !data) {
    console.error(JSON.stringify({ level: 'error', scope: 'saveSearch', detail: error?.message ?? 'no row' }));
    return err('INTERNAL', 'Could not save the search.');
  }
  return ok({ id: data.id });
}

/** Removes one entry (recent or saved) of the caller's. */
export async function forgetSearch(id: string): Promise<Result<{ id: string }>> {
  await requireInternal();
  const supabase = await createClient();
  const { error } = await supabase.schema('core').from('saved_searches').delete().eq('id', id);
  if (error) return err('INTERNAL', 'Could not remove the search.');
  return ok({ id });
}

/**
 * Renames a saved search and/or changes its query — the saved-search manager's
 * "edit". The row stays the caller's own (RLS); a clash with another entry of
 * the same query and filters is refused with a sentence, not merged silently.
 */
export async function editSearch(id: string, input: { name: string; query: string }): Promise<Result<{ id: string }>> {
  const name = input.name.trim();
  const query = input.query.trim();
  if (name.length < 1 || name.length > 60) return err('VALIDATION', 'Give the search a name of up to 60 characters.');
  if (query.length < 2 || query.length > 200) return err('VALIDATION', 'A search needs two to 200 characters.');
  await requireInternal();
  const supabase = await createClient();
  const { error } = await supabase.schema('core').from('saved_searches').update({ name, query }).eq('id', id).not('name', 'is', null);
  if (error) {
    return err(error.code === '23505' ? 'CONFLICT' : 'INTERNAL', error.code === '23505' ? 'Another saved search already has that query and filters.' : 'Could not update the search.');
  }
  return ok({ id });
}
