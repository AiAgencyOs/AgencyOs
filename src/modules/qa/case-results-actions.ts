'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { approveTestPlan, recordTestCaseResults } from './case-results-service';
import { TEST_CASE_RESULT_STATUSES, type TestCaseResultStatus } from './case-results-schema';
import { recordTestRun } from './service';

/**
 * SCR-045/046 — approve a plan; record a run that carries per-case results.
 *
 * `recordTestRunWithResultsAction` is the record-run flow with the results
 * grid attached: it goes through the existing `recordTestRun` door first
 * (the run's own totals stay the source of total/passed/failed), then
 * `recordTestCaseResults` beside it with the id that came back. A run whose
 * results then fail to record is still a run — the message says which half
 * landed, rather than pretending both did or neither did.
 */

function revalidateQa(formData: FormData) {
  const projectId = String(formData.get('projectId') ?? '');
  revalidatePath(`/projects/${projectId}/qa`);
  revalidatePath(`/projects/${projectId}/release`);
  revalidatePath('/qa');
}

export async function approveTestPlanAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await approveTestPlan({ planId: String(formData.get('planId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateQa(formData);
  return { status: 'success', message: 'Test plan approved. It accepts no new item and loses none from here.' };
}

function isStatus(value: string): value is TestCaseResultStatus {
  return (TEST_CASE_RESULT_STATUSES as readonly string[]).includes(value);
}

/** The results grid: `result:<itemId>` = status or '' (untouched), `notes:<itemId>` = free text. */
function collectResults(formData: FormData) {
  const results: { itemId: string; status: TestCaseResultStatus; notes?: string }[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('result:')) continue;
    const status = String(value);
    if (!isStatus(status)) continue;
    const itemId = key.slice('result:'.length);
    const notes = String(formData.get(`notes:${itemId}`) ?? '').trim();
    results.push({ itemId, status, ...(notes ? { notes } : {}) });
  }
  return results;
}

export async function recordTestRunWithResultsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const num = (name: string) => Number(String(formData.get(name) ?? '0'));
  const text = (name: string) => String(formData.get(name) ?? '').trim() || undefined;

  const run = await recordTestRun({
    deliverableId: String(formData.get('deliverableId') ?? ''),
    suite: String(formData.get('suite') ?? '') as never,
    total: num('total'),
    passed: num('passed'),
    failed: num('failed'),
    skipped: num('skipped'),
    ...(text('evidenceUrl') ? { evidenceUrl: text('evidenceUrl') } : {}),
    device: text('device'),
    browser: text('browser'),
    os: text('os'),
    perfNotes: text('perfNotes'),
  });
  if (!run.ok) return { status: 'error', message: run.error.message };

  const results = collectResults(formData);
  if (results.length === 0) {
    revalidateQa(formData);
    return { status: 'success', message: 'Test run recorded.' };
  }

  const cases = await recordTestCaseResults({ testRunId: run.data.testRunId, results });
  revalidateQa(formData);
  if (!cases.ok) {
    return { status: 'error', message: `The run was recorded, but its case results were not: ${cases.error.message}` };
  }
  return { status: 'success', message: `Test run recorded with ${cases.data.recorded} case result${cases.data.recorded === 1 ? '' : 's'}.` };
}
