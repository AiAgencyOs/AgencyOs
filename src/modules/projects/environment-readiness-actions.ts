'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { READINESS_CHECKS, type ReadinessCheck } from './environment-readiness-schema';
import { promoteBuild, recordEnvironmentCheck } from './environment-readiness-service';

/** SCR-043 — the Builds tab's "record check" and "promote build" controls. */

const str = (formData: FormData, key: string) => String(formData.get(key) ?? '');

export async function recordEnvironmentCheckAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const check = str(formData, 'check');
  const result = await recordEnvironmentCheck({
    projectId,
    environmentId: str(formData, 'environmentId'),
    check: (READINESS_CHECKS as readonly string[]).includes(check) ? (check as ReadinessCheck) : ('' as ReadinessCheck),
    ok: str(formData, 'ok') === 'true',
    evidenceUrl: str(formData, 'evidenceUrl').trim() || undefined,
    note: str(formData, 'note').trim() || undefined,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/builds`);
  return { status: 'success', message: `${result.data.check.replace(/_/g, ' ')} recorded as ${result.data.ok ? 'passing' : 'failing'}.` };
}

export async function promoteBuildAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const result = await promoteBuild({ projectId, environmentId: str(formData, 'environmentId'), deliverableId: str(formData, 'deliverableId') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/builds`);
  revalidatePath(`/projects/${projectId}/release`);
  return { status: 'success', message: 'Build promoted.' };
}
