'use server';

import { revalidatePath } from 'next/cache';
import type { ZodType } from 'zod';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

import {
  alertAckSchema,
  alertRuleSchema,
  certificateSchema,
  emptySchema,
  failoverApproveSchema,
  failoverExecutedSchema,
  followupTaskSchema,
  majorReleaseSchema,
  morningUtc,
  notificationAckSchema,
  outageRecordSchema,
  outageResolveSchema,
  p789FormFields,
  policySchema,
  providerDecisionSchema,
  receiptSchema,
  reminderSentSchema,
  retentionSchema,
  signalReviewSchema,
  startOfDayUtc,
} from './p789-round2-schema';

/**
 * ONE server action over a WHITELIST of the Phase 7 / 8 round-two database doors. The form is parsed (a malformed id, date or number is refused with a word and
 * never sent), then the door checks the role, the state and the tenant under its own lock and its answer is reported as written. A door answer that is not a
 * success word is an ERROR, never swallowed. Nothing here sends a message, deploys, fails anything over, pays, prices or decides on anyone's behalf: the Admin-only
 * doors (policy, acknowledgement, approval, retention, alert rules) refuse a person who is not an Admin. No agent door is reachable from here.
 */

type Parsed = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Door = { schema: ZodType<Parsed>; db?: 'projects' | 'finance'; rpc: string; args: (p: Parsed) => Record<string, unknown>; ok: readonly string[]; paths?: string[] };
const s = (x: unknown) => x as ZodType<Parsed>;

const DOORS: Record<string, Door> = {
  certificate_render: { schema: s(certificateSchema), rpc: 'render_completion_certificate', ok: ['rendered', 'already_rendered'], args: (p) => ({ p_project_id: p.projectId }) },
  receipt_render: { schema: s(receiptSchema), db: 'finance', rpc: 'p789_render_receipt_documents', ok: ['rendered'], args: (p) => ({ p_receipt_id: p.receiptId }) },
  reminder_sweep: { schema: s(emptySchema), rpc: 'p789_sweep_client_action_reminders', ok: ['scheduled', 'nothing_to_schedule'], args: () => ({}) },
  reminder_sent: { schema: s(reminderSentSchema), rpc: 'p789_record_client_action_reminder_sent', ok: ['recorded'], args: (p) => ({ p_reminder_id: p.reminderId, p_channel: p.channel, p_note: p.note }) },
  policy_set: { schema: s(policySchema), rpc: 'p789_set_admin_notification_policy', ok: ['set'], args: (p) => ({ p_severity: p.severity, p_channel: p.channel, p_acknowledge_within_min: p.minutes, p_reason: p.reason }) },
  notification_ack: { schema: s(notificationAckSchema), rpc: 'p789_acknowledge_admin_notification', ok: ['acknowledged'], args: (p) => ({ p_notification_id: p.notificationId, p_note: p.note }) },
  provider_decision: {
    schema: s(providerDecisionSchema), rpc: 'p789_record_provider_decision', ok: ['recorded'],
    args: (p) => ({ p_incident_id: p.incidentId, p_provider_kind: p.providerKind, p_provider_name: p.providerName, p_decision: p.decision, p_evidence_ref: p.evidenceRef, p_next_check_at: p.nextCheckOn ? morningUtc(p.nextCheckOn) : null, p_failover_target: p.failoverTarget ?? null }),
  },
  failover_approve: { schema: s(failoverApproveSchema), rpc: 'p789_approve_provider_failover', ok: ['approved'], args: (p) => ({ p_record_id: p.recordId, p_note: p.note }) },
  failover_executed: { schema: s(failoverExecutedSchema), rpc: 'p789_record_provider_failover_executed', ok: ['recorded'], args: (p) => ({ p_record_id: p.recordId, p_evidence: p.evidence }) },
  outage_record: {
    schema: s(outageRecordSchema), rpc: 'p789_record_outage_case', ok: ['recorded'],
    args: (p) => ({ p_kind: p.kind, p_handling: p.handling, p_observed_from: startOfDayUtc(p.observedOn), p_summary: p.summary, p_project_id: p.projectId ?? null, p_incident_id: p.incidentId ?? null, p_audit_gap: p.auditGap }),
  },
  outage_resolve: { schema: s(outageResolveSchema), rpc: 'p789_resolve_outage_case', ok: ['resolved'], args: (p) => ({ p_case_id: p.caseId, p_observed_until: startOfDayUtc(p.observedUntilOn), p_note: p.note }) },
  major_release: {
    schema: s(majorReleaseSchema), rpc: 'p789_record_major_release', ok: ['recorded'],
    args: (p) => ({ p_project_id: p.projectId, p_version_label: p.versionLabel, p_summary: p.summary, p_release_ref: p.releaseRef, p_released_on: p.releasedOn }),
  },
  retention_set: {
    schema: s(retentionSchema), rpc: 'p789_set_retention_class', ok: ['set'],
    args: (p) => ({ p_data_set: p.dataSet, p_indefinite: p.mode === 'indefinite', p_retention_days: p.mode === 'period' ? p.days : null, p_basis: p.basis }),
  },
  alert_rule_set: { schema: s(alertRuleSchema), rpc: 'p789_set_alert_rule', ok: ['set'], args: (p) => ({ p_metric: p.metric, p_threshold: p.threshold, p_reason: p.reason }) },
  alert_sweep: { schema: s(emptySchema), rpc: 'p789_sweep_alerts', ok: ['swept', 'nothing_changed'], args: () => ({}) },
  alert_ack: { schema: s(alertAckSchema), rpc: 'p789_acknowledge_alert', ok: ['acknowledged'], args: (p) => ({ p_alert_id: p.alertId, p_note: p.note }) },
  followup_task: { schema: s(followupTaskSchema), rpc: 'p789_create_task_from_followup', ok: ['created'], args: (p) => ({ p_request_id: p.requestId, p_assignee_id: p.assigneeId ?? null, p_due_on: p.dueOn ?? null }) },
  signal_review: { schema: s(signalReviewSchema), rpc: 'p789_review_feedback_signal_draft', ok: ['reviewed', 'dismissed'], args: (p) => ({ p_draft_id: p.draftId, p_decision: p.decision, p_note: p.note }) },
};

