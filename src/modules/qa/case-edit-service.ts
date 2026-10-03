import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  restoreCoverageSchema,
  updateTestCaseSchema,
  waiveCoverageSchema,
  type RestoreCoverageInput,
  type UpdateTestCaseInput,
  type WaiveCoverageInput,
} from './case-edit-schema';

/**
 * SCR-045 — editing a case and accounting for a requirement that has none.
 * `project.write` (owner, ops admin, delivery lead) — the roles
 * `core.can_manage_delivery()` admits; the database asks again and audits.
 */

const first = (data: unknown) => ((Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined)?.outcome;

export async function updateTestCase(input: UpdateTestCaseInput): Promise<Result<{ updated: true }>> {
  const parsed = updateTestCaseSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid case.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to edit a test plan.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('update_test_plan_item', {
    p_item_id: parsed.data.itemId,
    p_reason: parsed.data.reason,
    p_critical_path: parsed.data.criticalPath,
    ...(parsed.data.preconditions ? { p_preconditions: parsed.data.preconditions } : {}),
    ...(parsed.data.steps ? { p_steps: parsed.data.steps } : {}),
    ...(parsed.data.expectedResult ? { p_expected_result: parsed.data.expectedResult } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'updateTestCase', detail: error.message }));
    return err('INTERNAL', 'Could not save the case.');
  }
  switch (first(data)) {
    case 'updated':
      return ok({ updated: true });
    case 'plan_approved':
      return err('CONFLICT', 'This plan is approved; what was approved is what is tested.');
    case 'bad_reason':
      return err('VALIDATION', 'Say why this category applies to this item.');
    case 'not_found':
      return err('NOT_FOUND', 'That case is not in the plan.');
    default:
      return err('FORBIDDEN', 'The database refused: your role may not edit a test plan.');
  }
}

export async function waiveTestCoverage(input: WaiveCoverageInput): Promise<Result<{ waived: true }>> {
  const parsed = waiveCoverageSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid rationale.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to edit a test plan.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('waive_test_coverage', {
    p_plan_id: parsed.data.planId,
    p_scope_item_id: parsed.data.scopeItemId,
    p_reason: parsed.data.reason,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'waiveTestCoverage', detail: error.message }));
    return err('INTERNAL', 'Could not record the rationale.');
  }
  switch (first(data)) {
    case 'waived':
      return ok({ waived: true });
    case 'already_covered':
      return err('CONFLICT', 'That requirement already has a case, so it needs no rationale.');
    case 'wrong_baseline':
      return err('VALIDATION', 'That requirement is not part of this plan’s baseline.');
    case 'bad_reason':
      return err('VALIDATION', 'Say why this requirement needs no test case.');
    case 'not_found':
      return err('NOT_FOUND', 'Test plan not found.');
    default:
      return err('FORBIDDEN', 'The database refused: your role may not edit a test plan.');
  }
}

export async function restoreTestCoverage(input: RestoreCoverageInput): Promise<Result<{ restored: true }>> {
  const parsed = restoreCoverageSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'That is not a requirement on a plan.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to edit a test plan.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('restore_test_coverage', {
    p_plan_id: parsed.data.planId,
    p_scope_item_id: parsed.data.scopeItemId,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'restoreTestCoverage', detail: error.message }));
    return err('INTERNAL', 'Could not withdraw the rationale.');
  }
  switch (first(data)) {
    case 'restored':
      return ok({ restored: true });
    case 'not_found':
      return err('NOT_FOUND', 'There is no rationale to withdraw.');
    default:
      return err('FORBIDDEN', 'The database refused: your role may not edit a test plan.');
  }
}
