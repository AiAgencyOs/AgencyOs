/**
 * The QA stage of the delivery pipeline — owner decision 9 (2026-10-03).
 *
 * QA is never a stored status and never set by hand. A project is IN QA
 * while it has an open test run and no release. "Release" is the same fact
 * the lifecycle phase already uses: a handover exists, or the project has
 * been marked production-ready. Archived, completed and cancelled projects
 * are never in QA — the run may still be open, the project is not.
 *
 * Pure so the dashboard's pipeline counts and both project lists' chips
 * agree on one rule, and so the rule has behavioural tests.
 */
export type QaStageFacts = {
  status: string;
  archivedAt?: string | null;
  openTestRuns: number;
  hasRelease: boolean;
};

const NOT_DELIVERING = new Set(['completed', 'cancelled']);

export function isInQa(facts: QaStageFacts): boolean {
  if (facts.archivedAt) return false;
  if (NOT_DELIVERING.has(facts.status)) return false;
  return facts.openTestRuns > 0 && !facts.hasRelease;
}

/** The chip a project list draws: "In QA" when derived, else the stored status. */
export function projectStageChip(facts: QaStageFacts): { key: string; label: string; inQa: boolean } {
  if (isInQa(facts)) return { key: 'in_qa', label: 'In QA', inQa: true };
  const spaced = facts.status.replace(/[_-]+/g, ' ').trim();
  return { key: facts.status, label: spaced.charAt(0).toUpperCase() + spaced.slice(1), inQa: false };
}

export type PipelineProject = QaStageFacts;

/**
 * Counts per pipeline stage. A project in QA is counted under `inQa` and
 * NOT under its stored status, so the stages never add a project twice.
 * Statuses keep their stored keys; `inQa` is the one derived key.
 */
export function pipelineCounts(projects: readonly PipelineProject[]): Record<string, number> & { inQa: number } {
  const counts: Record<string, number> = {};
  let inQa = 0;
  for (const p of projects) {
    if (isInQa(p)) {
      inQa += 1;
      continue;
    }
    counts[p.status] = (counts[p.status] ?? 0) + 1;
  }
  return { ...counts, inQa };
}
