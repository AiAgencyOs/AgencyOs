import { z } from 'zod';

import { TEST_CATEGORIES } from './schema';
import { IMPORT_LIMITS } from './test-case-import';
import type { TestCaseImportRow } from './test-case-import-types';

/**
 * SCR-045 — the commit half of the import, and the task link.
 *
 * `qa.import_test_cases` re-validates every row inside the transaction; this
 * is the shape the action hands the service, so a malformed commit is a
 * VALIDATION error with a field rather than a database refusal.
 */

export const testCaseImportRowSchema = z
  .object({
    requirement: z.string().trim().min(1, 'A case names a requirement of the baseline').max(500),
    category: z.enum(TEST_CATEGORIES),
    reason: z.string().trim().min(1, 'Say why this category applies').max(IMPORT_LIMITS.reason),
    criticalPath: z.boolean().default(false),
    preconditions: z.string().trim().max(IMPORT_LIMITS.preconditions).optional(),
    steps: z.string().trim().max(IMPORT_LIMITS.steps).optional(),
    expectedResult: z.string().trim().max(IMPORT_LIMITS.expectedResult).optional(),
    task: z.uuid().optional(),
  })
  .strict();

export const importTestCasesSchema = z.object({
  planId: z.uuid(),
  cases: z.array(testCaseImportRowSchema).min(1, 'Nothing to import').max(IMPORT_LIMITS.rows),
});

/** What the action hands over: the previewed rows as parsed, before the schema narrows them. */
export type ImportTestCasesInput = { planId: string; cases: TestCaseImportRow[] };

/** `qa.link_test_case_task`: null unlinks. */
export const linkTestCaseTaskSchema = z.object({
  itemId: z.uuid(),
  taskId: z.uuid().nullable(),
});

export type LinkTestCaseTaskInput = z.infer<typeof linkTestCaseTaskSchema>;
