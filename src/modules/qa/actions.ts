'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';
import { attachChosenFile } from '@/modules/projects/attached-files-form';

import { markProductionReady, raiseDefect, settleDefect, draftTestPlan, addTestPlanItem, removeTestPlanItem, recordTestRun,
  triageDefect,
} from './service';

/**
 * Server Actions for QA — G-306.
 *
 * The module had **no surface at all**. `raiseDefect`, `settleDefect`,
 * `markProductionReady`, `listDefects` and `readProjectQuality` were written,
 * tested and reachable by nobody: a caller sweep found the only references to
 * any of them outside their own files were the module's own log scope strings
 * and the name `qa.raiseDefect` in the agent tool catalogue, which is a
 * declaration rather than an executor.
 *
 * **That is not a cosmetic gap.** `projects.submit_deliverable` refuses while
 * an open blocking defect exists (§4.8, ADM-19), and `mark_production_ready`
 * reads the same register. So the gate was live in the database and the
 * register behind it could not be written to — a delivery could be blocked by
 * a defect nobody could raise, and could not be signed off by anybody using
 * the product.
 */

function revalidateProject(formData: FormData) {
  revalidatePath(`/projects/${String(formData.get('projectId') ?? '')}`);
}

export async function raiseDefectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const optional = (name: string) => String(formData.get(name) ?? '').trim() || undefined;

  const result = await raiseDefect({
    projectId: String(formData.get('projectId') ?? ''),
    deliverableId: optional('deliverableId'),
    severity: String(formData.get('severity') ?? '') as never,
    title: String(formData.get('title') ?? ''),
    reproduction: String(formData.get('reproduction') ?? ''),
    expected: optional('expected'),
    actual: optional('actual'),
    environment: optional('environment'),
    evidenceUrl: optional('evidenceUrl'),
    runId: optional('runId'),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  // Q-C6: the bug's evidence may be an uploaded file (a screenshot, a log), under the project-file rules.
  const evidenceFile = await attachChosenFile(formData, 'defect', result.data.defectId);
  revalidateProject(formData);
  if (evidenceFile.status === 'refused') {
    return { status: 'error', message: `The defect was raised, but its evidence file was not saved: ${evidenceFile.message}` };
  }
  return {
    status: 'success',
    // Said rather than implied: a blocker stops the next submission, and
    // somebody raising one should know that before they are asked why a
    // deliverable will not go.
    message: 'Defect raised. A blocker or a major stops the next submission until it is settled.',
  };
}

export async function settleDefectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const status = String(formData.get('status') ?? '');

  const result = await settleDefect({
    defectId: String(formData.get('defectId') ?? ''),
    status: status as never,
    resolution: String(formData.get('resolution') ?? '').trim() || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateProject(formData);
  return { status: 'success', message: `Recorded as ${result.data.status}.` };
}

export async function markProductionReadyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await markProductionReady(String(formData.get('projectId') ?? ''));

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateProject(formData);
  return {
    status: 'success',
    // `already_ready` is a success with nothing to do, and saying so beats
    // reporting a second sign-off that did not happen. The date does not move:
    // the moment it became ready is when it first did.
    message: result.data.ready ? 'Signed off as production ready.' : 'It was already signed off.',
  };
}

function revalidateTestPlan(formData: FormData) {
  revalidatePath(`/projects/${String(formData.get('projectId') ?? '')}/qa`);
}

export async function draftTestPlanAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await draftTestPlan({ scopeVersionId: String(formData.get('scopeVersionId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateTestPlan(formData);
  return { status: 'success', message: 'Test plan drafted.' };
}

export async function addTestPlanItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await addTestPlanItem({
    planId: String(formData.get('planId') ?? ''),
    scopeItemId: String(formData.get('scopeItemId') ?? ''),
    category: String(formData.get('category') ?? '') as never,
    reason: String(formData.get('reason') ?? ''),
    criticalPath: formData.get('criticalPath') === 'on',
    preconditions: String(formData.get('preconditions') ?? '').trim() || undefined,
    steps: String(formData.get('steps') ?? '').trim() || undefined,
    expectedResult: String(formData.get('expectedResult') ?? '').trim() || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateTestPlan(formData);
  return { status: 'success', message: 'Added.' };
}

export async function removeTestPlanItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await removeTestPlanItem({ itemId: String(formData.get('itemId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateTestPlan(formData);
  return { status: 'success', message: 'Removed.' };
}

export async function recordTestRunAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const num = (name: string) => Number(String(formData.get(name) ?? '0'));
  const evidenceUrl = String(formData.get('evidenceUrl') ?? '').trim();

  const result = await recordTestRun({
    deliverableId: String(formData.get('deliverableId') ?? ''),
    suite: String(formData.get('suite') ?? '') as never,
    total: num('total'),
    passed: num('passed'),
    failed: num('failed'),
    skipped: num('skipped'),
    ...(evidenceUrl ? { evidenceUrl } : {}),
    device: String(formData.get('device') ?? '').trim() || undefined,
    browser: String(formData.get('browser') ?? '').trim() || undefined,
    os: String(formData.get('os') ?? '').trim() || undefined,
    perfNotes: String(formData.get('perfNotes') ?? '').trim() || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  const evidenceFile = await attachChosenFile(formData, 'test_run', result.data.testRunId);
  revalidatePath(`/projects/${String(formData.get('projectId') ?? '')}/qa`);
  if (evidenceFile.status === 'refused') {
    return { status: 'error', message: `The test run was recorded, but its evidence file was not saved: ${evidenceFile.message}` };
  }
  return { status: 'success', message: 'Test run recorded.' };
}

export async function triageDefectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await triageDefect({
    defectId: String(formData.get('defectId') ?? ''),
    projectId,
    assigneeId: String(formData.get('assigneeId') ?? '').trim() || null,
    severity: String(formData.get('severity') ?? '') as 'blocker' | 'major' | 'minor' | 'trivial',
    reason: String(formData.get('reason') ?? '').trim() || undefined,
    // SCR-047: the form always carries the field; blank means "no task".
    ...(formData.has('taskId') ? { taskId: String(formData.get('taskId') ?? '').trim() || null } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/qa`);
  revalidatePath(`/projects/${projectId}/development`);
  revalidatePath('/qa');
  return { status: 'success', message: 'Defect triaged.' };
}
