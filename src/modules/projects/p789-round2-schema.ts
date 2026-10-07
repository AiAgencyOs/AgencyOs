import { z } from 'zod';

/**
 * Form schemas for the Phase 7 / 8 round-two doors (migrations 20261129000000, 20261129100000, 20261129200000). Pure: no 'use server', no database. The server
 * action parses with these BEFORE the database is asked, so a malformed id or number is refused with a word and never sent to fail as a type error. Every bound
 * is the bound the database door holds again; the database remains the authority.
 */

export const PROVIDER_KINDS = ['hosting', 'database', 'email', 'payment', 'whatsapp', 'ai_model', 'dns', 'other'] as const;
export const PROVIDER_DECISIONS = ['wait', 'retry', 'failover', 'escalate_to_provider', 'stop'] as const;
export const OUTAGE_KINDS = ['cloud_timeout', 'provider_outage', 'audit_store_failure', 'monitoring_gap'] as const;
export const OUTAGE_HANDLING = ['waited', 'retried', 'failed_over', 'degraded', 'work_held', 'manual_workaround'] as const;
export const SEVERITIES = ['sev1', 'sev2', 'sev3'] as const;
export const NOTIFY_CHANNELS = ['internal_inbox', 'email', 'whatsapp'] as const;
export const REMINDER_CHANNELS = ['call', 'whatsapp', 'email', 'portal', 'meeting'] as const;
export const RETENTION_SETS = ['communication_ledger', 'client_feedback', 'value_reports', 'opportunities', 'access_denials'] as const;
export const ALERT_METRICS = ['tickets_sla_breached', 'check_ins_overdue', 'recovery_plans_open', 'admin_notifications_overdue'] as const;

const uuid = z.uuid({ message: 'A selected record is not valid.' });
const optionalUuid = uuid.optional();
const text = (min: number, max: number, what: string) =>
  z.string({ message: `${what} is required.` }).trim().min(min, `${what} must be at least ${min} characters.`).max(max, `${what} must be at most ${max} characters.`);
const day = z.string({ message: 'A date is required.' }).regex(/^\d{4}-\d{2}-\d{2}$/, 'The date is not valid.').refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'The date is not valid.');
const wholeNumber = (min: number, max: number, what: string) =>
  z.string({ message: `${what} is required.` }).regex(/^\d{1,6}$/, `${what} is a whole number.`).transform(Number).refine((n) => n >= min && n <= max, `${what} must be between ${min} and ${max}.`);

/** Read a FormData into a plain object: a blank field is ABSENT, a checkbox named in CHECKBOXES is a boolean. Nothing is guessed. */
const CHECKBOXES = ['auditGap'];
export function p789FormFields(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set([...fd.keys()])) {
    if (CHECKBOXES.includes(key)) continue;
    const raw = String(fd.get(key) ?? '').trim();
    if (raw !== '') out[key] = raw;
  }
  for (const key of CHECKBOXES) out[key] = fd.get(key) === 'on' || fd.get(key) === 'true';
  return out;
}

/** A calendar day as the start of that day in UTC. */
export const startOfDayUtc = (d: string): string => `${d}T00:00:00.000Z`;
/** A calendar day as 09:00 UTC, for a next-check time that must be in the future. */
export const morningUtc = (d: string): string => `${d}T09:00:00.000Z`;

export const certificateSchema = z.object({ projectId: uuid });
export const receiptSchema = z.object({ receiptId: uuid });
export const emptySchema = z.object({});
export const reminderSentSchema = z.object({ reminderId: uuid, channel: z.enum(REMINDER_CHANNELS, { message: 'Choose how you reminded the client.' }), note: text(10, 1000, 'The note') });
export const policySchema = z.object({
  severity: z.enum(SEVERITIES, { message: 'Choose a severity.' }),
  channel: z.enum(NOTIFY_CHANNELS, { message: 'Choose a channel.' }),
  minutes: wholeNumber(1, 10080, 'Minutes to acknowledge'),
  reason: text(5, 500, 'The reason'),
});
export const notificationAckSchema = z.object({ notificationId: uuid, note: text(5, 1000, 'The note') });
export const providerDecisionSchema = z.object({
  incidentId: uuid,
  providerKind: z.enum(PROVIDER_KINDS, { message: 'Choose a provider kind.' }),
  providerName: text(1, 120, 'The provider name'),
  decision: z.enum(PROVIDER_DECISIONS, { message: 'Choose a decision.' }),
  evidenceRef: text(1, 500, 'The evidence'),
  nextCheckOn: day.optional(),
  failoverTarget: text(1, 200, 'The fail-over target').optional(),
});
export const failoverApproveSchema = z.object({ recordId: uuid, note: text(5, 1000, 'The note') });
export const failoverExecutedSchema = z.object({ recordId: uuid, evidence: text(1, 500, 'The evidence') });
export const outageRecordSchema = z.object({
  kind: z.enum(OUTAGE_KINDS, { message: 'Choose the kind of outage.' }),
  handling: z.enum(OUTAGE_HANDLING, { message: 'Choose how it was handled.' }),
  observedOn: day,
  summary: text(10, 2000, 'The summary'),
  projectId: optionalUuid,
  incidentId: optionalUuid,
  auditGap: z.boolean(),
});
export const outageResolveSchema = z.object({ caseId: uuid, observedUntilOn: day, note: text(10, 1000, 'The resolution note') });
export const majorReleaseSchema = z.object({
  projectId: uuid,
  versionLabel: text(1, 80, 'The version'),
  summary: text(10, 2000, 'The summary'),
  releaseRef: text(1, 500, 'Where the release notes live'),
  releasedOn: day,
});
export const retentionSchema = z
  .object({ dataSet: z.enum(RETENTION_SETS, { message: 'Choose a data set.' }), mode: z.enum(['period', 'indefinite'], { message: 'Choose a period or indefinite.' }), days: wholeNumber(30, 36500, 'The period in days').optional(), basis: text(10, 1000, 'The basis') })
  .superRefine((v, ctx) => {
    if (v.mode === 'period' && v.days === undefined) ctx.addIssue({ code: 'custom', path: ['days'], message: 'State the period in days, or choose indefinite.' });
    if (v.mode === 'indefinite' && v.days !== undefined) ctx.addIssue({ code: 'custom', path: ['days'], message: 'Indefinite has no period: clear the days.' });
  });
export const alertRuleSchema = z.object({ metric: z.enum(ALERT_METRICS, { message: 'Choose a figure.' }), threshold: wholeNumber(1, 100000, 'The threshold'), reason: text(5, 500, 'The reason') });
export const alertAckSchema = z.object({ alertId: uuid, note: text(5, 1000, 'The note') });
export const followupTaskSchema = z.object({ requestId: uuid, assigneeId: optionalUuid, dueOn: day.optional() });
export const signalReviewSchema = z.object({ draftId: uuid, decision: z.enum(['reviewed', 'dismissed'], { message: 'Choose reviewed or dismissed.' }), note: text(5, 1000, 'The note') });
