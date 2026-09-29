import { z } from 'zod';

/**
 * SCR-045/046 — a plan is approved, and a run carries a result per case.
 *
 * Mirrors `qa.approve_test_plan` and `qa.record_test_case_results`
 * (20260929170000). The status words are the table's own CHECK; `blocked`
 * is the one worth a sentence: a case that could not be run because
 * something else was broken is neither passed nor skipped, and folding it
 * into either is the lie Doc 14 §31 warns about.
 */

export const approveTestPlanSchema = z.object({ planId: z.uuid() });
export type ApproveTestPlanInput = z.infer<typeof approveTestPlanSchema>;

export const TEST_CASE_RESULT_STATUSES = ['passed', 'failed', 'skipped', 'blocked'] as const;
export type TestCaseResultStatus = (typeof TEST_CASE_RESULT_STATUSES)[number];

export const recordTestCaseResultsSchema = z.object({
  testRunId: z.uuid(),
  results: z
    .array(
      z.object({
        itemId: z.uuid(),
        status: z.enum(TEST_CASE_RESULT_STATUSES),
        notes: z.string().trim().max(2000).optional(),
        evidenceUrl: z.url().optional(),
      }),
    )
    .min(1, 'Mark at least one case.'),
});
export type RecordTestCaseResultsInput = z.infer<typeof recordTestCaseResultsSchema>;
