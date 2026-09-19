'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { markProductionReady, raiseDefect, settleDefect } from './service';

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
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateProject(formData);
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
