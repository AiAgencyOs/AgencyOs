import { z } from 'zod';

import { decoderSafeSchema } from '@/lib/ai/schema';

/**
 * The QA vocabulary — gap G-030, directive §19.
 *
 * The severity and status words are `ARCHITECTURE.md` §4.8's own, kept rather
 * than improved: a design document followed except where somebody preferred
 * otherwise is not a design document. Everything here mirrors a CHECK in
 * `20260813120002_qa_defects.sql`, and the tests read this file rather than
 * restating the lists, so the two cannot drift.
 */

export const DEFECT_SEVERITIES = ['blocker', 'major', 'minor', 'trivial'] as const;
export type DefectSeverity = (typeof DEFECT_SEVERITIES)[number];

export const DEFECT_STATUSES = ['open', 'fixed', 'wontfix', 'verified'] as const;
export type DefectStatus = (typeof DEFECT_STATUSES)[number];

/**
 * Legal moves.
 *
 * `fixed → open` is the one worth reading twice: verification failing is not
 * a new bug, it is the same bug still being wrong, and forcing a new row for
 * it would lose the history of what was tried. `verified` and `wontfix` are
 * terminal — a verified defect that can be reopened makes "verified" mean
 * "verified for now", and the entire value of the state is that somebody
 * checked.
 */
export const DEFECT_TRANSITIONS: Record<DefectStatus, readonly DefectStatus[]> = {
  open: ['fixed', 'wontfix'],
  fixed: ['verified', 'open'],
  verified: [],
  wontfix: [],
};

/** What stops a version reaching the client — ARCHITECTURE.md §4.8. */
export const BLOCKING_SEVERITIES: readonly DefectSeverity[] = ['blocker', 'major'];

export function blocksDelivery(defect: { status: DefectStatus; severity: DefectSeverity }): boolean {
  return defect.status === 'open' && BLOCKING_SEVERITIES.includes(defect.severity);
}

export const raiseDefectSchema = z.object({
  projectId: z.uuid(),
  /** Absent means project-wide: it blocks every submission, not one version. */
  deliverableId: z.uuid().optional(),
  severity: z.enum(DEFECT_SEVERITIES),
  title: z.string().trim().min(1, 'A defect needs a name').max(200),
  /**
   * Required, and not out of formality. A bug nobody can reproduce is a
   * rumour, and the cost of writing the steps down is paid once by whoever
   * found it rather than repeatedly by whoever picks it up.
   */
  reproduction: z.string().trim().min(1, 'How do you make it happen?').max(4000),
  expected: z.string().trim().max(2000).optional(),
  actual: z.string().trim().max(2000).optional(),
  environment: z.string().trim().max(500).optional(),
  evidenceUrl: z.url().optional(),
});

export type RaiseDefectInput = z.infer<typeof raiseDefectSchema>;

export const settleDefectSchema = z
  .object({
    defectId: z.uuid(),
    status: z.enum(['fixed', 'wontfix', 'verified', 'open']),
    /** Required to leave `open` — what stops a bug being closed by silence. */
    resolution: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.status === 'open' || (v.resolution && v.resolution.length > 0), {
    message: 'Say what happened to it.',
    path: ['resolution'],
  });

export type SettleDefectInput = z.infer<typeof settleDefectSchema>;

/**
 * Document 14 §6's eleven testing categories, and no twelfth.
 *
 * *"360° QA = FUNCTIONAL + UI + API + DATABASE + INTEGRATION + E2E +
 * REGRESSION + SECURITY + PERFORMANCE + COMPATIBILITY + DEPLOYMENT/SMOKE."*
 *
 * Mirrors the CHECK in `20260822180000_a_plan_of_what_to_test_not_a_verdict`,
 * the same way the severity list above mirrors its own.
 */
export const TEST_CATEGORIES = [
  'functional',
  'ui',
  'api',
  'database',
  'integration',
  'e2e',
  'regression',
  'security',
  'performance',
  'compatibility',
  'smoke',
] as const;
export type TestCategory = (typeof TEST_CATEGORIES)[number];

/**
 * What the QA agent may say a project needs tested.
 *
 * **Which categories apply to which agreed item, and why. Nothing else.**
 *
 * Every field Document 14 puts under somebody else's authority is missing
 * here, and each absence is the rule rather than a guard against breaking it:
 *
 * - §16, performance: *"Targets must be project-specific; AI must not invent
 *   universal thresholds."* No latency, no payload size, no load figure.
 * - §14, severity: *"Exact thresholds are Admin-configurable."*
 * - §19, the readiness score: *"The scoring model and weights are configurable
 *   in the Admin Policy Engine."* No score, and no §20 band.
 * - §21, the hard gates: deterministic policy. Nothing here passes, fails,
 *   blocks or releases.
 *
 * So a plan says *test the checkout journey for security, because it moves
 * money*. It cannot say the security gate passed, that the release is 92/100,
 * or that the API must answer in 200ms. Those are four different people's
 * decisions and the schema can express none of them.
 */
export const testPlanSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            scopeItemId: z.string().uuid(),
            category: z.enum(TEST_CATEGORIES),
            reason: z
              .string()
              .trim()
              .min(1, 'Say why this category applies to this item')
              .max(600),
            criticalPath: z.boolean(),
          })
          .strict(),
      )
      .min(1, 'A plan that tests nothing is not a plan'),
  })
  .strict();

export type TestPlan = z.infer<typeof testPlanSchema>;

export function testPlanJsonSchema(): Record<string, unknown> {
  return decoderSafeSchema(z.toJSONSchema(testPlanSchema)) as Record<string, unknown>;
}
