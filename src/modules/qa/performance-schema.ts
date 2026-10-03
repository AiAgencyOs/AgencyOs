import { z } from 'zod';

/**
 * SCR-048 — performance budgets, metric results and stability incidents.
 * A budget is a target per metric per project; a metric result is what one
 * run measured; an incident is an outage or degradation with a severity.
 * The comparison of results against budgets is a reader, never a verdict
 * the database stores.
 */
export const setPerformanceBudgetSchema = z.object({
  projectId: z.uuid(),
  metric: z.string().trim().min(1, 'Name the metric.').max(80),
  target: z.coerce.number().min(0, 'A target is a number, zero or more.'),
  unit: z.string().trim().min(1, 'Say the unit (ms, s, score, KB).').max(20),
  lowerIsBetter: z.boolean().default(true),
  remove: z.boolean().default(false),
});
export type SetPerformanceBudgetInput = z.input<typeof setPerformanceBudgetSchema>;

export const recordMetricResultSchema = z.object({
  projectId: z.uuid(),
  runId: z.uuid(),
  metric: z.string().trim().min(1, 'Name the metric.').max(80),
  value: z.coerce.number(),
  unit: z.string().trim().min(1, 'Say the unit.').max(20),
});
export type RecordMetricResultInput = z.input<typeof recordMetricResultSchema>;

export const INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const openIncidentSchema = z.object({
  projectId: z.uuid(),
  severity: z.enum(INCIDENT_SEVERITIES),
  summary: z.string().trim().min(1, 'Say what happened.').max(2000),
});
export type OpenIncidentInput = z.infer<typeof openIncidentSchema>;

export const resolveIncidentSchema = z.object({
  projectId: z.uuid(),
  incidentId: z.uuid(),
  resolution: z.string().trim().min(1, 'Say how it was resolved.').max(2000),
});
export type ResolveIncidentInput = z.infer<typeof resolveIncidentSchema>;
