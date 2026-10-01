'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';
import { attachChosenFile } from '@/modules/projects/attached-files-form';

import { addRunEvidence, closeTestRun, openTestRun, rerunTestRun } from './run-lifecycle-service';

/** SCR-046 — open, close and rerun, from the project's QA page and the QA dashboard. */

function revalidateQa(projectId: string) {
  revalidatePath(`/projects/${projectId}/qa`);
  revalidatePath(`/projects/${projectId}/release`);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/qa');
}

const text = (formData: FormData, name: string) => String(formData.get(name) ?? '').trim();
const int = (formData: FormData, name: string) => {
  const raw = text(formData, name);
  return raw === '' ? 0 : Number(raw);
};

export async function openTestRunAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  const result = await openTestRun({
    projectId,
    deliverableId: text(formData, 'deliverableId'),
    suite: text(formData, 'suite') as never,
    ...(text(formData, 'device') ? { device: text(formData, 'device') } : {}),
    ...(text(formData, 'browser') ? { browser: text(formData, 'browser') } : {}),
    ...(text(formData, 'os') ? { os: text(formData, 'os') } : {}),
    ...(text(formData, 'environment') ? { environment: text(formData, 'environment') as never } : {}),
    ...(text(formData, 'testerId') ? { testerId: text(formData, 'testerId') } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateQa(projectId);
  return { status: 'success', message: 'Run opened. Record the counts and close it when the suite is done.' };
}

export async function closeTestRunAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  const result = await closeTestRun({
    projectId,
    runId: text(formData, 'runId'),
    passed: int(formData, 'passed'),
    failed: int(formData, 'failed'),
    skipped: int(formData, 'skipped'),
    blocked: int(formData, 'blocked'),
    ...(text(formData, 'evidenceUrl') ? { evidenceUrl: text(formData, 'evidenceUrl') } : {}),
    ...(text(formData, 'perfNotes') ? { perfNotes: text(formData, 'perfNotes') } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  // Q-C6: the run's evidence may be an uploaded file (a screenshot, a log), under the project-file rules.
  // It is filed beside the run: a closed run is never edited, and this adds a row next to it.
  const evidenceFile = await attachChosenFile(formData, 'test_run', text(formData, 'runId'));
  revalidateQa(projectId);
  if (evidenceFile.status === 'refused') {
    return { status: 'error', message: `The run was closed, but its evidence file was not saved: ${evidenceFile.message}` };
  }
  return { status: 'success', message: 'Run closed. It is evidence now and will not change.' };
}

export async function rerunTestRunAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  const result = await rerunTestRun({ projectId, runId: text(formData, 'runId') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateQa(projectId);
  return { status: 'success', message: 'Rerun opened against the same build. Close it with what the failed cases did this time.' };
}

export async function addRunEvidenceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  const result = await addRunEvidence({
    projectId,
    runId: text(formData, 'runId'),
    kind: text(formData, 'kind') as never,
    value: text(formData, 'value'),
    ...(text(formData, 'label') ? { label: text(formData, 'label') } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateQa(projectId);
  revalidatePath(`/projects/${projectId}/qa/runs/${text(formData, 'runId')}`);
  return { status: 'success', message: 'Evidence added. The run itself is unchanged.' };
}
