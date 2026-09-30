/**
 * "No duplicate alert storms" (SCR-003): rows of an event stream that share a
 * category and a title collapse behind the newest one.
 */
const REPEATING = new Set(['delivery', 'job', 'alert']);

/** Rows sharing a category and a title, newest (first in the list) leading. */
export function groupRepeats<T extends { key: string; category: string; title: string }>(rows: T[]): { lead: T; repeats: T[] }[] {
  const byId = new Map<string, { lead: T; repeats: T[] }>();
  for (const r of rows) {
    // Only event streams repeat; two approvals with one title are two records.
    const id = REPEATING.has(r.category) ? `${r.category}\u0000${r.title}` : r.key;
    const existing = byId.get(id);
    if (existing) existing.repeats.push(r);
    else byId.set(id, { lead: r, repeats: [] });
  }
  return [...byId.values()];
}

