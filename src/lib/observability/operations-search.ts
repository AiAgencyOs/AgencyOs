import type { Workflow } from '@/lib/admin/run-chain';

/**
 * SCR-066 "search/filtering where list size can grow": one text box over the
 * Operations lists (dead letters, the job queue, failed deliveries, workflow
 * runs). Every list on the page is already loaded for the page's own counts,
 * so this narrows what is DRAWN; it never changes a count, and the page says
 * how many rows matched out of how many it holds.
 *
 * Case-insensitive; every word must appear somewhere in the row's text
 * (a job kind, an error, a provider reason, an agent, a correlation id).
 */

export function matchesAllWords(query: string, ...texts: readonly (string | null | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = texts.filter((t): t is string => typeof t === 'string' && t.length > 0).join(' \n ').toLowerCase();
  return words.every((w) => haystack.includes(w));
}

export function workflowSearchText(w: Workflow): (string | null)[] {
  return [w.correlationId, w.state, ...w.runs.flatMap((r) => [r.agentKey, r.trigger, r.status, r.error]), ...w.jobs.flatMap((j) => [j.kind, j.status, j.lastError])];
}

export type Narrowed<T> = { rows: T[]; held: number };

/** The rows that match, and how many the list held before narrowing. */
export function narrow<T>(query: string, rows: readonly T[], textOf: (row: T) => readonly (string | null | undefined)[]): Narrowed<T> {
  if (!query.trim()) return { rows: [...rows], held: rows.length };
  return { rows: rows.filter((r) => matchesAllWords(query, ...textOf(r))), held: rows.length };
}
