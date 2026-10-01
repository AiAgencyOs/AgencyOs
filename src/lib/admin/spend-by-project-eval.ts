/**
 * SCR-065 "No hidden spend: every AI call should be attributable to project
 * and agent" — the pure part of the per-project spend table.
 *
 * Every run names its agent. A run names a project only when the work belongs
 * to one. The line with no project is KEPT and shown as its own row, never
 * dropped: a table that listed only the projects it could name would
 * understate what was spent.
 */

export type SpendRow = {
  projectId: string | null;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costMinor: number;
};

export type SpendLine = SpendRow & {
  /** The project's name; null for the line that belongs to no project. */
  name: string | null;
  /** The share of all recorded cost, as a whole percent; null while the total is zero (a share of nothing is not a number). */
  sharePercent: number | null;
};

export type SpendTable = {
  lines: SpendLine[];
  total: { runs: number; costMinor: number };
  /** Runs and cost that belong to no project. */
  unattributed: { runs: number; costMinor: number };
};

export function assembleSpend(rows: readonly SpendRow[], names: ReadonlyMap<string, string>): SpendTable {
  const total = rows.reduce((t, r) => ({ runs: t.runs + r.runs, costMinor: t.costMinor + r.costMinor }), { runs: 0, costMinor: 0 });
  const lines = rows
    .map((r): SpendLine => ({
      ...r,
      // A project that cannot be named (deleted, or not visible) is still shown, as what it is.
      name: r.projectId === null ? null : (names.get(r.projectId) ?? 'Unknown project'),
      sharePercent: total.costMinor > 0 ? Math.round((r.costMinor / total.costMinor) * 100) : null,
    }))
    // Most costly first; a project with no cost sorts by its runs; the line with no project always sits last so it reads as a remainder.
    .sort((a, b) => Number(a.projectId === null) - Number(b.projectId === null) || b.costMinor - a.costMinor || b.runs - a.runs);
  const none = rows.filter((r) => r.projectId === null);
  return {
    lines,
    total,
    unattributed: { runs: none.reduce((n, r) => n + r.runs, 0), costMinor: none.reduce((n, r) => n + r.costMinor, 0) },
  };
}
