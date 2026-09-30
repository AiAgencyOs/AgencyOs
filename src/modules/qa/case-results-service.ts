import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  approveTestPlanSchema,
  recordTestCaseResultsSchema,
  type ApproveTestPlanInput,
  type RecordTestCaseResultsInput,
} from './case-results-schema';

/**
 * Approves a test plan — `qa.approve_test_plan` (20260929170000).
 * `project.sign_off` (owner, ops_admin): the same two roles ADM-19 gives
 * production sign-off, and the database asks again through `core.is_admin()`.
 * A delivery lead approving the plan for their own delivery would be the
 * review signing its own homework, which is why `project.write` is wrong
 * here by exactly one role.
 */
export async function approveTestPlan(input: ApproveTestPlanInput): Promise<Result<{ approved: boolean }>> {
  const parsed = approveTestPlanSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid test plan.');

  const context = await requireInternal();
  if (!can(context, 'project.sign_off')) {
    return err('FORBIDDEN', 'Approving a test plan needs project.sign_off (owner or ops admin).');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('approve_test_plan', { p_plan_id: parsed.data.planId });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'approveTestPlan', detail: error.message }));
    return err('INTERNAL', 'Could not approve the test plan.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;

  switch (row?.outcome) {
    case 'approved':
      return ok({ approved: true });
    case 'already_approved':
      return err('CONFLICT', 'This plan is already approved.');
    case 'empty_plan':
      return err('VALIDATION', 'A plan with no items cannot be approved — approving nothing is not a decision.');
    case 'not_found':
      return err('NOT_FOUND', 'Test plan not found.');
    default:
      return err('FORBIDDEN', 'Approving a test plan needs project.sign_off (owner or ops admin).');
  }
}

/**
 * Records per-case results beneath a run — `qa.record_test_case_results`.
 * `task.write`, matching `recordTestRun`: the same act, one level down.
 * The run's counts are untouched; a result row is detail, never a total.
 */
export async function recordTestCaseResults(
  input: RecordTestCaseResultsInput,
): Promise<Result<{ recorded: number }>> {
  const parsed = recordTestCaseResultsSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid case results.');
  }

  const context = await requireInternal();
  if (!can(context, 'task.write')) {
    return err('FORBIDDEN', 'You do not have permission to record test evidence.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('record_test_case_results', {
    p_test_run_id: parsed.data.testRunId,
    p_results: parsed.data.results.map((r) => ({
      item_id: r.itemId,
      status: r.status,
      ...(r.notes ? { notes: r.notes } : {}),
      ...(r.evidenceUrl ? { evidence_url: r.evidenceUrl } : {}),
    })),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordTestCaseResults', detail: error.message }));
    return err('INTERNAL', 'Could not record the case results.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; recorded?: number } | undefined;

  switch (row?.outcome) {
    case 'recorded':
      return ok({ recorded: row.recorded ?? 0 });
    case 'wrong_project':
      return err('VALIDATION', 'A case result must name a case from this project’s own plan.');
    case 'bad_results':
      return err('VALIDATION', 'A case result needs a planned case and one of passed, failed, skipped or blocked.');
    case 'not_found':
      return err('NOT_FOUND', 'Test run not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to record test evidence.');
  }
}
