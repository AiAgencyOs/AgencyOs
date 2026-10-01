import { z } from 'zod';

/**
 * Q-PH56 — completing Phase 5 (development) or Phase 6 (testing). What counts
 * as complete is decided in `projects.phase_readiness` from Development / QA
 * data; the labels below are how the page says it.
 */
export const PHASE_COMPLETION_PHASES = [5, 6] as const;
export type PhaseCompletionPhase = (typeof PHASE_COMPLETION_PHASES)[number];

export const PHASE_COMPLETION_COPY: Record<PhaseCompletionPhase, { name: string; rule: string; raises: string }> = {
  5: {
    name: 'Phase 5, Development',
    rule: 'Complete when the project has development tasks and every one of them is done.',
    raises: 'Completing it raises the M3 invoice and the PM’s Task 3 message.',
  },
  6: {
    name: 'Phase 6, Testing',
    rule: 'Complete when Phase 5 is complete, a test run is recorded, the latest run of every suite is clean and no blocker or major defect is open.',
    raises: 'Completing it raises the M4 invoice and the PM’s Task 4 message.',
  },
};

export const completePhaseSchema = z.object({
  projectId: z.uuid(),
  phase: z.union([z.literal(5), z.literal(6)]),
});
export type CompletePhaseInput = z.input<typeof completePhaseSchema>;
