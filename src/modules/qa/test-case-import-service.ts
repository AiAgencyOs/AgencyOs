import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  importTestCasesSchema,
  linkTestCaseTaskSchema,
  type ImportTestCasesInput,
  type LinkTestCaseTaskInput,
} from './test-case-import-schema';

/**
 * SCR-045 — import a batch of cases; link a case to a task.
 *
 * `project.write`, the capability every other test-plan door uses
 * (`addTestPlanItem`, `removeTestPlanItem`); the database asks again through
 * `core.can_manage_delivery()`. Both doors are in migration 20261001160000.
 */

/** The row `qa.import_test_cases` returns. */
type ImportRow = {
  outcome: 'imported' | 'no_actor' | 'not_authorized' | 'not_found' | 'plan_approved' | 'empty_batch' | 'not_an_array' | 'invalid_row';
  imported: number;
  row_number: number | null;
  detail: string | null;
};

/**
 * One transaction: every case lands or none does. A refusal on a row says
 * which row and why, in the database's own words — the same sentence the
 * preview would have shown, or a constraint the preview cannot see (a
 * requirement that is not in the plan's baseline, a case already planned).
 */
export async function importTestCases(input: ImportTestCasesInput): Promise<Result<{ imported: number }>> {
  const parsed = importTestCasesSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path[1] !== undefined ? `Row ${Number(issue.path[1]) + 1}: ` : '';
    return err('VALIDATION', `${where}${issue?.message ?? 'Invalid import.'}`);
  }

  const context = await requireInternal();
  if (!can(context, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to edit a test plan.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('import_test_cases', {
    p_plan_id: parsed.data.planId,
    p_cases: parsed.data.cases.map((c) => ({
      requirement: c.requirement,
      category: c.category,
      reason: c.reason,
      critical_path: c.criticalPath,
      ...(c.preconditions ? { preconditions: c.preconditions } : {}),
      ...(c.steps ? { steps: c.steps } : {}),
      ...(c.expectedResult ? { expected_result: c.expectedResult } : {}),
      ...(c.task ? { task: c.task } : {}),
    })),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'importTestCases', detail: error.message }));
    return err('INTERNAL', 'Could not import the cases.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as ImportRow | undefined;

  switch (row?.outcome) {
    case 'imported':
      return ok({ imported: row.imported });
    case 'invalid_row':
      return err('VALIDATION', `Row ${row.row_number ?? '?'}: ${row.detail ?? 'invalid'}. Nothing was imported.`);
    case 'plan_approved':
      return err('CONFLICT', 'This plan is approved; what was approved is what is tested.');
    case 'empty_batch':
    case 'not_an_array':
      return err('VALIDATION', 'Nothing to import.');
    case 'not_found':
      return err('NOT_FOUND', 'Test plan not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to edit a test plan.');
  }
}

export async function linkTestCaseTask(input: LinkTestCaseTaskInput): Promise<Result<{ linked: boolean }>> {
  const parsed = linkTestCaseTaskSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid task link.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to edit a test plan.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('link_test_case_task', {
    p_test_case_id: parsed.data.itemId,
    p_task_id: parsed.data.taskId,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'linkTestCaseTask', detail: error.message }));
    return err('INTERNAL', 'Could not link the task.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;

  switch (row?.outcome) {
    case 'linked':
      return ok({ linked: true });
    case 'unlinked':
      return ok({ linked: false });
    case 'task_not_on_project':
      return err('VALIDATION', 'That task is not on this project.');
    case 'not_found':
      return err('NOT_FOUND', 'Test case not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to edit a test plan.');
  }
}
