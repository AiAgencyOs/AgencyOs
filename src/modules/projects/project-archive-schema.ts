import { z } from 'zod';

/** SCR-018 — archive a completed project (migration 20261001120000). */
export const archiveProjectSchema = z.object({
  projectId: z.uuid(),
  reason: z.string().trim().max(500).optional(),
});

export type ArchiveProjectInput = z.input<typeof archiveProjectSchema>;

/**
 * The lifecycle phases the projects list distributes and filters on —
 * derived, never stored: each is the newest phase table with a row for the
 * project, the same tables the workspace tabs read. `archived` and
 * `completed` come from the project row itself.
 */
export const LIFECYCLE_PHASES = ['onboarding', 'planning', 'design', 'development', 'qa', 'release', 'completed', 'archived'] as const;
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

export const LIFECYCLE_PHASE_LABEL: Record<LifecyclePhase, string> = {
  onboarding: 'Onboarding',
  planning: 'Planning',
  design: 'Design',
  development: 'Development',
  qa: 'QA',
  release: 'Release',
  completed: 'Completed',
  archived: 'Archived',
};

/**
 * One project's phase from the facts that exist about it. Pure so the rule
 * is testable: the ORDER is the lifecycle — a project with a Phase 4
 * workspace is in development even though its Phase 2 row still exists.
 */
export function lifecyclePhaseOf(facts: {
  status: string;
  archivedAt: string | null;
  productionReadyAt: string | null;
  hasPhaseTwo: boolean;
  hasPhaseThree: boolean;
  hasPhaseFour: boolean;
  hasTestRun: boolean;
  hasHandover: boolean;
}): LifecyclePhase {
  if (facts.archivedAt) return 'archived';
  if (facts.status === 'completed') return 'completed';
  if (facts.hasHandover || facts.productionReadyAt) return 'release';
  if (facts.hasTestRun) return 'qa';
  if (facts.hasPhaseFour) return 'development';
  if (facts.hasPhaseThree) return 'design';
  if (facts.hasPhaseTwo) return 'planning';
  return 'onboarding';
}

/** The health filter's vocabulary — the same rule the list's "At risk" tile already used, plus blocked. */
export const HEALTH_FILTERS = ['healthy', 'at_risk', 'blocked'] as const;
export type HealthFilter = (typeof HEALTH_FILTERS)[number];

export function healthOf(facts: { atRisk: boolean; blocked: boolean }): HealthFilter {
  if (facts.blocked) return 'blocked';
  if (facts.atRisk) return 'at_risk';
  return 'healthy';
}
