'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { IMPORT_LIMITS, parseTestCaseImport } from './test-case-import';
import { importTestCases, linkTestCaseTask } from './test-case-import-service';
import type { TestCaseImportFormState, TestCaseImportRow } from './test-case-import-types';

/**
 * SCR-045 — import cases in two steps, and link a case to a task.
 *
 * `previewTestCaseImportAction` parses the paste or the upload and answers
 * with the rows and the errors; it writes nothing. `commitTestCaseImportAction`
 * takes the previewed rows (carried in the form) through the door — one
 * transaction, all or none. Nothing is inert-then-lost: a preview that shows
 * an error cannot be committed, and a commit that the database refuses says
 * which row.
 */

function revalidateQa(projectId: string) {
  revalidatePath(`/projects/${projectId}/qa`);
  revalidatePath('/qa');
}

export async function previewTestCaseImportAction(
  _prev: TestCaseImportFormState,
  formData: FormData,
): Promise<TestCaseImportFormState> {
  const planId = String(formData.get('planId') ?? '');
  const pasted = String(formData.get('source') ?? '');
  const upload = formData.get('file');

  let text = pasted;
  if (upload instanceof File && upload.size > 0) {
    if (upload.size > IMPORT_LIMITS.bytes) {
      return { status: 'error', message: `That file is ${Math.round(upload.size / 1024)} KB; the import takes at most ${IMPORT_LIMITS.bytes / 1024} KB.` };
    }
    text = await upload.text();
  } else if (Buffer.byteLength(pasted, 'utf8') > IMPORT_LIMITS.bytes) {
    return { status: 'error', message: `That is more than ${IMPORT_LIMITS.bytes / 1024} KB; the import takes at most that.` };
  }

  const parsed = parseTestCaseImport(text);
  const preview = { ...parsed, planId };

  if (parsed.issues.length > 0) {
    return {
      status: 'error',
      message: `${parsed.issues.length} problem${parsed.issues.length === 1 ? '' : 's'} found — fix them and preview again. Nothing was written.`,
      preview,
    };
  }
  return {
    status: 'success',
    message: `${parsed.rows.length} case${parsed.rows.length === 1 ? '' : 's'} ready. Nothing is written until you commit.`,
    preview,
  };
}

export async function commitTestCaseImportAction(
  _prev: TestCaseImportFormState,
  formData: FormData,
): Promise<TestCaseImportFormState> {
  const projectId = String(formData.get('projectId') ?? '');
  let cases: TestCaseImportRow[];
  try {
    const raw: unknown = JSON.parse(String(formData.get('cases') ?? '[]'));
    if (!Array.isArray(raw)) throw new Error('not an array');
    cases = raw as TestCaseImportRow[];
  } catch {
    return { status: 'error', message: 'The previewed rows could not be read back; preview again.' };
  }

  const result = await importTestCases({ planId: String(formData.get('planId') ?? ''), cases });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateQa(projectId);
  return { status: 'success', message: `Imported ${result.data.imported} case${result.data.imported === 1 ? '' : 's'}.` };
}

export async function linkTestCaseTaskAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await linkTestCaseTask({
    itemId: String(formData.get('itemId') ?? ''),
    taskId: String(formData.get('taskId') ?? '').trim() || null,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateQa(projectId);
  revalidatePath(`/projects/${projectId}/development`);
  return { status: 'success', message: result.data.linked ? 'Task linked.' : 'Task unlinked.' };
}
