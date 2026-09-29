'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { openStabilityIncident, recordMetricResult, resolveStabilityIncident, setPerformanceBudget } from './performance-service';

/** SCR-048 — budgets, metrics and incidents, from the project's QA page and the QA dashboard. */

function revalidate(projectId: string) {
  revalidatePath(`/projects/${projectId}/qa`);
  revalidatePath(`/projects/${projectId}/release`);
  revalidatePath('/qa');
}

const text = (formData: FormData, name: string) => String(formData.get(name) ?? '').trim();

export async function setPerformanceBudgetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  const result = await setPerformanceBudget({
    projectId,
    metric: text(formData, 'metric'),
    target: text(formData, 'target'),
    unit: text(formData, 'unit'),
    lowerIsBetter: text(formData, 'lowerIsBetter') !== 'false',
    remove: text(formData, 'remove') === 'true',
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidate(projectId);
  return { status: 'success', message: result.data.removed ? 'Budget removed.' : 'Budget set.' };
}

export async function recordMetricResultAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  const result = await recordMetricResult({
    projectId,
    runId: text(formData, 'runId'),
    metric: text(formData, 'metric'),
    value: text(formData, 'value'),
    unit: text(formData, 'unit'),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidate(projectId);
  return { status: 'success', message: 'Metric recorded on the run.' };
}

export async function openIncidentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  const result = await openStabilityIncident({
    projectId,
    severity: text(formData, 'severity') as never,
    summary: text(formData, 'summary'),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidate(projectId);
  return { status: 'success', message: 'Incident opened.' };
}

export async function resolveIncidentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  const result = await resolveStabilityIncident({
    projectId,
    incidentId: text(formData, 'incidentId'),
    resolution: text(formData, 'resolution'),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidate(projectId);
  return { status: 'success', message: 'Incident resolved.' };
}
