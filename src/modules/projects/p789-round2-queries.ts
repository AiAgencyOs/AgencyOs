import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Reads for the Phase 7 / 8 round-two records. Every read goes through the signed-in person's client, so row security and the internal-only guards in the
 * functions apply. A failed read is refused (G-054): an empty list must mean nothing is there, and a document that could not be read must never look missing.
 */

type Row = Record<string, unknown>;
const rows = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
type Loose = {
  schema(name: string): {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
    from(table: string): { select(columns: string): { eq(column: string, value: string): PromiseLike<{ data: unknown; error: { message: string } | null }> & { order(column: string, o: { ascending: boolean }): PromiseLike<{ data: unknown; error: { message: string } | null }> } } };
  };
};
const db = async (): Promise<Loose> => (await createClient()) as unknown as Loose;

export type StoredDocument = { number: string; sha256: string; html: string };

/** The certificate of a completed project (staff of the organization, or the owning client). Null when none has been rendered. */
export async function readCertificateDocument(projectId: string): Promise<(StoredDocument & { renderedAt: string; intact: boolean }) | null> {
  const { data, error } = await (await db()).schema('projects').rpc('p789_completion_certificate', { p_project_id: projectId });
  if (error) unreadable('readCertificateDocument', error);
  const r = rows(data)[0];
  if (!r) return null;
  return { number: String(r.certificate_number), sha256: String(r.content_sha256), html: String(r.body_html), renderedAt: String(r.rendered_at), intact: r.intact === true };
}

/** A client's own receipt document for a verified payment. Null when it is not theirs, not verified, or not rendered. */
export async function readClientReceiptDocument(paymentId: string): Promise<StoredDocument | null> {
  const { data, error } = await (await db()).schema('projects').rpc('p789_client_receipt_document', { p_payment_id: paymentId });
  if (error) unreadable('readClientReceiptDocument', error);
  const r = rows(data)[0];
  return r ? { number: String(r.receipt_number), sha256: String(r.content_sha256), html: String(r.body_html) } : null;
}

/** A receipt document for staff who may read finance (Admin, finance). Row security decides; anyone else reads nothing. */
export async function readStaffReceiptDocument(paymentId: string): Promise<StoredDocument | null> {
  const { data, error } = await (await db()).schema('finance').from('p789_receipt_documents').select('receipt_number, content_sha256, body_html').eq('payment_id', paymentId);
  if (error) unreadable('readStaffReceiptDocument', error);
  const r = rows(data)[0];
  return r ? { number: String(r.receipt_number), sha256: String(r.content_sha256), html: String(r.body_html) } : null;
}

export type PendingReminder = { reminderId: string; requestId: string; projectId: string; title: string; kind: string; dueAt: string; scheduledAt: string };
export async function readPendingReminders(projectId: string | null): Promise<PendingReminder[]> {
  const { data, error } = await (await db()).schema('projects').rpc('p789_pending_client_action_reminders', { p_project_id: projectId });
  if (error) unreadable('readPendingReminders', error);
  return rows(data).map((r) => ({ reminderId: String(r.reminder_id), requestId: String(r.request_id), projectId: String(r.project_id), title: String(r.title), kind: String(r.kind), dueAt: String(r.due_at), scheduledAt: String(r.scheduled_at) }));
}

export type AdminNotification = { id: string; incidentId: string; projectId: string; severity: string; channel: string; delivery: string; dueBy: string; overdue: boolean; status: string; technicalSummary: string };
/** The Admin notification queue (Admin only: anyone else reads an empty queue by design, and the page says who may see it). */
export async function readAdminNotificationQueue(): Promise<AdminNotification[]> {
  const { data, error } = await (await db()).schema('projects').rpc('p789_admin_notification_queue', {});
  if (error) unreadable('readAdminNotificationQueue', error);
  return rows(data).map((r) => ({
    id: String(r.notification_id), incidentId: String(r.incident_id), projectId: String(r.project_id), severity: String(r.severity), channel: String(r.channel), delivery: String(r.delivery),
    dueBy: String(r.due_by), overdue: r.overdue === true, status: String(r.status), technicalSummary: String(r.technical_summary ?? ''),
  }));
}

export type ProviderRecord = { id: string; incidentId: string; providerKind: string; providerName: string; decision: string; nextCheckAt: string | null; failoverTarget: string | null; approved: boolean; executed: boolean; recordedAt: string };
export async function readProviderRecords(): Promise<ProviderRecord[]> {
  const { data, error } = await (await db()).schema('projects').from('p789_provider_failover_records').select('id, incident_id, provider_kind, provider_name, decision, next_check_at, failover_target, approved_by, executed_at, recorded_at').eq('organization_id', await orgId()).order('recorded_at', { ascending: false });
  if (error) unreadable('readProviderRecords', error);
  return rows(data).slice(0, 100).map((r) => ({
    id: String(r.id), incidentId: String(r.incident_id), providerKind: String(r.provider_kind), providerName: String(r.provider_name), decision: String(r.decision), nextCheckAt: str(r.next_check_at),
    failoverTarget: str(r.failover_target), approved: r.approved_by !== null && r.approved_by !== undefined, executed: r.executed_at !== null && r.executed_at !== undefined, recordedAt: String(r.recorded_at),
  }));
}

