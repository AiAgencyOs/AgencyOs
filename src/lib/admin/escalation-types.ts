/**
 * Client-safe types for escalations — SCR-001 / SCR-003 (bucket F, stream
 * F-A). No `server-only` import: the escalate form and the notification
 * drawer are client components that carry these across the wire.
 */

export const ESCALATION_ROLES = ['owner', 'ops_admin'] as const;
export type EscalationRole = (typeof ESCALATION_ROLES)[number];

export const ESCALATION_STATES = ['open', 'acknowledged', 'resolved'] as const;
export type EscalationState = (typeof ESCALATION_STATES)[number];

export type Escalation = {
  id: string;
  subjectType: string;
  subjectKey: string;
  title: string;
  fromUserName: string | null;
  toRole: EscalationRole;
  reason: string;
  state: EscalationState;
  acknowledgedByName: string | null;
  acknowledgedAt: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
};

/**
 * Notification severity — SCR-003's four chips, DERIVED from the source row
 * by the reader (no column): an overdue approval or a dead job is critical;
 * a due approval, a payment claim or an overdue task wants an action; a
 * failed delivery or a major defect is a warning; a watched phase change is
 * information.
 */
export const SEVERITIES = ['critical', 'action', 'warning', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  action: 'Action required',
  warning: 'Warning',
  info: 'Information',
};

export const SEVERITY_TONE: Record<Severity, 'danger' | 'warning' | 'info' | 'neutral'> = {
  critical: 'danger',
  action: 'warning',
  warning: 'warning',
  info: 'info',
};

export function isSeverity(value: string | undefined): value is Severity {
  return (SEVERITIES as readonly string[]).includes(value ?? '');
}
