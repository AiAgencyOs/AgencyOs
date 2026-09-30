import { z } from 'zod';

/**
 * SCR-069 — security incidents and exceptions. Mirrors
 * `security.open_incident` / `security.resolve_incident` (20261001150000).
 */
export const INCIDENT_KINDS = ['unauthorized_access', 'credential_exposure', 'data_exposure', 'policy_violation', 'suspicious_activity', 'other'] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const openIncidentSchema = z.object({
  kind: z.enum(INCIDENT_KINDS),
  severity: z.enum(INCIDENT_SEVERITIES),
  summary: z.string().trim().min(1, 'Say what happened.').max(1000),
  /** Free evidence: audit entry ids, run ids, notes. Recorded as given. */
  evidence: z.string().trim().max(4000).default(''),
  /** An audit entry this incident was opened from, if any. */
  auditEntryId: z.number().int().positive().optional(),
});
export type OpenIncidentInput = z.infer<typeof openIncidentSchema>;

export const resolveIncidentSchema = z.object({
  incidentId: z.uuid('Not an incident id.'),
  resolution: z.string().trim().min(1, 'Say how it was resolved.').max(2000),
});
export type ResolveIncidentInput = z.infer<typeof resolveIncidentSchema>;