const WORDS: Record<string, string> = {
  rendered: 'Rendered. The document is stored once and cannot be edited.',
  already_rendered: 'That document was already rendered; it is the same one.',
  nothing_to_render: 'Nothing to render: the payment is not verified, or a document already exists.',
  scheduled: 'Reminders scheduled. Nothing was sent: a person sends each one.',
  nothing_to_schedule: 'Nothing new to remind.',
  recorded: 'Recorded.',
  set: 'Saved.',
  acknowledged: 'Acknowledged.',
  approved: 'Approved. AgencyOS does not fail anything over: a person does it and records the evidence.',
  resolved: 'Resolved.',
  created: 'Task created from the acknowledged request.',
  swept: 'Alerts updated.',
  nothing_changed: 'No alert changed.',
  reviewed: 'Marked reviewed. Nothing was sent.',
  dismissed: 'Dismissed.',
  not_authorized: 'You do not have permission to do this.',
  no_actor: 'You are not signed in as a member.',
  not_found: 'That record was not found.',
  not_completed: 'The project has not completed, so there is no certificate to render.',
  note_required: 'A note of substance is required.',
  contains_secret: 'That looks like a secret (a password or key). Take it out.',
  self_approval: 'The person who recorded a fail-over cannot approve it. Another Admin must.',
  not_approved: 'That fail-over has not been approved.',
  not_a_provider_incident: 'A provider decision is only for a provider outage incident.',
  next_check_in_the_future_required: 'Waiting or retrying needs a next-check day in the future.',
  failover_target_required: 'A fail-over names its target.',
  a_failover_is_already_pending: 'A fail-over is already pending for this incident.',
  audit_gap_must_be_stated: 'An audit-store failure must state the audit gap.',
  admin_required_for_audit_gap: 'Only an Admin can accept an audit gap.',
  no_recorded_failover_execution: 'Record the fail-over execution first.',
  no_phase_eight: 'This project has no Customer Success workspace yet.',
  bad_release_date: 'A release cannot be dated in the future.',
  not_acknowledged_yet: 'Acknowledge the developer request first; a task is made from an acknowledged one.',
  not_a_developer_request: 'Only a Developer request becomes a task.',
  request_already_settled: 'That request is already settled.',
  already_created: 'A task was already made from that request.',
  assignee_not_in_organization: 'The assignee must belong to this organization.',
  already_recorded: 'That is already recorded.',
  already_acknowledged: 'That was already acknowledged.',
  already_settled: 'That draft is already settled.',
  basis_required: 'Say the basis for the decision.',
  state_a_period_or_indefinite: 'State a period in days, or choose indefinite, not both.',
};

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/** Staff: one action over the whitelisted doors above. The database refuses by role (Admin-only doors included). */
export async function p789RoundTwoAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'project.write')) return { status: 'error', message: 'You do not have permission to change this.' };
  const name = String(formData.get('door') ?? '');
  const door = Object.prototype.hasOwnProperty.call(DOORS, name) ? DOORS[name] : undefined;
  if (!door) return { status: 'error', message: 'Unknown action.' };
  const parsed = door.schema.safeParse(p789FormFields(formData));
  if (!parsed.success) return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  const supabase = await createClient();
  const schema = supabase.schema(door.db ?? 'projects') as unknown as { rpc: Rpc };
  const { data, error } = await schema.rpc(door.rpc, door.args(parsed.data));
  if (error) return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
  const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as { outcome?: string | null };
  const outcome = String(row.outcome ?? 'no answer');
  if (!door.ok.includes(outcome)) return { status: 'error', message: WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.` };
  revalidatePath('/projects/p789-operations');
  revalidatePath('/projects/customer-success/p789-governance');
  const project = String(formData.get('projectId') ?? '');
  if (/^[0-9a-f-]{36}$/i.test(project)) revalidatePath(`/projects/${project}`);
  return { status: 'success', message: WORDS[outcome] ?? 'Done.' };
}
