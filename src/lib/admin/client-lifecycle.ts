/**
 * A client's lifecycle chip, derived from its projects — owner decision
 * Q-CHIPS, round 3 (2026-10-01):
 *
 *   Active     at least one running project
 *   Pending    nothing running or held, and at least one unstarted / signed
 *              project (a finished project beside an unstarted one is Pending:
 *              owner decision R1-2, round 3b, replacing the old "no chip" mix)
 *   Completed  every project complete
 *   On hold    a project on hold
 *
 * A client wears at most one chip. Where two rules would both hold, the
 * client that needs somebody to act wins: ON HOLD beats Active (a held project
 * is the thing to chase even while another runs). Cancelled and archived
 * projects are not counted. A client with no live project wears no chip. The
 * rules are checked in that order, so every live client wears exactly one chip.
 */

export type ClientLifecycle = 'on_hold' | 'active' | 'pending' | 'completed';

export const CLIENT_LIFECYCLE_LABEL: Record<ClientLifecycle, string> = {
  on_hold: 'On hold',
  active: 'Active',
  pending: 'Pending',
  completed: 'Completed',
};

/** `projects.projects.status` values that mean the work has not started. */
const UNSTARTED = new Set(['planning', 'onboarding']);
const IGNORED = new Set(['cancelled', 'archived']);

export function clientLifecycle(byStatus: Readonly<Record<string, number>> | undefined): ClientLifecycle | null {
  if (!byStatus) return null;
  let live = 0;
  let unstarted = 0;
  let completed = 0;
  let running = 0;
  let held = 0;
  for (const [status, count] of Object.entries(byStatus)) {
    if (count <= 0 || IGNORED.has(status)) continue;
    live += count;
    if (status === 'on_hold') held += count;
    else if (status === 'completed') completed += count;
    else if (UNSTARTED.has(status)) unstarted += count;
    else running += count;
  }
  if (live === 0) return null;
  if (held > 0) return 'on_hold';
  if (running > 0) return 'active';
  if (unstarted > 0) return 'pending';
  if (completed === live) return 'completed';
  return null;
}
