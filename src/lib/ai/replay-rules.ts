/**
 * Which runs may be replayed — SCR-065, decision 2026-09-30.
 *
 * A replay queues the job that produced a run again. Only work whose tools
 * are read-only can be run twice without acting twice: ADM-61's `read` class
 * reads and reports, nothing else. Every other class drafts, plans, sends or
 * spends, and a second run of it is a second act — refused, here and in
 * `ai.replay_run`, which holds the same rule in the database.
 *
 * Pure, so the page, the door and the test share one answer.
 */
export const SAFE_WORK_CLASSES = ['read'] as const;

export function mayReplay(workClass: string | null | undefined): boolean {
  return workClass !== null && workClass !== undefined && (SAFE_WORK_CLASSES as readonly string[]).includes(workClass);
}
