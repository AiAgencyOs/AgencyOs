import { HANDLER_JOB_KIND, SUBSCRIPTIONS, type Handler } from '@/lib/events/catalog';

/**
 * SCR-061 / SCR-065 "Automation workflows" — the definitions, from the code
 * that runs them.
 *
 * The owner's decision (2026-10-01, Round 2 #10) is that automation workflows
 * stay in code, like the agents. So the panel does not offer to define one; it
 * shows what the code already defines: for each event, which handlers react to
 * it, who runs each (an agent or a module of the application), and the job
 * kind each becomes. `SUBSCRIPTIONS` is the one table the dispatcher reads, so
 * this list cannot drift from what actually runs.
 *
 * Pure: the agent roster is passed in (lib may not import the agent module),
 * and the run statistics come from the caller's own read.
 */

export type WorkflowStep = {
  handler: Handler;
  /** The part before the colon: an agent key, or an application module. */
  actor: string;
  actorIsAgent: boolean;
  /** The part after the colon. */
  action: string;
  jobKind: string;
};

export type WorkflowDefinition = {
  /** The event that starts it. */
  event: string;
  steps: WorkflowStep[];
};

export function workflowDefinitions(agentKeys: readonly string[]): WorkflowDefinition[] {
  const agents = new Set(agentKeys);
  return Object.entries(SUBSCRIPTIONS)
    .filter(([, handlers]) => handlers.length > 0)
    .map(([event, handlers]) => ({
      event,
      steps: handlers.map((handler) => {
        const [actor = '', action = ''] = handler.split(':');
        return { handler, actor, actorIsAgent: agents.has(actor), action, jobKind: HANDLER_JOB_KIND[handler] };
      }),
    }))
    .sort((a, b) => a.event.localeCompare(b.event));
}

export type JobKindStats = { runs: number; failed: number; lastAt: string | null };

/** Jobs of the last window, summed per kind. A `dead` or `failed` job counts as a failure. */
export function statsByJobKind(jobs: readonly { kind: string; status: string; created_at: string }[]): Map<string, JobKindStats> {
  const out = new Map<string, JobKindStats>();
  for (const j of jobs) {
    const s = out.get(j.kind) ?? { runs: 0, failed: 0, lastAt: null };
    s.runs += 1;
    if (j.status === 'dead' || j.status === 'failed') s.failed += 1;
    if (s.lastAt === null || j.created_at > s.lastAt) s.lastAt = j.created_at;
    out.set(j.kind, s);
  }
  return out;
}

/** "Camel case" handler action to words: `startPhaseTwo` -> "start phase two". */
export function humanAction(action: string): string {
  return action.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

/** "project.phase_four_ready" -> "project phase four ready". */
export function humanEvent(event: string): string {
  return event.replace(/[._]/g, ' ');
}