export type OutageCase = { id: string; kind: string; handling: string; observedFrom: string; observedUntil: string | null; summary: string; auditGap: boolean; status: string };
export async function readOutageCases(): Promise<OutageCase[]> {
  const { data, error } = await (await db()).schema('projects').from('p789_outage_cases').select('id, kind, handling, observed_from, observed_until, summary, audit_gap, status').eq('organization_id', await orgId()).order('observed_from', { ascending: false });
  if (error) unreadable('readOutageCases', error);
  return rows(data).slice(0, 100).map((r) => ({
    id: String(r.id), kind: String(r.kind), handling: String(r.handling), observedFrom: String(r.observed_from), observedUntil: str(r.observed_until), summary: String(r.summary), auditGap: r.audit_gap === true, status: String(r.status),
  }));
}

export type CsAlert = { id: string; metric: string; threshold: number; observed: number; state: string; raisedAt: string; clearedAt: string | null };
export async function readAlerts(): Promise<CsAlert[]> {
  const { data, error } = await (await db()).schema('projects').from('p789_alerts').select('id, metric, threshold, observed, state, raised_at, cleared_at').eq('organization_id', await orgId()).order('raised_at', { ascending: false });
  if (error) unreadable('readAlerts', error);
  return rows(data).slice(0, 100).map((r) => ({ id: String(r.id), metric: String(r.metric), threshold: Number(r.threshold), observed: Number(r.observed), state: String(r.state), raisedAt: String(r.raised_at), clearedAt: str(r.cleared_at) }));
}

export type RetentionRow = { dataSet: string; decided: boolean; version: number | null; indefinite: boolean | null; retentionDays: number | null; rowsHeld: number; oldestAt: string | null; rowsPastDecision: number };
export async function readRetentionDecisions(): Promise<RetentionRow[]> {
  const { data, error } = await (await db()).schema('projects').rpc('p789_retention_status', {});
  if (error) unreadable('readRetentionDecisions', error);
  return rows(data).map((r) => ({
    dataSet: String(r.data_set), decided: r.decided === true, version: typeof r.version === 'number' ? r.version : null, indefinite: typeof r.indefinite === 'boolean' ? r.indefinite : null,
    retentionDays: typeof r.retention_days === 'number' ? r.retention_days : null, rowsHeld: Number(r.rows_held ?? 0), oldestAt: str(r.oldest_at), rowsPastDecision: Number(r.rows_past_decision ?? 0),
  }));
}

export type MajorRelease = { id: string; versionLabel: string; releasedOn: string; summary: string; releaseRef: string };
export async function readMajorReleases(projectId: string): Promise<MajorRelease[]> {
  const { data, error } = await (await db()).schema('projects').from('p789_major_releases').select('id, version_label, released_on, summary, release_ref').eq('project_id', projectId).order('released_on', { ascending: false });
  if (error) unreadable('readMajorReleases', error);
  return rows(data).map((r) => ({ id: String(r.id), versionLabel: String(r.version_label), releasedOn: String(r.released_on), summary: String(r.summary), releaseRef: String(r.release_ref) }));
}

export type SignalDraft = { id: string; projectId: string; signal: string; summary: string; citedCount: number; status: string; createdAt: string };
export async function readFeedbackSignalDrafts(): Promise<SignalDraft[]> {
  const { data, error } = await (await db()).schema('projects').from('p789_feedback_signal_drafts').select('id, project_id, signal, summary, cited_feedback_ids, status, created_at').eq('organization_id', await orgId()).order('created_at', { ascending: false });
  if (error) unreadable('readFeedbackSignalDrafts', error);
  return rows(data).slice(0, 100).map((r) => ({ id: String(r.id), projectId: String(r.project_id), signal: String(r.signal), summary: String(r.summary), citedCount: Array.isArray(r.cited_feedback_ids) ? r.cited_feedback_ids.length : 0, status: String(r.status), createdAt: String(r.created_at) }));
}

export type AcknowledgedFollowup = { requestId: string; ticketId: string; reason: string };
/** Developer requests a person has acknowledged and nobody has yet turned into a task. */
export async function readAcknowledgedDeveloperRequests(): Promise<AcknowledgedFollowup[]> {
  const sb = await db();
  const [reqs, made] = await Promise.all([
    sb.schema('projects').from('support_handoff_requests').select('id, ticket_id, reason, target').eq('status', 'acknowledged'),
    sb.schema('projects').from('p789_support_followup_tasks').select('request_id').eq('organization_id', await orgId()),
  ]);
  if (reqs.error) unreadable('readAcknowledgedDeveloperRequests requests', reqs.error);
  if (made.error) unreadable('readAcknowledgedDeveloperRequests tasks', made.error);
  const done = new Set(rows(made.data).map((r) => String(r.request_id)));
  return rows(reqs.data).filter((r) => r.target === 'developer' && !done.has(String(r.id))).map((r) => ({ requestId: String(r.id), ticketId: String(r.ticket_id), reason: String(r.reason) }));
}

async function orgId(): Promise<string> {
  const context = await requireInternal();
  return context.organizationId ?? '';
}
