import 'server-only';

import { recordAudit } from '@/lib/audit';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  openIncidentSchema,
  recordMetricResultSchema,
  resolveIncidentSchema,
  setPerformanceBudgetSchema,
  type OpenIncidentInput,
  type RecordMetricResultInput,
  type ResolveIncidentInput,
  type SetPerformanceBudgetInput,
} from './performance-schema';

/**
 * SCR-048's doors. Budgets and incidents are `project.write` (owner,
 * ops_admin, delivery_lead — the roles the write policies name); a metric
 * result is `task.write`, like recording the run it belongs to. Budgets and
 * incidents are plain RLS writes with a named audit row; resolving an
 * incident goes through `qa.resolve_stability_incident`, which audits in
 * its transaction.
 */

export async function setPerformanceBudget(input: SetPerformanceBudgetInput): Promise<Result<{ removed: boolean }>> {
  const parsed = setPerformanceBudgetSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid budget.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to set performance budgets.');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  if (parsed.data.remove) {
    const { error } = await supabase
      .schema('qa')
      .from('performance_budgets')
      .delete()
      .eq('project_id', parsed.data.projectId)
      .eq('metric', parsed.data.metric);
    if (error) {
      console.error(JSON.stringify({ level: 'error', scope: 'setPerformanceBudget.remove', detail: error.message }));
      return err('INTERNAL', 'Could not remove the budget.');
    }
    await recordAudit({ organizationId: context.organizationId, action: 'performance_budget.removed', subjectType: 'project', subjectId: parsed.data.projectId, before: { metric: parsed.data.metric } });
    return ok({ removed: true });
  }

  const { data, error } = await supabase
    .schema('qa')
    .from('performance_budgets')
    .upsert(
      {
        organization_id: context.organizationId,
        project_id: parsed.data.projectId,
        metric: parsed.data.metric,
        target: parsed.data.target,
        unit: parsed.data.unit,
        lower_is_better: parsed.data.lowerIsBetter,
        set_by: context.userId,
      },
      { onConflict: 'project_id,metric' },
    )
    .select('id')
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setPerformanceBudget', detail: error.message }));
    return err('INTERNAL', 'Could not save the budget.');
  }
  if (!data) return err('FORBIDDEN', 'The database refused the budget.');

  await recordAudit({
    organizationId: context.organizationId,
    action: 'performance_budget.set',
    subjectType: 'project',
    subjectId: parsed.data.projectId,
    after: { metric: parsed.data.metric, target: parsed.data.target, unit: parsed.data.unit, lower_is_better: parsed.data.lowerIsBetter },
  });
  return ok({ removed: false });
}

export async function recordMetricResult(input: RecordMetricResultInput): Promise<Result<{ resultId: string }>> {
  const parsed = recordMetricResultSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid metric.');

  const context = await requireInternal();
  if (!can(context.role, 'task.write')) return err('FORBIDDEN', 'You do not have permission to record metrics.');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('qa')
    .from('metric_results')
    .insert({
      organization_id: context.organizationId,
      run_id: parsed.data.runId,
      metric: parsed.data.metric,
      value: parsed.data.value,
      unit: parsed.data.unit,
      recorded_by: context.userId,
    })
    .select('id')
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordMetricResult', detail: error.message }));
    return err('INTERNAL', 'Could not record the metric.');
  }
  if (!data) return err('FORBIDDEN', 'The database refused the metric.');

  await recordAudit({
    organizationId: context.organizationId,
    action: 'metric_result.recorded',
    subjectType: 'test_run',
    subjectId: parsed.data.runId,
    after: { metric: parsed.data.metric, value: parsed.data.value, unit: parsed.data.unit },
  });
  return ok({ resultId: data.id });
}

export async function openStabilityIncident(input: OpenIncidentInput): Promise<Result<{ incidentId: string }>> {
  const parsed = openIncidentSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid incident.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to open incidents.');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('qa')
    .from('stability_incidents')
    .insert({
      organization_id: context.organizationId,
      project_id: parsed.data.projectId,
      severity: parsed.data.severity,
      summary: parsed.data.summary,
      opened_by: context.userId,
    })
    .select('id')
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'openStabilityIncident', detail: error.message }));
    return err('INTERNAL', 'Could not open the incident.');
  }
  if (!data) return err('FORBIDDEN', 'The database refused the incident.');

  await recordAudit({
    organizationId: context.organizationId,
    action: 'stability_incident.opened',
    subjectType: 'stability_incident',
    subjectId: data.id,
    after: { project_id: parsed.data.projectId, severity: parsed.data.severity, summary: parsed.data.summary },
  });
  return ok({ incidentId: data.id });
}

export async function resolveStabilityIncident(input: ResolveIncidentInput): Promise<Result<{ resolved: true }>> {
  const parsed = resolveIncidentSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid resolution.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to resolve incidents.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('resolve_stability_incident', {
    p_incident_id: parsed.data.incidentId,
    p_resolution: parsed.data.resolution,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'resolveStabilityIncident', detail: error.message }));
    return err('INTERNAL', 'Could not resolve the incident.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome: string } | undefined;
  switch (row?.outcome) {
    case 'resolved':
      return ok({ resolved: true });
    case 'not_found':
      return err('NOT_FOUND', 'That incident is not on this project.');
    case 'already_resolved':
      return err('CONFLICT', 'This incident is already resolved.');
    case 'no_resolution':
      return err('VALIDATION', 'Say how it was resolved.');
    default:
      return err('INTERNAL', `Could not resolve the incident (${row?.outcome ?? 'no answer'}).`);
  }
}
