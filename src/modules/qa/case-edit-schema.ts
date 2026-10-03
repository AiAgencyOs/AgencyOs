import { z } from 'zod';

/** SCR-045 — edit one case of a draft plan (`qa.update_test_plan_item`). */
export const updateTestCaseSchema = z.object({
  itemId: z.uuid(),
  reason: z.string().trim().min(1, 'Say why this category applies to this item.').max(600),
  criticalPath: z.boolean().default(false),
  preconditions: z.string().trim().max(2000).optional(),
  steps: z.string().trim().max(4000).optional(),
  expectedResult: z.string().trim().max(2000).optional(),
});
export type UpdateTestCaseInput = z.input<typeof updateTestCaseSchema>;

/** SCR-045 guardrail — a requirement with no case carries the reason it needs none (`qa.waive_test_coverage`). */
export const waiveCoverageSchema = z.object({
  planId: z.uuid(),
  scopeItemId: z.uuid(),
  reason: z.string().trim().min(1, 'Say why this requirement needs no test case.').max(600),
});
export type WaiveCoverageInput = z.input<typeof waiveCoverageSchema>;

export const restoreCoverageSchema = z.object({ planId: z.uuid(), scopeItemId: z.uuid() });
export type RestoreCoverageInput = z.input<typeof restoreCoverageSchema>;
