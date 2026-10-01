import type { SearchCondition } from '@/lib/admin/search-conditions';

/**
 * Pure helpers for the search modes — decision 14. The page offers Keyword,
 * Meaning and Both; every result says which one found it.
 */

export const SEARCH_MODES = ['keyword', 'meaning', 'both'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];
export type MatchedBy = 'keyword' | 'meaning' | 'both';

export const SEARCH_MODE_LABELS: Record<SearchMode, string> = { keyword: 'Keyword', meaning: 'Meaning', both: 'Both' };

/** The palette stays keyword-only; so does anything the URL does not name. */
export function parseMode(value: string | undefined): SearchMode {
  return (SEARCH_MODES as readonly string[]).includes(value ?? '') ? (value as SearchMode) : 'keyword';
}

export type Matchable = { id: string; group: string; createdAt: string | null };

/**
 * Both lists under one rule: a record both found comes first (it matched the
 * words AND the sense), then the meaning matches by score, then the keyword
 * matches newest first — the order each list already has.
 */
export function mergeResults<K extends Matchable, M extends Matchable & { score?: number }>(keyword: readonly K[], meaning: readonly M[]): ((K | M) & { matched: MatchedBy; score?: number })[] {
  const key = (r: Matchable) => `${r.group}:${r.id}`;
  const byMeaning = new Map(meaning.map((m) => [key(m), m]));
  const both: ((K | M) & { matched: MatchedBy; score?: number })[] = [];
  const keywordOnly: ((K | M) & { matched: MatchedBy; score?: number })[] = [];
  for (const k of keyword) {
    const m = byMeaning.get(key(k));
    if (m) {
      both.push({ ...k, matched: 'both', score: m.score });
      byMeaning.delete(key(k));
    } else keywordOnly.push({ ...k, matched: 'keyword' });
  }
  both.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const meaningOnly = [...byMeaning.values()].map((m) => ({ ...m, matched: 'meaning' as const })).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return [...both, ...meaningOnly, ...keywordOnly];
}

/** The page's filter conditions, applied to a hydrated row (the keyword search applies them in the query). */
export function passesConditions(row: { status: string | null; owner: string | null | undefined; createdAt: string | null }, conditions: readonly SearchCondition[]): boolean {
  for (const c of conditions) {
    if (c.field === 'status') {
      if (row.status === null) continue; // a type without a status ignores it, as the keyword search does
      if (c.op === 'not' ? row.status === c.value : row.status !== c.value) return false;
    } else if (c.field === 'owner') {
      // undefined = the type has no owner column: the keyword search leaves such a type out, and so does this.
      if (row.owner === undefined) return false;
      if (c.op === 'not' ? row.owner === c.value : row.owner !== c.value) return false;
    } else if (c.field === 'created' && row.createdAt) {
      const day = row.createdAt.slice(0, 10);
      if (c.op === 'before' ? day > c.value : day < c.value) return false;
    }
  }
  return true;
}

/** Similarity as the percentage the page shows. */
export function scoreLabel(score: number | undefined): string | null {
  return typeof score === 'number' && Number.isFinite(score) ? `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%` : null;
}
