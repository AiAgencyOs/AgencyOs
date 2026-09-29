import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  closeTestRunSchema,
  openTestRunSchema,
  rerunTestRunSchema,
  type CloseTestRunInput,
  type OpenTestRunInput,
  type RerunTestRunInput,
} from './run-lifecycle-schema';

/**
 * The run lifecycle doors — SCR-046, bucket F: `qa.open_test_run`,
 * `qa.close_test_run`, `qa.rerun_test_run`. `task.write`, the capability
 * `recordTestRun` uses (owner, ops_admin, delivery_lead, member, contractor);
 * the functions ask `core.can_write()` again and audit inside their
 * transaction. Every refusal comes back in the door's own words.
 */

type OutcomeRow = { outcome: string; id?: string | null };

function first(data: unknown): OutcomeRow | undefined {
  return (Array.isArray(data) ? data[0] : data) as OutcomeRow | undefined;
}

export async function openTestRun(input: OpenTestRunInput): Promise<Result<{ runId: string }>> {
  const parsed = openTestRunSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid run.');

  const context = await requireInternal();
  if (!can(context, 'task.write')) return err('FORBIDDEN', 'You do not have permission to open a test run.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('open_test_run', {
    p_deliverable_id: parsed.data.deliverableId,
    p_suite: parsed.data.suite,
    ...(parsed.data.device ? { p_device: parsed.data.device } : {}),
    ...(parsed.data.browser ? { p_browser: parsed.data.browser } : {}),
    ...(parsed.data.os ? { p_os: parsed.data.os } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'openTestRun', detail: error.message }));
    return err('INTERNAL', 'Could not open the run.');
  }
  const row = first(data);
  switch (row?.outcome) {
    case 'opened':
      return row.id ? ok({ runId: row.id }) : err('INTERNAL', 'Could not open the run.');
    case 'not_found':
      return err('NOT_FOUND', 'That build is not on this project.');
    case 'not_a_build':
      return err('CONFLICT', 'A test run is run against a build deliverable, not a design or a document.');
    case 'bad_suite':
      return err('VALIDATION', 'That is not a suite this register knows.');
    case 'not_authorized':
      return err('FORBIDDEN', 'The database refused: your role may not record runs.');
    default:
      return err('INTERNAL', `Could not open the run (${row?.outcome ?? 'no answer'}).`);
  }
}

export async function closeTestRun(input: CloseTestRunInput): Promise<Result<{ closed: true }>> {
  const parsed = closeTestRunSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid counts.');

  const context = await requireInternal();
  if (!can(context, 'task.write')) return err('FORBIDDEN', 'You do not have permission to close a test run.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('close_test_run', {
    p_run_id: parsed.data.runId,
    p_passed: parsed.data.passed,
    p_failed: parsed.data.failed,
    p_skipped: parsed.data.skipped,
    p_blocked: parsed.data.blocked,
    ...(parsed.data.evidenceUrl ? { p_evidence_url: parsed.data.evidenceUrl } : {}),
    ...(parsed.data.perfNotes ? { p_perf_notes: parsed.data.perfNotes } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'closeTestRun', detail: error.message }));
    return err('INTERNAL', 'Could not close the run.');
  }
  const row = first(data);
  switch (row?.outcome) {
    case 'closed':
      return ok({ closed: true });
    case 'not_found':
      return err('NOT_FOUND', 'That run is not on this project.');
    case 'not_open':
      return err('CONFLICT', 'This run is already closed. A closed run is evidence and is never edited — open a rerun instead.');
    case 'bad_counts':
      return err('VALIDATION', 'Counts must be whole numbers, none below zero.');
    case 'not_authorized':
      return err('FORBIDDEN', 'The database refused: your role may not record runs.');
    default:
      return err('INTERNAL', `Could not close the run (${row?.outcome ?? 'no answer'}).`);
  }
}

export async function rerunTestRun(input: RerunTestRunInput): Promise<Result<{ runId: string }>> {
  const parsed = rerunTestRunSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'That is not a run id.');

  const context = await requireInternal();
  if (!can(context, 'task.write')) return err('FORBIDDEN', 'You do not have permission to rerun a suite.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('rerun_test_run', { p_run_id: parsed.data.runId });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'rerunTestRun', detail: error.message }));
    return err('INTERNAL', 'Could not open the rerun.');
  }
  const row = first(data);
  switch (row?.outcome) {
    case 'opened':
      return row.id ? ok({ runId: row.id }) : err('INTERNAL', 'Could not open the rerun.');
    case 'not_found':
      return err('NOT_FOUND', 'That run is not on this project.');
    case 'not_closed':
      return err('CONFLICT', 'Close this run before rerunning its failed cases.');
    case 'nothing_failed':
      return err('CONFLICT', 'Nothing failed or was blocked on this run — there is nothing to rerun.');
    default:
      return err('INTERNAL', `Could not open the rerun (${row?.outcome ?? 'no answer'}).`);
  }
}
